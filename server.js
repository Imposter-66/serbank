"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
// データ保存先。ホスティングの永続ディスクを使うときは DATA_DIR にそのパスを指定する
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "data.json");
const KEYS_FILE = path.join(DATA_DIR, "keys.json");
const FILES_FILE = path.join(DATA_DIR, "files.json");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
// 画像・動画の容量制限 (MB)。既定は制限なし。
//   MAX_FILE_MB: 1ファイルの上限 / MAX_TOTAL_MB: 保存できる合計 (どちらも、設定したときだけ制限される)
const mbToBytes = (v) => (Number(v) > 0 ? Number(v) * 1024 * 1024 : Infinity);
const MAX_FILE_BYTES = mbToBytes(process.env.MAX_FILE_MB);
const MAX_TOTAL_BYTES = mbToBytes(process.env.MAX_TOTAL_MB);
const PUBLIC_DIR = path.join(__dirname, "public");
// public フォルダがあればその中身を配信し、無ければ同じ場所の index.html だけを配信する
const HAS_PUBLIC_DIR = fs.existsSync(PUBLIC_DIR);

// 他のサイトからAPIを使うときの設定 (環境変数)
//   CORS_ORIGIN : 許可するサイト。例 "https://example.com" (既定は誰でも許可の "*")
//   API_KEY     : 設定すると、REST APIの書き込みにキーが必要になる
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const API_KEY = process.env.API_KEY || "";
//   REQUIRE_KEY : "1" にすると、API_KEY が無くても書き込みにキー(発行済みキー)を必須にする
//   ALLOW_UNVERIFIED : "1" の間だけ、アカウントの本人確認なしでキーを発行する (動作確認専用。公開環境では使わない)
const REQUIRE_KEY = process.env.REQUIRE_KEY === "1";
const ALLOW_UNVERIFIED = process.env.ALLOW_UNVERIFIED === "1";

// ---- 共有データ (キー → { value, updatedAt, updatedBy }) ----
let store = Object.create(null);
try {
  Object.assign(store, JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
} catch {
  store = Object.create(null);
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), (err) => {
      if (err) console.error("保存に失敗:", err.message);
    });
  }, 300);
}

// ---- 発行済みAPIキー (キーそのものは保存せず、ハッシュだけ保存する) ----
let keys = {};
try {
  keys = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
} catch {
  keys = {};
}

function saveKeys() {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// GAKU PAY の確認用URL (GAKU acct の埋め込みに使っているウェブアプリのURL)。
// 「?embed=1」などは付けない。別のURLを使うときは環境変数 GAKU_VERIFY_URL で上書きできる。
const GAKU_VERIFY_URL = (
  process.env.GAKU_VERIFY_URL ||
  "https://script.google.com/a/macros/school.kasugai.ed.jp/s/AKfycbytjzCXcwEO5u_kSvyBaXrY-iqHkuEI_ZjMtHtNDG-SZiaPvXbtE-pGwV3qZaIpfHyU/exec"
).split("?")[0];

// アカウントの本人確認。成功したら { uid, name } を返し、失敗したら理由つきの Error を投げる。
// ブラウザから届くユーザー情報はなりすませるので、信用するのは GAKU PAY が返した結果だけにする。
// 確認コードは GAKU PAY 側で「5分間・1回だけ」有効。
async function verifyAccount(user, code) {
  if (ALLOW_UNVERIFIED) {
    const uid = String(user.id || user.email || user.name || "").slice(0, 100);
    if (!uid) throw new Error("ユーザー情報が空です");
    return { uid, name: String(user.name || uid).slice(0, 100) };
  }

  if (!/^[0-9a-f]{64}$/.test(code)) {
    throw new Error("確認コードがありません。ログインし直してからもう一度お試しください");
  }

  let result;
  try {
    const r = await fetch(`${GAKU_VERIFY_URL}?verify=${code}`, { signal: AbortSignal.timeout(20000) });
    result = JSON.parse(await r.text());
  } catch {
    throw new Error("GAKU PAY に確認できませんでした。ウェブアプリの公開設定(アクセスできるユーザー)を確認してください");
  }

  if (!result || result.ok !== true) {
    throw new Error((result && result.message) || "アカウントを確認できませんでした");
  }
  if (result.active === false) throw new Error("このアカウントは現在使えません");

  const name = String(result.name || "").slice(0, 100);
  const uid = `${String(result.cls)}|${String(result.no)}`.slice(0, 100);
  if (!name || result.cls == null || result.no == null) throw new Error("アカウント情報を読み取れませんでした");
  return { uid, name };
}

function issueKey(uid, name) {
  for (const h of Object.keys(keys)) if (keys[h].uid === uid) delete keys[h]; // 再発行すると古いキーは無効
  const key = "sb_" + crypto.randomBytes(24).toString("base64url");
  keys[sha256(key)] = { uid, name, createdAt: Date.now() };
  saveKeys();
  return key;
}

// ---- 画像・動画ファイル (本体は uploads/ フォルダ、情報は files.json) ----
let files = {};
try {
  files = JSON.parse(fs.readFileSync(FILES_FILE, "utf8"));
} catch {
  files = {};
}

function saveFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILES_FILE, JSON.stringify(files, null, 2));
}

const FILE_ID_RE = /^[A-Za-z0-9_-]{16}$/;

// ファイルの先頭バイトから、本当の種類を判定する。許可する種類(画像・動画)以外は null。
// (送信者が名乗る種類は信用しない。SVGやHTMLは、悪用されやすいので許可しない)
function sniffType(h) {
  if (h.length >= 4 && h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) return "image/png";
  if (h.length >= 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return "image/jpeg";
  if (h.length >= 4 && h.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  if (h.length >= 12 && h.toString("latin1", 0, 4) === "RIFF" && h.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (h.length >= 4 && h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) return "video/webm";
  if (h.length >= 12 && h.toString("latin1", 4, 8) === "ftyp") {
    const brand = h.toString("latin1", 8, 12);
    if (brand === "qt  ") return "video/quicktime";
    if (brand === "avif") return "image/avif";
    if (["heic", "heix", "hevc", "mif1", "msf1"].includes(brand)) return null; // HEIC写真は未対応
    return "video/mp4";
  }
  return null;
}

function totalFileBytes() {
  return Object.values(files).reduce((sum, f) => sum + (f.size || 0), 0);
}

function fileInfo(id) {
  const f = files[id];
  return { id, url: `/files/${id}`, name: f.name, type: f.type, size: f.size, by: f.by, createdAt: f.createdAt };
}

function cleanFileName(raw) {
  let name = "";
  try {
    name = decodeURIComponent(String(raw || ""));
  } catch {
    name = String(raw || "");
  }
  name = name.replace(/[\u0000-\u001f\u007f/\\]/g, "").trim().slice(0, 200);
  return name || "file";
}

// アップロードを、メモリに溜めずにディスクへ直接書き込む (大きい動画でも落ちないように)
function receiveFile(req, tmpPath) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmpPath);
    let size = 0;
    let head = Buffer.alloc(0);
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      req.unpipe(out);
      out.destroy();
      fs.unlink(tmpPath, () => reject(err));
    };
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_FILE_BYTES) return fail(new Error("too_large"));
      if (head.length < 32) head = Buffer.concat([head, c.subarray(0, 32 - head.length)]);
    });
    req.on("error", fail);
    req.on("aborted", () => fail(new Error("aborted")));
    out.on("error", fail);
    out.on("finish", () => {
      if (!failed) resolve({ size, head });
    });
    req.pipe(out);
  });
}

function validKey(key) {
  return typeof key === "string" && key.length > 0 && key.length <= 100 && key !== "__proto__";
}

// WebSocket と REST API の両方から使う更新処理 (変更は全員にリアルタイム配信)
function setKey(key, value, by) {
  store[key] = { value, updatedAt: Date.now(), updatedBy: by };
  scheduleSave();
  broadcast({ type: "update", key, entry: store[key] });
  return store[key];
}

function deleteKey(key, by) {
  if (!Object.hasOwn(store, key)) return false;
  delete store[key];
  scheduleSave();
  broadcast({ type: "delete", key, by });
  return true;
}

// ---- REST API ----
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-File-Name",
  };
}

// 画像・動画を配信する (動画のシークや途中再生のため Range リクエストに対応)
function serveFile(req, res, id) {
  if (!FILE_ID_RE.test(id) || !Object.hasOwn(files, id)) {
    res.writeHead(404).end("Not Found");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end("Method Not Allowed");
    return;
  }
  const meta = files[id];
  const filePath = path.join(UPLOAD_DIR, id);
  fs.stat(filePath, (err, st) => {
    if (err) {
      res.writeHead(404).end("Not Found");
      return;
    }
    const base = {
      "Content-Type": meta.type,
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Access-Control-Allow-Origin": CORS_ORIGIN,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    };

    let start = 0;
    let end = st.size - 1;
    let status = 200;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (m[1] === "" && m[2] === "")) {
        res.writeHead(416, { ...base, "Content-Range": `bytes */${st.size}` }).end();
        return;
      }
      if (m[1] === "") {
        start = Math.max(0, st.size - Number(m[2])); // 末尾からNバイト
      } else {
        start = Number(m[1]);
        if (m[2] !== "") end = Math.min(end, Number(m[2]));
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { ...base, "Content-Range": `bytes */${st.size}` }).end();
        return;
      }
      status = 206;
      base["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
    }

    res.writeHead(status, { ...base, "Content-Length": end - start + 1 });
    if (req.method === "HEAD") return res.end();
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  });
}

// POST /api/files : 画像・動画を保存する (ボディにファイルそのものを送る)
async function handleUpload(req, res) {
  const who = identify(req);
  if (keyRequired && !who) return sendJson(res, 401, { error: "APIキーが正しくありません" });

  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_FILE_BYTES) {
    return sendJson(res, 413, { error: `ファイルが大きすぎます (上限${Math.round(MAX_FILE_BYTES / 1048576)}MB)` });
  }
  if (totalFileBytes() + declared > MAX_TOTAL_BYTES) {
    return sendJson(res, 507, { error: "保存容量がいっぱいです。古いファイルを削除してください" });
  }

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const id = crypto.randomBytes(12).toString("base64url");
  const tmpPath = path.join(UPLOAD_DIR, `${id}.part`);

  let received;
  try {
    received = await receiveFile(req, tmpPath);
  } catch (e) {
    if (e.message === "too_large") {
      res.on("finish", () => req.destroy());
      return sendJson(res, 413, { error: `ファイルが大きすぎます (上限${Math.round(MAX_FILE_BYTES / 1048576)}MB)` });
    }
    return; // 途中で切断された
  }

  const type = sniffType(received.head);
  if (!type || received.size === 0) {
    fs.unlink(tmpPath, () => {});
    return sendJson(res, 415, { error: "画像(PNG/JPEG/GIF/WebP/AVIF)か動画(MP4/WebM/MOV)だけ保存できます" });
  }
  if (totalFileBytes() + received.size > MAX_TOTAL_BYTES) {
    fs.unlink(tmpPath, () => {});
    return sendJson(res, 507, { error: "保存容量がいっぱいです。古いファイルを削除してください" });
  }

  fs.renameSync(tmpPath, path.join(UPLOAD_DIR, id));
  const url = new URL(req.url, "http://localhost");
  files[id] = {
    name: cleanFileName(req.headers["x-file-name"] || url.searchParams.get("name")),
    type,
    size: received.size,
    by: who ? who.name : "api",
    uid: who ? who.uid || "" : "",
    createdAt: Date.now(),
  };
  saveFiles();
  return sendJson(res, 201, fileInfo(id));
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() });
  res.end(JSON.stringify(body));
}

const keyRequired = Boolean(API_KEY) || REQUIRE_KEY;

// リクエストのキーから誰かを判定する。キーが無い・不正なら null
function identify(req) {
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const token = String(req.headers["x-api-key"] || bearer);
  if (!token) return null;
  if (API_KEY) {
    const given = Buffer.from(token);
    const expected = Buffer.from(API_KEY);
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return { name: "admin", admin: true };
  }
  const rec = keys[sha256(token)];
  return rec ? { name: rec.name, uid: rec.uid } : null;
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
      } catch {
        reject(new Error("bad_json"));
      }
    });
    req.on("error", reject);
  });
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  // APIキーの発行: ログイン済みアカウントの情報と確認コードを送ると、そのユーザー用のキーを返す
  if (url.pathname === "/api/keys") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "POST のみ使えます" });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "JSONの形式が不正です" });
    }
    if (!body || typeof body !== "object") {
      return sendJson(res, 400, { error: '{"code": "確認コード"} の形式で送ってください' });
    }
    const user = body.user && typeof body.user === "object" ? body.user : {};
    let who;
    try {
      who = await verifyAccount(user, String(body.code || ""));
    } catch (e) {
      return sendJson(res, 403, { error: e.message });
    }
    return sendJson(res, 200, { key: issueKey(who.uid, who.name), name: who.name });
  }

  // 画像・動画: 一覧 / アップロード / 削除
  if (url.pathname === "/api/files") {
    if (req.method === "GET") return sendJson(res, 200, Object.keys(files).map(fileInfo));
    if (req.method === "POST" || req.method === "PUT") return handleUpload(req, res);
    return sendJson(res, 405, { error: "このメソッドは使えません" });
  }
  if (url.pathname.startsWith("/api/files/")) {
    const id = url.pathname.slice("/api/files/".length);
    if (!FILE_ID_RE.test(id) || !Object.hasOwn(files, id)) return sendJson(res, 404, { error: "ファイルが存在しません" });
    if (req.method === "GET") return sendJson(res, 200, fileInfo(id));
    if (req.method === "DELETE") {
      const who = identify(req);
      if (keyRequired && !who) return sendJson(res, 401, { error: "APIキーが正しくありません" });
      // 削除できるのは、アップロードした本人か、管理者(API_KEY)だけ
      if (keyRequired && !who.admin && files[id].uid !== who.uid) {
        return sendJson(res, 403, { error: "他の人のファイルは削除できません" });
      }
      delete files[id];
      saveFiles();
      fs.unlink(path.join(UPLOAD_DIR, id), () => {});
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: "このメソッドは使えません" });
  }

  const prefix = "/api/data";
  if (url.pathname === prefix || url.pathname === prefix + "/") {
    if (req.method === "GET") return sendJson(res, 200, store);
    return sendJson(res, 405, { error: "このパスでは GET のみ使えます" });
  }

  if (!url.pathname.startsWith(prefix + "/")) {
    return sendJson(res, 404, { error: "見つかりません" });
  }

  let key;
  try {
    key = decodeURIComponent(url.pathname.slice(prefix.length + 1));
  } catch {
    return sendJson(res, 400, { error: "キーの形式が不正です" });
  }
  if (!validKey(key)) return sendJson(res, 400, { error: "キーは1〜100文字で指定してください" });

  if (req.method === "GET") {
    return Object.hasOwn(store, key)
      ? sendJson(res, 200, store[key])
      : sendJson(res, 404, { error: "キーが存在しません" });
  }

  if (req.method === "PUT" || req.method === "POST" || req.method === "DELETE") {
    const who = identify(req);
    if (keyRequired && !who) return sendJson(res, 401, { error: "APIキーが正しくありません" });
    const by = who ? who.name : "api";

    if (req.method === "DELETE") {
      return deleteKey(key, by)
        ? sendJson(res, 200, { ok: true })
        : sendJson(res, 404, { error: "キーが存在しません" });
    }

    try {
      const body = await readJsonBody(req);
      if (body === null || typeof body !== "object" || !("value" in body)) {
        return sendJson(res, 400, { error: 'ボディは {"value": ...} の形式で送ってください' });
      }
      return sendJson(res, 200, setKey(key, body.value, by));
    } catch (e) {
      return e.message === "too_large"
        ? sendJson(res, 413, { error: "データが大きすぎます (上限64KB)" })
        : sendJson(res, 400, { error: "JSONの形式が不正です" });
    }
  }

  return sendJson(res, 405, { error: "このメソッドは使えません" });
}

// ---- HTTP (API + 静的ファイル + ヘルスチェック) ----
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/health") {
    return sendJson(res, 200, { ok: true, clients: wss.clients.size, keys: Object.keys(store).length });
  }

  if (url.pathname.startsWith("/files/")) {
    serveFile(req, res, url.pathname.slice("/files/".length));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((e) => {
      console.error("APIエラー:", e);
      if (!res.headersSent) sendJson(res, 500, { error: "サーバーエラー" });
    });
    return;
  }

  let filePath;
  if (HAS_PUBLIC_DIR) {
    let rel;
    try {
      rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end("Bad Request");
      return;
    }
    filePath = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
  } else {
    // public フォルダが無いとき: index.html だけを配信する
    // (server.js や data.json など、他のファイルは絶対に配信しない)
    if (url.pathname !== "/" && url.pathname !== "/index.html") {
      res.writeHead(404).end("Not Found");
      return;
    }
    filePath = path.join(__dirname, "index.html");
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404).end("Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  });
});

// ---- WebSocket ----
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
let nextId = 1;

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg, except) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client !== except && client.readyState === WebSocket.OPEN) client.send(data);
  }
}

function broadcastPresence() {
  broadcast({ type: "presence", count: wss.clients.size });
}

wss.on("connection", (ws) => {
  ws.id = `user-${nextId++}`;
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  // 接続直後に現在の全データを送る
  send(ws, { type: "init", id: ws.id, data: store, count: wss.clients.size });
  broadcastPresence();

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, { type: "error", message: "JSONの形式が不正です" });
    }

    if (msg && msg.type === "set" && validKey(msg.key)) {
      setKey(msg.key, msg.value, ws.id);
    } else if (msg && msg.type === "delete" && validKey(msg.key) && Object.hasOwn(store, msg.key)) {
      deleteKey(msg.key, ws.id);
    } else {
      send(ws, { type: "error", message: "不明なメッセージです" });
    }
  });

  ws.on("close", broadcastPresence);
});

// 切断済みクライアントの掃除 (30秒ごと)
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on("close", () => clearInterval(heartbeat));

function shutdown() {
  clearTimeout(saveTimer);
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
  } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`SerBANK 起動: http://localhost:${PORT}`);
    if (!keyRequired) console.log("注意: キー必須の設定がないため、REST APIの書き込みは誰でも可能です (API_KEY または REQUIRE_KEY=1 で制限)");
    if (ALLOW_UNVERIFIED) console.log("警告: ALLOW_UNVERIFIED=1 のため、本人確認なしでキーが発行されます。公開環境では使わないでください");
  });
}

module.exports = { server, wss };

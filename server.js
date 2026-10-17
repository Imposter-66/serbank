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

// アカウントの本人確認。成功したら { uid, name } を返し、失敗したら null を返す。
// TODO: GAKU acct の「確認コード」をサーバー側で検証する処理をここに実装する。
//       (ブラウザから届く情報はなりすませるため、検証なしでキーを発行してはいけない)
async function verifyAccount(user, code) {
  if (ALLOW_UNVERIFIED) {
    const uid = String(user.id || user.email || user.name || "").slice(0, 100);
    if (!uid) return null;
    return { uid, name: String(user.name || uid).slice(0, 100) };
  }
  return null;
}

function issueKey(uid, name) {
  for (const h of Object.keys(keys)) if (keys[h].uid === uid) delete keys[h]; // 再発行すると古いキーは無効
  const key = "sb_" + crypto.randomBytes(24).toString("base64url");
  keys[sha256(key)] = { uid, name, createdAt: Date.now() };
  saveKeys();
  return key;
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
  };
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
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return { name: "admin" };
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
    if (!body || typeof body.user !== "object" || body.user === null) {
      return sendJson(res, 400, { error: '{"user": {...}, "code": "..."} の形式で送ってください' });
    }
    const who = await verifyAccount(body.user, String(body.code || ""));
    if (!who) return sendJson(res, 403, { error: "アカウントの本人確認ができませんでした" });
    return sendJson(res, 200, { key: issueKey(who.uid, who.name), name: who.name });
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

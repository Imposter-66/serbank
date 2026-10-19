"use strict";

const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
// データ保存先。ホスティングの永続ディスクを使うときは DATA_DIR にそのパスを指定する
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "data.json");
const KEYS_FILE = path.join(DATA_DIR, "keys.json");
const FILES_FILE = path.join(DATA_DIR, "files.json");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
const PDATA_FILE = path.join(DATA_DIR, "pdata.json");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

// ---- Supabase (無料で、再起動しても消えない保存先) ----
//   SUPABASE_URL         : 例 https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY : 秘密のキー (secret key / service_role)。絶対に公開しない
//   SUPABASE_BUCKET      : 画像・動画を入れる入れ物の名前 (既定 uploads。自動で作られる)
// 2つ(URLとキー)が設定されているときだけ Supabase を使い、無いときは今までどおり DATA_DIR のファイルに保存する。
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SUPABASE_KEY = String(process.env.SUPABASE_SERVICE_KEY || "").trim();
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "uploads";
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_KEY);

// 画像・動画の容量制限 (MB)。
//   MAX_FILE_MB: 1ファイルの上限 / MAX_TOTAL_MB: 保存できる合計
//   未設定のとき、ファイルに保存する場合は制限なし。Supabase を使う場合は無料枠に合わせて 50MB / 900MB。
const mbToBytes = (v, fallbackMb) => {
  const n = Number(v) > 0 ? Number(v) : fallbackMb;
  return n > 0 ? n * 1024 * 1024 : Infinity;
};
const MAX_FILE_BYTES = mbToBytes(process.env.MAX_FILE_MB, USE_SUPABASE ? 50 : 0);
const MAX_TOTAL_BYTES = mbToBytes(process.env.MAX_TOTAL_MB, USE_SUPABASE ? 900 : 0);
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

// ---- 発行済みAPIキー (キーそのものは保存せず、ハッシュだけ保存する) ----
let keys = {};
try {
  keys = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
} catch {
  keys = {};
}

// ---- プロジェクト (アカウントごとに作る。APIキーとデータは、プロジェクトごとに分かれる) ----
//   projDb.items[id] = { id, name, ownerUid, ownerName, createdAt, keys: { キーID: {id,type,label,value,active,createdAt,lastUsedAt} } }
//   pdata[プロジェクトID] = { キー名: { value, updatedAt, updatedBy } }
let projDb = { secret: "", items: {} };
try {
  Object.assign(projDb, JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8")));
} catch {}
let pdata = {};
try {
  pdata = JSON.parse(fs.readFileSync(PDATA_FILE, "utf8"));
} catch {
  pdata = {};
}

// ---- 保存 (Supabase があればそこへ、なければ DATA_DIR のファイルへ) ----
// 「data」(共有データ)・「keys」(APIキーのハッシュ)・「files」(画像・動画の情報)の3つを、それぞれ丸ごと保存する。
const PERSIST_NAMES = ["data", "keys", "files", "projects", "pdata"];
const PERSIST_FILES = { data: DATA_FILE, keys: KEYS_FILE, files: FILES_FILE, projects: PROJECTS_FILE, pdata: PDATA_FILE };
const snapshot = (name) => ({ data: store, keys, files, projects: projDb, pdata })[name];

function sbHeaders(extra = {}) {
  const h = { apikey: SUPABASE_KEY, ...extra };
  // 従来形式(JWT)のキーは Authorization にも付ける。新形式(sb_secret_...)は apikey だけでよい
  if (SUPABASE_KEY.startsWith("eyJ")) h.Authorization = `Bearer ${SUPABASE_KEY}`;
  return h;
}

function sb(pathAndQuery, opts = {}) {
  const { timeout = 30000, ...rest } = opts;
  return fetch(SUPABASE_URL + pathAndQuery, { ...rest, headers: sbHeaders(opts.headers), signal: AbortSignal.timeout(timeout) });
}

async function sbError(r, what) {
  const text = (await r.text().catch(() => "")).slice(0, 300);
  const e = new Error(`${what} (HTTP ${r.status}) ${text}`);
  e.status = r.status;
  e.body = text;
  return e;
}

async function sbUpsert(name, value) {
  const r = await sb("/rest/v1/kv?on_conflict=name", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ name, value, updated_at: new Date().toISOString() }]),
  });
  if (!r.ok) throw await sbError(r, `Supabase への保存に失敗 (${name})`);
}

async function sbLoad(name) {
  const r = await sb(`/rest/v1/kv?name=eq.${encodeURIComponent(name)}&select=value`);
  if (!r.ok) {
    const e = await sbError(r, `Supabase から読み込めません (${name})`);
    if (r.status === 404 || /PGRST205|does not exist|Could not find the table/i.test(e.body)) {
      throw new Error("Supabase に kv テーブルがありません。supabase-setup.sql を、Supabase の SQL Editor で実行してください");
    }
    if (r.status === 401 || r.status === 403) {
      throw new Error("Supabase のキー(SUPABASE_SERVICE_KEY)が正しくないようです。secret key をもう一度コピーしてください");
    }
    throw e;
  }
  const rows = await r.json();
  return rows[0] ? rows[0].value : null;
}

async function writeNamed(name) {
  if (USE_SUPABASE) return sbUpsert(name, snapshot(name));
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  await fs.promises.writeFile(PERSIST_FILES[name], JSON.stringify(snapshot(name), null, 2));
}

const dirty = new Set();
const inflight = {};
const saveTimers = {};

// 保存が終わるまで待つ。失敗したら、5秒後に自動でやり直す予約をして、エラーを投げる
async function flushOne(name) {
  while (inflight[name] || dirty.has(name)) {
    if (inflight[name]) {
      try { await inflight[name]; } catch {}
      continue;
    }
    dirty.delete(name);
    clearTimeout(saveTimers[name]);
    const p = (inflight[name] = writeNamed(name));
    try {
      await p;
    } catch (e) {
      console.error(`保存に失敗 (${name}):`, e.message);
      dirty.add(name);
      saveTimers[name] = setTimeout(() => flushOne(name).catch(() => {}), 5000);
      throw e;
    } finally {
      inflight[name] = null;
    }
  }
}

function persistLater(name, delay = 300) {
  dirty.add(name);
  clearTimeout(saveTimers[name]);
  saveTimers[name] = setTimeout(() => flushOne(name).catch(() => {}), delay);
}

async function flushAll() {
  await Promise.all(PERSIST_NAMES.map((n) => flushOne(n).catch(() => {})));
}

function scheduleSave() {
  persistLater("data");
}
function saveKeys() {
  persistLater("keys", 0);
}
function saveFiles() {
  persistLater("files", 0);
}

// 起動時: Supabase から保存済みのデータを読み込む (入れ物のバケットも、無ければ作る)
async function loadFromSupabase() {
  const r = await sb("/storage/v1/bucket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: SUPABASE_BUCKET, name: SUPABASE_BUCKET, public: false }),
  });
  if (!r.ok) {
    const e = await sbError(r, "Supabase の Storage(画像・動画の入れ物)を用意できません");
    if (r.status === 401 || r.status === 403) {
      throw new Error("Supabase のキーが正しくありません。SUPABASE_SERVICE_KEY に、Supabase の secret キー(service_role)を貼ったか確認してください");
    }
    if (!/already exists|Duplicate/i.test(e.body) && r.status !== 409) throw e;
  }
  for (const name of PERSIST_NAMES) {
    const v = await sbLoad(name);
    if (!v || typeof v !== "object") continue;
    if (name === "data") store = Object.assign(Object.create(null), v);
    else if (name === "keys") keys = v;
    else if (name === "files") files = v;
    else if (name === "projects") projDb = Object.assign({ secret: "", items: {} }, v);
    else pdata = v;
  }
}

async function sbPutObject(id, type, filePath) {
  const body = await fs.promises.readFile(filePath);
  const r = await sb(`/storage/v1/object/${SUPABASE_BUCKET}/${id}`, {
    method: "POST",
    headers: { "Content-Type": type, "Cache-Control": "max-age=31536000" },
    body,
    timeout: 180000,
  });
  if (r.ok) return;
  const e = await sbError(r, "Supabase Storage への保存に失敗");
  if (r.status === 413 || /exceeded the maximum allowed size|Payload too large/i.test(e.body)) {
    e.userMessage = "ファイルが大きすぎます (Supabaseの無料枠は1ファイル50MBまでです)";
    e.status = 413;
  } else if (/quota|storage limit|exceeded/i.test(e.body)) {
    e.userMessage = "保存容量がいっぱいです。古いファイルを削除してください";
    e.status = 507;
  }
  throw e;
}

async function removeObject(id) {
  if (!USE_SUPABASE) return fs.promises.unlink(path.join(UPLOAD_DIR, id)).catch(() => {});
  try {
    const r = await sb(`/storage/v1/object/${SUPABASE_BUCKET}/${id}`, { method: "DELETE" });
    if (!r.ok && r.status !== 404) console.error("Storage の削除に失敗:", r.status);
  } catch (e) {
    console.error("Storage の削除に失敗:", e.message);
  }
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// GAKU PAY の確認用URL (GAKU acct の埋め込みに使っているウェブアプリのURL)。
// 「?embed=1」などは付けない。別のURLを使うときは環境変数 GAKU_VERIFY_URL で上書きできる。
const GAKU_VERIFY_URL = (
  process.env.GAKU_VERIFY_URL ||
  "https://script.google.com/a/macros/school.kasugai.ed.jp/s/AKfycbyDnabgy3qc0L6Y4cfwW53tyzPMPS2thg1nd6mAvtIHa5YURK3Tui4c7vCUWt47sCow/exec"
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
  saveKeys(); // 呼び出した側が、保存の完了を待ってから、キーを本人に渡す
  return key;
}

// ---- 画像・動画ファイル (本体は uploads/ フォルダか Supabase Storage、情報は files.json か Supabase) ----
let files = {};
try {
  files = JSON.parse(fs.readFileSync(FILES_FILE, "utf8"));
} catch {
  files = {};
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
    "Access-Control-Allow-Methods": "GET, PUT, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-File-Name, X-Session",
  };
}

// 画像・動画を返すときの共通のヘッダー (安全のため、ブラウザに「種類を勝手に判断しない」「中のスクリプトは動かさない」と伝える)
function fileHeaders(meta) {
  return {
    "Content-Type": meta.type,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
  };
}

// Supabase Storage から取り出して、そのまま返す (入れ物は非公開のまま。Range もそのまま渡す)
async function serveFromSupabase(req, res, id, meta) {
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  let r;
  try {
    r = await sb(`/storage/v1/object/${SUPABASE_BUCKET}/${id}`, { headers, timeout: 60000 });
  } catch {
    res.writeHead(502).end("Bad Gateway");
    return;
  }
  const drop = async () => {
    try { await r.body.cancel(); } catch {}
  };
  if (r.status === 416) {
    await drop();
    res.writeHead(416, { ...fileHeaders(meta), "Content-Range": r.headers.get("content-range") || "bytes */*" }).end();
    return;
  }
  if (r.status !== 200 && r.status !== 206) {
    await drop();
    res.writeHead(r.status === 404 || r.status === 400 ? 404 : 502).end(r.status === 404 || r.status === 400 ? "Not Found" : "Bad Gateway");
    return;
  }
  const h = fileHeaders(meta);
  const len = r.headers.get("content-length");
  if (len) h["Content-Length"] = len;
  const range = r.headers.get("content-range");
  if (range) h["Content-Range"] = range;
  res.writeHead(r.status, h);
  if (req.method === "HEAD") {
    await drop();
    return res.end();
  }
  const stream = Readable.fromWeb(r.body);
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
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
  if (meta.pid) res.pid = meta.pid;
  if (USE_SUPABASE) {
    serveFromSupabase(req, res, id, meta).catch(() => {
      if (!res.headersSent) res.writeHead(502).end("Bad Gateway");
      else res.destroy();
    });
    return;
  }
  const filePath = path.join(UPLOAD_DIR, id);
  fs.stat(filePath, (err, st) => {
    if (err) {
      res.writeHead(404).end("Not Found");
      return;
    }
    const base = fileHeaders(meta);

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
async function handleUpload(req, res, ctx) {
  // ctx があるとき (プロジェクトのSecretキー) は、そのプロジェクトのファイルとして保存する
  let who;
  if (ctx) {
    who = { name: ctx.by, uid: ctx.uid };
  } else {
    who = identify(req);
    if (keyRequired && !who) return sendJson(res, 401, { error: "APIキーが正しくありません" });
  }

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

  if (USE_SUPABASE) {
    try {
      await sbPutObject(id, type, tmpPath);
    } catch (e) {
      fs.unlink(tmpPath, () => {});
      console.error(e.message);
      return sendJson(res, e.status === 413 || e.status === 507 ? e.status : 502, {
        error: e.userMessage || "保存先(Supabase)に保存できませんでした",
      });
    }
    fs.unlink(tmpPath, () => {}); // 作業用の一時ファイルは、もう要らない
  } else {
    fs.renameSync(tmpPath, path.join(UPLOAD_DIR, id));
  }

  const url = new URL(req.url, "http://localhost");
  files[id] = {
    name: cleanFileName(req.headers["x-file-name"] || url.searchParams.get("name")),
    type,
    size: received.size,
    by: who ? who.name : "api",
    uid: who ? who.uid || "" : "",
    createdAt: Date.now(),
  };
  if (ctx) files[id].pid = ctx.pid;
  saveFiles();
  try {
    await flushOne("files");
  } catch {
    delete files[id]; // 情報を保存できなかったので、取り消す
    await removeObject(id);
    return sendJson(res, 502, { error: "保存できませんでした。少し待ってから、もう一度お試しください" });
  }
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

  // プロジェクト用API (キーで認証)
  if (url.pathname.startsWith("/api/v1/") || url.pathname === "/api/v1") {
    return handleV1(req, res, url, url.pathname.slice("/api/v1".length).replace(/\/+$/, ""), null);
  }
  // 画面(コンソール)用API (ログインで認証)
  if (url.pathname === "/api/session" || url.pathname === "/api/status" || url.pathname === "/api/projects" || url.pathname.startsWith("/api/projects/")) {
    return handleConsole(req, res, url);
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
    const key = issueKey(who.uid, who.name);
    try {
      await flushOne("keys"); // 保存できてから、キーを渡す (保存前に落ちて、キーが無効になるのを防ぐ)
    } catch {
      return sendJson(res, 502, { error: "キーを保存できませんでした。少し待ってから、もう一度お試しください" });
    }
    return sendJson(res, 200, { key, name: who.name });
  }

  // 画像・動画: 一覧 / アップロード / 削除
  if (url.pathname === "/api/files") {
    if (req.method === "GET") return sendJson(res, 200, Object.keys(files).filter((i) => !files[i].pid).map(fileInfo));
    if (req.method === "POST" || req.method === "PUT") return handleUpload(req, res);
    return sendJson(res, 405, { error: "このメソッドは使えません" });
  }
  if (url.pathname.startsWith("/api/files/")) {
    const id = url.pathname.slice("/api/files/".length);
    if (!FILE_ID_RE.test(id) || !Object.hasOwn(files, id) || files[id].pid) return sendJson(res, 404, { error: "ファイルが存在しません" });
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
      await removeObject(id);
      await flushOne("files").catch(() => {}); // 失敗しても、自動でやり直される
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

// =====================================================================
// プロジェクト機能
// =====================================================================
const PROJECTS_PER_USER = 20;
const KEYS_PER_TYPE = 10;
const ENTRIES_PER_PROJECT = 1000;
const SESSION_DAYS = 7;
const PROJECT_ID_RE = /^[0-9a-f]{12}$/;

const keyIndex = new Map(); // sha256(キー) → { pid, kid }

function rebuildKeyIndex() {
  keyIndex.clear();
  for (const p of Object.values(projDb.items)) {
    for (const k of Object.values(p.keys || {})) keyIndex.set(sha256(k.value), { pid: p.id, kid: k.id });
  }
}

function initProjects() {
  if (!projDb.items || typeof projDb.items !== "object") projDb.items = {};
  if (!projDb.secret) {
    projDb.secret = crypto.randomBytes(32).toString("base64url"); // ログインの確認用の秘密 (これでログイン情報の改ざんを防ぐ)
    persistLater("projects", 0);
  }
  rebuildKeyIndex();
}

function makeKeyRec(type, label) {
  return {
    id: crypto.randomBytes(4).toString("hex"),
    type,
    label: String(label || "").trim().slice(0, 40),
    value: (type === "secret" ? "sk_" : "pk_") + crypto.randomBytes(24).toString("base64url"),
    active: true,
    createdAt: Date.now(),
    lastUsedAt: 0,
  };
}

function addKey(p, type, label) {
  const same = Object.values(p.keys).filter((k) => k.type === type);
  const rec = makeKeyRec(type, label || `${type === "secret" ? "Secret" : "Public"} キー ${same.length + 1}`);
  p.keys[rec.id] = rec;
  keyIndex.set(sha256(rec.value), { pid: p.id, kid: rec.id });
  return rec;
}

// データ用API: キーからプロジェクトを調べる。キーは X-API-Key か Authorization: Bearer。WebSocket だけは ?key= でも可
function projectAuth(req, url, allowQuery) {
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const token = String(req.headers["x-api-key"] || bearer || (allowQuery ? url.searchParams.get("key") : "") || "");
  const hit = token ? keyIndex.get(sha256(token)) : null;
  const p = hit && projDb.items[hit.pid];
  const k = p && p.keys[hit.kid];
  if (!k) return { status: 401, error: "APIキーが正しくありません" };
  if (!k.active) return { status: 401, error: "このキーは停止されています" };
  k.lastUsedAt = Date.now();
  return { p, k };
}

// ---- ログイン (確認コードで本人確認 → 7日間使える、改ざんできない合言葉を渡す) ----
function signSession(uid, name) {
  const body = Buffer.from(JSON.stringify({ uid, name, exp: Date.now() + SESSION_DAYS * 86400000 })).toString("base64url");
  const sig = crypto.createHmac("sha256", projDb.secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readSession(req) {
  const [body, sig] = String(req.headers["x-session"] || "").split(".");
  if (!body || !sig || !projDb.secret) return null;
  const want = crypto.createHmac("sha256", projDb.secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return d.exp > Date.now() && d.uid ? { uid: String(d.uid), name: String(d.name || d.uid) } : null;
  } catch {
    return null;
  }
}

// ---- 混み具合・利用状況の集計 (サーバーが起動してからの分。再起動でリセットされる) ----
class Meter {
  constructor() {
    this.min = new Map(); // 分 → { n, ms, err }
    this.hour = new Map(); // 時 → n
    this.lastAt = 0;
  }
  hit(ms, err) {
    const now = Date.now();
    const m = Math.floor(now / 60000);
    const h = Math.floor(now / 3600000);
    const e = this.min.get(m) || { n: 0, ms: 0, err: 0 };
    e.n++;
    e.ms += ms;
    if (err) e.err++;
    this.min.set(m, e);
    this.hour.set(h, (this.hour.get(h) || 0) + 1);
    this.lastAt = now;
    if (this.min.size > 70) for (const k of this.min.keys()) if (k < m - 65) this.min.delete(k);
    if (this.hour.size > 30) for (const k of this.hour.keys()) if (k < h - 25) this.hour.delete(k);
  }
  // 直近60分の、1分ごとのリクエスト数 (古い順)
  series() {
    const m = Math.floor(Date.now() / 60000);
    const out = [];
    for (let i = 59; i >= 0; i--) out.push((this.min.get(m - i) || { n: 0 }).n);
    return out;
  }
  lastMinute() {
    const sec = Date.now() / 1000;
    const m = Math.floor(sec / 60);
    // 直近60秒 = 今の分と前の分を、経過時間で按分
    const cur = (this.min.get(m) || { n: 0 }).n;
    const prev = (this.min.get(m - 1) || { n: 0 }).n;
    const frac = (sec % 60) / 60;
    return Math.round(cur + prev * (1 - frac));
  }
  recent(mins) {
    const m = Math.floor(Date.now() / 60000);
    let n = 0, ms = 0, err = 0;
    for (let i = 0; i < mins; i++) {
      const e = this.min.get(m - i);
      if (e) { n += e.n; ms += e.ms; err += e.err; }
    }
    return { n, avgMs: n ? Math.round(ms / n) : 0, err };
  }
  last24h() {
    const h = Math.floor(Date.now() / 3600000);
    let n = 0;
    for (let i = 0; i < 24; i++) n += this.hour.get(h - i) || 0;
    return n;
  }
}

const gMeter = new Meter();
const pMeters = new Map();
let activeReqs = 0;
const startedAt = Date.now();

function recordHit(pid, ms, err) {
  gMeter.hit(ms, err);
  if (pid) {
    if (!pMeters.has(pid)) pMeters.set(pid, new Meter());
    pMeters.get(pid).hit(ms, err);
  }
}

// 処理の遅れ (イベントループの遅延)。サーバーが忙しいほど大きくなる
let lagMs = 0;
let lagLast = Date.now();
setInterval(() => {
  const now = Date.now();
  lagMs = lagMs * 0.7 + Math.max(0, now - lagLast - 500) * 0.3;
  lagLast = now;
}, 500).unref();

function serverStatus() {
  const clients = wss.clients.size;
  const rpm = gMeter.lastMinute();
  const score = Math.min(
    100,
    Math.round(Math.min(60, lagMs * 0.5) + Math.min(30, rpm / 10) + Math.min(10, clients / 5) + Math.min(20, activeReqs * 4))
  );
  const level = score < 20 ? "quiet" : score < 45 ? "normal" : score < 70 ? "busy" : "heavy";
  const label = { quiet: "空いています", normal: "ふつう", busy: "やや混んでいます", heavy: "混み合っています" }[level];
  const r5 = gMeter.recent(5);
  const mem = process.memoryUsage();
  return {
    level,
    label,
    score,
    uptimeSec: Math.round(process.uptime()),
    startedAt,
    storage: USE_SUPABASE ? "supabase" : "local",
    clients,
    activeReqs,
    lagMs: Math.round(lagMs),
    reqLastMin: rpm,
    reqLastHour: gMeter.recent(60).n,
    req24h: gMeter.last24h(),
    series: gMeter.series(),
    avgMs: r5.avgMs,
    errors5m: r5.err,
    rssMB: Math.round(mem.rss / 1048576),
    heapMB: Math.round(mem.heapUsed / 1048576),
    projects: Object.keys(projDb.items).length,
    usedBytes: totalFileBytes(),
    limitBytes: Number.isFinite(MAX_TOTAL_BYTES) ? MAX_TOTAL_BYTES : null,
    maxFileBytes: Number.isFinite(MAX_FILE_BYTES) ? MAX_FILE_BYTES : null,
    time: Date.now(),
  };
}

function projectFiles(pid) {
  return Object.keys(files).filter((id) => files[id].pid === pid);
}

function projectStats(p) {
  const m = pMeters.get(p.id) || new Meter();
  const fids = projectFiles(p.id);
  const keysArr = Object.values(p.keys);
  return {
    dataCount: Object.keys(pdata[p.id] || {}).length,
    fileCount: fids.length,
    fileBytes: fids.reduce((n, id) => n + (files[id].size || 0), 0),
    reqLastMin: m.lastMinute(),
    reqLastHour: m.recent(60).n,
    req24h: m.last24h(),
    avgMs: m.recent(5).avgMs,
    series: m.series(),
    clients: projectClients(p.id),
    keysActive: keysArr.filter((k) => k.active).length,
    keysTotal: keysArr.length,
    lastAccessAt: m.lastAt || 0,
  };
}

function projectView(p, withStats) {
  const v = {
    id: p.id,
    name: p.name,
    ownerName: p.ownerName,
    createdAt: p.createdAt,
    keys: Object.values(p.keys).sort((a, b) => a.createdAt - b.createdAt),
  };
  if (withStats) v.stats = projectStats(p);
  return v;
}

function projectSummary(p) {
  const s = projectStats(p);
  return { id: p.id, name: p.name, createdAt: p.createdAt, dataCount: s.dataCount, fileCount: s.fileCount, keysActive: s.keysActive };
}

function pset(pid, key, value, by) {
  const d = pdata[pid] || (pdata[pid] = {});
  d[key] = { value, updatedAt: Date.now(), updatedBy: by };
  persistLater("pdata");
  pbroadcast(pid, { type: "update", key, entry: d[key] });
  return d[key];
}

function pdelete(pid, key, by) {
  const d = pdata[pid];
  if (!d || !Object.hasOwn(d, key)) return false;
  delete d[key];
  persistLater("pdata");
  pbroadcast(pid, { type: "delete", key, by });
  return true;
}

function decodeKeyName(raw) {
  let key;
  try {
    key = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return validKey(key) ? key : null;
}

const READ_ONLY_MSG = "公開用(Public)キーでは読み取りだけできます。書き込み・削除・アップロードには Secret キーを使ってください";

// ---- データ用API: /api/v1/... (キーで認証。Public は読み取り、Secret は読み書き) ----
// rest: ベースURLより後ろの部分 (例 "/data/memo")。expectPid: プロジェクト専用URL (/p/ID/...) のとき、そのID
async function handleV1(req, res, url, rest, expectPid) {
  const auth = projectAuth(req, url, false);
  if (auth.error) return sendJson(res, auth.status, { error: auth.error });
  const { p, k } = auth;
  if (expectPid && p.id !== expectPid) {
    return sendJson(res, 401, { error: "このキーは、このプロジェクトのものではありません" });
  }
  res.pid = p.id;
  const canWrite = k.type === "secret";

  if (rest === "" || rest === "/me") {
    return sendJson(res, 200, { project: { id: p.id, name: p.name }, keyType: k.type, canWrite });
  }

  if (rest === "/data") {
    if (req.method !== "GET") return sendJson(res, 405, { error: "このパスでは GET のみ使えます" });
    return sendJson(res, 200, pdata[p.id] || {});
  }

  if (rest.startsWith("/data/")) {
    const key = decodeKeyName(rest.slice("/data/".length));
    if (!key) return sendJson(res, 400, { error: "キーは1〜100文字で指定してください" });
    const d = pdata[p.id] || {};
    if (req.method === "GET") {
      return Object.hasOwn(d, key) ? sendJson(res, 200, d[key]) : sendJson(res, 404, { error: "キーが存在しません" });
    }
    if (!["PUT", "POST", "DELETE"].includes(req.method)) return sendJson(res, 405, { error: "このメソッドは使えません" });
    if (!canWrite) return sendJson(res, 403, { error: READ_ONLY_MSG });
    const by = k.label || "api";
    if (req.method === "DELETE") {
      return pdelete(p.id, key, by) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "キーが存在しません" });
    }
    try {
      const body = await readJsonBody(req);
      if (body === null || typeof body !== "object" || !("value" in body)) {
        return sendJson(res, 400, { error: 'ボディは {"value": ...} の形式で送ってください' });
      }
      if (!Object.hasOwn(d, key) && Object.keys(d).length >= ENTRIES_PER_PROJECT) {
        return sendJson(res, 507, { error: `1つのプロジェクトに保存できるデータは${ENTRIES_PER_PROJECT}件までです` });
      }
      return sendJson(res, 200, pset(p.id, key, body.value, by));
    } catch (e) {
      return e.message === "too_large"
        ? sendJson(res, 413, { error: "データが大きすぎます (上限64KB)" })
        : sendJson(res, 400, { error: "JSONの形式が不正です" });
    }
  }

  if (rest === "/files") {
    if (req.method === "GET") return sendJson(res, 200, projectFiles(p.id).map(fileInfo));
    if (req.method === "POST" || req.method === "PUT") {
      if (!canWrite) return sendJson(res, 403, { error: READ_ONLY_MSG });
      return handleUpload(req, res, { by: k.label || "api", uid: p.ownerUid, pid: p.id });
    }
    return sendJson(res, 405, { error: "このメソッドは使えません" });
  }

  if (rest.startsWith("/files/")) {
    const id = rest.slice("/files/".length);
    if (!FILE_ID_RE.test(id) || !Object.hasOwn(files, id) || files[id].pid !== p.id) {
      return sendJson(res, 404, { error: "ファイルが存在しません" });
    }
    if (req.method === "GET") return sendJson(res, 200, fileInfo(id));
    if (req.method === "DELETE") {
      if (!canWrite) return sendJson(res, 403, { error: READ_ONLY_MSG });
      await deleteProjectFile(id);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: "このメソッドは使えません" });
  }

  return sendJson(res, 404, { error: "見つかりません" });
}

async function deleteProjectFile(id) {
  delete files[id];
  saveFiles();
  await removeObject(id);
  await flushOne("files").catch(() => {}); // 失敗しても、自動でやり直される
}

// ---- 画面用API: /api/session, /api/status, /api/projects... (ログインで認証) ----
async function handleConsole(req, res, url) {
  const route = url.pathname;

  // ログイン: アカウントの確認コードを GAKU PAY で確かめて、合言葉(セッション)を渡す
  if (route === "/api/session") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "POST のみ使えます" });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "JSONの形式が不正です" });
    }
    if (!body || typeof body !== "object") return sendJson(res, 400, { error: "ユーザー情報と確認コードを送ってください" });
    let who;
    try {
      who = await verifyAccount(body.user && typeof body.user === "object" ? body.user : {}, String(body.code || ""));
    } catch (e) {
      return sendJson(res, 403, { error: e.message });
    }
    return sendJson(res, 200, { token: signSession(who.uid, who.name), uid: who.uid, name: who.name });
  }

  const me = readSession(req);
  if (!me) return sendJson(res, 401, { error: "ログインが必要です", code: "session" });

  const owned = (id) => {
    const p = PROJECT_ID_RE.test(id) ? projDb.items[id] : null;
    return p && p.ownerUid === me.uid ? p : null;
  };

  if (route === "/api/status") {
    if (req.method !== "GET") return sendJson(res, 405, { error: "GET のみ使えます" });
    const pid = url.searchParams.get("project");
    const p = pid ? owned(pid) : null;
    return sendJson(res, 200, { server: serverStatus(), project: p ? projectStats(p) : null });
  }

  if (route === "/api/projects") {
    if (req.method === "GET") {
      const mine = Object.values(projDb.items).filter((p) => p.ownerUid === me.uid).sort((a, b) => b.createdAt - a.createdAt);
      return sendJson(res, 200, mine.map(projectSummary));
    }
    if (req.method === "POST") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { error: "JSONの形式が不正です" });
      }
      const mineCount = Object.values(projDb.items).filter((p) => p.ownerUid === me.uid).length;
      if (mineCount >= PROJECTS_PER_USER) return sendJson(res, 507, { error: `作れるプロジェクトは${PROJECTS_PER_USER}個までです` });
      const name = String((body && body.name) || "").trim().slice(0, 50) || `${me.name}のプロジェクト`;
      const id = crypto.randomBytes(6).toString("hex");
      const p = { id, name, ownerUid: me.uid, ownerName: me.name, createdAt: Date.now(), keys: {} };
      addKey(p, "public", "Public キー 1");
      addKey(p, "secret", "Secret キー 1");
      projDb.items[id] = p;
      persistLater("projects", 0);
      try {
        await flushOne("projects"); // 保存できてから、キーを渡す
      } catch {
        delete projDb.items[id];
        rebuildKeyIndex();
        return sendJson(res, 502, { error: "保存できませんでした。少し待ってから、もう一度お試しください" });
      }
      return sendJson(res, 201, projectView(p, true));
    }
    return sendJson(res, 405, { error: "このメソッドは使えません" });
  }

  const m = /^\/api\/projects\/([^/]+)(?:\/(.*))?$/.exec(route);
  const p = m && owned(m[1]);
  if (!p) return sendJson(res, 404, { error: "プロジェクトが見つかりません" });
  const sub = (m[2] || "").replace(/\/+$/, "");

  if (sub === "") {
    if (req.method === "GET") return sendJson(res, 200, projectView(p, true));
    if (req.method === "PATCH") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { error: "JSONの形式が不正です" });
      }
      const name = String((body && body.name) || "").trim().slice(0, 50);
      if (!name) return sendJson(res, 400, { error: "プロジェクト名を入力してください" });
      p.name = name;
      persistLater("projects", 0);
      try { await flushOne("projects"); } catch { return sendJson(res, 502, { error: "保存できませんでした。もう一度お試しください" }); }
      return sendJson(res, 200, projectView(p, true));
    }
    return sendJson(res, 405, { error: "このメソッドは使えません" });
  }

  // APIキー: 新しく作る / 停止・再開
  if (sub === "keys") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "POST のみ使えます" });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "JSONの形式が不正です" });
    }
    const type = body && body.type;
    if (type !== "public" && type !== "secret") return sendJson(res, 400, { error: 'type は "public" か "secret" を指定してください' });
    if (Object.values(p.keys).filter((k) => k.type === type).length >= KEYS_PER_TYPE) {
      return sendJson(res, 507, { error: `${type === "secret" ? "Secret" : "Public"}キーは${KEYS_PER_TYPE}個までです。使わないキーは停止のままにしておけます` });
    }
    const rec = addKey(p, type, body.label);
    persistLater("projects", 0);
    try { await flushOne("projects"); } catch {
      delete p.keys[rec.id];
      rebuildKeyIndex();
      return sendJson(res, 502, { error: "保存できませんでした。もう一度お試しください" });
    }
    return sendJson(res, 201, rec);
  }
  const km = /^keys\/([0-9a-f]{8})$/.exec(sub);
  if (km) {
    const rec = p.keys[km[1]];
    if (!rec) return sendJson(res, 404, { error: "キーが見つかりません" });
    if (req.method !== "PATCH") return sendJson(res, 405, { error: "PATCH のみ使えます" });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "JSONの形式が不正です" });
    }
    if (!body || typeof body.active !== "boolean") return sendJson(res, 400, { error: '{"active": true または false} を送ってください' });
    const before = rec.active;
    rec.active = body.active;
    persistLater("projects", 0);
    try { await flushOne("projects"); } catch {
      rec.active = before;
      return sendJson(res, 502, { error: "保存できませんでした。もう一度お試しください" });
    }
    if (!rec.active) for (const c of wss.clients) if (c.pid === p.id && c.keyId === rec.id) c.close(4401, "key stopped"); // 停止したキーで接続中のものを切る
    return sendJson(res, 200, rec);
  }

  // サーバーデータ: 一覧 / 削除
  if (sub === "data") {
    if (req.method !== "GET") return sendJson(res, 405, { error: "GET のみ使えます" });
    return sendJson(res, 200, pdata[p.id] || {});
  }
  if (sub.startsWith("data/")) {
    const key = decodeKeyName(sub.slice(5));
    if (!key) return sendJson(res, 400, { error: "キーが不正です" });
    if (req.method !== "DELETE") return sendJson(res, 405, { error: "DELETE のみ使えます" });
    return pdelete(p.id, key, me.name) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "キーが存在しません" });
  }
  if (sub === "files") {
    if (req.method !== "GET") return sendJson(res, 405, { error: "GET のみ使えます" });
    return sendJson(res, 200, projectFiles(p.id).map(fileInfo).sort((a, b) => b.createdAt - a.createdAt));
  }
  if (sub.startsWith("files/")) {
    const id = sub.slice(6);
    if (!FILE_ID_RE.test(id) || !Object.hasOwn(files, id) || files[id].pid !== p.id) return sendJson(res, 404, { error: "ファイルが存在しません" });
    if (req.method !== "DELETE") return sendJson(res, 405, { error: "DELETE のみ使えます" });
    await deleteProjectFile(id);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: "見つかりません" });
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

  // 混み具合の集計 (APIの利用と画像・動画の配信だけを数える。画面の管理用の通信は数えない)
  const counted = /^\/(api\/(v1|data|files|keys)|files\/|p\/[0-9a-f]{12})/.test(url.pathname);
  if (counted) {
    const t0 = Date.now();
    activeReqs++;
    res.on("close", () => {
      activeReqs--;
      recordHit(res.pid, Date.now() - t0, res.statusCode >= 500);
    });
  }

  if (url.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      clients: wss.clients.size,
      keys: Object.keys(store).length,
      storage: USE_SUPABASE ? "supabase" : "local",
    });
  }

  if (url.pathname.startsWith("/files/")) {
    serveFile(req, res, url.pathname.slice("/files/".length));
    return;
  }

  // プロジェクト専用のURL: /p/プロジェクトID/data ... (中身は /api/v1 と同じ。そのプロジェクトのキーだけが使える)
  const pm = /^\/p\/([0-9a-f]{12})(\/.*)?$/.exec(url.pathname);
  if (pm) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      return res.end();
    }
    handleV1(req, res, url, (pm[2] || "").replace(/\/+$/, ""), pm[1]).catch((e) => {
      console.error("APIエラー:", e);
      if (!res.headersSent) sendJson(res, 500, { error: "サーバーエラー" });
    });
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
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
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

// 従来の共通チャンネル (キー無しで接続した人だけ)
function broadcast(msg, except) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (!client.pid && client !== except && client.readyState === WebSocket.OPEN) client.send(data);
  }
}

const legacyCount = () => [...wss.clients].filter((c) => !c.pid).length;
const projectClients = (pid) => [...wss.clients].filter((c) => c.pid === pid).length;

// プロジェクトのチャンネル (そのプロジェクトのキーで接続した人だけ)
function pbroadcast(pid, msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.pid === pid && client.readyState === WebSocket.OPEN) client.send(data);
  }
}

function broadcastPresence() {
  broadcast({ type: "presence", count: legacyCount() });
}

wss.on("connection", (ws, req) => {
  ws.id = `user-${nextId++}`;
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  // キー付きの接続 (?key=...) は、そのプロジェクトの更新だけを受け取る (読み取り専用)
  const wsUrl = new URL(req.url || "/", "http://localhost");
  if (wsUrl.searchParams.has("key")) {
    const a = projectAuth(req, wsUrl, true);
    const wm = /^\/p\/([0-9a-f]{12})\/?$/.exec(wsUrl.pathname);
    if (!a.error && wm && a.p.id !== wm[1]) {
      a.error = "このキーは、このプロジェクトのものではありません";
    }
    if (a.error) {
      send(ws, { type: "error", message: a.error });
      ws.close(4401, "unauthorized");
      return;
    }
    ws.pid = a.p.id;
    ws.keyId = a.k.id;
    send(ws, { type: "init", id: ws.id, data: pdata[ws.pid] || {}, count: projectClients(ws.pid) });
    pbroadcast(ws.pid, { type: "presence", count: projectClients(ws.pid) });
    ws.on("message", () => send(ws, { type: "error", message: "WebSocketは読み取り専用です。書き込みには REST API (Secretキー) を使ってください" }));
    ws.on("close", () => pbroadcast(ws.pid, { type: "presence", count: projectClients(ws.pid) }));
    return;
  }

  // 接続直後に現在の全データを送る
  send(ws, { type: "init", id: ws.id, data: store, count: legacyCount() });
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

// 停止の合図を受けたら、まだ保存していない分を保存してから終わる (最大8秒待つ)
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const limit = setTimeout(() => process.exit(1), 8000);
  await flushAll();
  clearTimeout(limit);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function start() {
  if (USE_SUPABASE) {
    try {
      await loadFromSupabase();
      console.log(`保存先: Supabase (データ ${Object.keys(store).length}件、画像・動画 ${Object.keys(files).length}件を読み込みました)`);
    } catch (e) {
      console.error("Supabase の準備に失敗しました:", e.message);
      process.exit(1);
    }
  } else {
    console.log(`保存先: このサーバーのファイル (${DATA_DIR})。無料のホスティングでは、再起動で消えることがあります`);
  }
  initProjects();
  server.listen(PORT, () => {
    console.log(`SerBANK 起動: http://localhost:${PORT}`);
    if (!keyRequired) console.log("注意: キー必須の設定がないため、REST APIの書き込みは誰でも可能です (API_KEY または REQUIRE_KEY=1 で制限)");
    if (ALLOW_UNVERIFIED) console.log("警告: ALLOW_UNVERIFIED=1 のため、本人確認なしでキーが発行されます。公開環境では使わないでください");
  });
}

if (require.main === module) start();

module.exports = { server, wss };

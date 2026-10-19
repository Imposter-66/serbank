"use strict";
// Supabase に保存するモードのテスト
// Supabase の代わりになる模擬サーバーを立て、「再起動しても、データ・キー・画像が残る」ことなどを確認する
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const SECRET = "sb_secret_testkey123";

// ---- 模擬 Supabase (REST と Storage の、使う部分だけ) ----
function startMock() {
  const state = { kv: new Map(), objects: new Map(), buckets: new Set(), tableMissing: false, sawAuthorization: false, badKeyRequests: 0, storageLimit: 100 * 1024 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const json = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.headers.authorization) state.sawAuthorization = true;
      if (req.headers.apikey !== SECRET) {
        state.badKeyRequests++;
        return json(401, { message: "Invalid API key" });
      }

      // バケット作成
      if (req.method === "POST" && url.pathname === "/storage/v1/bucket") {
        const id = JSON.parse(body).id;
        if (state.buckets.has(id)) return json(400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
        state.buckets.add(id);
        return json(200, { name: id });
      }

      // kv テーブル
      if (url.pathname === "/rest/v1/kv") {
        if (state.tableMissing) return json(404, { code: "PGRST205", message: "Could not find the table 'public.kv' in the schema cache" });
        if (req.method === "GET") {
          const name = (url.searchParams.get("name") || "").replace(/^eq\./, "");
          return json(200, state.kv.has(name) ? [{ value: state.kv.get(name) }] : []);
        }
        if (req.method === "POST") {
          for (const row of JSON.parse(body)) state.kv.set(row.name, JSON.parse(JSON.stringify(row.value)));
          res.writeHead(201);
          return res.end();
        }
      }

      // Storage のファイル
      const m = /^\/storage\/v1\/object\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const [, bucket, id] = m;
        if (!state.buckets.has(bucket)) return json(404, { statusCode: "404", error: "Bucket not found" });
        if (req.method === "POST") {
          if (body.length > state.storageLimit) {
            return json(413, { statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size" });
          }
          state.objects.set(id, { buf: body, type: req.headers["content-type"] });
          return json(200, { Key: `${bucket}/${id}` });
        }
        if (req.method === "DELETE") {
          state.objects.delete(id);
          return json(200, { message: "Successfully deleted" });
        }
        if (req.method === "GET") {
          const o = state.objects.get(id);
          if (!o) return json(400, { statusCode: "404", error: "not_found", message: "Object not found" });
          const total = o.buf.length;
          const rm = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
          if (rm) {
            const start = rm[1] === "" ? Math.max(0, total - Number(rm[2])) : Number(rm[1]);
            const end = rm[1] === "" || rm[2] === "" ? total - 1 : Math.min(total - 1, Number(rm[2]));
            if (start >= total || start > end) {
              res.writeHead(416, { "Content-Range": `bytes */${total}` });
              return res.end();
            }
            res.writeHead(206, { "Content-Type": o.type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${total}` });
            return res.end(o.buf.subarray(start, end + 1));
          }
          res.writeHead(200, { "Content-Type": o.type, "Content-Length": total });
          return res.end(o.buf);
        }
      }
      json(404, { message: "not found" });
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, state, url: `http://localhost:${server.address().port}` })));
}

// ---- SerBANK サーバーの起動・停止 ----
function startServer(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serbank-sb-"));
  const port = 4200 + Math.floor(Math.random() * 500);
  const child = spawn("node", [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, dir, base: `http://localhost:${port}`, exited, out: () => output };
}

async function ready(s) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${s.base}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("サーバーが起動しませんでした\n" + s.out());
}

const stop = async (s) => {
  s.child.kill("SIGTERM");
  return s.exited;
};

const PNG = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 5)]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mock = await startMock();
  const baseEnv = { SUPABASE_URL: mock.url, SUPABASE_SERVICE_KEY: SECRET, REQUIRE_KEY: "1", ALLOW_UNVERIFIED: "1" };

  // ================= 1) 1回目の起動: 保存する =================
  const a = startServer(baseEnv);
  let key, fileId;
  const png = PNG(20000);
  try {
    await ready(a);
    const health = await (await fetch(`${a.base}/health`)).json();
    assert.strictEqual(health.storage, "supabase");
    assert.ok(mock.state.buckets.has("uploads"));
    console.log("OK: Supabase モードで起動し、画像・動画の入れ物(バケット)が自動で作られた");

    key = (await (await fetch(`${a.base}/api/keys`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user: { id: "t", name: "太郎" }, code: "" }) })).json()).key;
    assert.ok(key.startsWith("sb_"));
    const keysRow = JSON.stringify(mock.state.kv.get("keys"));
    assert.ok(keysRow && !keysRow.includes(key));
    console.log("OK: APIキーは、発行の応答より前に Supabase へ保存された(キー本体ではなくハッシュのみ)");

    const auth = { "X-API-Key": key };
    let r = await fetch(`${a.base}/api/data/memo`, { method: "PUT", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify({ value: "こんにちは" }) });
    assert.strictEqual(r.status, 200);
    await sleep(700);
    assert.strictEqual(mock.state.kv.get("data").memo.value, "こんにちは");
    console.log("OK: 共有データが Supabase に保存された");

    r = await fetch(`${a.base}/api/files`, { method: "POST", headers: { "X-File-Name": encodeURIComponent("ねこ.png"), ...auth }, body: png });
    assert.strictEqual(r.status, 201);
    const up = await r.json();
    fileId = up.id;
    assert.ok(mock.state.objects.has(fileId));
    assert.ok(mock.state.kv.get("files")[fileId]);
    const leftovers = fs.existsSync(path.join(a.dir, "uploads")) ? fs.readdirSync(path.join(a.dir, "uploads")) : [];
    assert.deepStrictEqual(leftovers, []);
    console.log("OK: 画像が Supabase Storage に保存され、サーバー側に一時ファイルが残らない");

    r = await fetch(a.base + up.url);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get("content-type"), "image/png");
    assert.strictEqual(r.headers.get("x-content-type-options"), "nosniff");
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(png));
    r = await fetch(a.base + up.url, { headers: { Range: "bytes=0-3" } });
    assert.strictEqual(r.status, 206);
    assert.strictEqual(r.headers.get("content-range"), `bytes 0-3/${png.length}`);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(png.subarray(0, 4)));
    r = await fetch(a.base + up.url, { headers: { Range: "bytes=999999-" } });
    assert.strictEqual(r.status, 416);
    console.log("OK: Supabase から取り出して配信でき、途中からの再生(Range)にも対応している");

    r = await fetch(`${a.base}/api/files`, { method: "POST", headers: auth, body: PNG(200 * 1024) });
    assert.strictEqual(r.status, 413);
    assert.ok((await r.json()).error.includes("50MB"));
    assert.strictEqual(Object.keys(mock.state.kv.get("files")).length, 1);
    console.log("OK: Supabase の上限を超えるファイルは413で断られ、分かりやすい説明が出る(記録も残らない)");

    assert.strictEqual(mock.state.sawAuthorization, false);
    assert.strictEqual(mock.state.badKeyRequests, 0);
    console.log("OK: 新形式のキー(sb_secret_...)は apikey だけで送られている");

    // 保存の待ち時間(0.3秒)より前に止めても、停止の合図で保存し切る
    await fetch(`${a.base}/api/data/last`, { method: "PUT", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify({ value: "止める直前" }) });
  } finally {
    const code = await stop(a);
    assert.strictEqual(code, 0);
  }
  assert.strictEqual(mock.state.kv.get("data").last.value, "止める直前");
  console.log("OK: 停止の合図を受けたとき、保存前の分も保存してから終了した");

  // ================= 2) 2回目の起動: 空のサーバーで再起動しても残っている =================
  const b = startServer(baseEnv);
  try {
    await ready(b);
    assert.deepStrictEqual(fs.readdirSync(b.dir), []); // サーバー側には何も無い新品の状態
    let r = await fetch(`${b.base}/api/data/memo`);
    assert.strictEqual((await r.json()).value, "こんにちは");
    console.log("OK: 再起動(サーバー側は空)しても、共有データが残っている");

    r = await fetch(`${b.base}/api/data/memo`, { method: "PUT", headers: { "Content-Type": "application/json", "X-API-Key": key }, body: JSON.stringify({ value: "更新" }) });
    assert.strictEqual(r.status, 200);
    console.log("OK: 再起動前に発行したAPIキーが、そのまま使える");

    r = await fetch(`${b.base}/files/${fileId}`);
    assert.strictEqual(r.status, 200);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(png));
    const list = await (await fetch(`${b.base}/api/files`)).json();
    assert.ok(list.some((f) => f.id === fileId && f.name === "ねこ.png"));
    console.log("OK: 再起動しても、画像が配信でき、一覧にも残っている");

    r = await fetch(`${b.base}/api/files/${fileId}`, { method: "DELETE", headers: { "X-API-Key": key } });
    assert.strictEqual(r.status, 200);
    assert.ok(!mock.state.objects.has(fileId));
    assert.ok(!mock.state.kv.get("files")[fileId]);
    assert.strictEqual((await fetch(`${b.base}/files/${fileId}`)).status, 404);
    console.log("OK: 削除すると、Supabase の画像と記録の両方が消える");
  } finally {
    await stop(b);
  }

  // ================= 3) 準備ができていないときは、原因のわかるメッセージで止まる =================
  mock.state.tableMissing = true;
  const c = startServer(baseEnv);
  const codeC = await c.exited;
  assert.strictEqual(codeC, 1);
  assert.ok(c.out().includes("kv テーブルがありません"), c.out());
  mock.state.tableMissing = false;
  console.log("OK: kv テーブルが無いときは、SQLを実行するよう案内して止まる");

  const d = startServer({ ...baseEnv, SUPABASE_SERVICE_KEY: "sb_secret_wrong" });
  const codeD = await d.exited;
  assert.strictEqual(codeD, 1);
  assert.ok(d.out().includes("キー"), d.out());
  console.log("OK: キーが違うときは、キーを確認するよう案内して止まる");

  mock.server.close();
  console.log("Supabase 保存のテストに成功しました");
  process.exit(0);
})().catch((e) => {
  console.error("テスト失敗:", e.message);
  process.exit(1);
});

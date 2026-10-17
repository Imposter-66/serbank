"use strict";
// 画像・動画の保存・配信のテスト
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

function startServer(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serbank-"));
  const port = 3700 + Math.floor(Math.random() * 500);
  const child = spawn("node", [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, ...env },
    stdio: "ignore",
  });
  return { child, dir, port, base: `http://localhost:${port}` };
}

async function ready(base) {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("サーバーが起動しませんでした");
}

// 見かけだけ本物の画像・動画 (先頭の数バイトが種類を決める)
const PNG = (n = 64) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 7)]);
const MP4 = (n = 64) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(n, 9)]);

const upload = (base, body, headers = {}) =>
  fetch(`${base}/api/files`, { method: "POST", headers: { "X-File-Name": encodeURIComponent("写真 1.png"), ...headers }, body });

const getKey = async (base, id, name) =>
  (await (await fetch(`${base}/api/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: { id, name }, code: "" }),
  })).json()).key;

(async () => {
  const s = startServer({ REQUIRE_KEY: "1", ALLOW_UNVERIFIED: "1", MAX_FILE_MB: "1", MAX_TOTAL_MB: "2" });
  try {
    await ready(s.base);

    // キー必須のとき、キーなしは断られる
    assert.strictEqual((await upload(s.base, PNG())).status, 401);
    console.log("OK: キーなしのアップロードは401");

    const taro = await getKey(s.base, "t", "太郎");
    const hanako = await getKey(s.base, "h", "花子");
    const auth = { "X-API-Key": taro };

    // 画像を保存して取り出す
    const png = PNG(200);
    let r = await upload(s.base, png, auth);
    assert.strictEqual(r.status, 201);
    const img = await r.json();
    assert.strictEqual(img.type, "image/png");
    assert.strictEqual(img.name, "写真 1.png");
    assert.strictEqual(img.by, "太郎");
    assert.match(img.url, /^\/files\/[A-Za-z0-9_-]{16}$/);
    console.log("OK: 画像を保存でき、日本語のファイル名も保たれた");

    r = await fetch(s.base + img.url);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get("content-type"), "image/png");
    assert.strictEqual(r.headers.get("x-content-type-options"), "nosniff");
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(png));
    console.log("OK: 保存した画像がそのまま取り出せた(安全のためのヘッダー付き)");

    // 動画の途中再生 (Range)
    const mp4 = MP4(500);
    const vid = await (await upload(s.base, mp4, auth)).json();
    assert.strictEqual(vid.type, "video/mp4");
    r = await fetch(s.base + vid.url, { headers: { Range: "bytes=0-3" } });
    assert.strictEqual(r.status, 206);
    assert.strictEqual(r.headers.get("content-range"), `bytes 0-3/${mp4.length}`);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(mp4.subarray(0, 4)));
    r = await fetch(s.base + vid.url, { headers: { Range: "bytes=-10" } });
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(mp4.subarray(mp4.length - 10)));
    r = await fetch(s.base + vid.url, { headers: { Range: "bytes=99999-" } });
    assert.strictEqual(r.status, 416);
    console.log("OK: 動画を保存でき、途中からの再生(Range)に対応している");

    // 危険・非対応のファイルは断る (名乗る種類は信用しない)
    r = await upload(s.base, Buffer.from("<html><script>alert(1)</script></html>"), { ...auth, "Content-Type": "image/png" });
    assert.strictEqual(r.status, 415);
    r = await upload(s.base, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), { ...auth, "Content-Type": "image/svg+xml" });
    assert.strictEqual(r.status, 415);
    r = await upload(s.base, Buffer.alloc(0), auth);
    assert.strictEqual(r.status, 415);
    console.log("OK: HTML・SVG・空ファイルは画像のふりをしても415で断られた");

    // 1ファイルの上限 (1MB)
    r = await upload(s.base, PNG(1.5 * 1024 * 1024), auth);
    assert.strictEqual(r.status, 413);
    console.log("OK: 上限を超える大きなファイルは413で断られた");

    // content-length なし(分割送信)でも上限を超えたら止まり、ゴミが残らない
    await new Promise((resolve) => {
      const req = http.request(
        { port: s.port, method: "POST", path: "/api/files", headers: { "X-API-Key": taro, "Transfer-Encoding": "chunked" } },
        (res) => { res.resume(); res.on("end", resolve); }
      );
      req.on("error", resolve);
      req.write(PNG(10));
      const chunk = Buffer.alloc(256 * 1024, 1);
      for (let i = 0; i < 6; i++) req.write(chunk);
      req.end();
    });
    await new Promise((r2) => setTimeout(r2, 300));
    const leftovers = fs.readdirSync(path.join(s.dir, "uploads")).filter((f) => f.endsWith(".part"));
    assert.deepStrictEqual(leftovers, []);
    console.log("OK: 分割送信で上限を超えても途中で止まり、作りかけのファイルは残らない");

    // 合計容量の上限 (2MB): 既に約0.0007MB。0.9MBを2つ入れると3つ目で超える
    const big = PNG(900 * 1024);
    assert.strictEqual((await upload(s.base, big, auth)).status, 201);
    assert.strictEqual((await upload(s.base, big, auth)).status, 201);
    assert.strictEqual((await upload(s.base, big, auth)).status, 507);
    console.log("OK: 保存できる合計容量を超えると507で断られた");

    // 一覧
    const list = await (await fetch(`${s.base}/api/files`)).json();
    assert.ok(list.some((f) => f.id === img.id) && list.some((f) => f.id === vid.id));
    console.log("OK: 一覧にアップロードしたファイルが出る");

    // 不正なID
    for (const p of ["/files/../../etc/passwd", "/files/..%2f..%2fserver.js", "/files/short", "/files/" + "A".repeat(16)]) {
      r = await fetch(s.base + p);
      assert.strictEqual(r.status, 404, p);
    }
    console.log("OK: 不正なIDや存在しないIDは404");

    // 削除: 他人はできない。本人はできる
    r = await fetch(`${s.base}/api/files/${img.id}`, { method: "DELETE", headers: { "X-API-Key": hanako } });
    assert.strictEqual(r.status, 403);
    r = await fetch(`${s.base}/api/files/${img.id}`, { method: "DELETE" });
    assert.strictEqual(r.status, 401);
    r = await fetch(`${s.base}/api/files/${img.id}`, { method: "DELETE", headers: auth });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await fetch(s.base + img.url)).status, 404);
    console.log("OK: 他人は削除できず、本人は削除できる(削除後は404)");
  } finally {
    s.child.kill();
  }

  console.log("画像・動画のテストに成功しました");
  process.exit(0);
})().catch((e) => {
  console.error("テスト失敗:", e.message);
  process.exit(1);
});

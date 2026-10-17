"use strict";
// APIキーの発行・認証のテスト (別プロセスでサーバーを起動して確認する)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

function startServer(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serbank-"));
  const port = 3200 + Math.floor(Math.random() * 500);
  const child = spawn("node", [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, ...env },
    stdio: "ignore",
  });
  return { child, dir, base: `http://localhost:${port}` };
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

const put = (base, key, headers = {}) =>
  fetch(`${base}/api/data/${key}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ value: 1 }),
  });

const issue = (base, user) =>
  fetch(`${base}/api/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, code: "dummy" }),
  });

(async () => {
  // 1) 本人確認の仕組みが未設定のとき: キーは発行されない (安全側に倒れる)
  let s = startServer({ REQUIRE_KEY: "1" });
  try {
    await ready(s.base);
    const r = await issue(s.base, { id: "u1", name: "太郎" });
    assert.strictEqual(r.status, 403);
    console.log("OK: 本人確認が未設定ならキーは発行されない(403)");
    assert.strictEqual((await put(s.base, "a")).status, 401);
    console.log("OK: キー必須のとき、キーなしの書き込みは401");
  } finally {
    s.child.kill();
  }

  // 2) 動作確認モード: 発行 → 書き込み → 再発行で旧キー無効
  s = startServer({ REQUIRE_KEY: "1", ALLOW_UNVERIFIED: "1" });
  try {
    await ready(s.base);
    const r1 = await issue(s.base, { id: "u1", name: "太郎" });
    assert.strictEqual(r1.status, 200);
    const { key: key1 } = await r1.json();
    assert.ok(key1.startsWith("sb_"));
    console.log("OK: キーが発行された");

    const w = await put(s.base, "a", { "X-API-Key": key1 });
    assert.strictEqual(w.status, 200);
    assert.strictEqual((await w.json()).updatedBy, "太郎");
    console.log("OK: 発行したキーで書き込め、更新者が記録された");

    const keysJson = fs.readFileSync(path.join(s.dir, "keys.json"), "utf8");
    assert.ok(!keysJson.includes(key1));
    console.log("OK: キーそのものは保存されていない(ハッシュのみ)");

    const { key: key2 } = await (await issue(s.base, { id: "u1", name: "太郎" })).json();
    assert.notStrictEqual(key1, key2);
    assert.strictEqual((await put(s.base, "a", { "X-API-Key": key1 })).status, 401);
    assert.strictEqual((await put(s.base, "a", { Authorization: `Bearer ${key2}` })).status, 200);
    console.log("OK: 再発行で旧キーが無効になり、新キーは使える");

    assert.strictEqual((await issue(s.base, {})).status, 403);
    console.log("OK: ユーザー情報が空なら発行されない");
  } finally {
    s.child.kill();
  }

  console.log("キー関連のテストに成功しました");
  process.exit(0);
})().catch((e) => {
  console.error("テスト失敗:", e.message);
  process.exit(1);
});

"use strict";
// APIキーの発行・本人確認のテスト
// GAKU PAY の「?verify=確認コード」を真似たダミーのサーバーを立てて、実際の確認の流れを試す
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const CODE = (ch) => ch.repeat(64); // 確認コードは64桁の16進数
const EXPIRED = "期限が切れているか、すでに使われています。";

// ダミーの GAKU PAY: 有効なコードは1回だけ使える
function startMockGaku() {
  const codes = {
    [CODE("a")]: { ok: true, cls: "6年1組", no: 3, name: "太郎", company: "", active: true },
    [CODE("e")]: { ok: true, cls: "6年1組", no: 5, name: "花子", company: "", active: true },
    [CODE("f")]: { ok: true, cls: "6年1組", no: 3, name: "太郎", company: "", active: true },
    [CODE("c")]: { ok: true, cls: "6年1組", no: 9, name: "停止中", company: "", active: false },
  };
  const server = http.createServer((req, res) => {
    const code = new URL(req.url, "http://x").searchParams.get("verify");
    if (code === CODE("d")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end("<html>Googleのログイン画面</html>"); // 公開設定が違うとこうなる
    }
    const hit = codes[code];
    delete codes[code];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(hit || { ok: false, message: "確認コードの" + EXPIRED }));
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, url: `http://localhost:${server.address().port}/exec` })));
}

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

const issue = (base, code, user = {}) =>
  fetch(`${base}/api/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, code }),
  });

(async () => {
  const mock = await startMockGaku();

  // ---- 本番と同じ本人確認 (ダミーのGAKU PAYに問い合わせる) ----
  let s = startServer({ REQUIRE_KEY: "1", GAKU_VERIFY_URL: mock.url });
  try {
    await ready(s.base);

    let r = await issue(s.base, "");
    assert.strictEqual(r.status, 403);
    console.log("OK: 確認コードがなければ発行されない(403)");

    r = await issue(s.base, "not-a-code");
    assert.strictEqual(r.status, 403);
    console.log("OK: 形式が違う確認コードは問い合わせる前に断られる(403)");

    assert.strictEqual((await put(s.base, "a")).status, 401);
    console.log("OK: キー必須のとき、キーなしの書き込みは401");

    r = await issue(s.base, CODE("a"), { name: "なりすまし", id: "teacher" });
    assert.strictEqual(r.status, 200);
    const first = await r.json();
    assert.strictEqual(first.name, "太郎");
    assert.ok(first.key.startsWith("sb_"));
    console.log("OK: 本物の確認コードでキーが発行され、名前はGAKU PAYの結果が使われた(送られたユーザー情報は無視)");

    r = await issue(s.base, CODE("a"));
    assert.strictEqual(r.status, 403);
    assert.ok((await r.json()).error.includes("すでに使われています"));
    console.log("OK: 同じ確認コードは2回使えない");

    r = await issue(s.base, CODE("c"));
    assert.strictEqual(r.status, 403);
    console.log("OK: 停止中のアカウントには発行されない");

    r = await issue(s.base, CODE("d"));
    assert.strictEqual(r.status, 403);
    assert.ok((await r.json()).error.includes("公開設定"));
    console.log("OK: GAKU PAYの公開設定が違う場合は、原因のわかるメッセージが出る");

    const w = await put(s.base, "a", { "X-API-Key": first.key });
    assert.strictEqual(w.status, 200);
    assert.strictEqual((await w.json()).updatedBy, "太郎");
    console.log("OK: 発行したキーで書き込め、更新者に名前が記録された");

    const keysJson = fs.readFileSync(path.join(s.dir, "keys.json"), "utf8");
    assert.ok(!keysJson.includes(first.key));
    console.log("OK: キーそのものは保存されていない(ハッシュのみ)");

    const hanako = await (await issue(s.base, CODE("e"))).json();
    assert.strictEqual(hanako.name, "花子");
    assert.strictEqual((await put(s.base, "b", { "X-API-Key": hanako.key })).status, 200);
    assert.strictEqual((await put(s.base, "b", { "X-API-Key": first.key })).status, 200);
    console.log("OK: 別の人のキーは別々に使える");

    const second = await (await issue(s.base, CODE("f"))).json();
    assert.strictEqual((await put(s.base, "a", { "X-API-Key": first.key })).status, 401);
    assert.strictEqual((await put(s.base, "a", { Authorization: `Bearer ${second.key}` })).status, 200);
    assert.strictEqual((await put(s.base, "b", { "X-API-Key": hanako.key })).status, 200);
    console.log("OK: 再発行すると同じ人の古いキーだけが無効になる");
  } finally {
    s.child.kill();
  }

  // ---- 動作確認モード (本人確認なし) ----
  s = startServer({ REQUIRE_KEY: "1", ALLOW_UNVERIFIED: "1" });
  try {
    await ready(s.base);
    assert.strictEqual((await issue(s.base, "", { id: "u1", name: "太郎" })).status, 200);
    assert.strictEqual((await issue(s.base, "", {})).status, 403);
    console.log("OK: ALLOW_UNVERIFIED の動作確認モードで発行できる(ユーザー情報が空なら403)");
  } finally {
    s.child.kill();
  }

  mock.server.close();
  console.log("キー関連のテストに成功しました");
  process.exit(0);
})().catch((e) => {
  console.error("テスト失敗:", e.message);
  process.exit(1);
});

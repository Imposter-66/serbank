# SerBANK

データをリアルタイムに共有するサーバーです。ブラウザの画面、REST API、WebSocket のどれから書き込んでも、接続中の全員に即座に反映されます。

## 起動

```
npm install
npm start          # http://localhost:3000
```

| 環境変数 | 意味 |
| --- | --- |
| `PORT` | 待ち受けポート (既定 3000) |
| `API_KEY` | 設定すると REST API の書き込み(PUT/POST/DELETE)にキーが必要になる |
| `REQUIRE_KEY` | `1` にすると、`API_KEY` が無くても書き込みに発行済みキーを必須にする |
| `DATA_DIR` | `data.json` と `keys.json` の保存先 (永続ディスクのパスを指定) |
| `ALLOW_UNVERIFIED` | `1` の間だけ、本人確認なしでキーを発行する。**動作確認専用。公開環境では使わない** |
| `CORS_ORIGIN` | API を呼んでよいサイト。例 `https://example.com` (既定 `*` = どのサイトでも可) |

データは `data.json` に保存されます。

## REST API

データは `キー → { value, updatedAt, updatedBy }` の形で保存されます。`value` には JSON で表せるものなら何でも入れられます。

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/api/data` | 全データを取得 |
| GET | `/api/data/:key` | 1件取得 (なければ 404) |
| PUT / POST | `/api/data/:key` | 書き込み。ボディは `{"value": ...}` |
| DELETE | `/api/data/:key` | 削除 (なければ 404) |
| GET | `/health` | 稼働状況 |

`API_KEY` を設定した場合、書き込みには `X-API-Key: <キー>` または `Authorization: Bearer <キー>` が必要です。読み取りは誰でも可能です。

```
curl -X PUT https://あなたのサイト/api/data/memo \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <キー>" \
  -d '{"value": "こんにちは"}'
```

## アカウントとAPIキーの発行

画面に GAKU acct が埋め込まれています。ログインすると「APIキーを発行する」ボタンが出て、ユーザー別のキー (`sb_...`) を取得できます。

- `POST /api/keys` に `{"user": {...}, "code": "確認コード"}` を送るとキーが返ります。
- キーは `X-API-Key` または `Authorization: Bearer` で使います。書き込んだ人の名前が `updatedBy` に記録されます。
- 再発行すると、そのユーザーの古いキーは無効になります。
- サーバーにはキーのハッシュだけを保存します。
- **本人確認は `server.js` の `verifyAccount()` に実装が必要です。** ブラウザから届く情報はなりすませるため、GAKU acct の確認コードをサーバー側で検証してからキーを発行します。未実装のうちは、キーは発行されません。

## 他のサイトから使う

### fetch で読み書き

```js
const BASE = "https://あなたのサイト";

// 読む
const entry = await (await fetch(`${BASE}/api/data/memo`)).json();
console.log(entry.value);

// 書く
await fetch(`${BASE}/api/data/memo`, {
  method: "PUT",
  headers: { "Content-Type": "application/json", "X-API-Key": "<キー>" },
  body: JSON.stringify({ value: "こんにちは" }),
});
```

> ブラウザ上のコードに API キーを書くと、サイトを見た人に丸見えになります。キーが必要な書き込みは、自分のサーバー側から呼ぶようにしてください。

### WebSocket でリアルタイムに受け取る

```js
const ws = new WebSocket("wss://あなたのサイト");

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "init") console.log("最初の全データ", msg.data);
  if (msg.type === "update") console.log("更新", msg.key, msg.entry.value);
  if (msg.type === "delete") console.log("削除", msg.key);
  if (msg.type === "presence") console.log("接続中の人数", msg.count);
};

// 書き込み・削除
ws.send(JSON.stringify({ type: "set", key: "memo", value: "こんにちは" }));
ws.send(JSON.stringify({ type: "delete", key: "memo" }));
```

## 注意

- `API_KEY` で守られるのは REST API の書き込みだけです。WebSocket からの書き込みと、付属の画面からの書き込みは認証なしで通ります。インターネットに公開するときは、ログイン機能など認証の追加を検討してください。
- ホスティング先によっては、再起動で `data.json` が消えます。永続ディスクかデータベースが必要です。

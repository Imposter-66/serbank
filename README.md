# SerBANK

データ・画像・動画をリアルタイムに共有するサーバーです。ブラウザの画面、REST API、WebSocket のどれから書き込んでも、接続中の全員に即座に反映されます。

## 起動

```
npm install
npm start          # http://localhost:3000
```

## 環境変数 (Renderでは「Environment」で設定)

| 名前 | 意味 |
| --- | --- |
| `REQUIRE_KEY` | `1` にすると、書き込み・アップロードに APIキーが必須になる(**公開するなら推奨**) |
| `API_KEY` | 管理者用のキー。設定すると、書き込みにキーが必須になり、このキーは全ファイルを削除できる |
| `DATA_DIR` | `data.json`・`keys.json`・`files.json`・`uploads/` の保存先 (永続ディスクのパス) |
| `MAX_FILE_MB` | 画像・動画1つの上限。既定は制限なし。設定したときだけ制限される |
| `MAX_TOTAL_MB` | 画像・動画の保存できる合計。既定は制限なし。設定したときだけ制限される |
| `CORS_ORIGIN` | APIを呼んでよいサイト。例 `https://example.com` (既定 `*` = どのサイトでも可) |
| `GAKU_VERIFY_URL` | GAKU PAY のウェブアプリURL。既定でコードに入っているので、変えるとき以外は不要 |
| `ALLOW_UNVERIFIED` | `1` の間だけ、本人確認なしでキーを発行する。**動作確認専用。公開環境では使わない** |
| `PORT` | 待ち受けポート (既定 3000。Renderでは自動) |

## アカウントとAPIキー

画面に GAKU acct が埋め込まれています。ログインして「APIキーを発行する」を押すと、あなた専用のキー(`sb_...`)が表示されます。

- 発行のたびに、サーバーが GAKU PAY に「この確認コードは本物か」を問い合わせます(`ウェブアプリのURL?verify=確認コード`)。名前・クラス・出席番号は、GAKU PAY が返した内容だけを信用します。
- 確認コードは5分間・1回だけ有効です。ボタンを押すたびに新しいコードを取得します。
- キーを再発行すると、同じ人の古いキーは使えなくなります。
- サーバーにはキーのハッシュだけを保存します。キーそのものは、発行した瞬間にしか表示されません。
- キーで書き込むと、データの更新者(`updatedBy`)にあなたの名前が記録されます。
- GAKU PAY のウェブアプリは、サーバー(Render)からも確認できるよう、アクセスできるユーザーを「全員」にして公開する必要があります。

## APIキーの使い方

書き込み・アップロード・削除のときに、次のどちらかの形でキーを送ります。読み取り(GET)にはキーは要りません。

```
X-API-Key: sb_xxxxxxxx
Authorization: Bearer sb_xxxxxxxx
```

### curl で試す

```
# 書き込む
curl -X PUT https://あなたのサイト/api/data/memo \
  -H "Content-Type: application/json" \
  -H "X-API-Key: sb_xxxxxxxx" \
  -d '{"value": "こんにちは"}'

# 読む
curl https://あなたのサイト/api/data/memo
```

### JavaScript (fetch) で使う

```js
const BASE = "https://あなたのサイト";
const KEY = "sb_xxxxxxxx";

// 書く
await fetch(`${BASE}/api/data/memo`, {
  method: "PUT",
  headers: { "Content-Type": "application/json", "X-API-Key": KEY },
  body: JSON.stringify({ value: "こんにちは" }),
});

// 読む
const entry = await (await fetch(`${BASE}/api/data/memo`)).json();
console.log(entry.value);
```

> キーは自分だけのパスワードです。他人に見せたり、公開するサイトのコードに直接書いたりしないでください。

## REST API 一覧

データは `キー → { value, updatedAt, updatedBy }` の形で保存されます。`value` には JSON で表せるものなら何でも入れられます。

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/api/data` | 全データを取得 |
| GET | `/api/data/:key` | 1件取得 (なければ 404) |
| PUT / POST | `/api/data/:key` | 書き込み。ボディは `{"value": ...}` (上限64KB) |
| DELETE | `/api/data/:key` | 削除 |
| POST | `/api/keys` | APIキーの発行 (`{"code": "確認コード"}`) |
| POST | `/api/files` | 画像・動画の保存 (ボディにファイルそのもの) |
| GET | `/api/files` | 保存したファイルの一覧 |
| DELETE | `/api/files/:id` | ファイルの削除 (アップロードした本人か管理者だけ) |
| GET | `/files/:id` | 画像・動画そのものを取得 (`<img>` や `<video>` にそのまま使える) |
| GET | `/health` | 稼働状況 |

## 画像・動画を保存する

保存できるのは、画像(PNG / JPEG / GIF / WebP / AVIF)と動画(MP4 / WebM / MOV)です。ファイルの中身から種類を判定するので、名前や申告は関係ありません。SVG・HTML・HEICは保存できません。

画面から: 「キー」を入れてファイルを選び、「画像・動画を共有」を押します。全員の画面にすぐ表示されます。

APIから: 2ステップです。

```js
// 1) ファイルを保存する → { id, url, type, name, ... } が返る
const file = document.querySelector("input[type=file]").files[0];
const up = await (await fetch(`${BASE}/api/files`, {
  method: "POST",
  headers: { "X-API-Key": KEY, "X-File-Name": encodeURIComponent(file.name) },
  body: file,
})).json();

// 2) 「どのデータの値か」を保存する (全員の画面にも出る)
await fetch(`${BASE}/api/data/photo1`, {
  method: "PUT",
  headers: { "Content-Type": "application/json", "X-API-Key": KEY },
  body: JSON.stringify({ value: { type: "image", url: up.url, name: up.name } }),  // 動画なら type: "video"
});
```

表示は `<img src="https://あなたのサイト/files/…">` や `<video src="…" controls>` で使えます。動画は途中から再生できます。

curl の例: `curl -X POST $BASE/api/files -H "X-API-Key: $KEY" --data-binary @photo.jpg`

注意:
- データ(`/api/data/...`)を削除しても、ファイル本体は残ります。不要なファイルは `DELETE /api/files/:id` で消してください。
- 保存先の `uploads/` は、ホスティングによっては再起動で消えます。残したいときは永続ディスクを付け、`DATA_DIR` にそのパスを指定します。

## 更新のしかた (URLは変わりません)

1. 直したファイルを GitHub のリポジトリにアップロードして「Commit changes」を押します (同じ名前なら上書き)。
2. Render が自動で入れ替えます。サイトのURLは同じままです。
3. Render で「Delete」したり、新しい Web Service を作り直したりすると URL が変わるので、しないでください。

環境変数だけを変えるときは、Render の「Environment」で変更すれば、再起動だけで反映されます。

## WebSocket でリアルタイムに受け取る

```js
const ws = new WebSocket("wss://あなたのサイト");

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "init") console.log("最初の全データ", msg.data);
  if (msg.type === "update") console.log("更新", msg.key, msg.entry.value);
  if (msg.type === "delete") console.log("削除", msg.key);
  if (msg.type === "presence") console.log("接続中の人数", msg.count);
};
```

## 注意

- **WebSocket からの書き込みと、付属の画面からのテキスト・画像の共有メッセージには、まだキーの確認がありません。** `REQUIRE_KEY` で守られるのは、REST API の書き込み・アップロード・削除です。
- 無料のホスティングでは、再起動で `data.json`・`keys.json`・`uploads/` が消えることがあります。消えるとAPIキーも無効になり、再発行が必要です。

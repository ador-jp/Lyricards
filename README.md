# Lyricards

英語の歌詞から単語を抽出し、意味と日常例文をまとめる単語帳アプリです。

**Live:** https://lyricards.uchizawa0103.chatgpt.site

## Features

- Apple Musicの公開メタデータを使った曲名・アーティスト検索
- Geniusへ移動して、利用権のある歌詞を手動で貼り付け
- `[Chorus]` やコピー時の広告文を除去
- 歌詞内の全ユニーク英単語を頻度順に抽出
- Datamuseから主要な意味を最大3件取得
- Tatoebaから日常的な例文を取得し、出典を表示
- 例文が取得できない場合も会話向けの予備例文を生成
- 学習済み単語の除外、サーバー保存、CSV書き出し

歌詞本文は保存しません。歌詞サイトのスクレイピングや歌詞全文の自動取得も行いません。

通信障害などでサーバーに保存できない場合は、同じブラウザに一時保存します。再接続や再読み込み時に、そのブラウザの同じ識別子でサーバーへの保存を再試行します。

## Development

Node.js 22.13以上が必要です。

```bash
npm install
npm run dev
```

`npm run dev` は起動時に `drizzle/` の未適用マイグレーションをローカル D1 に適用します。手動で SQL を実行する必要はありません。ローカルデータは `.wrangler/state` に保存され、再起動後も残ります。本番の D1 には接続しません。

```bash
npm run lint
npm test
npm run build
```

### Sentry tracing

API tracing is disabled unless the Worker has a runtime `SENTRY_DSN` binding.
For local development, put it in the gitignored `.dev.vars` file (never in a
`VITE_*` variable). Optional bindings are `SENTRY_TRACES_SAMPLE_RATE` (0–1,
default `1`; invalid values fall back to `1`) and `SENTRY_ENVIRONMENT` (default
`production`; use `development` locally).

The custom `worker.ts` entry wraps vinext with `@sentry/cloudflare`. Only
`/api/*` requests are instrumented, named by method and pathname without query
parameters. Outgoing fetches have `http.client` child spans; Sentry flushes via
the execution context's `waitUntil`, without delaying responses.
Both errors and transactions omit request headers, cookies, user IP addresses,
and request/upstream URL query strings.

`.openai/hosting.json` identifies the hosted project and its D1/R2 bindings;
it does not contain Sentry credentials. Set the bindings in the hosting
provider's runtime environment/secret settings for project
`appgprj_6aac98b0151c8191bde9b132169d3115`. If managing its Cloudflare Worker
directly, use Workers & Pages → the deployed Worker → Settings → Variables
and Secrets (`SENTRY_DSN` as a secret, the other two as text variables).
Local `.dev.vars` values are not deployed.

## Stack

- Vinext / React / TypeScript
- Cloudflare Workers / D1
- iTunes Search API
- Datamuse API
- Tatoeba API

## Data model

```ts
type Entry = {
  id: string
  song: string
  artist: string
  words: Word[]
  createdAt: string
}
```

歌詞原文は保存せず、抽出した単語・意味・例文だけを保存します。保存データは匿名のブラウザ識別子ごとに分離されます。

## Copyright

楽曲情報のみAppleの公開検索APIから取得します。歌詞はユーザー自身が利用権を確認したうえで入力してください。商用利用や歌詞の自動取得には、権利者または正式な歌詞提供事業者との契約が必要です。

Tatoeba由来の例文には、アプリ内で作者・原文URL・ライセンス表記を付けています。

## License

[MIT](LICENSE)

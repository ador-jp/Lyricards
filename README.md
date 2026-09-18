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

## Development

Node.js 22.13以上が必要です。

```bash
npm install
npm run dev
```

```bash
npm test
npm run build
```

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

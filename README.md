# pdf-editor

バージョン `v0.1.0`

![pdf-editorの画面：左にページ一覧、右にPDFのプレビュー](pdf-editor-screenshot.png)

ブラウザーでPDFのページを並べ替え・回転・削除し、注釈を追加するツールです。PDF・JPEG・PNGを読み込めます。ファイルの処理はブラウザー内で行います。

## 使い方

配布ファイルの `pdf-editor.html` をブラウザーで開きます。単一HTMLなので、オフラインでも使えます。静的サイトとして置く場合は、`dist/pdf-editor.html` または `src/` フォルダーの中身一式を公開してください。

PDFを結合する場合、文書全体の出力ICCは、出力の先頭ページの元PDFから引き継ぎます。保存時にスクリプトや外部動作は除き、読み上げ用のタグは引き継ぎません。同名フォーム欄の衝突は通知しますが、フォームの定義は修正しません。

## 開発・配布

Node.js 24とnpmを使います。

```sh
npm ci
npm run build
npm test
```

- `src/`：静的公開できるアプリのソース
- `dist/pdf-editor.html`：ビルドで生成する単一HTML
- `npm test`：ビルド結果の照合、操作ロジック、PDF構造、代表PDFの保存前後の描画を検査
- `npm run package`：`build-output/` に `pdf-editor-source.zip` と `pdf-editor.html` を作成

実ブラウザーでの検査は `npx playwright install chromium` の後に `npm run test:browser` を実行します。テストはPDF.jsでの保存前後を比較します。別の描画エンジンや印刷機器での一致を保証する検査ではありません。

Dockerを使う場合は `docker build -t pdf-editor .`、`docker run --rm pdf-editor` でNodeのテストを実行できます。アプリを使うためのコンテナは不要です。

同梱ライブラリとフォントのライセンスは [src/vendor/LICENSES.txt](src/vendor/LICENSES.txt) と [tests/fixtures/licenses/](tests/fixtures/licenses/) を参照してください。

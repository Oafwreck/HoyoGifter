# HoyoGift Hub

原神・崩壊：スターレイル・ゼンレスゾーンゼロの交換コードを、公式交換ページのURLおよび Discord 向け Markdown リンクへ変換する静的 Web サイトです。ビルド不要で、そのまま GitHub Pages で公開できます。

## 主な機能

- 交換コードまたは公式交換URLから、対象ゲームの公式交換リンクを一括生成
- URL 形式 / Discord 用 Markdown 形式の切り替えとコピー
- Discord Webhook を利用したチャンネルへの直接送信（送信前確認・重複チェック・再送対応）
- 設定のブラウザ保存 ON / OFF 切り替え、JSON 形式での書き出し・読み込み

## GitHub Pages で公開する手順

1. GitHub で新しいリポジトリを作成します。
2. このフォルダー内のファイルをリポジトリにアップロード（または `git push`）します。
3. リポジトリの **Settings** → **Pages** を開きます。
4. **Build and deployment** の **Source** で **Deploy from a branch** を選び、ブランチに `main`、フォルダーに `/ (root)` を指定して **Save** をクリックします。
5. 数十秒〜数分後、ページ上部に公開 URL（`https://<ユーザー名>.github.io/<リポジトリ名>/`）が表示されます。

## ファイル構成

```text
.
├── index.html          # アプリ本体（画面・使い方・CSP 設定）
├── css/
│   ├── tokens.css      # デザイントークン（色・余白・フォント定義）
│   ├── style.css       # 共通コンポーネントスタイル
│   └── workspace.css   # ワークスペースレイアウト
├── js/
│   ├── safety.js       # 入力・URL・Webhook・JSON の検証と分割処理
│   ├── delivery.js     # Discord 送信・レート制限・送信済み管理
│   └── app.js          # UI 制御・状態管理・ローカル保存
├── tests/              # 安全性・UI 処理・マークアップの自動テスト
├── .nojekyll           # GitHub Pages の Jekyll 処理を無効化
└── .gitignore          # 一時ファイルや秘密 URL 付きバックアップの誤コミット防止
```

## ローカルでの動作確認

ビルドツールや外部パッケージは不要です。任意の静的サーバーで確認できます。

```bash
python -m http.server 8000
```

ブラウザで `http://127.0.0.1:8000/` を開いて確認してください。

## テストの実行

```bash
node tests/safety.test.cjs
node tests/polish.test.cjs
python tests/markup.test.py
```

## プライバシーとセキュリティ

- バックエンドサーバーや外部トラッキングは使用していません。
- Webhook URL や履歴は利用者のブラウザ内（`localStorage`）にのみ保存され、Discord への投稿以外で外部送信しません。
- 「URL付きバックアップ」で書き出した JSON には投稿権限を持つ秘密情報が含まれるため、リポジトリへコミットしたり公開場所へ置いたりしないでください。

## 免責事項

本サイトは非公式のファンツールです。HoYoverse および COGNOSPHERE とは関係ありません。各コードの有効性・期限は公式ページで確認してください。

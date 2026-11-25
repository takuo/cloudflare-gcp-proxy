# cloudrun-proxy

Cloudflare Workers 上で動くリバースプロキシ（Hono 製）。サービスアカウントから Google OIDC ID トークンを生成し、`Authorization: Bearer` ヘッダーに付けて **IAM 保護された Cloud Run** へリクエストを転送します。指定した URL パターンに一致するリクエストには `403 Forbidden` を返します。

```
Client ──▶ Cloudflare Worker ──(Authorization: Bearer <ID token>)──▶ Cloud Run (--no-allow-unauthenticated)
               │
               └─ BLOCKED_URL_PATTERNS に一致 → 403
```

## セットアップ

### 1. 開発環境（mise）

```bash
mise install        # Node 24 をインストール
mise run install    # npm install
```

| タスク | 内容 |
|---|---|
| `mise run dev` | ローカル起動（`wrangler dev`） |
| `mise run test` | テスト（vitest） |
| `mise run typecheck` | 型チェック |
| `mise run deploy` | Cloudflare へデプロイ |

### 2. Google Cloud 側

```bash
# プロキシ用サービスアカウント
gcloud iam service-accounts create cloudrun-proxy --project PROJECT_ID

# Cloud Run の呼び出し権限を付与
gcloud run services add-iam-policy-binding SERVICE \
  --region REGION \
  --member serviceAccount:cloudrun-proxy@PROJECT_ID.iam.gserviceaccount.com \
  --role roles/run.invoker

# キーを作成（リポジトリに入れないこと）
gcloud iam service-accounts keys create service-account.json \
  --iam-account cloudrun-proxy@PROJECT_ID.iam.gserviceaccount.com
```

### 3. Cloudflare 側

変数は `wrangler.jsonc` に書かず、Cloudflare ダッシュボードの **Settings → Variables and Secrets** で設定します。`wrangler.jsonc` に `"keep_vars": true` を書いてあるので、デプロイしてもダッシュボードの変数は上書きされません。

- `GOOGLE_SERVICE_ACCOUNT_KEY` は **Secret** 型で、キー JSON の中身をそのまま貼り付けます（CLI なら `npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY < service-account.json`）。
- そのほかは Text 型です。`BLOCKED_URL_PATTERNS` だけは JSON 型（配列）も使えます。

#### GitHub 連携（Workers Builds）

1. **Workers & Pages → Create → Import a repository** でこのリポジトリを選ぶ
2. Project name は `cloudrun-proxy`（`wrangler.jsonc` の `name` と一致させる）
3. Build command: `npm run test && npm run typecheck`、Deploy command: `npx wrangler deploy`
4. Build variables に `NODE_VERSION=24` を設定（Workers Builds は `mise.toml` を読まない）

#### ローカル開発

`.dev.vars.example` を `.dev.vars` にコピーし、値を設定して `mise run dev` で起動します。

## 設定

| 変数 | 必須 | 説明 |
|---|---|---|
| `CLOUD_RUN_URL` | ✓ | 転送先 Cloud Run の URL。オリジンのみ使用し、パスとクエリはリクエストのものを引き継ぐ |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | ✓（secret） | サービスアカウントキー JSON |
| `AUDIENCE` | | ID トークンの audience。省略時は `CLOUD_RUN_URL` のオリジン。カスタムドメインを使う場合などに指定 |
| `BLOCKED_URL_PATTERNS` | | 403 を返す URL パターン（後述） |
| `PRESERVE_CLIENT_AUTHORIZATION` | | `"true"` にするとクライアントの `Authorization` をそのまま渡し、ID トークンは `X-Serverless-Authorization` に付ける（Cloud Run はこのヘッダーで IAM 認証する） |

### BLOCKED_URL_PATTERNS

[URLPattern](https://developer.mozilla.org/docs/Web/API/URL_Pattern_API) 構文で指定します（正規表現そのものではありません）。ダッシュボードでは JSON 型なら配列、Text 型なら 1 行に 1 パターンで書きます。

| 例 | 意味 |
|---|---|
| `/admin/*` | `/admin/` 配下すべて（`/admin` 自体は含まない） |
| `/admin{/*}?` | `/admin` とその配下すべて |
| `/users/:id/secret` | 名前付きパラメータ |
| `/files/*.env` | ワイルドカード |
| `/v(1\|2)/debug` | 正規表現グループ |
| `/((?:.*/)?\..*)` | どの階層でもドットで始まるパス（`/.env`、`/a/.git/config` など） |
| `DELETE /api/*` | 先頭にメソッドを付けるとそのメソッドだけを対象にする |
| `https://*.example.com/hidden/*` | ホストを含む URL 全体でマッチ |

- パスのマッチは**大文字小文字を区別しません**（`/ADMIN` のような回避を防ぐため）。
- 重複スラッシュ（`//admin`）は判定前に 1 つにまとめ、まとめた後のパスで転送します。
- `.` / `..` セグメントや `%2e` は、判定前に URL パーサーが正規化します。
- `#` で始まる行はコメントとして無視します。
- **`/.*` は使わないこと。** パターン中の `/.` がカレントディレクトリとして正規化されて `/*` と同じ意味になり、全パスが 403 になります。ドットを文字として書きたいときは `/(\..*)` のように正規表現グループに入れます。
- 不正なパターン（`^/\..*` など）があると、すべてのリクエストが 500 になります。

## 補足

- ID トークンは Worker の isolate ごとにメモリへキャッシュし、期限の 5 分前に再取得します。
- `Host`、hop-by-hop ヘッダー、Cloudflare の `cf-*` ヘッダーは転送しません。`X-Forwarded-For` / `X-Forwarded-Host` / `X-Forwarded-Proto` を付与します。
- リダイレクトは追わず、レスポンスをそのままクライアントへ返します。

import { Hono } from "hono";
import { findBlockingRule, parseBlockRules, type BlockRule } from "./blocklist";
import { getIdToken, parseServiceAccountKey } from "./google-auth";

export type Bindings = {
  /** 転送先 Cloud Run サービスの URL（オリジンのみ使用） */
  CLOUD_RUN_URL: string;
  /** ID トークンの audience。省略時は CLOUD_RUN_URL のオリジン */
  AUDIENCE?: string;
  /** サービスアカウントキー JSON（secret） */
  GOOGLE_SERVICE_ACCOUNT_KEY: string;
  /** 403 を返す URL パターン（配列 / JSON 文字列 / 改行区切り） */
  BLOCKED_URL_PATTERNS?: string[] | string;
  /** "true" ならクライアントの Authorization を保持し、ID トークンは X-Serverless-Authorization に付与 */
  PRESERVE_CLIENT_AUTHORIZATION?: string;
};

type Variables = { blockRules: BlockRule[] };

// 転送しないヘッダー（hop-by-hop と Cloudflare 付与のもの）
const STRIPPED_REQUEST_HEADERS = [
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "cdn-loop",
  "x-real-ip",
  "x-serverless-authorization",
];

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// isolate 内でパース結果をキャッシュ（設定値が同じ間は再パースしない）
let rulesCache: { raw: unknown; rules: BlockRule[] } | undefined;
function getBlockRules(raw: unknown): BlockRule[] {
  if (!rulesCache || rulesCache.raw !== raw) {
    rulesCache = { raw, rules: parseBlockRules(raw) };
  }
  return rulesCache.rules;
}

/** "//admin" のような重複スラッシュでブロックを回避されないよう正規化する */
function normalizeUrl(raw: string): URL {
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  return url;
}

// URL パターンによるブロック
app.use("*", async (c, next) => {
  const url = normalizeUrl(c.req.url);
  const rule = findBlockingRule(getBlockRules(c.env.BLOCKED_URL_PATTERNS), c.req.method, url.href);
  if (rule) {
    console.log(JSON.stringify({ msg: "blocked", method: c.req.method, path: url.pathname, rule: rule.source }));
    return c.text("Forbidden", 403);
  }
  await next();
});

// Cloud Run への転送
app.all("*", async (c) => {
  const env = c.env;
  if (!env.CLOUD_RUN_URL) {
    console.error("CLOUD_RUN_URL is not set");
    return c.text("Proxy misconfigured", 500);
  }

  const upstreamOrigin = new URL(env.CLOUD_RUN_URL).origin;
  const audience = env.AUDIENCE || upstreamOrigin;

  let idToken: string;
  try {
    idToken = await getIdToken(parseServiceAccountKey(env.GOOGLE_SERVICE_ACCOUNT_KEY), audience);
  } catch (e) {
    console.error(JSON.stringify({ msg: "failed to obtain ID token", error: (e as Error).message }));
    return c.text("Bad Gateway", 502);
  }

  const incoming = normalizeUrl(c.req.url);
  const target = new URL(incoming.pathname + incoming.search, upstreamOrigin);

  const headers = new Headers(c.req.raw.headers);
  const clientIp = headers.get("cf-connecting-ip");
  // WebSocket のアップグレード要求は Upgrade / Connection を残して転送する
  // （Workers の fetch は 101 + webSocket を返し、それをそのままクライアントへ返せば中継される）
  const isWebSocket = headers.get("upgrade")?.toLowerCase() === "websocket";
  for (const h of STRIPPED_REQUEST_HEADERS) {
    if (isWebSocket && (h === "upgrade" || h === "connection")) continue;
    headers.delete(h);
  }

  if (clientIp) {
    // cf-connecting-ip は Cloudflare が付与するため信頼できる。クライアント送信の X-Real-IP は上で削除済み
    headers.set("x-real-ip", clientIp);
    const prior = headers.get("x-forwarded-for");
    headers.set("x-forwarded-for", prior ? `${prior}, ${clientIp}` : clientIp);
  }
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(/:$/, ""));

  if (env.PRESERVE_CLIENT_AUTHORIZATION === "true") {
    // Cloud Run は X-Serverless-Authorization を IAM 認証に使い、Authorization はそのままアプリへ渡す
    headers.set("x-serverless-authorization", `Bearer ${idToken}`);
  } else {
    headers.set("authorization", `Bearer ${idToken}`);
  }

  const method = c.req.method;
  const hasBody = method !== "GET" && method !== "HEAD";

  try {
    return await fetch(target.href, {
      method,
      headers,
      body: hasBody ? c.req.raw.body : undefined,
      redirect: "manual",
    });
  } catch (e) {
    console.error(JSON.stringify({ msg: "upstream fetch failed", error: (e as Error).message }));
    return c.text("Bad Gateway", 502);
  }
});

export default app;

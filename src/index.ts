import { Hono } from "hono";
import type { Context } from "hono";
import { cacheKeyFor, getEdgeCache, isCacheableRequest, isCacheableResponse, withCacheStatus } from "./cache";
import { getIdToken, parseServiceAccountKey } from "./google-auth";
import { findMatchingRule, parseUrlRules, type UrlRule } from "./url-rules";

export type Bindings = {
  /** 転送先 Cloud Run サービスの URL（オリジンのみ使用） */
  CLOUD_RUN_URL: string;
  /** ID トークンの audience。省略時は CLOUD_RUN_URL のオリジン */
  AUDIENCE?: string;
  /** サービスアカウントキー JSON（secret） */
  GOOGLE_SERVICE_ACCOUNT_KEY: string;
  /** 403 を返す URL パターン（配列 / JSON 文字列 / 改行区切り） */
  BLOCKED_URL_PATTERNS?: string[] | string;
  /** エッジキャッシュ対象の URL パターン（書式は BLOCKED_URL_PATTERNS と同じ） */
  CACHE_URL_PATTERNS?: string[] | string;
  /** "true" ならクライアントの Authorization を保持し、ID トークンは X-Serverless-Authorization に付与 */
  PRESERVE_CLIENT_AUTHORIZATION?: string;
};

type AppEnv = { Bindings: Bindings };

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

const app = new Hono<AppEnv>();

// isolate 内でパース結果をキャッシュ（設定値が同じ間は再パースしない）
const rulesCache = new Map<string, { raw: unknown; rules: UrlRule[] }>();
function getRules(varName: "BLOCKED_URL_PATTERNS" | "CACHE_URL_PATTERNS", raw: unknown): UrlRule[] {
  const cached = rulesCache.get(varName);
  if (cached && cached.raw === raw) return cached.rules;
  const rules = parseUrlRules(raw, varName);
  rulesCache.set(varName, { raw, rules });
  return rules;
}

/** レスポンス返却後も処理を続ける（ExecutionContext がない環境ではそのまま実行） */
function runInBackground(c: Context<AppEnv>, promise: Promise<unknown>): void {
  const p = promise.catch((e) => console.error(JSON.stringify({ msg: "background task failed", error: (e as Error).message })));
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    // ExecutionContext なし
  }
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
  const rule = findMatchingRule(getRules("BLOCKED_URL_PATTERNS", c.env.BLOCKED_URL_PATTERNS), c.req.method, url.href);
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
  const incoming = normalizeUrl(c.req.url);

  // エッジキャッシュ（ヒット時は ID トークン取得も Cloud Run 呼び出しもしない）
  const edgeCache =
    isCacheableRequest(c.req.raw) &&
    findMatchingRule(getRules("CACHE_URL_PATTERNS", env.CACHE_URL_PATTERNS), c.req.method, incoming.href)
      ? getEdgeCache()
      : undefined;
  const cacheKey = cacheKeyFor(incoming);
  if (edgeCache) {
    const hit = await edgeCache.match(cacheKey);
    if (hit) return withCacheStatus(hit, "HIT");
  }

  let idToken: string;
  try {
    idToken = await getIdToken(parseServiceAccountKey(env.GOOGLE_SERVICE_ACCOUNT_KEY), audience);
  } catch (e) {
    console.error(JSON.stringify({ msg: "failed to obtain ID token", error: (e as Error).message }));
    return c.text("Bad Gateway", 502);
  }

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

  let res: Response;
  try {
    res = await fetch(target.href, {
      method,
      headers,
      body: hasBody ? c.req.raw.body : undefined,
      redirect: "manual",
    });
  } catch (e) {
    console.error(JSON.stringify({ msg: "upstream fetch failed", error: (e as Error).message }));
    return c.text("Bad Gateway", 502);
  }

  // キャッシュ対象外はそのまま返す（WebSocket の 101 応答を包み直さないため）
  if (!edgeCache) return res;
  if (!isCacheableResponse(res)) return withCacheStatus(res, "BYPASS");
  runInBackground(c, edgeCache.put(cacheKey, res.clone()));
  return withCacheStatus(res, "MISS");
});

export default app;

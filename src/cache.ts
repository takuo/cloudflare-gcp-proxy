/**
 * Workers Cache API によるエッジキャッシュの判定。
 *
 * キャッシュ期間はオリジン（Cloud Run）の Cache-Control に従い、
 * 認証や個人データを含みうるものはキャッシュしない。
 * Cache API はカスタムドメイン上でのみ有効（workers.dev では何もしない）。
 */

const CACHEABLE_STATUSES = new Set([200, 301, 302, 307, 308]);

/** リクエストがキャッシュ対象になりうるか（URL パターンの判定は別途） */
export function isCacheableRequest(req: Request): boolean {
  if (req.method !== "GET") return false;
  const h = req.headers;
  if (h.has("authorization")) return false;
  if (h.has("range")) return false;
  if (h.get("upgrade")) return false;
  return true;
}

/** オリジンのレスポンスをキャッシュに保存してよいか */
export function isCacheableResponse(res: Response): boolean {
  if (!CACHEABLE_STATUSES.has(res.status)) return false;
  if (res.headers.has("set-cookie")) return false;
  if (res.headers.get("vary")?.trim() === "*") return false;

  const cc = parseCacheControl(res.headers.get("cache-control"));
  if (cc.has("no-store") || cc.has("private") || cc.has("no-cache")) return false;
  const ttl = Number(cc.get("s-maxage") ?? cc.get("max-age") ?? 0);
  return Number.isFinite(ttl) && ttl > 0;
}

/** キャッシュキー（ヘッダーを含まない、正規化済み URL の GET） */
export function cacheKeyFor(url: URL): Request {
  return new Request(url.href, { method: "GET" });
}

/** Cache API が使えない環境（テスト等）では undefined */
export function getEdgeCache(): Cache | undefined {
  try {
    return (globalThis as unknown as { caches?: CacheStorage & { default?: Cache } }).caches?.default;
  } catch {
    return undefined;
  }
}

export function withCacheStatus(res: Response, status: "HIT" | "MISS" | "BYPASS"): Response {
  const out = new Response(res.body, res);
  out.headers.set("x-proxy-cache", status);
  return out;
}

function parseCacheControl(value: string | null): Map<string, string | undefined> {
  const map = new Map<string, string | undefined>();
  if (!value) return map;
  for (const part of value.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k) map.set(k.toLowerCase(), v?.replace(/^"|"$/g, ""));
  }
  return map;
}

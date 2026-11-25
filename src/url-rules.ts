/**
 * URLPattern ベースの URL ルール（BLOCKED_URL_PATTERNS / CACHE_URL_PATTERNS で共用）。
 *
 * パターン書式:
 *   "/admin/*"                    パス名のみでマッチ（先頭が "/"）
 *   "https://*.example.com/x/*"   URL 全体でマッチ（URLPattern 文字列）
 *   "POST /api/*"                 先頭に HTTP メソッドを付けるとそのメソッドのみ対象
 *
 * パス名マッチは大文字小文字を区別しない（"/ADMIN" のような回避を防ぐため）。
 */

export interface UrlRule {
  source: string;
  method?: string;
  pattern: URLPattern;
}

const METHOD_PREFIX = /^([A-Za-z]+)\s+(\S.*)$/;

export function parseUrlRules(raw: unknown, varName = "URL_PATTERNS"): UrlRule[] {
  return normalizeList(raw, varName).map((source) => {
    let method: string | undefined;
    let body = source;
    const m = METHOD_PREFIX.exec(source);
    if (m && m[1] && m[2]) {
      method = m[1].toUpperCase();
      body = m[2].trim();
    }
    try {
      const pattern = body.startsWith("/")
        ? new URLPattern({ pathname: body }, { ignoreCase: true })
        : new URLPattern(body, { ignoreCase: true });
      return { source, method, pattern };
    } catch (e) {
      throw new Error(`Invalid ${varName} entry "${source}": ${(e as Error).message}`);
    }
  });
}

export function findMatchingRule(rules: UrlRule[], method: string, url: string): UrlRule | undefined {
  const upper = method.toUpperCase();
  return rules.find((r) => (!r.method || r.method === upper) && r.pattern.test(url));
}

/** 配列（wrangler vars の JSON 値）、JSON 文字列、改行区切り文字列（正規表現中の "," と衝突するためカンマ区切りは不可）を受け付ける */
function normalizeList(raw: unknown, varName: string): string[] {
  if (raw == null || raw === "") return [];
  let list: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      list = JSON.parse(trimmed);
    } else {
      list = trimmed.split("\n");
    }
  }
  if (!Array.isArray(list)) throw new Error(`${varName} must be an array or string`);
  return list
    .map((v) => String(v).trim())
    .filter((v) => v !== "" && !v.startsWith("#"));
}

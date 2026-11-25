/**
 * サービスアカウントキーから Google 署名の OIDC ID トークンを取得する。
 *
 * 1. サービスアカウントの秘密鍵で JWT（target_audience 付き）を RS256 署名
 * 2. Google のトークンエンドポイントで jwt-bearer グラントにより id_token と交換
 *
 * 取得したトークンは isolate 内でキャッシュし、期限 5 分前に再取得する。
 */

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
}

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const REFRESH_MARGIN_SEC = 300;

interface CachedToken {
  token: string;
  expiresAt: number; // epoch 秒
}

const tokenCache = new Map<string, CachedToken>();
const keyCache = new Map<string, CryptoKey>();

export function parseServiceAccountKey(raw: string | undefined): ServiceAccountKey {
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not set");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON");
  }
  const key = parsed as Partial<ServiceAccountKey>;
  if (typeof key.client_email !== "string" || typeof key.private_key !== "string") {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY must contain client_email and private_key");
  }
  return key as ServiceAccountKey;
}

export async function getIdToken(sa: ServiceAccountKey, audience: string): Promise<string> {
  const cacheKey = `${sa.client_email}|${audience}`;
  const now = Math.floor(Date.now() / 1000);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - REFRESH_MARGIN_SEC > now) {
    return cached.token;
  }

  const tokenUri = sa.token_uri ?? DEFAULT_TOKEN_URI;
  const assertion = await signJwt(sa, {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
    target_audience: audience,
  });

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token endpoint returned ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw new Error("Token endpoint response has no id_token");

  const expiresAt = readExp(body.id_token) ?? now + 3600;
  tokenCache.set(cacheKey, { token: body.id_token, expiresAt });
  return body.id_token;
}

/** テスト用 */
export function clearAuthCache(): void {
  tokenCache.clear();
  keyCache.clear();
}

async function signJwt(sa: ServiceAccountKey, payload: Record<string, unknown>): Promise<string> {
  const header: Record<string, string> = { alg: "RS256", typ: "JWT" };
  if (sa.private_key_id) header.kid = sa.private_key_id;

  const enc = new TextEncoder();
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const cached = keyCache.get(pem);
  if (cached) return cached;

  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  keyCache.set(pem, key);
  return key;
}

function readExp(jwt: string): number | undefined {
  try {
    const part = jwt.split(".")[1];
    if (!part) return undefined;
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp : undefined;
  } catch {
    return undefined;
  }
}

function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

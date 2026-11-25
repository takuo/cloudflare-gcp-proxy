import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app, { type Bindings } from "../src/index";
import { clearAuthCache } from "../src/google-auth";
import { findMatchingRule, parseUrlRules } from "../src/url-rules";

const UPSTREAM = "https://my-service-abc123-an.a.run.app";
const TOKEN_URI = "https://oauth2.googleapis.com/token";

let saKeyJson: string;
let publicKey: CryptoKey;

function b64url(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

function fakeIdToken(exp: number): string {
  return `${b64url({ alg: "RS256" })}.${b64url({ exp, aud: UPSTREAM })}.sig`;
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  publicKey = pair.publicKey;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  saKeyJson = JSON.stringify({
    type: "service_account",
    client_email: "proxy@test-project.iam.gserviceaccount.com",
    private_key_id: "kid-123",
    private_key: pem,
    token_uri: TOKEN_URI,
  });
});

function env(overrides: Partial<Bindings> = {}): Bindings {
  return {
    CLOUD_RUN_URL: UPSTREAM,
    GOOGLE_SERVICE_ACCOUNT_KEY: saKeyJson,
    BLOCKED_URL_PATTERNS: ["/admin{/*}?", "/internal/*", "DELETE /api/*"],
    ...overrides,
  };
}

type Call = { url: string; init: RequestInit };
let calls: Call[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearAuthCache();
  calls = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === TOKEN_URI) {
      return Response.json({ id_token: fakeIdToken(Math.floor(Date.now() / 1000) + 3600) });
    }
    return new Response("upstream ok", { status: 200, headers: { "x-upstream": "1" } });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("proxy", () => {
  it("ID トークンを Authorization に付けて Cloud Run へ転送する", async () => {
    const res = await app.request(
      "https://proxy.example.com/hello?x=1",
      { headers: { "cf-connecting-ip": "203.0.113.5", "x-custom": "abc" } },
      env(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream ok");

    const upstream = calls.find((c) => c.url.startsWith(UPSTREAM))!;
    expect(upstream.url).toBe(`${UPSTREAM}/hello?x=1`);
    const h = new Headers(upstream.init.headers);
    expect(h.get("authorization")).toMatch(/^Bearer .+\..+\..+$/);
    expect(h.get("x-custom")).toBe("abc");
    expect(h.get("x-forwarded-for")).toBe("203.0.113.5");
    expect(h.get("x-real-ip")).toBe("203.0.113.5");
    expect(h.get("x-forwarded-host")).toBe("proxy.example.com");
    expect(h.get("cf-connecting-ip")).toBeNull();
    expect(h.get("host")).toBeNull();
  });

  it("署名済み JWT を正しいクレームでトークンエンドポイントへ送る", async () => {
    await app.request("https://proxy.example.com/", {}, env());
    const tokenCall = calls.find((c) => c.url === TOKEN_URI)!;
    const params = new URLSearchParams(String(tokenCall.init.body));
    expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");

    const [h, p, s] = params.get("assertion")!.split(".") as [string, string, string];
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    expect(header).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-123" });
    expect(payload.iss).toBe("proxy@test-project.iam.gserviceaccount.com");
    expect(payload.aud).toBe(TOKEN_URI);
    expect(payload.target_audience).toBe(UPSTREAM);

    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      b64urlDecode(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });

  it("AUDIENCE を指定するとそれを target_audience に使う", async () => {
    await app.request("https://proxy.example.com/", {}, env({ AUDIENCE: "custom-aud" }));
    const params = new URLSearchParams(String(calls.find((c) => c.url === TOKEN_URI)!.init.body));
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(params.get("assertion")!.split(".")[1]!)));
    expect(payload.target_audience).toBe("custom-aud");
  });

  it("ID トークンをキャッシュし、2 回目はトークンエンドポイントを呼ばない", async () => {
    await app.request("https://proxy.example.com/a", {}, env());
    await app.request("https://proxy.example.com/b", {}, env());
    expect(calls.filter((c) => c.url === TOKEN_URI)).toHaveLength(1);
    expect(calls.filter((c) => c.url.startsWith(UPSTREAM))).toHaveLength(2);
  });

  it("PRESERVE_CLIENT_AUTHORIZATION=true ならクライアントの Authorization を保持する", async () => {
    await app.request(
      "https://proxy.example.com/",
      { headers: { authorization: "Bearer client-token" } },
      env({ PRESERVE_CLIENT_AUTHORIZATION: "true" }),
    );
    const h = new Headers(calls.find((c) => c.url.startsWith(UPSTREAM))!.init.headers);
    expect(h.get("authorization")).toBe("Bearer client-token");
    expect(h.get("x-serverless-authorization")).toMatch(/^Bearer /);
  });

  it("クライアントが送った X-Real-IP は cf-connecting-ip で置き換える", async () => {
    await app.request(
      "https://proxy.example.com/",
      { headers: { "x-real-ip": "1.2.3.4", "cf-connecting-ip": "203.0.113.5" } },
      env(),
    );
    const h = new Headers(calls.find((c) => c.url.startsWith(UPSTREAM))!.init.headers);
    expect(h.get("x-real-ip")).toBe("203.0.113.5");
  });

  it("WebSocket のアップグレード要求は Upgrade / Connection を残す", async () => {
    await app.request(
      "https://proxy.example.com/notifications/hub?access_token=abc",
      { headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "k" } },
      env(),
    );
    const upstream = calls.find((c) => c.url.startsWith(UPSTREAM))!;
    expect(upstream.url).toBe(`${UPSTREAM}/notifications/hub?access_token=abc`);
    const h = new Headers(upstream.init.headers);
    expect(h.get("upgrade")).toBe("websocket");
    expect(h.get("connection")).toBe("Upgrade");
    expect(h.get("sec-websocket-key")).toBe("k");
    expect(h.get("authorization")).toMatch(/^Bearer /);
  });

  it("WebSocket 以外では Upgrade / Connection を転送しない", async () => {
    await app.request("https://proxy.example.com/", { headers: { upgrade: "h2c", connection: "Upgrade" } }, env());
    const h = new Headers(calls.find((c) => c.url.startsWith(UPSTREAM))!.init.headers);
    expect(h.get("upgrade")).toBeNull();
    expect(h.get("connection")).toBeNull();
  });

  it("POST のボディを転送する", async () => {
    await app.request("https://proxy.example.com/api/items", { method: "POST", body: "payload" }, env());
    const upstream = calls.find((c) => c.url.startsWith(UPSTREAM))!;
    expect(upstream.init.method).toBe("POST");
    expect(await new Response(upstream.init.body).text()).toBe("payload");
  });

  it("トークン取得に失敗したら 502", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("denied", { status: 400 }));
    const res = await app.request("https://proxy.example.com/", {}, env());
    expect(res.status).toBe(502);
    expect(calls.filter((c) => c.url.startsWith(UPSTREAM))).toHaveLength(0);
  });
});

describe("blocklist", () => {
  it.each([
    ["GET", "/admin"],
    ["GET", "/admin/users"],
    ["GET", "/ADMIN/users"],
    ["GET", "//admin/users"],
    ["GET", "/internal/metrics"],
    ["DELETE", "/api/items/1"],
  ])("%s %s は 403", async (method, path) => {
    const res = await app.request(`https://proxy.example.com${path}`, { method }, env());
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["GET", "/administrator"],
    ["GET", "/internal"],
    ["GET", "/api/items/1"],
  ])("%s %s は転送される", async (method, path) => {
    const res = await app.request(`https://proxy.example.com${path}`, { method }, env());
    expect(res.status).toBe(200);
  });

  it("改行区切り文字列・コメント・完全 URL パターンを扱える", () => {
    const rules = parseUrlRules("# comment\n/secret/*\nhttps://*.example.com/hidden/*\n");
    expect(rules).toHaveLength(2);
    expect(findMatchingRule(rules, "GET", "https://a.example.com/secret/x")).toBeDefined();
    expect(findMatchingRule(rules, "GET", "https://foo.example.com/hidden/y")).toBeDefined();
    expect(findMatchingRule(rules, "GET", "https://foo.other.com/hidden/y")).toBeUndefined();
  });

  it("不正なパターンはエラー", () => {
    expect(() => parseUrlRules(["/(unclosed"], "BLOCKED_URL_PATTERNS")).toThrow(/Invalid BLOCKED_URL_PATTERNS/);
  });
});

describe("edge cache", () => {
  let store: Map<string, Response>;
  let pending: Promise<unknown>[];
  const ctx = () => ({
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
  });
  const cacheEnv = () => env({ CACHE_URL_PATTERNS: ["/icons/*", "/app/*"] });
  let upstreamResponse: () => Response;

  beforeEach(() => {
    store = new Map();
    pending = [];
    vi.stubGlobal("caches", {
      default: {
        match: async (req: Request) => store.get(req.url)?.clone(),
        put: async (req: Request, res: Response) => {
          await res.arrayBuffer().then((b) => store.set(req.url, new Response(b, res)));
        },
      },
    });
    upstreamResponse = () =>
      new Response("icon-bytes", { status: 200, headers: { "cache-control": "public, max-age=2592000", "content-type": "image/png" } });
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === TOKEN_URI) return Response.json({ id_token: fakeIdToken(Math.floor(Date.now() / 1000) + 3600) });
      return upstreamResponse();
    });
  });

  const get = async (path: string, init: RequestInit = {}, e = cacheEnv()) => {
    const res = await app.request(`https://proxy.example.com${path}`, init, e, ctx() as unknown as ExecutionContext);
    await Promise.all(pending);
    return res;
  };
  const upstreamCalls = () => calls.filter((c) => c.url.startsWith(UPSTREAM)).length;
  const tokenCalls = () => calls.filter((c) => c.url === TOKEN_URI).length;

  it("1 回目は MISS で保存し、2 回目は HIT で Cloud Run もトークン取得も呼ばない", async () => {
    const r1 = await get("/icons/github.com/icon.png");
    expect(r1.headers.get("x-proxy-cache")).toBe("MISS");
    expect(await r1.text()).toBe("icon-bytes");
    const r2 = await get("/icons/github.com/icon.png");
    expect(r2.headers.get("x-proxy-cache")).toBe("HIT");
    expect(await r2.text()).toBe("icon-bytes");
    expect(r2.headers.get("cache-control")).toBe("public, max-age=2592000");
    expect(upstreamCalls()).toBe(1);
    expect(tokenCalls()).toBe(1);
  });

  it("重複スラッシュは正規化した URL をキーにする", async () => {
    await get("/icons/a.com/icon.png");
    const r = await get("//icons//a.com/icon.png");
    expect(r.headers.get("x-proxy-cache")).toBe("HIT");
  });

  it("CACHE_URL_PATTERNS に一致しない URL はキャッシュしない（ヘッダーも付けない）", async () => {
    const r = await get("/api/config");
    expect(r.headers.get("x-proxy-cache")).toBeNull();
    expect(store.size).toBe(0);
  });

  it("CACHE_URL_PATTERNS 未設定ならキャッシュしない", async () => {
    await get("/icons/a.com/icon.png", {}, env());
    await get("/icons/a.com/icon.png", {}, env());
    expect(upstreamCalls()).toBe(2);
    expect(store.size).toBe(0);
  });

  it.each([
    ["Authorization 付き", { headers: { authorization: "Bearer x" } }],
    ["Range 付き", { headers: { range: "bytes=0-1" } }],
    ["POST", { method: "POST", body: "x" }],
    ["WebSocket", { headers: { upgrade: "websocket", connection: "Upgrade" } }],
  ])("%s のリクエストはキャッシュを使わない", async (_label, init) => {
    await get("/app/main.js", init as RequestInit);
    await get("/app/main.js", init as RequestInit);
    expect(upstreamCalls()).toBe(2);
    expect(store.size).toBe(0);
  });

  it.each([
    ["no-store", { "cache-control": "no-store" }],
    ["no-cache", { "cache-control": "no-cache, max-age=600" }],
    ["private", { "cache-control": "private, max-age=600" }],
    ["max-age=0", { "cache-control": "public, max-age=0" }],
    ["Cache-Control なし", {}],
    ["Set-Cookie あり", { "cache-control": "public, max-age=600", "set-cookie": "a=b" }],
    ["Vary: *", { "cache-control": "public, max-age=600", vary: "*" }],
  ])("レスポンスが %s なら保存しない（BYPASS）", async (_label, h) => {
    upstreamResponse = () => new Response("x", { status: 200, headers: h as Record<string, string> });
    const r = await get("/app/main.js");
    expect(r.headers.get("x-proxy-cache")).toBe("BYPASS");
    expect(store.size).toBe(0);
  });

  it("エラー応答は保存しない", async () => {
    upstreamResponse = () => new Response("err", { status: 500, headers: { "cache-control": "public, max-age=600" } });
    const r = await get("/app/main.js");
    expect(r.status).toBe(500);
    expect(r.headers.get("x-proxy-cache")).toBe("BYPASS");
    expect(store.size).toBe(0);
  });

  it("リダイレクトは保存する（アイコンサービスへのリダイレクト等）", async () => {
    upstreamResponse = () =>
      new Response(null, { status: 302, headers: { location: "https://icons.duckduckgo.com/ip3/a.com.ico", "cache-control": "public, max-age=600" } });
    await get("/icons/a.com/icon.png");
    const r = await get("/icons/a.com/icon.png");
    expect(r.status).toBe(302);
    expect(r.headers.get("x-proxy-cache")).toBe("HIT");
    expect(r.headers.get("location")).toBe("https://icons.duckduckgo.com/ip3/a.com.ico");
  });

  it("ブロック対象はキャッシュより先に 403", async () => {
    const r = await get("/admin", {}, env({ CACHE_URL_PATTERNS: ["/*"] }));
    expect(r.status).toBe(403);
  });
});

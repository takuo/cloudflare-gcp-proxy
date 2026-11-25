import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app, { type Bindings } from "../src/index";
import { clearAuthCache } from "../src/google-auth";
import { findBlockingRule, parseBlockRules } from "../src/blocklist";

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
    const rules = parseBlockRules("# comment\n/secret/*\nhttps://*.example.com/hidden/*\n");
    expect(rules).toHaveLength(2);
    expect(findBlockingRule(rules, "GET", "https://a.example.com/secret/x")).toBeDefined();
    expect(findBlockingRule(rules, "GET", "https://foo.example.com/hidden/y")).toBeDefined();
    expect(findBlockingRule(rules, "GET", "https://foo.other.com/hidden/y")).toBeUndefined();
  });

  it("不正なパターンはエラー", () => {
    expect(() => parseBlockRules(["/(unclosed"])).toThrow(/Invalid BLOCKED_URL_PATTERNS/);
  });
});

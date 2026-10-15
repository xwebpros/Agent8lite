import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type IdxBridgeRequest,
  idxBridgeSecret,
  idxTemplateOrigins,
  signIdxTemplateRequest,
  verifyIdxTemplateRequest,
} from "../../packages/auth/idx-template-bridge";

const origin = "http://localhost:3000";
const path = "/v1/public/sites/11111111-1111-4111-8111-111111111111/idx-template/inquiries";
const environment = {
  APP_ENV: "test",
  DEV_AUTH_ENABLED: "true",
  IDX_TEMPLATE_WEB_ORIGINS: `${origin},http://localhost:3002`,
};
const now = 1_792_000_000_000;
const body = { name: "Synthetic visitor", email: "visitor@example.test", message: "Keep this message." };
const key = "22222222-2222-4222-8222-222222222222";

function signedRequest(env: Readonly<Record<string, string | undefined>> = environment): IdxBridgeRequest {
  vi.spyOn(Date, "now").mockReturnValue(now);
  return {
    method: "POST",
    url: path,
    body: { ...body },
    remoteAddress: "127.0.0.1",
    headers: {
      ...signIdxTemplateRequest("POST", path, origin, body, key, env),
      "idempotency-key": key,
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("public IDX bridge proof", () => {
  it("authenticates the signed origin without accepting arbitrary forwarding or member headers", () => {
    const request = signedRequest();
    request.headers = {
      ...request.headers,
      origin: "https://attacker.example.test",
      host: "attacker.example.test",
      "x-forwarded-host": "attacker.example.test",
      cookie: "estate_session=untrusted",
      "x-member-id": "untrusted-member",
    };
    expect(verifyIdxTemplateRequest(request, environment)).toBe(origin);
  });

  it.each([
    [
      "approved origin",
      (request: IdxBridgeRequest) => ({
        ...request,
        headers: { ...request.headers, "x-idx-template-origin": "http://localhost:3002" },
      }),
    ],
    [
      "unapproved origin",
      (request: IdxBridgeRequest) => ({
        ...request,
        headers: { ...request.headers, "x-idx-template-origin": "https://attacker.example.test" },
      }),
    ],
    [
      "idempotency key",
      (request: IdxBridgeRequest) => ({
        ...request,
        headers: { ...request.headers, "idempotency-key": "33333333-3333-4333-8333-333333333333" },
      }),
    ],
    [
      "message body",
      (request: IdxBridgeRequest) => ({ ...request, body: { ...body, message: "Changed after signing." } }),
    ],
    ["method", (request: IdxBridgeRequest) => ({ ...request, method: "GET" })],
    ["site path", (request: IdxBridgeRequest) => ({ ...request, url: path.replace("11111111", "44444444") })],
    ["query string", (request: IdxBridgeRequest) => ({ ...request, url: `${path}?owner=untrusted` })],
    [
      "timestamp",
      (request: IdxBridgeRequest) => ({
        ...request,
        headers: { ...request.headers, "x-idx-template-timestamp": String(now + 1) },
      }),
    ],
    [
      "signature",
      (request: IdxBridgeRequest) => ({
        ...request,
        headers: { ...request.headers, "x-idx-template-proof": "a".repeat(64) },
      }),
    ],
  ] as const)("rejects tampering with the %s", (_name, change) => {
    expect(() => verifyIdxTemplateRequest(change(signedRequest()), environment)).toThrowError(
      expect.objectContaining({ status: 403, code: "idx_bridge_proof_invalid" }),
    );
  });

  it.each(["x-idx-template-origin", "x-idx-template-timestamp", "x-idx-template-proof", "idempotency-key"])(
    "rejects duplicate %s headers rather than choosing one value",
    (header) => {
      const request = signedRequest();
      const value = request.headers[header] as string;
      request.headers = { ...request.headers, [header]: [value, value] };
      expect(() => verifyIdxTemplateRequest(request, environment)).toThrowError(
        expect.objectContaining({ status: 403, code: "idx_bridge_proof_invalid" }),
      );
    },
  );

  it("normalizes HTTP method casing and signs an absent GET body", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const headers = signIdxTemplateRequest("get", path, origin, undefined, "", environment);
    expect(
      verifyIdxTemplateRequest(
        { method: "GET", url: path, headers, remoteAddress: "127.0.0.1" },
        environment,
      ),
    ).toBe(origin);
    expect(() =>
      verifyIdxTemplateRequest(
        { method: "GET", url: path, headers, body: {}, remoteAddress: "127.0.0.1" },
        environment,
      ),
    ).toThrowError(expect.objectContaining({ status: 403 }));
  });

  it.each([-30_001, 30_001])("rejects a proof outside the freshness window (%i ms)", (elapsed) => {
    const request = signedRequest();
    vi.spyOn(Date, "now").mockReturnValue(now + elapsed);
    expect(() => verifyIdxTemplateRequest(request, environment)).toThrowError(
      expect.objectContaining({ status: 403, code: "idx_bridge_proof_invalid" }),
    );
  });

  it("allows a current proof shortly inside the freshness window", () => {
    const request = signedRequest();
    vi.spyOn(Date, "now").mockReturnValue(now + 29_999);
    expect(verifyIdxTemplateRequest(request, environment)).toBe(origin);
  });
});

describe("bridge activation and synthetic boundaries", () => {
  it.each([
    { APP_ENV: "production", DEV_AUTH_ENABLED: "true" },
    { APP_ENV: "test", DEV_AUTH_ENABLED: "false" },
    { APP_ENV: "development", DEV_AUTH_ENABLED: "false" },
    { APP_ENV: "production", IDX_TEMPLATE_BRIDGE_SECRET: "short" },
  ])("requires a configured secret outside explicitly enabled development/test: %o", (env) => {
    expect(() => idxBridgeSecret(env)).toThrowError(
      expect.objectContaining({ status: 503, code: "idx_bridge_unavailable" }),
    );
    expect(() => signIdxTemplateRequest("POST", path, origin, body, key, env)).toThrowError(
      expect.objectContaining({ status: 503, code: "idx_bridge_unavailable" }),
    );
  });

  it("cannot replay a synthetic proof against production without a configured secret", () => {
    const request = signedRequest();
    expect(() => verifyIdxTemplateRequest(request, { APP_ENV: "production" })).toThrowError(
      expect.objectContaining({ status: 503, code: "idx_bridge_unavailable" }),
    );
  });

  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])(
    "permits the explicit synthetic loopback peer %s",
    (peer) => {
      const request = signedRequest();
      expect(verifyIdxTemplateRequest({ ...request, remoteAddress: peer }, environment)).toBe(origin);
    },
  );

  it.each([undefined, "192.0.2.10", "127.0.0.2"])("denies an unapproved peer %s", (remoteAddress) => {
    const request = signedRequest();
    expect(() => verifyIdxTemplateRequest({ ...request, remoteAddress }, environment)).toThrowError(
      expect.objectContaining({ status: 403, code: "idx_bridge_peer_denied" }),
    );
  });

  it("keeps the synthetic key loopback-only even if a non-loopback peer is configured", () => {
    const env = { ...environment, IDX_TEMPLATE_BRIDGE_PEERS: "192.0.2.10" };
    const request = signedRequest(env);
    expect(() => verifyIdxTemplateRequest({ ...request, remoteAddress: "192.0.2.10" }, env)).toThrowError(
      expect.objectContaining({ status: 403, code: "idx_loopback_required" }),
    );
  });

  it("requires both a provisioned secret and an explicitly approved peer in production", () => {
    const env = {
      APP_ENV: "production",
      IDX_TEMPLATE_BRIDGE_SECRET: "synthetic-unit-fixture-provisioned-secret-0123456789",
      IDX_TEMPLATE_BRIDGE_PEERS: "192.0.2.10",
      IDX_TEMPLATE_WEB_ORIGINS: origin,
    };
    const request = signedRequest(env);
    expect(verifyIdxTemplateRequest({ ...request, remoteAddress: "192.0.2.10" }, env)).toBe(origin);
    expect(() => verifyIdxTemplateRequest(request, env)).toThrowError(
      expect.objectContaining({ status: 403, code: "idx_bridge_peer_denied" }),
    );
  });

  it.each([
    "https://user:password@example.test",
    "https://example.test/path",
    "https://example.test?host=attacker",
    "https://example.test/#fragment",
    "file:///fixture",
  ])("rejects a configured value that is not a plain HTTP(S) origin: %s", (value) => {
    expect(() => idxTemplateOrigins({ IDX_TEMPLATE_WEB_ORIGINS: value })).toThrow();
  });

  it("refuses to sign for an origin outside the approved allowlist", () => {
    expect(() =>
      signIdxTemplateRequest("POST", path, "https://attacker.example.test", body, key, environment),
    ).toThrowError(expect.objectContaining({ status: 403, code: "idx_origin_denied" }));
  });
});

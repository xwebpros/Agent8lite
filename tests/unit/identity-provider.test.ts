import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MockOidcProvider } from "../../packages/providers/identity/mock";
import type { OidcAuthorization } from "../../packages/providers/identity/port";

const clientId = "synthetic-workspace";
const redirectUri = "http://localhost:3000/api/auth/callback";
const baseTime = new Date("2026-10-10T00:00:00Z").getTime();
const verifier = () => randomBytes(48).toString("base64url");
const challenge = (value: string) => createHash("sha256").update(value).digest("base64url");

function authorization(codeVerifier: string): OidcAuthorization {
  return {
    clientId,
    redirectUri,
    codeChallenge: challenge(codeVerifier),
    codeChallengeMethod: "S256",
    state: randomBytes(32).toString("hex"),
    nonce: randomBytes(32).toString("hex"),
  };
}

function tokenFixture() {
  let clock = baseTime;
  const provider = new MockOidcProvider({
    clientId,
    redirectUris: [redirectUri],
    mode: "test",
    now: () => clock,
  });
  const codeVerifier = verifier();
  const input = authorization(codeVerifier);
  const result = new URL(provider.authorize(input, "agent"));
  const code = result.searchParams.get("code")!;
  const token = provider.exchange({ code, clientId, redirectUri, codeVerifier }).idToken;
  return {
    provider,
    token,
    input,
    setClock: (time: number) => {
      clock = time;
    },
  };
}

describe("M1 — synthetic OIDC protocol verification", () => {
  it("requires a development/test mode and loopback HTTP redirect allowlist", () => {
    expect(
      () => new MockOidcProvider({ clientId, redirectUris: [redirectUri], mode: "production" as "test" }),
    ).toThrow("SYNTHETIC_IDENTITY_DISABLED");
    for (const denied of [
      "http://example.invalid/callback",
      "http://192.168.0.1/callback",
      "https://localhost/callback",
      "http://localhost.example.invalid/callback",
    ]) {
      expect(() => new MockOidcProvider({ clientId, redirectUris: [denied], mode: "test" })).toThrow(
        "MOCK_IDENTITY_REQUIRES_LOOPBACK",
      );
    }
  });

  it("binds a one-use code to S256 verifier, exact client and redirect; preserves state", () => {
    const provider = new MockOidcProvider({
      clientId,
      redirectUris: [redirectUri],
      mode: "test",
      now: () => baseTime,
    });
    const codeVerifier = verifier();
    const input = authorization(codeVerifier);
    const response = new URL(provider.authorize(input, "owner"));
    expect(response.origin + response.pathname).toBe(redirectUri);
    expect(response.searchParams.get("state")).toBe(input.state);
    const exchange = { code: response.searchParams.get("code")!, clientId, redirectUri, codeVerifier };
    const token = provider.exchange(exchange).idToken;
    expect(provider.verifyIdentityToken(token, { clientId, nonce: input.nonce })).toEqual({
      issuer: "urn:estate:synthetic",
      subject: "owner",
      email: "owner@example.test",
      emailVerified: true,
      authenticatedAt: Math.floor(baseTime / 1000),
    });
    expect(() => provider.exchange(exchange)).toThrow("OIDC_CODE_INVALID");
  });

  it.each(["verifier", "client", "redirect"] as const)(
    "rejects a mismatched %s and consumes the attempted code",
    (field) => {
      const provider = new MockOidcProvider({
        clientId,
        redirectUris: [redirectUri],
        mode: "test",
        now: () => baseTime,
      });
      const codeVerifier = verifier();
      const input = authorization(codeVerifier);
      const response = new URL(provider.authorize(input, "agent"));
      const exchange = { code: response.searchParams.get("code")!, clientId, redirectUri, codeVerifier };
      const mismatched =
        field === "verifier"
          ? { ...exchange, codeVerifier: verifier() }
          : field === "client"
            ? { ...exchange, clientId: "other-client" }
            : { ...exchange, redirectUri: "http://localhost:3000/api/auth/other" };
      expect(() => provider.exchange(mismatched)).toThrow("OIDC_CODE_INVALID");
      expect(() => provider.exchange(exchange)).toThrow("OIDC_CODE_INVALID");
    },
  );

  it("expires authorization codes at 60 seconds", () => {
    let clock = baseTime;
    const provider = new MockOidcProvider({
      clientId,
      redirectUris: [redirectUri],
      mode: "test",
      now: () => clock,
    });
    const codeVerifier = verifier();
    const response = new URL(provider.authorize(authorization(codeVerifier), "owner"));
    clock += 60_000;
    expect(() =>
      provider.exchange({ code: response.searchParams.get("code")!, clientId, redirectUri, codeVerifier }),
    ).toThrow("OIDC_CODE_INVALID");
  });

  it("rejects weak PKCE, invalid state/nonce, wrong redirect and invented identities", () => {
    const provider = new MockOidcProvider({
      clientId,
      redirectUris: [redirectUri],
      mode: "test",
      now: () => baseTime,
    });
    const input = authorization(verifier());
    for (const mutation of [
      { codeChallengeMethod: "plain" },
      { codeChallenge: "short" },
      { state: "x".repeat(31) },
      { nonce: "x".repeat(31) },
      { state: "x".repeat(201) },
      { nonce: "x".repeat(201) },
      { redirectUri: `${redirectUri}?unregistered=true` },
      { clientId: "other-client" },
    ])
      expect(() => provider.authorize({ ...input, ...mutation } as OidcAuthorization, "owner")).toThrow(
        "OIDC_AUTHORIZATION_INVALID",
      );
    expect(() => provider.authorize(input, "unregistered" as "owner")).toThrow("OIDC_AUTHORIZATION_INVALID");
  });

  it("checks the signed nonce and configured audience before producing a verified identity", () => {
    const { provider, token, input } = tokenFixture();
    expect(() => provider.verifyIdentityToken(token, { clientId, nonce: "wrong-nonce" })).toThrow(
      "OIDC_TOKEN_INVALID",
    );
    expect(() =>
      provider.verifyIdentityToken(token, { clientId: "other-client", nonce: input.nonce }),
    ).toThrow("OIDC_TOKEN_INVALID");
    expect(provider.verifyIdentityToken(token, { clientId, nonce: input.nonce })).toMatchObject({
      issuer: provider.issuer,
      subject: "agent",
      email: "agent@example.test",
      emailVerified: true,
    });
  });

  it.each(["iss", "aud", "sub", "email_verified"] as const)(
    "rejects tampering with the signed %s claim",
    (claim) => {
      const { provider, token, input } = tokenFixture();
      const [header, encoded, signature] = token.split(".");
      const claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      claims[claim] = claim === "email_verified" ? false : "unapproved";
      const tampered = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
      expect(() => provider.verifyIdentityToken(tampered, { clientId, nonce: input.nonce })).toThrow(
        "OIDC_TOKEN_INVALID",
      );
    },
  );

  it("rejects altered signatures, unsigned tokens, untrusted issuers and malformed/oversized token input", () => {
    const { provider, token, input } = tokenFixture();
    const [header, payload, signature] = token.split(".");
    const flipped = signature[0] === "A" ? "B" : "A";
    const invalid = [
      `${header}.${payload}.${flipped}${signature.slice(1)}`,
      `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: "synthetic-v1" })).toString("base64url")}.${payload}.`,
      "not-a-jwt",
      "x".repeat(8193),
      "invalid.invalid.invalid",
    ];
    for (const value of invalid)
      expect(() => provider.verifyIdentityToken(value, { clientId, nonce: input.nonce })).toThrow(
        "OIDC_TOKEN_INVALID",
      );
    const otherIssuer = new MockOidcProvider({
      clientId,
      redirectUris: [redirectUri],
      mode: "test",
      now: () => baseTime,
    });
    expect(() => otherIssuer.verifyIdentityToken(token, { clientId, nonce: input.nonce })).toThrow(
      "OIDC_TOKEN_INVALID",
    );
  });

  it("expires tokens at 300 seconds and rejects issuance more than 30 seconds in the future", () => {
    const { provider, token, input, setClock } = tokenFixture();
    setClock(baseTime + 300_000);
    expect(() => provider.verifyIdentityToken(token, { clientId, nonce: input.nonce })).toThrow(
      "OIDC_TOKEN_INVALID",
    );
    setClock(baseTime - 31_000);
    expect(() => provider.verifyIdentityToken(token, { clientId, nonce: input.nonce })).toThrow(
      "OIDC_TOKEN_INVALID",
    );
    setClock(baseTime - 30_000);
    expect(provider.verifyIdentityToken(token, { clientId, nonce: input.nonce }).subject).toBe("agent");
  });
});

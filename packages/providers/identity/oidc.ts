import { createPublicKey, createVerify, type KeyObject } from "node:crypto";
import type { IdentityTokenVerifier, VerifiedOidcIdentity } from "./port";

interface JwksKey {
  kty: string;
  use?: string;
  kid?: string;
  alg?: string;
  n?: string;
  e?: string;
  x5c?: string[];
}

interface CachedJwks {
  keys: Map<string, KeyObject>;
  fetchedAt: number;
}

const MAX_TOKEN_LENGTH = 8192;
const JWKS_CACHE_SECONDS = 300;
const JWKS_FETCH_TIMEOUT_MS = 5000;
const MAX_CLOCK_SKEW_SECONDS = 30;

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function rsaKeyFromJwk(jwk: JwksKey): KeyObject {
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) throw new Error("OIDC_JWKS_UNSUPPORTED_KEY");
  return createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
}

export class OidcTokenVerifier implements IdentityTokenVerifier {
  private cache: CachedJwks | undefined;
  private inflight: Promise<CachedJwks> | undefined;

  constructor(
    private readonly config: {
      issuer: string;
      jwksUri: string;
      now?: () => number;
    },
  ) {
    if (!config.issuer || !config.jwksUri) throw new Error("OIDC_CONFIGURATION_INVALID");
    const url = new URL(config.jwksUri);
    if (url.protocol !== "https:") throw new Error("OIDC_JWKS_REQUIRES_HTTPS");
  }

  private now(): number {
    return Math.floor((this.config.now?.() ?? Date.now()) / 1000);
  }

  private async fetchJwks(): Promise<CachedJwks> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), JWKS_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(this.config.jwksUri, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error("OIDC_JWKS_FETCH_FAILED");
      const body = (await response.json()) as { keys?: JwksKey[] };
      if (!body?.keys || !Array.isArray(body.keys)) throw new Error("OIDC_JWKS_INVALID");
      const keys = new Map<string, KeyObject>();
      for (const jwk of body.keys) {
        if (jwk.kty !== "RSA" || (jwk.use && jwk.use !== "sig") || (jwk.alg && jwk.alg !== "RS256")) continue;
        if (!jwk.kid) continue;
        try {
          keys.set(jwk.kid, rsaKeyFromJwk(jwk));
        } catch {
          // Skip malformed keys
        }
      }
      return { keys, fetchedAt: this.now() };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getKeys(forceRefresh = false): Promise<Map<string, KeyObject>> {
    if (!forceRefresh && this.cache && this.now() - this.cache.fetchedAt < JWKS_CACHE_SECONDS) {
      return this.cache.keys;
    }
    if (!this.inflight) {
      this.inflight = this.fetchJwks().finally(() => {
        this.inflight = undefined;
      });
    }
    this.cache = await this.inflight;
    return this.cache.keys;
  }

  async verifyIdentityToken(
    token: string,
    input: { clientId: string; nonce: string },
  ): Promise<VerifiedOidcIdentity> {
    if (!token || token.length > MAX_TOKEN_LENGTH) throw new Error("OIDC_TOKEN_INVALID");
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("OIDC_TOKEN_INVALID");

    let header: { alg?: string; typ?: string; kid?: string };
    let claims: Record<string, unknown>;
    try {
      header = decodeSegment(parts[0]);
      claims = decodeSegment(parts[1]);
    } catch {
      throw new Error("OIDC_TOKEN_INVALID");
    }

    if (header.alg !== "RS256" || !header.kid) throw new Error("OIDC_TOKEN_UNSUPPORTED_ALG");

    let keys = await this.getKeys();
    let publicKey = keys.get(header.kid);
    if (!publicKey) {
      keys = await this.getKeys(true);
      publicKey = keys.get(header.kid);
    }
    if (!publicKey) throw new Error("OIDC_TOKEN_UNKNOWN_KEY");

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${parts[0]}.${parts[1]}`);
    if (!verifier.verify(publicKey, parts[2], "base64url")) throw new Error("OIDC_TOKEN_SIGNATURE_INVALID");

    const now = this.now();
    if (
      claims.iss !== this.config.issuer ||
      claims.aud !== input.clientId ||
      claims.nonce !== input.nonce ||
      typeof claims.exp !== "number" ||
      claims.exp <= now - MAX_CLOCK_SKEW_SECONDS ||
      typeof claims.iat !== "number" ||
      claims.iat > now + MAX_CLOCK_SKEW_SECONDS ||
      typeof claims.auth_time !== "number" ||
      claims.email_verified !== true ||
      typeof claims.email !== "string" ||
      !claims.email ||
      typeof claims.sub !== "string" ||
      !claims.sub
    )
      throw new Error("OIDC_TOKEN_CLAIMS_INVALID");

    return {
      issuer: String(claims.iss),
      subject: String(claims.sub),
      email: String(claims.email),
      emailVerified: true,
      authenticatedAt: claims.auth_time,
    };
  }
}

export async function discoverOidcIssuer(issuerUrl: string): Promise<{
  issuer: string;
  jwksUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}> {
  const discoveryUrl = `${issuerUrl.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JWKS_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(discoveryUrl, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error("OIDC_DISCOVERY_FAILED");
    const config = (await response.json()) as Record<string, unknown>;
    if (
      typeof config.issuer !== "string" ||
      typeof config.jwks_uri !== "string" ||
      typeof config.authorization_endpoint !== "string" ||
      typeof config.token_endpoint !== "string"
    )
      throw new Error("OIDC_DISCOVERY_INVALID");
    if (config.issuer !== issuerUrl.replace(/\/$/, "")) throw new Error("OIDC_DISCOVERY_ISSUER_MISMATCH");
    return {
      issuer: config.issuer,
      jwksUri: config.jwks_uri,
      authorizationEndpoint: config.authorization_endpoint,
      tokenEndpoint: config.token_endpoint,
    };
  } finally {
    clearTimeout(timeout);
  }
}

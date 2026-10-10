import { createHash, generateKeyPairSync, randomBytes, sign, timingSafeEqual, verify } from "node:crypto";
import type {
  IdentityTokenVerifier,
  OidcAuthorization,
  OidcTokenExchange,
  VerifiedOidcIdentity,
} from "./port";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
const equal = (left: string, right: string) =>
  left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
export type SyntheticOidcSubject = "owner" | "agent" | "staff-administrator" | "staff-support";
type PendingCode = OidcAuthorization & { subject: SyntheticOidcSubject; expiresAt: number };
const memberSubjects: readonly SyntheticOidcSubject[] = ["owner", "agent"];
const staffSubjects: readonly SyntheticOidcSubject[] = ["staff-administrator", "staff-support"];

/** Test-only OIDC issuer. It cannot authenticate a real person or contact an IdP. */
export class MockOidcProvider implements IdentityTokenVerifier {
  readonly issuer = "urn:estate:synthetic";
  private readonly keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  private readonly codes = new Map<string, PendingCode>();
  private readonly subjects: readonly SyntheticOidcSubject[];
  constructor(
    private readonly config: {
      clientId: string;
      redirectUris: readonly string[];
      now?: () => number;
      mode: "development" | "test";
      /** Trusted server configuration. A client cannot authenticate both staff and members. */
      allowedSubjects?: readonly SyntheticOidcSubject[];
    },
  ) {
    if (!["development", "test"].includes(config.mode)) throw new Error("SYNTHETIC_IDENTITY_DISABLED");
    const subjects = config.allowedSubjects ?? memberSubjects;
    if (
      !Array.isArray(subjects) ||
      subjects.length === 0 ||
      subjects.length > 2 ||
      new Set(subjects).size !== subjects.length ||
      !(
        subjects.every((subject) => memberSubjects.includes(subject)) ||
        subjects.every((subject) => staffSubjects.includes(subject))
      )
    )
      throw new Error("SYNTHETIC_IDENTITY_SUBJECTS_INVALID");
    this.subjects = Object.freeze([...subjects]);
    if (
      !config.clientId ||
      config.redirectUris.some((value) => {
        const url = new URL(value);
        return !["localhost", "127.0.0.1"].includes(url.hostname) || url.protocol !== "http:";
      })
    )
      throw new Error("MOCK_IDENTITY_REQUIRES_LOOPBACK");
  }
  private now(): number {
    return Math.floor((this.config.now?.() ?? Date.now()) / 1000);
  }
  authorize(input: OidcAuthorization, subject: SyntheticOidcSubject): string {
    if (
      !this.subjects.includes(subject) ||
      input.clientId !== this.config.clientId ||
      !this.config.redirectUris.includes(input.redirectUri) ||
      input.codeChallengeMethod !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge) ||
      input.state.length < 32 ||
      input.state.length > 200 ||
      input.nonce.length < 32 ||
      input.nonce.length > 200
    )
      throw new Error("OIDC_AUTHORIZATION_INVALID");
    for (const [code, entry] of this.codes) if (entry.expiresAt <= this.now()) this.codes.delete(code);
    if (this.codes.size >= 1000) throw new Error("OIDC_CODE_CAPACITY");
    const code = randomBytes(32).toString("base64url");
    this.codes.set(hash(code), { ...input, subject, expiresAt: this.now() + 60 });
    const url = new URL(input.redirectUri);
    url.searchParams.set("code", code);
    url.searchParams.set("state", input.state);
    return url.href;
  }
  exchange(input: OidcTokenExchange): { idToken: string } {
    const codeKey = hash(input.code);
    const pending = this.codes.get(codeKey);
    this.codes.delete(codeKey);
    if (
      !pending ||
      pending.expiresAt <= this.now() ||
      input.clientId !== pending.clientId ||
      input.redirectUri !== pending.redirectUri ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier) ||
      !equal(hash(input.codeVerifier), pending.codeChallenge)
    )
      throw new Error("OIDC_CODE_INVALID");
    const issuedAt = this.now();
    const header = encode({ alg: "RS256", typ: "JWT", kid: "synthetic-v1" });
    const payload = encode({
      iss: this.issuer,
      sub: pending.subject,
      aud: pending.clientId,
      nonce: pending.nonce,
      iat: issuedAt,
      auth_time: issuedAt,
      exp: issuedAt + 300,
      email: `${pending.subject}@example.test`,
      email_verified: true,
    });
    const data = `${header}.${payload}`;
    return {
      idToken: `${data}.${sign("RSA-SHA256", Buffer.from(data), this.keys.privateKey).toString("base64url")}`,
    };
  }
  verifyIdentityToken(token: string, input: { clientId: string; nonce: string }): VerifiedOidcIdentity {
    if (token.length > 8192 || input.clientId !== this.config.clientId) throw new Error("OIDC_TOKEN_INVALID");
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("OIDC_TOKEN_INVALID");
    let header: { alg?: string; typ?: string; kid?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      throw new Error("OIDC_TOKEN_INVALID");
    }
    if (
      header.alg !== "RS256" ||
      header.typ !== "JWT" ||
      header.kid !== "synthetic-v1" ||
      !verify(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        this.keys.publicKey,
        Buffer.from(parts[2], "base64url"),
      ) ||
      claims.iss !== this.issuer ||
      claims.aud !== input.clientId ||
      claims.nonce !== input.nonce ||
      typeof claims.exp !== "number" ||
      claims.exp <= this.now() ||
      typeof claims.iat !== "number" ||
      claims.iat > this.now() + 30 ||
      typeof claims.auth_time !== "number" ||
      claims.email_verified !== true ||
      !this.subjects.includes(claims.sub as SyntheticOidcSubject) ||
      claims.email !== `${claims.sub}@example.test`
    )
      throw new Error("OIDC_TOKEN_INVALID");
    return {
      issuer: this.issuer,
      subject: String(claims.sub),
      email: String(claims.email),
      emailVerified: true,
      authenticatedAt: claims.auth_time,
    };
  }
}

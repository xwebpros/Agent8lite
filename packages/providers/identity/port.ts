export interface VerifiedOidcIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: true;
  readonly authenticatedAt: number;
}
export interface OidcAuthorization {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
}
export interface OidcTokenExchange {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly codeVerifier: string;
}
export interface IdentityTokenVerifier {
  verifyIdentityToken(
    token: string,
    input: { clientId: string; nonce: string },
  ): VerifiedOidcIdentity | Promise<VerifiedOidcIdentity>;
}

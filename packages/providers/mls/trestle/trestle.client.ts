import type { FeedContext } from "../port";
import { digest, endpointConfig, instant, parseRetryAfter, safeText, TrestleError } from "./safety";
import type { TrestleCredentialSource, TrestleEndpointConfig } from "./types";

/** Server-only transport. Tokens are process-private and never returned as diagnostics. */
export class TrestleClient {
  readonly endpoints: ReturnType<typeof endpointConfig>;
  #fetch: typeof globalThis.fetch;
  #credentials: TrestleCredentialSource;
  #now: () => Date;
  #token: { key: string; value: string; expiresAt: number } | null = null;
  #pending: { key: string; promise: Promise<string> } | null = null;

  constructor(
    config: TrestleEndpointConfig,
    credentials: TrestleCredentialSource,
    fetch = globalThis.fetch,
    now = () => new Date(),
  ) {
    if (typeof window !== "undefined") throw new TrestleError("TRESTLE_SERVER_ONLY");
    this.endpoints = endpointConfig(config);
    this.#credentials = credentials;
    this.#fetch = fetch;
    this.#now = now;
  }

  invalidate(): void {
    this.#token = null;
  }

  async #request(url: string, init: RequestInit, maxBytes: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.endpoints.timeoutMs);
    try {
      const response = await this.#fetch(url, {
        ...init,
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) this.invalidate();
        throw new TrestleError(
          response.status === 429
            ? "TRESTLE_QUOTA_EXCEEDED"
            : response.status === 401 || response.status === 403
              ? "TRESTLE_AUTH_DENIED"
              : "TRESTLE_UPSTREAM_ERROR",
          response.status,
          parseRetryAfter(response.headers.get("retry-after"), this.#now().getTime()),
        );
      }
      if (!response.body) throw new TrestleError("TRESTLE_BAD_RESPONSE");
      const declared = response.headers.get("content-length");
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
        await response.body.cancel();
        throw new TrestleError("TRESTLE_RESPONSE_TOO_LARGE");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0;
      let text = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new TrestleError("TRESTLE_RESPONSE_TOO_LARGE");
        }
        if (controller.signal.aborted) throw new TrestleError("TRESTLE_REQUEST_TIMEOUT");
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      if (controller.signal.aborted) throw new TrestleError("TRESTLE_REQUEST_TIMEOUT");
      return text;
    } catch (error) {
      if (error instanceof TrestleError) throw error;
      throw new TrestleError(
        controller.signal.aborted ? "TRESTLE_REQUEST_TIMEOUT" : "TRESTLE_TRANSPORT_ERROR",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #bearer(context: FeedContext, guard: () => Promise<void>): Promise<string> {
    return this.#credentials.withClientCredentials(context, async (credential) => {
      const started = this.#now().getTime();
      const expiresAt = instant(credential.expiresAt);
      if (
        !Number.isFinite(started) ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= started ||
        !safeText(credential.clientId, 512) ||
        !safeText(credential.clientSecret, 4096) ||
        !safeText(credential.version)
      ) {
        this.invalidate();
        throw new TrestleError("TRESTLE_CREDENTIAL_NOT_READY");
      }
      const key = digest([
        context.organizationId,
        context.feedId,
        credential.version,
        credential.clientId,
        credential.clientSecret,
        credential.expiresAt,
      ]);
      if (this.#token?.key === key && this.#token.expiresAt > started + 30000) return this.#token.value;
      if (this.#pending?.key === key) return this.#pending.promise;
      const promise = (async () => {
        await guard();
        const body = new URLSearchParams({
          client_id: credential.clientId,
          client_secret: credential.clientSecret,
          grant_type: "client_credentials",
          scope: "api",
        });
        const text = await this.#request(
          this.endpoints.tokenUrl,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
            body: body.toString(),
          },
          16384,
        );
        let token: unknown;
        try {
          token = JSON.parse(text);
        } catch {
          throw new TrestleError("TRESTLE_BAD_TOKEN_RESPONSE");
        }
        if (!token || typeof token !== "object" || Array.isArray(token))
          throw new TrestleError("TRESTLE_BAD_TOKEN_RESPONSE");
        const fields = token as Record<string, unknown>;
        if (
          typeof fields.access_token !== "string" ||
          fields.access_token.length > 12000 ||
          !/^[A-Za-z0-9._~+/-]+=*$/.test(fields.access_token) ||
          fields.token_type !== "Bearer" ||
          typeof fields.expires_in !== "number" ||
          !Number.isInteger(fields.expires_in) ||
          fields.expires_in <= 30 ||
          fields.expires_in > 86400
        )
          throw new TrestleError("TRESTLE_BAD_TOKEN_RESPONSE");
        const expiry = Math.min(started + fields.expires_in * 1000, expiresAt);
        if (expiry <= this.#now().getTime() + 30000) throw new TrestleError("TRESTLE_CREDENTIAL_NOT_READY");
        this.#token = { key, value: fields.access_token, expiresAt: expiry };
        return fields.access_token;
      })();
      this.#pending = { key, promise };
      try {
        return await promise;
      } finally {
        if (this.#pending?.promise === promise) this.#pending = null;
      }
    });
  }

  async get(
    context: FeedContext,
    url: string,
    metadata: boolean,
    guard: () => Promise<void>,
  ): Promise<string> {
    const target = new URL(url);
    const base = new URL(this.endpoints.odataBaseUrl);
    if (
      target.origin !== base.origin ||
      target.username ||
      target.password ||
      target.hash ||
      target.pathname !== `${base.pathname}${metadata ? "$metadata" : "Property"}`
    )
      throw new TrestleError("TRESTLE_ENDPOINT_DENIED");
    await guard();
    const token = await this.#bearer(context, guard);
    await guard();
    return this.#request(
      target.href,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: metadata ? "application/xml" : "application/json",
        },
      },
      metadata ? 4 * 1024 * 1024 : 2 * 1024 * 1024,
    );
  }
}

export class EnvironmentTrestleCredentials implements TrestleCredentialSource {
  #environment: NodeJS.ProcessEnv;
  #organizationId: string;
  #feedId: string;
  constructor(binding: Pick<FeedContext, "organizationId" | "feedId">, environment = process.env) {
    if (typeof window !== "undefined") throw new TrestleError("TRESTLE_SERVER_ONLY");
    this.#organizationId = binding.organizationId;
    this.#feedId = binding.feedId;
    this.#environment = environment;
  }
  async withClientCredentials<T>(
    context: FeedContext,
    run: (
      credential: Readonly<{ clientId: string; clientSecret: string; version: string; expiresAt: string }>,
    ) => Promise<T>,
  ): Promise<T> {
    if (context.organizationId !== this.#organizationId || context.feedId !== this.#feedId)
      throw new TrestleError("TRESTLE_CREDENTIAL_SCOPE_DENIED");
    const {
      TRESTLE_CLIENT_ID,
      TRESTLE_CLIENT_SECRET,
      TRESTLE_CREDENTIAL_VERSION,
      TRESTLE_CREDENTIAL_EXPIRES_AT,
    } = this.#environment;
    if (
      !TRESTLE_CLIENT_ID ||
      !TRESTLE_CLIENT_SECRET ||
      !TRESTLE_CREDENTIAL_VERSION ||
      !TRESTLE_CREDENTIAL_EXPIRES_AT
    )
      throw new TrestleError("TRESTLE_CREDENTIAL_NOT_READY");
    return run({
      clientId: TRESTLE_CLIENT_ID,
      clientSecret: TRESTLE_CLIENT_SECRET,
      version: TRESTLE_CREDENTIAL_VERSION,
      expiresAt: TRESTLE_CREDENTIAL_EXPIRES_AT,
    });
  }
}

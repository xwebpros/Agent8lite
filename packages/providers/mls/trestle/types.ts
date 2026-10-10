import type { FeedContext, MlsPolicy } from "../port";

/** Internal server port. The resolver uses verified context and current feed state. */
export interface TrestleFeedAuthorization {
  readonly organizationId: string;
  readonly feedId: string;
  readonly policyVersion: string;
  readonly revision: string;
  readonly connectionState: "pending" | "approved" | "suspended" | "terminated";
  readonly brokerAuthorization: "unknown" | "pending" | "approved" | "not_required";
  readonly originatingSystemIds: readonly string[];
  /** Source fields verified against this licensed feed's metadata, not public catalog defaults. */
  readonly observedPropertyFields: readonly string[];
  readonly policy: MlsPolicy;
}

export interface TrestleAuthorizationSource {
  current(context: FeedContext): Promise<TrestleFeedAuthorization | null>;
}

/** Version changes/rotation invalidate process-local OAuth tokens. No serialized credentials. */
export interface TrestleCredentialSource {
  withClientCredentials<T>(
    context: FeedContext,
    run: (credential: Readonly<{
      clientId: string;
      clientSecret: string;
      version: string;
      expiresAt: string;
    }>) => Promise<T>,
  ): Promise<T>;
}

export interface TrestleEndpointConfig {
  readonly tokenUrl: string;
  readonly odataBaseUrl: string;
  readonly timeoutMs?: number;
  readonly pageSize?: number;
}

export interface TrestleAdapterOptions {
  readonly enabled: boolean;
  readonly endpoints: TrestleEndpointConfig;
  readonly authorization: TrestleAuthorizationSource;
  readonly credentials: TrestleCredentialSource;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

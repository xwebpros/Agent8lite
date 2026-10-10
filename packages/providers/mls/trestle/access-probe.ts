import { createHash } from "node:crypto";
import { safeText, TrestleError } from "./safety";
import { TrestleAdapter } from "./trestle.adapter";
import { EnvironmentTrestleCredentials } from "./trestle.client";
import type { TrestleEndpointConfig, TrestleFeedAuthorization } from "./types";

export interface TrestleAccessConfig {
  organizationId: string;
  feedId: string;
  productId: string;
  mlsName: string;
  feedType: string;
  connectionState: "pending" | "approved" | "suspended" | "terminated";
  brokerAuthorization: "unknown" | "pending" | "approved" | "not_required";
  endpoints: TrestleEndpointConfig;
}

/** Operator-only approval record for an isolated probe; never an application policy resolver. */
function accessConfig(value: unknown): TrestleAccessConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TrestleError("TRESTLE_ACCESS_CONFIG_INVALID");
  const config = value as TrestleAccessConfig;
  for (const key of ["organizationId", "feedId", "productId", "mlsName", "feedType"] as const) {
    if (!safeText(config[key]) || config[key].startsWith("REPLACE_"))
      throw new TrestleError("TRESTLE_ACCESS_CONFIG_INVALID");
  }
  if (!config.endpoints || typeof config.endpoints !== "object")
    throw new TrestleError("TRESTLE_ACCESS_CONFIG_INVALID");
  return config;
}

export async function probeTrestleAccess(input: {
  enabled: boolean;
  environment: NodeJS.ProcessEnv;
  readConfig: () => Promise<unknown>;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}): Promise<
  | { state: "disabled"; code: string }
  | { state: "accessible"; protocol: "reso-web-api"; metadataBytes: number; metadataSha256: string }
> {
  if (!input.enabled || input.environment.TRESTLE_ACCESS_TEST_ENABLED !== "true")
    return { state: "disabled", code: "TRESTLE_ACCESS_TEST_NOT_ENABLED" };
  const config = accessConfig(await input.readConfig());
  const context = {
    organizationId: config.organizationId,
    feedId: config.feedId,
    policyVersion: "access-probe-v1",
  };
  const authorization: TrestleFeedAuthorization = {
    ...context,
    revision: "access-probe-v1",
    connectionState: config.connectionState,
    brokerAuthorization: config.brokerAuthorization,
    originatingSystemIds: [],
    observedPropertyFields: [],
    policy: {
      approvalState: "unapproved",
      rights: {
        display: "unknown",
        replicate: "unknown",
        cache: "unknown",
        storeMedia: "unknown",
        alerts: "unknown",
        aiUse: "unknown",
      },
      allowedFields: [],
      addressRule: "hidden",
      locationRule: "hidden",
      maxDataAgeSeconds: null,
      maxCacheAgeSeconds: null,
      retentionDays: null,
      attributionText: "",
      attributionLogoAssetId: null,
      disclaimerVersion: "unverified",
    },
  };
  const adapter = new TrestleAdapter({
    enabled: true,
    endpoints: config.endpoints,
    authorization: { current: async () => authorization },
    credentials: new EnvironmentTrestleCredentials(context, input.environment),
    fetch: input.fetch,
    now: input.now,
  });
  const xml = await adapter.readMetadata(context);
  return {
    state: "accessible",
    protocol: "reso-web-api",
    metadataBytes: Buffer.byteLength(xml, "utf8"),
    metadataSha256: createHash("sha256").update(xml).digest("hex"),
  };
}

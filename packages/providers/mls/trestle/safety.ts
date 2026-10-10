import { createHash } from "node:crypto";
import type { FeedContext } from "../port";
import type { TrestleEndpointConfig, TrestleFeedAuthorization } from "./types";

export class TrestleError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(code);
    this.name = "TrestleError";
  }
}

export const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function instant(value: string): number {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return Number.NaN;
  const parsed = Date.parse(value);
  const normalized = value.replace(
    /(?:\.(\d{1,3}))?Z$/,
    (_match, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0")}Z`,
  );
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === normalized ? parsed : Number.NaN;
}

export function safeText(value: unknown, limit = 255): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= limit &&
    !/[\x00-\x1f\x7f]/.test(value)
    ? value
    : null;
}

export function endpointConfig(input: TrestleEndpointConfig) {
  const hosts = new Set(["api.cotality.com", "api-trestle.corelogic.com", "apiprod.corelogic.com"]);
  const check = (value: string, path: string) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new TrestleError("TRESTLE_ENDPOINT_DENIED");
    }
    if (
      url.protocol !== "https:" ||
      !hosts.has(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== path
    )
      throw new TrestleError("TRESTLE_ENDPOINT_DENIED");
    return url.href;
  };
  const timeoutMs = input.timeoutMs ?? 10000;
  const pageSize = input.pageSize ?? 20;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 30000 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    throw new TrestleError("TRESTLE_INVALID_BOUNDS");
  return Object.freeze({
    tokenUrl: check(input.tokenUrl, "/trestle/oidc/connect/token"),
    odataBaseUrl: check(input.odataBaseUrl, "/trestle/odata/"),
    timeoutMs,
    pageSize,
  });
}

export function authorizeFeed(
  context: FeedContext,
  value: TrestleFeedAuthorization | null,
  display: boolean,
): TrestleFeedAuthorization {
  if (
    !value ||
    !safeText(context.organizationId) ||
    !safeText(context.feedId) ||
    !safeText(context.policyVersion) ||
    value.organizationId !== context.organizationId ||
    value.feedId !== context.feedId ||
    value.policyVersion !== context.policyVersion ||
    !safeText(value.revision) ||
    value.connectionState !== "approved" ||
    !["approved", "not_required"].includes(value.brokerAuthorization) ||
    !Array.isArray(value.originatingSystemIds) ||
    value.originatingSystemIds.length > 20 ||
    value.originatingSystemIds.some((id) => !safeText(id)) ||
    !Array.isArray(value.observedPropertyFields) ||
    value.observedPropertyFields.some((field) => !safeText(field)) ||
    !value.policy ||
    value.policy.approvalState === "revoked"
  )
    throw new TrestleError("TRESTLE_FEED_NOT_AUTHORIZED");
  if (
    display &&
    (value.originatingSystemIds.length === 0 ||
      value.policy.approvalState !== "approved" ||
      value.policy.rights?.display !== "allowed" ||
      !Array.isArray(value.policy.allowedFields) ||
      !value.policy.allowedFields.includes("status") ||
      !safeText(value.policy.attributionText, 8000) ||
      !Number.isInteger(value.policy.maxDataAgeSeconds) ||
      value.policy.maxDataAgeSeconds === null ||
      value.policy.maxDataAgeSeconds < 1 ||
      value.policy.maxDataAgeSeconds > 86400)
  )
    throw new TrestleError("TRESTLE_DISPLAY_POLICY_DENIED");
  return structuredClone(value);
}

export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(3600, Math.ceil(seconds)) : null;
}

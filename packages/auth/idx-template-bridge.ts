import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { AccessError } from "../db/tenant-transaction";

export type IdxBridgeRequest = {
  method: string;
  url: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body?: unknown;
  remoteAddress?: string;
};
const fixtureKey = "synthetic-loopback-idx-template-bridge-only-2026";
export function idxBridgeSecret(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = environment.IDX_TEMPLATE_BRIDGE_SECRET;
  if (configured && configured.length >= 32) return configured;
  if (["development", "test"].includes(environment.APP_ENV ?? "") && environment.DEV_AUTH_ENABLED === "true")
    return fixtureKey;
  throw new AccessError(503, "idx_bridge_unavailable", "The public template bridge is not configured.");
}
export function idxTemplateOrigins(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Set<string> {
  const text =
    environment.IDX_TEMPLATE_WEB_ORIGINS ??
    environment.WEB_ORIGIN ??
    "http://localhost:3000,http://127.0.0.1:3000";
  return new Set(
    text.split(",").map((value) => {
      const url = new URL(value.trim());
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error("IDX template origins must be plain HTTP(S) origins.");
      return url.origin;
    }),
  );
}
function normalizedBody(body: unknown): string {
  return body === undefined ? "" : JSON.stringify(body);
}
function payload(method: string, url: string, origin: string, timestamp: string, key: string, body: unknown) {
  return [
    method.toUpperCase(),
    url,
    origin,
    timestamp,
    key,
    createHash("sha256").update(normalizedBody(body)).digest("hex"),
  ].join("\n");
}
export function signIdxTemplateRequest(
  method: string,
  url: string,
  origin: string,
  body: unknown,
  key = "",
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (!idxTemplateOrigins(environment).has(origin))
    throw new AccessError(403, "idx_origin_denied", "This template origin is not configured.");
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", idxBridgeSecret(environment))
    .update(payload(method, url, origin, timestamp, key, body))
    .digest("hex");
  return {
    "x-idx-template-origin": origin,
    "x-idx-template-timestamp": timestamp,
    "x-idx-template-proof": signature,
  };
}
export function verifyIdxTemplateRequest(
  request: IdxBridgeRequest,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const peers = (environment.IDX_TEMPLATE_BRIDGE_PEERS ?? "127.0.0.1,::1,::ffff:127.0.0.1")
    .split(",")
    .map((value) => value.trim());
  if (peers.some((peer) => !isIP(peer)) || !peers.includes(request.remoteAddress ?? ""))
    throw new AccessError(403, "idx_bridge_peer_denied", "A trusted private template peer is required.");
  const header = (name: string) => {
    const value = request.headers[name];
    return typeof value === "string" ? value : "";
  };
  const origin = header("x-idx-template-origin");
  const timestamp = header("x-idx-template-timestamp");
  const proof = header("x-idx-template-proof");
  if (
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(Date.now() - Number(timestamp)) > 30_000 ||
    !/^[0-9a-f]{64}$/.test(proof) ||
    !idxTemplateOrigins(environment).has(origin)
  )
    throw new AccessError(403, "idx_bridge_proof_invalid", "A current trusted template origin is required.");
  const expected = createHmac("sha256", idxBridgeSecret(environment))
    .update(payload(request.method, request.url, origin, timestamp, header("idempotency-key"), request.body))
    .digest();
  const actual = Buffer.from(proof, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new AccessError(403, "idx_bridge_proof_invalid", "A current trusted template origin is required.");
  if (
    idxBridgeSecret(environment) === fixtureKey &&
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.remoteAddress ?? "")
  )
    throw new AccessError(403, "idx_loopback_required", "Synthetic template capture is loopback-only.");
  return origin;
}

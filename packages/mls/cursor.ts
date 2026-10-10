import { createHmac, timingSafeEqual } from "node:crypto";
import { isUuid, MlsReadError } from "./contracts";

const MAX_CURSOR_AGE_MS = 15 * 60 * 1000;
const invalid = () =>
  new MlsReadError(422, "cursor_invalid", "Pagination expired or does not match the current search.");
function requireKey(key: string) {
  if (typeof key !== "string" || Buffer.byteLength(key) < 32)
    throw new MlsReadError(503, "cursor_unconfigured", "Pagination signing is unavailable.");
}

export function encodeListingCursor(
  id: string,
  binding: string,
  now: Date,
  listingExpiry: number,
  key: string,
): string {
  requireKey(key);
  const expires = Math.min(now.getTime() + MAX_CURSOR_AGE_MS, listingExpiry);
  if (!isUuid(id) || !Number.isFinite(expires) || expires <= now.getTime()) throw invalid();
  const body = Buffer.from(JSON.stringify({ v: 1, id, binding, expires })).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

export function decodeListingCursor(value: unknown, binding: string, now: Date, key: string): string | null {
  if (value === undefined || value === null) return null;
  requireKey(key);
  try {
    if (
      typeof value !== "string" ||
      value.length > 2048 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) ||
      !Number.isFinite(now.getTime())
    )
      throw invalid();
    const [body, signature] = value.split(".");
    const expected = createHmac("sha256", key).update(body).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw invalid();
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid();
    const payload = parsed as Record<string, unknown>;
    if (
      Object.keys(payload).sort().join(",") !== "binding,expires,id,v" ||
      payload.v !== 1 ||
      payload.binding !== binding ||
      !isUuid(payload.id) ||
      typeof payload.expires !== "number" ||
      !Number.isFinite(payload.expires) ||
      payload.expires <= now.getTime() ||
      payload.expires > now.getTime() + MAX_CURSOR_AGE_MS
    )
      throw invalid();
    return payload.id;
  } catch {
    throw invalid();
  }
}

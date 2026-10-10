import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AccessError, type TenantContext } from "../../../packages/db/tenant-transaction";

const cursorKey =
  process.env.CURSOR_SIGNING_KEY ??
  (["development", "test"].includes(process.env.APP_ENV ?? "")
    ? "synthetic-local-cursor-signing-only-not-for-production"
    : "");
function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function cursorBinding(
  context: TenantContext,
  resource: string,
  scope: string,
  filter: unknown,
  sort = "id:asc",
) {
  return digest(
    JSON.stringify({
      tenant: context.organizationId,
      actor: context.userId,
      member: context.memberId,
      role: context.roleId,
      permissions: context.permissions,
      resource,
      scope,
      sort,
      filter,
    }),
  );
}
export function encodeCursor(id: string, binding: string) {
  if (!cursorKey) throw new AccessError(503, "cursor_unconfigured", "Pagination signing key is unavailable.");
  const body = Buffer.from(JSON.stringify({ id, binding, expires: Date.now() + 15 * 60 * 1000 })).toString(
    "base64url",
  );
  return `${body}.${createHmac("sha256", cursorKey).update(body).digest("base64url")}`;
}
export function decodeCursor(value: unknown, binding: string): string | null {
  if (!value) return null;
  try {
    if (!cursorKey || typeof value !== "string" || value.length > 4096) throw new Error();
    const parts = value.split(".");
    if (parts.length !== 2) throw new Error();
    const expected = createHmac("sha256", cursorKey).update(parts[0]).digest();
    const supplied = Buffer.from(parts[1], "base64url");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error();
    const body = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (
      body.binding !== binding ||
      !Number.isFinite(body.expires) ||
      body.expires < Date.now() ||
      typeof body.id !== "string"
    )
      throw new Error();
    return body.id;
  } catch {
    throw new AccessError(422, "cursor_invalid", "Pagination cursor expired or does not match this query.");
  }
}

import type { Pool } from "pg";
import type { ServerSession } from "../../../../packages/auth/sessions";
import { AccessError, withTenantTransaction } from "../../../../packages/db/tenant-transaction";
import { isUuid } from "../../../../packages/mls/contracts";
import { assertNativeMockMode, NativeMockReadService } from "./service";

export interface NativeMockReadRequest {
  path: string;
  method: string;
  query: unknown;
  body?: unknown;
  remoteAddress: string | undefined;
  forwardedFor?: string | readonly string[];
}
const loopback = (address: string | undefined) =>
  address !== undefined && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);

/** Root calls after its shared session/rate/no-store guards. This export registers no routes. */
export async function tryNativeMockRead(
  request: NativeMockReadRequest,
  session: ServerSession,
  pool: Pool,
  options: { signingKey: string; environment?: Readonly<Record<string, string | undefined>> },
) {
  const match = request.path.match(/^\/dev\/orgs\/([^/]+)\/mls\/listings(?:\/([^/]+))?$/);
  if (!match || request.method !== "GET") return null;
  assertNativeMockMode(options.environment);
  if (
    !loopback(request.remoteAddress) ||
    (request.forwardedFor !== undefined &&
      (Array.isArray(request.forwardedFor) ||
        String(request.forwardedFor)
          .split(",")
          .some((value) => !loopback(value.trim()))))
  )
    throw new AccessError(403, "loopback_required", "Synthetic property reads require loopback.");
  const [, orgId, listingId] = match;
  if (!isUuid(orgId)) throw new AccessError(422, "query_invalid", "The organization identifier is invalid.");
  if (orgId !== session.organizationId)
    throw new AccessError(
      403,
      "active_organization_mismatch",
      "Select this organization before accessing its records.",
    );
  if (request.body !== undefined)
    throw new AccessError(422, "query_invalid", "Property reads do not accept a request body.");
  return withTenantTransaction(pool, session, async (client, context) => {
    const service = new NativeMockReadService(client, context, options);
    return listingId
      ? { schema: "Listing" as const, body: await service.detail(listingId, request.query) }
      : { schema: "PageListing" as const, body: await service.list(request.query) };
  });
}

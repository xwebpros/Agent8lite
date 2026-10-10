import type { components } from "../../../../packages/contracts/generated/api";
import { AccessError } from "../../../../packages/db/tenant-transaction";
import { validateSchema } from "../contract-validation";

export type Campaign = components["schemas"]["Campaign"];
export type CampaignWrite = components["schemas"]["CampaignWrite"];
export type CampaignPage = components["schemas"]["PageCampaign"];
export type CampaignCommandHeaders = { key: string | undefined; ifMatch?: string };
export type CampaignQuery = Record<string, unknown>;

export function campaignInput(value: CampaignWrite): CampaignWrite {
  validateSchema("CampaignWrite", value);
  const name = value.name.trim();
  const category = value.category.trim();
  if (!name || !category)
    throw new AccessError(422, "campaign_text_required", "Campaign name and category cannot be blank.");
  return { name, category };
}

export function campaignRevision(header: string | undefined): number {
  if (!header || !/^"[1-9][0-9]*"$/.test(header))
    throw new AccessError(400, "revision_required", "A strong numeric If-Match revision is required.");
  const revision = Number(header.slice(1, -1));
  if (!Number.isSafeInteger(revision))
    throw new AccessError(400, "revision_required", "A strong numeric If-Match revision is required.");
  return revision;
}

export function campaignKey(key: string | undefined): string {
  if (!key || key.length > 100 || !/^[\x21-\x7e]+$/.test(key))
    throw new AccessError(400, "idempotency_required", "A printable Idempotency-Key is required.");
  return key;
}

export function campaignPagination(query: CampaignQuery): { limit: number; cursor: string | undefined } {
  if (Object.keys(query).some((key) => !["cursor", "limit"].includes(key)))
    throw new AccessError(422, "query_invalid", "Unsupported campaign query.");
  const rawLimit = query.limit;
  if (
    rawLimit !== undefined &&
    !((typeof rawLimit === "string" && /^[1-9][0-9]*$/.test(rawLimit)) || typeof rawLimit === "number")
  )
    throw new AccessError(422, "limit_invalid", "Limit must be an integer between 1 and 100.");
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new AccessError(422, "limit_invalid", "Limit must be an integer between 1 and 100.");
  const cursor = query.cursor;
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 4096))
    throw new AccessError(422, "cursor_invalid", "A scalar pagination cursor is required.");
  return { limit, cursor };
}

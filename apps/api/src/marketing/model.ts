import { AccessError } from "../../../../packages/db/tenant-transaction";
import { validateSchema } from "../contract-validation";
import type { Campaign } from "./input";

/** Private persistence shape; published API types come only from the frozen contract. */
export type CampaignRow = {
  id: string;
  name: string;
  category: string;
  state: Campaign["state"];
  row_version: string;
};

export function campaignModel(row: CampaignRow): Campaign {
  const version = Number(row.row_version);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new AccessError(503, "campaign_revision_unavailable", "Campaign revision is unavailable.");
  const model: Campaign = {
    id: row.id,
    name: row.name,
    category: row.category,
    state: row.state,
    version,
  };
  validateSchema("Campaign", model, true);
  return model;
}

export function campaignEtag(version: number): string {
  if (!Number.isSafeInteger(version) || version < 1)
    throw new AccessError(503, "campaign_revision_unavailable", "Campaign revision is unavailable.");
  return `"${version}"`;
}

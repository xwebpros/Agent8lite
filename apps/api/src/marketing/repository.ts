import type { PoolClient } from "pg";
import type { CampaignWrite } from "./input";
import type { CampaignRow } from "./model";

/** Marketing-owned metadata only, within the caller's verified transaction. */
export class CampaignDraftRepository {
  constructor(private readonly client: PoolClient) {}

  async draft(id: string, lock: "read" | "write" = "read"): Promise<CampaignRow | undefined> {
    const result = await this.client.query<CampaignRow>(
      `SELECT id,name,category,state,row_version FROM app.campaign
       WHERE tenant_id=app.current_tenant() AND id=$1 AND state='draft'
       ${lock === "write" ? "FOR UPDATE" : "FOR SHARE"}`,
      [id],
    );
    return result.rows[0];
  }

  async list(after: string | null, limit: number): Promise<CampaignRow[]> {
    const result = await this.client.query<CampaignRow>(
      `SELECT id,name,category,state,row_version FROM app.campaign
       WHERE tenant_id=app.current_tenant() AND state='draft' AND ($1::uuid IS NULL OR id>$1)
       ORDER BY id LIMIT $2 FOR SHARE`,
      [after, limit],
    );
    return result.rows;
  }

  async create(input: CampaignWrite): Promise<CampaignRow> {
    const result = await this.client.query<CampaignRow>(
      `INSERT INTO app.campaign(tenant_id,name,category,state)
       VALUES(app.current_tenant(),$1,$2,'draft') RETURNING id,name,category,state,row_version`,
      [input.name, input.category],
    );
    return result.rows[0];
  }

  async update(id: string, expected: number, input: CampaignWrite): Promise<CampaignRow | undefined> {
    const result = await this.client.query<CampaignRow>(
      `UPDATE app.campaign SET name=$1,category=$2,row_version=row_version+1,updated_at=clock_timestamp()
       WHERE tenant_id=app.current_tenant() AND id=$3 AND row_version=$4 AND state='draft'
       RETURNING id,name,category,state,row_version`,
      [input.name, input.category, id, expected],
    );
    return result.rows[0];
  }
}

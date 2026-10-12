import type { PoolClient } from "pg";

export async function findOrCreateContact(
  client: PoolClient,
  tenantId: string,
  memberId: string,
  email: string,
  displayName: string,
  phone?: string,
): Promise<string> {
  const normalizedEmail = email.trim().toLowerCase();
  const existing = await client.query(
    "SELECT contact_id FROM app.contact_channel WHERE tenant_id=$1 AND kind='email' AND normalized_value=$2 AND active=true LIMIT 1",
    [tenantId, normalizedEmail],
  );
  if (existing.rowCount) return existing.rows[0].contact_id;
  const contact = await client.query(
    "INSERT INTO app.contact(tenant_id,display_name,created_by_member_id) VALUES($1,$2,$3) RETURNING id",
    [tenantId, (displayName.trim() || "Public Visitor").slice(0, 120), memberId],
  );
  const contactId: string = contact.rows[0].id;
  await client.query(
    "INSERT INTO app.contact_channel(tenant_id,contact_id,kind,normalized_value,is_primary) VALUES($1,$2,'email',$3,true)",
    [tenantId, contactId, normalizedEmail],
  );
  if (phone) {
    const normalizedPhone = phone.trim().replace(/[\s().-]/g, "");
    if (/^\+?[0-9]{7,15}$/.test(normalizedPhone))
      await client.query(
        "INSERT INTO app.contact_channel(tenant_id,contact_id,kind,normalized_value,is_primary) VALUES($1,$2,'phone',$3,false) ON CONFLICT DO NOTHING",
        [tenantId, contactId, normalizedPhone],
      );
  }
  return contactId;
}

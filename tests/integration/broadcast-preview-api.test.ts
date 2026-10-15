import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BroadcastPreviewService,
  broadcastAudienceLimit,
} from "../../apps/api/src/marketing/broadcast-preview-service";
import { fixtures, stageId } from "../../packages/db/fixtures";
import { assertRuntimeRole } from "../../packages/db/runtime-role";
import {
  withTenantTransaction,
  type PermissionGrant,
  type TenantContext,
  type VerifiedIdentityContext,
} from "../../packages/db/tenant-transaction";
import { ApiSession, assertContract, assertProblem, type Schemas } from "../helpers/api";

for (const variable of ["TEST_DATABASE_URL", "TEST_MIGRATION_DATABASE_URL"]) {
  const url = new URL(process.env[variable] ?? "http://missing.invalid");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/estate_acceptance_[a-f0-9]{16}$/.test(url.pathname)
  )
    throw new Error("Broadcast preview acceptance requires the owned disposable isolated batch runner.");
}

const runtime = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL, max: 4 });
const ownerA: VerifiedIdentityContext = { userId: fixtures.ownerUser, organizationId: fixtures.orgA };
const route = `POST /v1/orgs/${fixtures.orgA}/broadcast-previews`;
const path = `/v1/orgs/${fixtures.orgA}/broadcast-previews`;
type Request = Schemas["BroadcastRequest"];
const fullGrants: PermissionGrant[] = [
  { code: "campaigns.send", scope: "organization" },
  { code: "campaigns.read", scope: "organization" },
  { code: "crm.leads.read", scope: "organization" },
  { code: "crm.contacts.read", scope: "organization" },
  { code: "crm.tags.read", scope: "organization" },
  { code: "crm.pipeline.read", scope: "organization" },
  { code: "crm.sources.read", scope: "organization" },
  { code: "members.read", scope: "organization" },
];
let ownerHttp: ApiSession;

async function use<T>(
  identity: VerifiedIdentityContext,
  operation: (service: BroadcastPreviewService, client: PoolClient, context: TenantContext) => Promise<T>,
) {
  return withTenantTransaction(runtime, identity, (client, context) =>
    operation(new BroadcastPreviewService(client, context, randomUUID()), client, context),
  );
}
const preview = (body: unknown, key: string = randomUUID(), identity: VerifiedIdentityContext = ownerA) =>
  use(identity, (service) => service.preview(body, key, route));

async function actor(grants: PermissionGrant[]): Promise<VerifiedIdentityContext> {
  const userId = randomUUID(),
    memberId = randomUUID(),
    roleId = randomUUID();
  await admin.query(
    "INSERT INTO app.user_identity(id,issuer,subject,display_name,email_verified)VALUES($1,'urn:estate:synthetic',$2,'Synthetic broadcast actor',true)",
    [userId, randomUUID()],
  );
  await admin.query(
    "INSERT INTO app.role_definition(tenant_id,id,name,permission_grants)VALUES($1,$2,$3,$4)",
    [fixtures.orgA, roleId, "Synthetic broadcast role " + randomUUID(), JSON.stringify(grants)],
  );
  await admin.query(
    "INSERT INTO app.membership(tenant_id,id,user_id,role_id,status,display_name)VALUES($1,$2,$3,$4,'active','Synthetic broadcast member')",
    [fixtures.orgA, memberId, userId, roleId],
  );
  return { userId, organizationId: fixtures.orgA };
}

async function design(channel: "email" | "sms", tenant: string = fixtures.orgA) {
  const id = randomUUID(),
    text = "Synthetic broadcast message " + randomUUID();
  await admin.query(
    "INSERT INTO app.message_design(tenant_id,id,name,channel,version,editor_kind,design,rendered_content,content_hash)VALUES($1,$2,'Synthetic broadcast design',$3,1,'native',$4,$5,$6)",
    [
      tenant,
      id,
      channel,
      JSON.stringify({ schemaVersion: 1, blocks: [{ type: "text", text }] }),
      text,
      createHash("sha256").update(text).digest("hex"),
    ],
  );
  return id;
}

async function tag(tenant: string = fixtures.orgA) {
  const id = randomUUID();
  await admin.query("INSERT INTO app.tag(tenant_id,id,name)VALUES($1,$2,$3)", [
    tenant,
    id,
    "Synthetic broadcast segment " + id,
  ]);
  return id;
}

async function contact(name = "Synthetic broadcast contact " + randomUUID()) {
  const id = randomUUID();
  await admin.query(
    "INSERT INTO app.contact(tenant_id,id,display_name,created_by_member_id)VALUES($1,$2,$3,$4)",
    [fixtures.orgA, id, name, fixtures.ownerMemberA],
  );
  return id;
}

async function channel(contactId: string, kind: "email" | "phone", value: string, primary = true) {
  const id = randomUUID();
  await admin.query(
    "INSERT INTO app.contact_channel(tenant_id,id,contact_id,kind,normalized_value,is_primary)VALUES($1,$2,$3,$4,$5,$6)",
    [fixtures.orgA, id, contactId, kind, value, primary],
  );
  return id;
}

async function lead(
  contactId: string,
  tagId: string,
  options: { intent?: string; archived?: boolean; owner?: string } = {},
) {
  const id = randomUUID();
  await admin.query(
    "INSERT INTO app.lead(tenant_id,id,contact_id,source_id,stage_id,owner_member_id,intent,archived_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      fixtures.orgA,
      id,
      contactId,
      fixtures.sourceA,
      stageId(1, 1),
      options.owner ?? fixtures.ownerMemberA,
      options.intent ?? "buyer",
      options.archived ? new Date() : null,
    ],
  );
  await admin.query("INSERT INTO app.lead_tag(tenant_id,lead_id,tag_id)VALUES($1,$2,$3)", [
    fixtures.orgA,
    id,
    tagId,
  ]);
  return id;
}

let sequence = 0;
async function grant(channelId: string, purpose: string) {
  const evidence = randomUUID(),
    event = randomUUID();
  await admin.query(
    "INSERT INTO app.consent_evidence(tenant_id,id,contact_channel_id,purpose,policy_version,provenance,state_version,channel_version,contact_version,initiating_member_id,expires_at)VALUES($1,$2,$3,$4,'synthetic-communication-v1','synthetic-local',1,1,1,$5,clock_timestamp()+interval '10 minutes')",
    [fixtures.orgA, evidence, channelId, purpose, fixtures.ownerMemberA],
  );
  await admin.query(
    "INSERT INTO app.consent_event(tenant_id,id,contact_channel_id,purpose,action,policy_version,evidence_ref,occurred_at,consent_sequence,initiating_member_id,evidence_id)VALUES($1,$2,$3,$4,'grant','synthetic-communication-v1',$5,clock_timestamp(),$6,$7,$8)",
    [
      fixtures.orgA,
      event,
      channelId,
      purpose,
      `synthetic-evidence:${evidence}`,
      ++sequence,
      fixtures.ownerMemberA,
      evidence,
    ],
  );
  await admin.query(
    "INSERT INTO app.consent_state(tenant_id,contact_channel_id,purpose,state,last_event_id,verified_evidence_id)VALUES($1,$2,$3,'granted',$4,$5)",
    [fixtures.orgA, channelId, purpose, event, evidence],
  );
}
async function withdraw(channelId: string, purpose: string) {
  const event = randomUUID();
  await admin.query(
    "INSERT INTO app.consent_event(tenant_id,id,contact_channel_id,purpose,action,policy_version,evidence_ref,occurred_at,consent_sequence,initiating_member_id)VALUES($1,$2,$3,$4,'withdraw','synthetic-communication-v1',$5,clock_timestamp(),$6,$7)",
    [
      fixtures.orgA,
      event,
      channelId,
      purpose,
      `staff-withdrawal:${randomUUID()}`,
      ++sequence,
      fixtures.ownerMemberA,
    ],
  );
  await admin.query(
    "INSERT INTO app.consent_state(tenant_id,contact_channel_id,purpose,state,last_event_id)VALUES($1,$2,$3,'withdrawn',$4)",
    [fixtures.orgA, channelId, purpose, event],
  );
}
async function suppress(value: string, kind: "email" | "phone", purpose: string, expired = false) {
  await admin.query(
    "INSERT INTO app.suppression(tenant_id,channel_kind,normalized_destination,purpose,reason,expires_at)VALUES($1,$2,$3,$4,'synthetic_test',$5)",
    [fixtures.orgA, kind, value, purpose, expired ? new Date(Date.now() - 60_000) : null],
  );
}

/** Eight matched leads on a unique tag; see expected counts in the first test. */
async function audience() {
  const segment = await tag();
  const shared = `shared-${randomUUID()}@example.test`;
  const a = await contact("Synthetic Alpha broadcast");
  await grant(await channel(a, "email", shared), "email_marketing");
  await lead(a, segment);
  await lead(a, segment, { intent: "seller" });
  const b = await contact();
  await channel(b, "email", `unknown-${randomUUID()}@example.test`);
  await lead(b, segment);
  const withdrawnValue = `withdrawn-${randomUUID()}@example.test`;
  const c = await contact();
  await grant(await channel(c, "email", withdrawnValue), "email_marketing");
  await lead(c, segment);
  const d = await contact();
  await withdraw(await channel(d, "email", withdrawnValue), "email_marketing");
  const suppressedValue = `suppressed-${randomUUID()}@example.test`;
  const e = await contact();
  await grant(await channel(e, "email", suppressedValue), "email_marketing");
  await suppress(suppressedValue, "email", "email_marketing");
  await lead(e, segment);
  const expiredValue = `expired-${randomUUID()}@example.test`;
  const f = await contact();
  await grant(await channel(f, "email", expiredValue), "email_marketing");
  await suppress(expiredValue, "email", "email_marketing", true);
  await lead(f, segment);
  const g = await contact();
  await grant(await channel(g, "email", shared), "email_marketing");
  await lead(g, segment);
  const h = await contact();
  await grant(await channel(h, "email", `archived-${randomUUID()}@example.test`), "email_marketing");
  await lead(h, segment, { archived: true });
  const i = await contact();
  await grant(await channel(i, "phone", `+1555${String(Date.now()).slice(-7)}`), "sms_marketing");
  await lead(i, segment);
  return { segment };
}
const request = (
  messageDesignId: string,
  filter: Schemas["LeadFilter"],
  extra: Partial<Request> = {},
): Request => ({
  messageDesignId,
  filter,
  timezone: "America/Los_Angeles",
  ...extra,
});
async function effects(id: string) {
  return (
    await admin.query(
      "SELECT(SELECT count(*)::int FROM app.audit_event WHERE resource_type='broadcast_preview' AND resource_id=$1)audits,(SELECT count(*)::int FROM app.idempotency_record WHERE response_ref=$1)receipts,(SELECT count(*)::int FROM app.outbox WHERE tenant_id=$2)outbox,(SELECT count(*)::int FROM app.consent_event WHERE tenant_id=$2)consent,(SELECT count(*)::int FROM app.suppression WHERE tenant_id=$2)suppression",
      [id, fixtures.orgA],
    )
  ).rows[0];
}

beforeAll(async () => {
  await assertRuntimeRole(runtime);
  for (const tenant of [fixtures.orgA, fixtures.orgB])
    await admin.query(
      "INSERT INTO app.entitlement(tenant_id,feature,state)VALUES($1,'marketing','enabled')ON CONFLICT DO NOTHING",
      [tenant],
    );
  ownerHttp = await new ApiSession().signIn("owner");
});
afterAll(async () => {
  await Promise.all([runtime.end(), admin.end()]);
});

describe("ADR-051 broadcast audience counts", () => {
  it("counts eligible, ineligible and deduplicated recipients under the consent rule", async () => {
    const { segment } = await audience();
    const email = await design("email");
    const result = await preview(request(email, { tagIds: [segment] }));
    expect(result.status).toBe(201);
    assertContract("BroadcastPreview", result.body);
    // Alpha (2 leads) and G share one eligible address; F's suppression expired. B unknown, C withdrawn
    // destination, E suppressed, I has no email. H is archived and not matched.
    expect(result.body).toMatchObject({ eligible: 4, ineligible: 4, estimatedRecipients: 2 });
    const expires = Date.parse(result.body.expiresAt) - Date.now();
    expect(expires).toBeGreaterThan(14 * 60_000);
    expect(expires).toBeLessThanOrEqual(15 * 60_000 + 5_000);
    const sms = await preview(request(await design("sms"), { tagIds: [segment] }));
    expect(sms.body).toMatchObject({ eligible: 1, ineligible: 7, estimatedRecipients: 1 });
  });

  it("applies every predicate together", async () => {
    const { segment } = await audience();
    const email = await design("email");
    expect((await preview(request(email, { tagIds: [segment], intent: "seller" }))).body).toMatchObject({
      eligible: 1,
      ineligible: 0,
      estimatedRecipients: 1,
    });
    expect((await preview(request(email, { tagIds: [segment], q: "alpha BROADCAST" }))).body).toMatchObject({
      eligible: 2,
      ineligible: 0,
      estimatedRecipients: 1,
    });
    expect((await preview(request(email, { tagIds: [segment], q: "100%_\\" }))).body).toMatchObject({
      eligible: 0,
      ineligible: 0,
      estimatedRecipients: 0,
    });
    expect(
      (
        await preview(
          request(email, {
            tagIds: [segment],
            stageId: stageId(1, 1),
            sourceId: fixtures.sourceA,
            ownerMemberId: fixtures.ownerMemberA,
          }),
        )
      ).body,
    ).toMatchObject({ eligible: 4, ineligible: 4 });
    expect(
      (await preview(request(email, { tagIds: [segment], ownerMemberId: fixtures.agentMemberA }))).body,
    ).toMatchObject({ eligible: 0, ineligible: 0 });
  });

  it("refuses a segment above the bound instead of capping the count", async () => {
    const segment = await tag();
    const contactId = await contact();
    await admin.query(
      `INSERT INTO app.lead(tenant_id,id,contact_id,source_id,stage_id,owner_member_id)
       SELECT $1,gen_random_uuid(),$2,$3,$4,$5 FROM generate_series(1,$6::int)`,
      [
        fixtures.orgA,
        contactId,
        fixtures.sourceA,
        stageId(1, 1),
        fixtures.ownerMemberA,
        broadcastAudienceLimit + 1,
      ],
    );
    await admin.query(
      "INSERT INTO app.lead_tag(tenant_id,lead_id,tag_id)SELECT tenant_id,id,$2 FROM app.lead WHERE tenant_id=$1 AND contact_id=$3",
      [fixtures.orgA, segment, contactId],
    );
    await expect(preview(request(await design("email"), { tagIds: [segment] }))).rejects.toMatchObject({
      status: 422,
      code: "broadcast_audience_too_large",
    });
  });
});

describe("validation, authority and references", () => {
  it("rejects invalid input before any query", async () => {
    const email = await design("email");
    for (const [body, field] of [
      [request(email, {}), "filter"],
      [request(email, { q: "   " }), "filter.q"],
      [request(email, { tagIds: [fixtures.sourceA, fixtures.sourceA.toUpperCase()] }), "filter.tagIds"],
      [request(email, { intent: "buyer" }, { timezone: "PST" }), "timezone"],
      [request(email, { intent: "buyer" }, { timezone: "1America/Los_Angeles" }), "timezone"],
    ] as const)
      await expect(preview(body)).rejects.toMatchObject({ status: 422, errors: [{ field }] });
    await expect(preview({ ...request(email, { intent: "buyer" }), extra: true })).rejects.toMatchObject({
      status: 422,
    });
    await expect(preview(request(email, { intent: "buyer" }), "")).rejects.toMatchObject({ status: 400 });
    await expect(
      preview(request(email, { intent: "buyer" }, { scheduledAt: "2020-01-01T00:00:00Z" })),
    ).rejects.toMatchObject({ status: 422, errors: [{ field: "scheduledAt" }] });
  });

  it("requires organization scope for every grant it reads under", async () => {
    const email = await design("email");
    const body = request(email, { intent: "buyer" });
    expect((await preview(body, randomUUID(), await actor(fullGrants))).status).toBe(201);
    for (const code of ["campaigns.send", "campaigns.read", "crm.leads.read", "crm.contacts.read"]) {
      const reduced = fullGrants.filter((grant) => grant.code !== code);
      await expect(preview(body, randomUUID(), await actor(reduced))).rejects.toMatchObject({ status: 403 });
      const narrowed = fullGrants.map((grant) =>
        grant.code === code ? { ...grant, scope: "own" as const } : grant,
      );
      await expect(preview(body, randomUUID(), await actor(narrowed))).rejects.toMatchObject({ status: 403 });
    }
    const noTags = fullGrants.filter((grant) => grant.code !== "crm.tags.read");
    await expect(
      preview(request(email, { tagIds: [await tag()] }), randomUUID(), await actor(noTags)),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects foreign references and designs on BroadcastRequest field paths", async () => {
    const email = await design("email");
    await expect(
      preview(request(await design("email", fixtures.orgB), { intent: "buyer" })),
    ).rejects.toMatchObject({
      status: 422,
      code: "workflow_reference_unavailable",
      errors: [{ field: "messageDesignId" }],
    });
    await expect(preview(request(email, { tagIds: [await tag(fixtures.orgB)] }))).rejects.toMatchObject({
      status: 422,
      errors: [{ field: "filter.tagIds.0" }],
    });
    await expect(preview(request(email, { ownerMemberId: fixtures.ownerMemberB }))).rejects.toMatchObject({
      status: 422,
      errors: [{ field: "filter.ownerMemberId" }],
    });
  });

  it("denies when marketing capability is disabled", async () => {
    const email = await design("email");
    try {
      await admin.query(
        "UPDATE app.entitlement SET state='disabled' WHERE tenant_id=$1 AND feature='marketing'",
        [fixtures.orgA],
      );
      await expect(preview(request(email, { intent: "buyer" }))).rejects.toMatchObject({
        status: 403,
        code: "entitlement_disabled",
      });
    } finally {
      await admin.query(
        "UPDATE app.entitlement SET state='enabled' WHERE tenant_id=$1 AND feature='marketing'",
        [fixtures.orgA],
      );
    }
  });
});

describe("receipts and effects", () => {
  it("writes one audit and receipt, no outbox or consent change, and replays the historical counts", async () => {
    const { segment } = await audience();
    const email = await design("email");
    const body = request(email, { tagIds: [segment] }),
      key = randomUUID();
    const before = await admin.query("SELECT count(*)::int AS n FROM app.outbox WHERE tenant_id=$1", [
      fixtures.orgA,
    ]);
    const first = await preview(body, key);
    const effect = await effects(first.body.id);
    expect(effect).toMatchObject({ audits: 1, receipts: 1, outbox: before.rows[0].n });
    const audit = (
      await admin.query("SELECT safe_diff FROM app.audit_event WHERE resource_id=$1", [first.body.id])
    ).rows[0].safe_diff;
    expect(audit).toEqual({
      messageDesignId: email,
      channel: "email",
      eligible: 4,
      ineligible: 4,
      estimatedRecipients: 2,
    });
    // A later consent change does not rewrite a replayed historical preview.
    const extra = await contact();
    await grant(await channel(extra, "email", `late-${randomUUID()}@example.test`), "email_marketing");
    await lead(extra, segment);
    expect((await preview(body, key)).body).toEqual(first.body);
    expect(await effects(first.body.id)).toMatchObject({ audits: 1, receipts: 1 });
    expect((await preview(body)).body).toMatchObject({ eligible: 5 });
  });

  it("rejects a changed request, an expired receipt and a corrupt receipt", async () => {
    const email = await design("email");
    const key = randomUUID();
    const first = await preview(request(email, { intent: "buyer" }), key);
    await expect(preview(request(email, { intent: "seller" }), key)).rejects.toMatchObject({
      status: 409,
      code: "idempotency_conflict",
    });
    await admin.query(
      "UPDATE app.idempotency_record SET expires_at=clock_timestamp()-interval '1 second' WHERE response_ref=$1",
      [first.body.id],
    );
    await expect(preview(request(email, { intent: "buyer" }), key)).rejects.toMatchObject({
      status: 409,
      code: "receipt_expired",
    });
    const corruptKey = randomUUID();
    const second = await preview(request(email, { intent: "buyer" }), corruptKey);
    await admin.query(
      "UPDATE app.idempotency_record SET response_body=jsonb_set(response_body,'{eligible}','-1') WHERE response_ref=$1",
      [second.body.id],
    );
    await expect(preview(request(email, { intent: "buyer" }), corruptKey)).rejects.toMatchObject({
      status: 503,
      code: "receipt_unavailable",
    });
  });

  it("re-authorizes a replay after a referenced tag is removed", async () => {
    const email = await design("email");
    const segment = await tag();
    const key = randomUUID();
    await preview(request(email, { tagIds: [segment] }), key);
    await admin.query("DELETE FROM app.tag WHERE id=$1", [segment]);
    await expect(preview(request(email, { tagIds: [segment] }), key)).rejects.toMatchObject({ status: 422 });
  });
});

describe("registered HTTP boundary", () => {
  it("returns the frozen 201 BroadcastPreview and rejects queries and other methods", async () => {
    const { segment } = await audience();
    const email = await design("email");
    const response = await ownerHttp.command(path, request(email, { tagIds: [segment] }));
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(201);
    assertContract("BroadcastPreview", body);
    expect(body).toMatchObject({ eligible: 4, ineligible: 4, estimatedRecipients: 2 });
    expect(response.headers.get("cache-control")).toContain("no-store");
    await assertProblem(
      await ownerHttp.command(`${path}?limit=1`, request(email, { tagIds: [segment] })),
      422,
    );
    // Sending stays on the existing unavailable path; a preview never authorizes a send.
    const confirm = await ownerHttp.command(`/v1/orgs/${fixtures.orgA}/broadcast-confirmations`, {
      previewId: body.id,
      acceptedTermsVersion: "synthetic",
    });
    expect([404, 503]).toContain(confirm.status);
    await assertProblem(confirm, confirm.status);
  });
});

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CampaignDraftService } from "../../apps/api/src/marketing";
import { AutomationService } from "../../apps/api/src/marketing/automation-service";
import { CampaignWorkflowService } from "../../apps/api/src/marketing/workflow-service";
import { fixtures } from "../../packages/db/fixtures";
import { assertRuntimeRole } from "../../packages/db/runtime-role";
import {
  withTenantTransaction,
  type PermissionGrant,
  type TenantContext,
  type VerifiedIdentityContext,
} from "../../packages/db/tenant-transaction";
import { ApiSession, apiOrigin, assertContract, assertProblem, type Schemas } from "../helpers/api";

for (const variable of ["TEST_DATABASE_URL", "TEST_MIGRATION_DATABASE_URL", "TEST_WORKER_DATABASE_URL"]) {
  const url = new URL(process.env[variable] ?? "http://missing.invalid");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/estate_acceptance_[a-f0-9]{16}$/.test(url.pathname)
  )
    throw new Error("Automation service acceptance requires the owned disposable isolated batch runner.");
}

const runtime = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 });
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL, max: 4 });
const ownerA = { userId: fixtures.ownerUser, organizationId: fixtures.orgA };
const ownerB = { userId: fixtures.ownerUser, organizationId: fixtures.orgB };
type Actor = VerifiedIdentityContext & { memberId: string; roleId: string };
let ownerHttp: ApiSession;

const automationGrants: PermissionGrant[] = [
  { code: "campaigns.read", scope: "organization" },
  { code: "campaigns.write", scope: "organization" },
  { code: "campaigns.publish", scope: "organization" },
  { code: "automations.read", scope: "organization" },
  { code: "automations.write", scope: "organization" },
];

async function actor(grants = automationGrants): Promise<Actor> {
  const userId = randomUUID(), memberId = randomUUID(), roleId = randomUUID();
  await admin.query(
    "INSERT INTO app.user_identity(id,issuer,subject,display_name,email_verified)VALUES($1,'urn:estate:synthetic',$2,'Synthetic automation actor',true)",
    [userId, randomUUID()],
  );
  await admin.query(
    "INSERT INTO app.role_definition(tenant_id,id,name,permission_grants)VALUES($1,$2,$3,$4)",
    [fixtures.orgA, roleId, "Synthetic automation role " + randomUUID(), JSON.stringify(grants)],
  );
  await admin.query(
    "INSERT INTO app.membership(tenant_id,id,user_id,role_id,status,display_name)VALUES($1,$2,$3,$4,'active','Synthetic automation member')",
    [fixtures.orgA, memberId, userId, roleId],
  );
  return { userId, organizationId: fixtures.orgA, memberId, roleId };
}

async function use<T>(
  identity: VerifiedIdentityContext,
  operation: (service: AutomationService, client: import("pg").PoolClient, context: TenantContext) => Promise<T>,
) {
  return withTenantTransaction(runtime, identity, (client, context) =>
    operation(new AutomationService(client, context), client, context),
  );
}

/** Create a published campaign version and return its id. */
async function publishedVersion(identity: VerifiedIdentityContext = ownerA): Promise<string> {
  const campaign = await withTenantTransaction(runtime, identity, (client, context) =>
    new CampaignDraftService(client, context, randomUUID()).create(
      { name: "Automation test campaign " + randomUUID(), category: "synthetic-only" },
      { key: randomUUID() },
    ),
  );
  const version = await withTenantTransaction(runtime, identity, (client, context) =>
    new CampaignWorkflowService(client, context, randomUUID()).create(
      campaign.body.id,
      {
        nodes: [{ key: "wait", kind: "wait", delaySeconds: 3600 }],
        edges: [],
        timezone: "UTC",
      },
      { key: randomUUID() },
    ),
  );
  await withTenantTransaction(runtime, identity, (client, context) =>
    new CampaignWorkflowService(client, context, randomUUID()).publish(version.body.id, { key: randomUUID() }),
  );
  return version.body.id;
}

function automationInput(versionId: string): Schemas["AutomationWrite"] {
  return {
    name: "PRIVATE_SYNTHETIC_AUTOMATION_" + randomUUID(),
    trigger: "lead.captured",
    conditions: {},
    campaignVersionId: versionId,
    restartPolicy: "once",
    active: false,
  };
}

beforeAll(async () => {
  await assertRuntimeRole(runtime);
  for (const tenant of [fixtures.orgA, fixtures.orgB])
    await admin.query(
      "INSERT INTO app.entitlement(tenant_id,feature,state)VALUES($1,'marketing','enabled')",
      [tenant],
    );
  // Insert synthetic lead contacts for enrollment tests (not in the default seed)
  await admin.query(
    "INSERT INTO app.contact(tenant_id,id,display_name,created_by_member_id)VALUES($1,$2,'Synthetic Lead A',$3) ON CONFLICT DO NOTHING",
    [fixtures.orgA, fixtures.leadA, fixtures.ownerMemberA],
  );
  ownerHttp = await new ApiSession().signIn("owner");
});
afterAll(async () => {
  await Promise.all([runtime.end(), admin.end()]);
});

describe("ADR-060 automation CRUD", () => {
  it("creates and retrieves an automation rule", async () => {
    const a = await actor();
    const vId = await publishedVersion(a);
    const input = automationInput(vId);
    const created = await use(a, (svc) => svc.createAutomation(input, { key: randomUUID() }));
    expect(created.status).toBe(201);
    assertContract("Automation", created.body);
    expect(created.body.definition.name).toBe(input.name);
    expect(created.etag).toBe('"' + created.body.version + '"');
    const fetched = await use(a, (svc) => svc.getAutomation(created.body.id));
    assertContract("Automation", fetched);
    expect(fetched.id).toBe(created.body.id);
  });

  it("createAutomation is idempotent for the same key", async () => {
    const a = await actor();
    const vId = await publishedVersion(a);
    const input = automationInput(vId);
    const key = randomUUID();
    const first = await use(a, (svc) => svc.createAutomation(input, { key }));
    const second = await use(a, (svc) => svc.createAutomation(input, { key }));
    expect(second.body.id).toBe(first.body.id);
    expect(second.etag).toBe(first.etag);
  });

  it("rejects automation creation without automations.write", async () => {
    const a = await actor([{ code: "automations.read", scope: "organization" }]);
    const vId = await publishedVersion(ownerA);
    await expect(
      use(a, (svc) => svc.createAutomation(automationInput(vId), { key: randomUUID() })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lists automations with cursor pagination", async () => {
    const a = await actor();
    const vId = await publishedVersion(a);
    for (let i = 0; i < 3; i++)
      await use(a, (svc) => svc.createAutomation(automationInput(vId), { key: randomUUID() }));
    const page = await use(a, (svc) => svc.listAutomations({ limit: 2 }));
    assertContract("PageAutomation", page);
    expect(page.items.length).toBeLessThanOrEqual(2);
    expect(page.hasMore).toBeDefined();
  });

  it("updates an automation rule with revision check", async () => {
    const a = await actor();
    const vId = await publishedVersion(a);
    const { body } = await use(a, (svc) => svc.createAutomation(automationInput(vId), { key: randomUUID() }));
    const updated = await use(a, (svc) =>
      svc.updateAutomation(body.id, { ...body.definition, active: true }, {
        key: randomUUID(),
        ifMatch: '"' + body.version + '"',
      }),
    );
    expect(updated.status).toBe(200);
    expect(updated.body.definition.active).toBe(true);
    expect(updated.body.version).toBe(body.version + 1);
  });

  it("returns 412 for stale revision on update", async () => {
    const a = await actor();
    const vId = await publishedVersion(a);
    const { body } = await use(a, (svc) => svc.createAutomation(automationInput(vId), { key: randomUUID() }));
    await expect(
      use(a, (svc) =>
        svc.updateAutomation(body.id, body.definition, { key: randomUUID(), ifMatch: '"999"' }),
      ),
    ).rejects.toMatchObject({ status: 412 });
  });

  it("enforces tenant isolation on automation get", async () => {
    const a = await actor();
    const vId = await publishedVersion(a);
    const { body } = await use(a, (svc) => svc.createAutomation(automationInput(vId), { key: randomUUID() }));
    await expect(
      withTenantTransaction(runtime, ownerB, (client, context) =>
        new AutomationService(client, context).getAutomation(body.id),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("ADR-060 enrollment CRUD", () => {
  it("enrolls a lead and lists the enrollment", async () => {
    const a = await actor();
    const vId = await publishedVersion(a);
    const leadId = fixtures.leadA;
    const enrolled = await use(a, (svc) =>
      svc.enrollLead({ leadId, campaignVersionId: vId }, { key: randomUUID() }),
    );
    expect(enrolled.status).toBe(201);
    assertContract("Enrollment", enrolled.body);
    expect(enrolled.body.state).toBe("active");
    expect(enrolled.body.leadId).toBe(leadId);
    const page = await use(a, (svc) => svc.listEnrollments());
    assertContract("PageEnrollment", page);
    expect(page.items.some((e) => e.id === enrolled.body.id)).toBe(true);
  });

  it("enrollLead is idempotent for the same key", async () => {
    const a = await actor();
    const vId = await publishedVersion(a);
    const key = randomUUID();
    const first = await use(a, (svc) =>
      svc.enrollLead({ leadId: fixtures.leadA, campaignVersionId: vId }, { key }),
    );
    const second = await use(a, (svc) =>
      svc.enrollLead({ leadId: fixtures.leadA, campaignVersionId: vId }, { key }),
    );
    expect(second.body.id).toBe(first.body.id);
  });

  it("cancels an enrollment", async () => {
    const a = await actor();
    const vId = await publishedVersion(a);
    const { body } = await use(a, (svc) =>
      svc.enrollLead({ leadId: fixtures.leadA, campaignVersionId: vId }, { key: randomUUID() }),
    );
    const cancelled = await use(a, (svc) => svc.cancelEnrollment(body.id, { key: randomUUID() }));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.state).toBe("cancelled");
  });

  it("cancelEnrollment is idempotent for the same key", async () => {
    const a = await actor();
    const vId = await publishedVersion(a);
    const { body } = await use(a, (svc) =>
      svc.enrollLead({ leadId: fixtures.leadA, campaignVersionId: vId }, { key: randomUUID() }),
    );
    const key = randomUUID();
    const first = await use(a, (svc) => svc.cancelEnrollment(body.id, { key }));
    const second = await use(a, (svc) => svc.cancelEnrollment(body.id, { key }));
    expect(second.body.id).toBe(first.body.id);
    expect(second.etag).toBe(first.etag);
  });

  it("returns 409 when cancelling an already-cancelled enrollment with different key", async () => {
    const a = await actor();
    const vId = await publishedVersion(a);
    const { body } = await use(a, (svc) =>
      svc.enrollLead({ leadId: fixtures.leadA, campaignVersionId: vId }, { key: randomUUID() }),
    );
    await use(a, (svc) => svc.cancelEnrollment(body.id, { key: randomUUID() }));
    await expect(
      use(a, (svc) => svc.cancelEnrollment(body.id, { key: randomUUID() })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects enrollment without automations.write", async () => {
    const a = await actor([{ code: "automations.read", scope: "organization" }]);
    const vId = await publishedVersion(ownerA);
    await expect(
      use(a, (svc) =>
        svc.enrollLead({ leadId: fixtures.leadA, campaignVersionId: vId }, { key: randomUUID() }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("enforces tenant isolation on enrollment listing", async () => {
    const a = await actor();
    const vId = await publishedVersion(a);
    await use(a, (svc) =>
      svc.enrollLead({ leadId: fixtures.leadA, campaignVersionId: vId }, { key: randomUUID() }),
    );
    const pageB = await withTenantTransaction(runtime, ownerB, (client, context) =>
      new AutomationService(client, context).listEnrollments(),
    );
    expect(pageB.items).toHaveLength(0);
  });
});

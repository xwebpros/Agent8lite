import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { NotificationService } from "../../apps/api/src/notification-service";
import { fixtures } from "../../packages/db/fixtures";
import { type PermissionGrant, withTenantTransaction } from "../../packages/db/tenant-transaction";
import { createIdxPools, requireIdxIsolation } from "./isolation";

const { admin, runtime } = createIdxPools();
const database = new URL(requireIdxIsolation().migration).pathname.slice(1);
const safePayload = { title: "A lead was assigned to you", href: "/pipeline" };
type Actor = { userId: string; memberId: string; roleId: string; organizationId: string };
afterAll(async () => {
  await Promise.all([admin.end(), runtime.end()]);
});

async function actor(scope: PermissionGrant["scope"] = "organization"): Promise<Actor> {
  const userId = randomUUID();
  const memberId = randomUUID();
  const roleId = randomUUID();
  await admin.query(
    "INSERT INTO app.user_identity(id,issuer,subject,display_name,email,email_verified) VALUES($1,'urn:estate:notification-fixture',$3,'Synthetic notification producer',$2,true)",
    [userId, `notification-${userId}@example.test`, userId],
  );
  await admin.query(
    "INSERT INTO app.role_definition(tenant_id,id,name,permission_grants) VALUES($1,$2,$3,$4)",
    [
      fixtures.orgA,
      roleId,
      `Synthetic producer ${roleId}`,
      JSON.stringify([
        { code: "crm.leads.write", scope },
        { code: "self.notifications.read", scope: "own" },
      ]),
    ],
  );
  await admin.query(
    "INSERT INTO app.membership(tenant_id,id,user_id,role_id,status,display_name) VALUES($1,$2,$3,$4,'active','Synthetic notification producer')",
    [fixtures.orgA, memberId, userId, roleId],
  );
  return { userId, memberId, roleId, organizationId: fixtures.orgA };
}
async function count() {
  return (await admin.query("SELECT count(*)::int AS count FROM app.notification")).rows[0].count as number;
}
function produce(
  client: PoolClient,
  tenant = fixtures.orgA as string,
  member = fixtures.agentMemberA as string,
  payload: unknown = safePayload,
  kind = "lead.assigned",
) {
  return client.query<{ id: string | null }>("SELECT app.create_notification($1,$2,$3,$4) AS id", [
    tenant,
    member,
    kind,
    JSON.stringify(payload),
  ]);
}
/** Exercise misuse of the internal port independently of the application's session wrapper. */
async function raw<T>(
  context: { organizationId?: string; userId?: string },
  operation: (client: PoolClient) => Promise<T>,
  connected?: (pid: number) => void,
) {
  const client = await runtime.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [
      context.organizationId ?? "",
      context.userId ?? "",
    ]);
    connected?.((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const value = await operation(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function deny(
  context: { organizationId?: string; userId?: string },
  operation: (client: PoolClient) => Promise<unknown>,
  code = "42501",
) {
  const before = await count();
  await expect(raw(context, operation)).rejects.toMatchObject({ code });
  expect(await count()).toBe(before);
}
async function teamOffice(producer: Actor) {
  const office = randomUUID();
  await admin.query(
    "INSERT INTO app.office(tenant_id,id,name,timezone) VALUES($1,$2,$3,'America/Los_Angeles')",
    [fixtures.orgA, office, `Synthetic notification team ${office}`],
  );
  await admin.query(
    "INSERT INTO app.office_member(tenant_id,office_id,member_id) VALUES($1,$2,$3),($1,$2,$4)",
    [fixtures.orgA, office, producer.memberId, fixtures.agentMemberA],
  );
  return office;
}
async function waited(pid: () => number | undefined) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (
      pid() !== undefined &&
      (
        await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND pid=$2 AND usename='estate_runtime' AND wait_event_type='Lock'",
          [database, pid()],
        )
      ).rowCount === 1
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The owned notification producer did not enter the expected database lock wait.");
}

describe("forward notification producer context and scope guard", () => {
  it.each([{}, { organizationId: fixtures.orgA }, { userId: fixtures.ownerUser }])(
    "denies missing tenant or actor context %o without effects",
    async (context) => {
      await deny(context, (client) => produce(client));
      expect((await runtime.query("SELECT id FROM app.notification")).rowCount).toBe(0);
    },
  );
  it("denies cross-tenant parameters and an actor outside the claimed tenant", async () => {
    await deny({ userId: fixtures.ownerUser, organizationId: fixtures.orgA }, (client) =>
      produce(client, fixtures.orgB, fixtures.agentMemberB),
    );
    await deny({ userId: fixtures.otherAgentUser, organizationId: fixtures.orgA }, (client) =>
      produce(client),
    );
  });
  it("does not create a notification for a foreign or disabled recipient", async () => {
    const producer = await actor();
    const before = await count();
    expect(
      (await raw(producer, (client) => produce(client, fixtures.orgA, fixtures.agentMemberB))).rows[0].id,
    ).toBeNull();
    await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      producer.memberId,
    ]);
    expect(
      (
        await raw({ userId: fixtures.ownerUser, organizationId: fixtures.orgA }, (client) =>
          produce(client, fixtures.orgA, producer.memberId),
        )
      ).rows[0].id,
    ).toBeNull();
    await deny(producer, (client) => produce(client));
    expect(await count()).toBe(before);
  });
  it("returns a generic valid notification visible only to its intended member", async () => {
    const producer = await actor();
    const result = await raw(producer, (client) => produce(client));
    const id = result.rows[0].id;
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    const page = await withTenantTransaction(
      runtime,
      { userId: fixtures.agentUser, organizationId: fixtures.orgA },
      (client, context) => new NotificationService(client, context, randomUUID()).list({ limit: 100 }),
    );
    expect(page.items.find((item) => item.id === id)).toMatchObject({
      kind: "lead.assigned",
      title: safePayload.title,
      href: safePayload.href,
      readAt: null,
    });
    const foreign = await withTenantTransaction(
      runtime,
      { userId: fixtures.otherAgentUser, organizationId: fixtures.orgB },
      (client, context) => new NotificationService(client, context, randomUUID()).list({ limit: 100 }),
    );
    expect(foreign.items.some((item) => item.id === id)).toBe(false);
    const sender = await withTenantTransaction(runtime, producer, (client, context) =>
      new NotificationService(client, context, randomUUID()).list({ limit: 100 }),
    );
    expect(sender.items.some((item) => item.id === id)).toBe(false);
  });
  it("allows own-scope producers only their own recipient", async () => {
    const producer = await actor("own");
    await deny(producer, (client) => produce(client));
    expect(
      (await raw(producer, (client) => produce(client, fixtures.orgA, producer.memberId))).rows[0].id,
    ).toMatch(/^[a-f0-9-]{36}$/);
  });
  it("denies revoked CRM permissions and an unrelated notification kind permission", async () => {
    const producer = await actor();
    await deny(producer, (client) =>
      produce(
        client,
        fixtures.orgA,
        fixtures.agentMemberA,
        { title: "A task was assigned to you", href: "/tasks" },
        "task.assigned",
      ),
    );
    await admin.query(
      "UPDATE app.role_definition SET permission_grants='[]'::jsonb WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, producer.roleId],
    );
    await deny(producer, (client) => produce(client));
  });
  it("denies a disabled CRM entitlement without private effects", async () => {
    const producer = await actor();
    await admin.query("UPDATE app.entitlement SET state='disabled' WHERE tenant_id=$1 AND feature='crm'", [
      fixtures.orgA,
    ]);
    try {
      await deny(producer, (client) => produce(client));
    } finally {
      await admin.query("UPDATE app.entitlement SET state='enabled' WHERE tenant_id=$1 AND feature='crm'", [
        fixtures.orgA,
      ]);
    }
  });
  it.each([
    { title: "", href: "/pipeline" },
    { title: "x".repeat(161), href: "/pipeline" },
    { title: "Generic", href: "https://attacker.example.test" },
    { title: "Generic", href: "/pipeline", message: "Private fixture body must never be accepted here." },
    { title: "Generic", href: "/pipeline", leadId: fixtures.leadA },
  ])("rejects an unsafe internal payload %o", async (payload) => {
    await deny(
      await actor(),
      (client) => produce(client, fixtures.orgA, fixtures.agentMemberA, payload),
      "23514",
    );
  });
  it("allows team recipients only while both memberships share a current office", async () => {
    const producer = await actor("team");
    await deny(producer, (client) => produce(client));
    const office = await teamOffice(producer);
    expect((await raw(producer, (client) => produce(client))).rows[0].id).toMatch(/^[a-f0-9-]{36}$/);
    await admin.query("DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3", [
      fixtures.orgA,
      office,
      producer.memberId,
    ]);
    await deny(producer, (client) => produce(client));
  });
  it.each(["role-revocation", "office-loss", "entitlement-expiry"] as const)(
    "rechecks %s after an actual owned database lock wait",
    async (kind) => {
      const producer = await actor(kind === "office-loss" ? "team" : "organization");
      const office = kind === "office-loss" ? await teamOffice(producer) : undefined;
      const blocker = await admin.connect();
      const before = await count();
      let pid: number | undefined;
      let pending: Promise<{ result?: unknown; error?: unknown }> | undefined;
      try {
        if (kind === "entitlement-expiry")
          await admin.query(
            "UPDATE app.entitlement SET effective_until=clock_timestamp()+interval '1250 milliseconds' WHERE tenant_id=$1 AND feature='crm'",
            [fixtures.orgA],
          );
        await blocker.query("BEGIN");
        if (kind === "office-loss")
          await blocker.query(
            "DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3",
            [fixtures.orgA, office, producer.memberId],
          );
        else if (kind === "role-revocation")
          await blocker.query(
            "UPDATE app.role_definition SET permission_grants='[]'::jsonb WHERE tenant_id=$1 AND id=$2",
            [fixtures.orgA, producer.roleId],
          );
        else
          await blocker.query("UPDATE app.role_definition SET name=name WHERE tenant_id=$1 AND id=$2", [
            fixtures.orgA,
            producer.roleId,
          ]);
        pending = raw(
          producer,
          (client) => produce(client),
          (value) => {
            pid = value;
          },
        ).then(
          (result) => ({ result }),
          (error) => ({ error }),
        );
        await waited(() => pid);
        if (kind === "entitlement-expiry") await admin.query("SELECT pg_sleep(1.5)");
        await blocker.query("COMMIT");
        expect((await pending).error).toMatchObject({ code: "42501" });
        expect(await count()).toBe(before);
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        blocker.release();
        await pending;
        if (kind === "entitlement-expiry")
          await admin.query(
            "UPDATE app.entitlement SET effective_until=NULL WHERE tenant_id=$1 AND feature='crm'",
            [fixtures.orgA],
          );
      }
    },
  );
});

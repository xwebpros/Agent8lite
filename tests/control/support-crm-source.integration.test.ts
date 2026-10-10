import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SupportCrmReader } from "../../apps/api/src/control/support-crm-read";
import { SupportService, supportReadPermissions } from "../../apps/api/src/control/support-service";
import { validateStaff } from "../../apps/api/src/control/validation";
import { StaffSessionIssuer, withStaffTransaction } from "../../packages/auth/staff-sessions";
import { fixtures } from "../../packages/db/fixtures";
import { assertStaffRole, createStaffPools } from "../../packages/db/staff-pools";

// The query barrier delays an actual control-role result, never replaces database authorization.
const database = process.env.CONTROL_OWNED_DATABASE ?? "";
if (!/^estate_control_test_[0-9a-f]{16}$/.test(database))
  throw new Error("Run source-race acceptance with tests/control/run.mjs and its owned disposable database.");
for (const variable of ["TEST_MIGRATION_DATABASE_URL", "CONTROL_DATABASE_URL", "STAFF_ISSUER_DATABASE_URL"]) {
  const url = new URL(process.env[variable] ?? "http://missing.invalid");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/" + database)
    throw new Error("Source-race acceptance requires matching disposable loopback database identities.");
}

const pools = createStaffPools();
const admin = new Pool({
  connectionString: process.env.TEST_MIGRATION_DATABASE_URL,
  max: 1,
  options: "-c statement_timeout=5000",
});
let recipientToken: string;
let selectedGrantId: string;
let position = 20;

type Records = {
  marker: string;
  contact: string;
  channel: string;
  lead: string;
  task: string;
  deal: string;
  source: string;
  stage: string;
  tag: string;
};
async function records(): Promise<Records> {
  const fixture = {
    marker: "Synthetic source race " + randomUUID(),
    contact: randomUUID(),
    channel: randomUUID(),
    lead: randomUUID(),
    task: randomUUID(),
    deal: randomUUID(),
    source: randomUUID(),
    stage: randomUUID(),
    tag: randomUUID(),
  };
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO app.contact(tenant_id,id,display_name,created_by_member_id)VALUES($1,$2,$3,$4)",
      [fixtures.orgA, fixture.contact, fixture.marker, fixtures.ownerMemberA],
    );
    await client.query(
      "INSERT INTO app.contact_channel(tenant_id,id,contact_id,kind,normalized_value,is_primary)VALUES($1,$2,$3,'email',$4,true)",
      [fixtures.orgA, fixture.channel, fixture.contact, fixture.contact + "@example.test"],
    );
    await client.query("INSERT INTO app.lead_source(tenant_id,id,code,label)VALUES($1,$2,$3,$4)", [
      fixtures.orgA,
      fixture.source,
      "source-race-" + fixture.source,
      fixture.marker,
    ]);
    await client.query("INSERT INTO app.pipeline_stage(tenant_id,id,name,position)VALUES($1,$2,$3,$4)", [
      fixtures.orgA,
      fixture.stage,
      fixture.marker,
      position++,
    ]);
    await client.query(
      "INSERT INTO app.lead(tenant_id,id,contact_id,source_id,stage_id,owner_member_id,intent,attribution)VALUES($1,$2,$3,$4,$5,$6,'buyer','{\"synthetic\":true}')",
      [fixtures.orgA, fixture.lead, fixture.contact, fixture.source, fixture.stage, fixtures.ownerMemberA],
    );
    await client.query(
      "INSERT INTO app.task(tenant_id,id,lead_id,assignee_member_id,title,due_at,due_timezone,priority,state)VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 day','UTC','normal','open')",
      [fixtures.orgA, fixture.task, fixture.lead, fixtures.ownerMemberA, fixture.marker],
    );
    await client.query("INSERT INTO app.deal(tenant_id,id,lead_id,name,state)VALUES($1,$2,$3,$4,'open')", [
      fixtures.orgA,
      fixture.deal,
      fixture.lead,
      fixture.marker,
    ]);
    await client.query("INSERT INTO app.tag(tenant_id,id,name)VALUES($1,$2,$3)", [
      fixtures.orgA,
      fixture.tag,
      fixture.marker,
    ]);
    await client.query("INSERT INTO app.lead_tag(tenant_id,lead_id,tag_id)VALUES($1,$2,$3)", [
      fixtures.orgA,
      fixture.lead,
      fixture.tag,
    ]);
    await client.query("COMMIT");
    return fixture;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(description)), 10_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function read<T>(operation: (reader: SupportCrmReader) => Promise<T>) {
  return withStaffTransaction(
    pools.control,
    recipientToken,
    async (client, session) => {
      const access = new SupportService(client, session, randomUUID());
      const context = await access.resolveCurrent("");
      return operation(new SupportCrmReader(client, context, access, session));
    },
    { intent: "support-read" },
  );
}

async function race<T>(operation: (reader: SupportCrmReader) => Promise<T>, mutate: () => Promise<unknown>) {
  const arrived = deferred(),
    release = deferred();
  let snapshots = 0;
  const pending = withStaffTransaction(
    pools.control,
    recipientToken,
    async (client, session) => {
      const query = client.query.bind(client) as (text: unknown, values?: unknown) => Promise<QueryResult>;
      const controlled = new Proxy(client, {
        get(target, property) {
          if (property === "query")
            return async (text: unknown, values?: unknown) => {
              const result = await query(text, values);
              const statement = typeof text === "string" ? text : (text as { text?: string })?.text;
              if (statement?.includes(" AS source_snapshot")) {
                snapshots++;
                for (const row of result.rows) expect(row.source_snapshot).toBeDefined();
                if (snapshots === 1) {
                  arrived.resolve();
                  await release.promise;
                }
              }
              return result;
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as PoolClient;
      const access = new SupportService(controlled, session, randomUUID());
      const context = await access.resolveCurrent("");
      return operation(new SupportCrmReader(controlled, context, access, session));
    },
    { intent: "support-read" },
  ).then(
    (value) => ({ kind: "returned" as const, value }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );
  try {
    await bounded(
      Promise.race([
        arrived.promise,
        pending.then((outcome) => {
          if (outcome.kind === "rejected") throw outcome.error;
          throw new Error("The genuine source projection never reached the controlled race barrier.");
        }),
      ]),
      "The source projection did not reach the bounded barrier.",
    );
    // This write must commit while the SELECT-only control transaction is paused.
    await bounded(mutate(), "An unexpected CRM resource lock blocked the owned source mutation.");
    release.resolve();
    const outcome = await bounded(pending, "The current-source requery did not finish.");
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected")
      expect(outcome.error).toMatchObject({ status: 409, code: "support_source_changed" });
    expect(snapshots).toBeGreaterThanOrEqual(2);
  } finally {
    release.resolve();
    await bounded(pending, "The controlled source transaction did not release.");
  }
}

beforeAll(async () => {
  await assertStaffRole(pools.control, "estate_control");
  await assertStaffRole(pools.issuer, "estate_staff_issuer");
  const issuer = new StaffSessionIssuer(pools.issuer);
  const identity = (subject: "staff-administrator" | "staff-support") => ({
    issuer: "urn:estate:synthetic",
    subject,
    email: subject + "@example.test",
    emailVerified: true as const,
    authenticatedAt: Date.now() / 1000,
  });
  const administrator = await issuer.issueVerifiedIdentity(identity("staff-administrator"));
  const recipient = await issuer.issueVerifiedIdentity(identity("staff-support"));
  recipientToken = recipient.opaqueToken;
  const expiresAt = (
    await admin.query("SELECT clock_timestamp()+interval '30 minutes'AS expiry")
  ).rows[0].expiry.toISOString();
  const reference = await withStaffTransaction(
    pools.control,
    administrator.opaqueToken,
    async (client, session) => {
      const access = new SupportService(client, session, randomUUID());
      const job = await access.createGrant(
        fixtures.orgA,
        {
          staffUserId: fixtures.staffSupportUser,
          permissions: [...supportReadPermissions],
          reason: "Synthetic controlled CRM source race verification",
          expiresAt,
        },
        randomUUID(),
      );
      return (await access.readCommand(job.id)).grant;
    },
  );
  selectedGrantId = reference.accessGrantId;
  await withStaffTransaction(
    pools.control,
    recipientToken,
    async (client, session) =>
      new SupportService(client, session, randomUUID()).select(
        { organizationId: fixtures.orgA, accessGrantId: reference.accessGrantId },
        randomUUID(),
      ),
    { intent: "context-mutation" },
  );
});
afterAll(async () => {
  await Promise.all([pools.control.end(), pools.issuer.end(), admin.end()]);
});

describe("genuine control-role SELECT-only support source linearization", () => {
  it("returns all seven current frozen projections without granting CRM writes or member authority", async () => {
    const fixture = await records();
    for (const [resource, id] of [
      ["contacts", fixture.contact],
      ["leads", fixture.lead],
      ["tasks", fixture.task],
      ["deals", fixture.deal],
      ["pipeline-stages", fixture.stage],
      ["lead-sources", fixture.source],
      ["tags", fixture.tag],
    ] as const) {
      expect((await read((reader) => reader.detail(resource, id))).id).toBe(id);
      const page = await read((reader) =>
        reader.list(resource, { filter: JSON.stringify({ q: fixture.marker }) }),
      );
      expect(page.items.map((item) => item.id)).toContain(id);
    }
    const role = await pools.control.query(
      "SELECT current_user,session_user,has_table_privilege(current_user,'app.contact','UPDATE')AS can_write,(SELECT count(*)::int FROM app.contact)AS visible",
    );
    expect(role.rows[0]).toMatchObject({
      current_user: "estate_control",
      session_user: "estate_control",
      can_write: false,
      visible: 0,
    });
    expect(
      (
        await admin.query("SELECT count(*)::int AS count FROM app.membership WHERE user_id=$1", [
          fixtures.staffSupportUser,
        ])
      ).rows[0].count,
    ).toBe(0);
  });

  it.each([
    ["contacts", "contact"],
    ["leads", "lead"],
    ["leads", "contact"],
    ["tasks", "lead"],
    ["tasks", "contact"],
    ["deals", "lead"],
    ["deals", "contact"],
  ] as const)(
    "rejects %s detail when its %s is archived after the first projection",
    async (resource, source) => {
      const fixture = await records();
      const id =
        resource === "contacts"
          ? fixture.contact
          : resource === "leads"
            ? fixture.lead
            : resource === "tasks"
              ? fixture.task
              : fixture.deal;
      await race(
        (reader) => reader.detail(resource, id),
        () =>
          admin.query(`UPDATE app.${source} SET archived_at=clock_timestamp()WHERE tenant_id=$1 AND id=$2`, [
            fixtures.orgA,
            fixture[source],
          ]),
      );
      await expect(read((reader) => reader.detail(resource, id))).rejects.toMatchObject({ status: 404 });
    },
  );

  it.each(["tasks", "deals"] as const)(
    "rejects %s deleted after its first authorized projection",
    async (resource) => {
      const fixture = await records();
      const table = resource === "tasks" ? "task" : "deal";
      await race(
        (reader) => reader.detail(resource, fixture[table]),
        () =>
          admin.query(`DELETE FROM app.${table} WHERE tenant_id=$1 AND id=$2`, [
            fixtures.orgA,
            fixture[table],
          ]),
      );
    },
  );

  it.each(["contacts", "leads"] as const)(
    "rejects %s deleted after its first authorized projection",
    async (resource) => {
      const fixture = await records();
      await race(
        (reader) => reader.detail(resource, resource === "contacts" ? fixture.contact : fixture.lead),
        async () => {
          const client = await admin.connect();
          try {
            await client.query("BEGIN");
            await client.query("DELETE FROM app.lead_tag WHERE tenant_id=$1 AND lead_id=$2", [
              fixtures.orgA,
              fixture.lead,
            ]);
            await client.query("DELETE FROM app.task WHERE tenant_id=$1 AND id=$2", [
              fixtures.orgA,
              fixture.task,
            ]);
            await client.query("DELETE FROM app.deal WHERE tenant_id=$1 AND id=$2", [
              fixtures.orgA,
              fixture.deal,
            ]);
            await client.query("DELETE FROM app.lead WHERE tenant_id=$1 AND id=$2", [
              fixtures.orgA,
              fixture.lead,
            ]);
            if (resource === "contacts") {
              await client.query("DELETE FROM app.contact_channel WHERE tenant_id=$1 AND id=$2", [
                fixtures.orgA,
                fixture.channel,
              ]);
              await client.query("DELETE FROM app.contact WHERE tenant_id=$1 AND id=$2", [
                fixtures.orgA,
                fixture.contact,
              ]);
            }
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            client.release();
          }
        },
      );
    },
  );

  it.each(["active", "value", "order"] as const)(
    "rejects unversioned contact channel %s changes during a detail read",
    async (change) => {
      const fixture = await records();
      const clause =
        change === "active"
          ? "active=false"
          : change === "value"
            ? "normalized_value='changed@example.test'"
            : "created_at=created_at-interval '1 day'";
      await race(
        (reader) => reader.detail("contacts", fixture.contact),
        () =>
          admin.query(`UPDATE app.contact_channel SET ${clause} WHERE tenant_id=$1 AND id=$2`, [
            fixtures.orgA,
            fixture.channel,
          ]),
      );
      expect(
        (
          await admin.query("SELECT row_version FROM app.contact_channel WHERE tenant_id=$1 AND id=$2", [
            fixtures.orgA,
            fixture.channel,
          ])
        ).rows[0].row_version,
      ).toBe("1");
    },
  );

  it("rejects a changed frozen body even when a source writer failed to increment its revision", async () => {
    const fixture = await records();
    await race(
      (reader) => reader.detail("tasks", fixture.task),
      () =>
        admin.query("UPDATE app.task SET title='Changed synthetic task'WHERE tenant_id=$1 AND id=$2", [
          fixtures.orgA,
          fixture.task,
        ]),
    );
  });

  it("rejects a parent revision change even when the child frozen response is unchanged", async () => {
    const fixture = await records();
    await race(
      (reader) => reader.detail("deals", fixture.deal),
      () =>
        admin.query("UPDATE app.contact SET row_version=row_version+1 WHERE tenant_id=$1 AND id=$2", [
          fixtures.orgA,
          fixture.contact,
        ]),
    );
  });

  it("rejects removal of a tag relationship from the exact authorized filtered page", async () => {
    const fixture = await records();
    await race(
      (reader) =>
        reader.list("contacts", { filter: JSON.stringify({ q: fixture.marker, tagIds: [fixture.tag] }) }),
      () =>
        admin.query("DELETE FROM app.lead_tag WHERE tenant_id=$1 AND lead_id=$2 AND tag_id=$3", [
          fixtures.orgA,
          fixture.lead,
          fixture.tag,
        ]),
    );
    const current = await read((reader) =>
      reader.list("contacts", { filter: JSON.stringify({ q: fixture.marker, tagIds: [fixture.tag] }) }),
    );
    expect(current.items).toEqual([]);
  });

  it("rejects changed owner-filter authority without relying on a lead revision bump", async () => {
    const fixture = await records();
    await race(
      (reader) =>
        reader.list("contacts", {
          filter: JSON.stringify({ q: fixture.marker, ownerMemberId: fixtures.ownerMemberA }),
        }),
      () =>
        admin.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
          fixtures.orgA,
          fixture.lead,
          fixtures.agentMemberA,
        ]),
    );
  });

  it("rejects a related tag change even when the lead frozen projection still matches", async () => {
    const fixture = await records();
    await race(
      (reader) => reader.detail("leads", fixture.lead),
      () =>
        admin.query("UPDATE app.tag SET name=name||' changed'WHERE tenant_id=$1 AND id=$2", [
          fixtures.orgA,
          fixture.tag,
        ]),
    );
  });

  it("rejects page membership churn that changes hasMore after the first exact query", async () => {
    const fixture = await records();
    await race(
      (reader) => reader.list("tags", { limit: "1", filter: JSON.stringify({ q: fixture.marker }) }),
      () =>
        admin.query("INSERT INTO app.tag(tenant_id,id,name)VALUES($1,$2,$3)", [
          fixtures.orgA,
          randomUUID(),
          fixture.marker + " second",
        ]),
    );
  });

  it("rechecks full pipeline ordering including a changed row outside the limited page", async () => {
    const fixture = await records();
    const later = [randomUUID(), randomUUID()];
    for (const [offset, id] of later.entries())
      await admin.query("INSERT INTO app.pipeline_stage(tenant_id,id,name,position)VALUES($1,$2,$3,$4)", [
        fixtures.orgA,
        id,
        fixture.marker + " " + offset,
        position++,
      ]);
    await race(
      (reader) =>
        reader.list("pipeline-stages", { limit: "1", filter: JSON.stringify({ q: fixture.marker }) }),
      () =>
        admin.query("UPDATE app.pipeline_stage SET position=$3 WHERE tenant_id=$1 AND id=$2", [
          fixtures.orgA,
          later[1],
          position++,
        ]),
    );
  });

  it("leaves pooled control connections without tenant or grant visibility after rejected reads", async () => {
    const result = await pools.control.query(
      "SELECT nullif(current_setting('app.tenant_id',true),'')AS tenant,nullif(current_setting('app.support_grant_id',true),'')AS grant,(SELECT count(*)::int FROM app.contact)AS visible",
    );
    expect(result.rows[0]).toEqual({ tenant: null, grant: null, visible: 0 });
  });

  it("denies a preserved oversized purpose without disclosing or truncating it and permits identity-only clear", async () => {
    const reason = ("PRIVATE_SYNTHETIC_PRESERVED_PURPOSE_" + "x".repeat(1001)).slice(0, 1001);
    await admin.query("UPDATE app.support_access_grant SET reason=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      selectedGrantId,
      reason,
    ]);
    await expect(read((reader) => reader.detail("contacts", fixtures.contactA))).rejects.toMatchObject({
      status: 403,
      code: "support_context_unavailable",
    });
    const stale = await withStaffTransaction(
      pools.control,
      recipientToken,
      (client, session) => new SupportService(client, session, randomUUID()).sessionView(),
      { intent: "identity" },
    );
    validateStaff("SessionResponse", stale.body, true);
    expect(stale).toEqual({
      state: "stale",
      body: {
        staffUserId: fixtures.staffSupportUser,
        permissions: expect.any(Array),
        synthetic: true,
        supportContext: null,
      },
    });
    expect(JSON.stringify(stale)).not.toContain("PRIVATE_SYNTHETIC_PRESERVED_PURPOSE_");
    await withStaffTransaction(
      pools.control,
      recipientToken,
      async (client, session) => {
        const cleared = await new SupportService(client, session, randomUUID()).clear(randomUUID());
        validateStaff("SessionResponse", cleared, true);
        expect(cleared.supportContext).toBeNull();
      },
      { intent: "context-mutation" },
    );
    const row = (
      await admin.query("SELECT reason FROM app.support_access_grant WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        selectedGrantId,
      ])
    ).rows[0];
    expect(row.reason).toBe(reason);
    const session = await withStaffTransaction(
      pools.control,
      recipientToken,
      (client, identity) => new SupportService(client, identity, randomUUID()).sessionView(),
      { intent: "identity" },
    );
    expect(session.state).toBe("none");
    expect(session.body.supportContext).toBeNull();
  });
});

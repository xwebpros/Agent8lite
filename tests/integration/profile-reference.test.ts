import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCmsProfileReferencePort } from "../../apps/api/src/admin-profile-reference";
import { fixtures } from "../../packages/db/fixtures";
import { withTenantTransaction } from "../../packages/db/tenant-transaction";
import { createMigrationPool, createRuntimePool } from "../helpers/database";

const admin = createMigrationPool();
const runtime = createRuntimePool();
const own = randomUUID();
const foreign = randomUUID();
const capability = randomUUID();
const identity = { userId: fixtures.ownerUser, organizationId: fixtures.orgA };

beforeAll(async () => {
  await admin.query(
    "INSERT INTO app.entitlement(tenant_id,id,feature,state)VALUES($1,$2,'websites','enabled')",
    [fixtures.orgA, capability],
  );
  await admin.query(
    "INSERT INTO app.business_profile(tenant_id,id,name)VALUES($1,$2,'Synthetic reference'),($3,$4,'Synthetic foreign reference')",
    [fixtures.orgA, own, fixtures.orgB, foreign],
  );
});
afterAll(async () => {
  try {
    await admin.query("DELETE FROM app.business_profile WHERE id=ANY($1::uuid[])", [[own, foreign]]);
    await admin.query("DELETE FROM app.entitlement WHERE id=$1", [capability]);
  } finally {
    await Promise.all([runtime.end(), admin.end()]);
  }
});

describe("administration-owned CMS profile reference port", () => {
  it("returns only same-tenant reference identity and denies missing/foreign references", async () => {
    await withTenantTransaction(runtime, identity, async (client, context) => {
      const profiles = createCmsProfileReferencePort(client, context);
      expect(await profiles.requireActiveReference(own)).toEqual({ id: own, organizationId: fixtures.orgA });
      await expect(profiles.requireActiveReference(foreign)).rejects.toMatchObject({
        status: 404,
        code: "resource_unavailable",
      });
      await expect(profiles.requireActiveReference(randomUUID())).rejects.toMatchObject({
        status: 404,
        code: "resource_unavailable",
      });
    });
  });

  it("requires an organization CMS grant and the current websites capability", async () => {
    await withTenantTransaction(runtime, identity, async (client, context) => {
      await expect(
        createCmsProfileReferencePort(client, {
          ...context,
          permissions: [{ code: "sites.read", scope: "own" }],
        }).requireActiveReference(own),
      ).rejects.toMatchObject({ status: 403, code: "permission_denied" });
    });
    await admin.query("UPDATE app.entitlement SET state='disabled' WHERE id=$1", [capability]);
    try {
      await expect(
        withTenantTransaction(runtime, identity, (client, context) =>
          createCmsProfileReferencePort(client, context).requireActiveReference(own),
        ),
      ).rejects.toMatchObject({ status: 403, code: "entitlement_disabled" });
    } finally {
      await admin.query("UPDATE app.entitlement SET state='enabled' WHERE id=$1", [capability]);
    }
  });

  it("holds the profile row until caller rollback and preserves unrelated profile data", async () => {
    const count = (await admin.query("SELECT count(*)::int count FROM app.business_profile")).rows[0].count;
    await expect(
      withTenantTransaction(runtime, identity, async (client, context) => {
        await createCmsProfileReferencePort(client, context).requireActiveReference(own);
        const writer = await admin.connect();
        try {
          await writer.query("BEGIN");
          await writer.query("SET LOCAL lock_timeout='75ms'");
          await expect(
            writer.query("DELETE FROM app.business_profile WHERE id=$1", [own]),
          ).rejects.toMatchObject({ code: "55P03" });
        } finally {
          await writer.query("ROLLBACK");
          writer.release();
        }
        throw new Error("Synthetic caller rollback");
      }),
    ).rejects.toThrow("Synthetic caller rollback");
    expect((await admin.query("SELECT count(*)::int count FROM app.business_profile")).rows[0].count).toBe(
      count,
    );
    await admin.query("UPDATE app.business_profile SET row_version=row_version+1 WHERE id=$1", [own]);
  });

  it("denies a detached context after commit and does not retain actor or tenant in the pool", async () => {
    const context = await withTenantTransaction(runtime, identity, async (_client, verified) => verified);
    const client = await runtime.connect();
    try {
      const state = (await client.query("SELECT app.current_tenant() tenant,app.current_actor() actor"))
        .rows[0];
      expect(state).toEqual({ tenant: null, actor: null });
      await expect(
        createCmsProfileReferencePort(client, context).requireActiveReference(own),
      ).rejects.toMatchObject({ status: 403, code: "entitlement_disabled" });
    } finally {
      client.release();
    }
  });

  it("denies capability expiry while the profile lock blocks, using the current database clock", async () => {
    await admin.query(
      "UPDATE app.entitlement SET effective_until=clock_timestamp()+interval '2 seconds' WHERE id=$1",
      [capability],
    );
    const blocker = await admin.connect();
    let pending: Promise<unknown> | undefined;
    let readerPid: number | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE app.business_profile SET row_version=row_version+1 WHERE id=$1", [own]);
      pending = withTenantTransaction(runtime, identity, async (client, context) => {
        readerPid = (await client.query("SELECT pg_backend_pid() pid")).rows[0].pid;
        return createCmsProfileReferencePort(client, context).requireActiveReference(own);
      });
      const outcome = pending.then(
        () => ({ succeeded: true }),
        (error) => ({ succeeded: false, error }),
      );
      const deadline = Date.now() + 1500;
      let blocked = false;
      while (Date.now() < deadline) {
        if (readerPid) {
          blocked = (
            await blocker.query(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock') blocked",
              [readerPid],
            )
          ).rows[0].blocked;
          if (blocked) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked, "The real runtime reader must wait on the held profile row").toBe(true);
      await blocker.query("SELECT pg_sleep(2.1)");
      await blocker.query("ROLLBACK");
      expect(await outcome).toMatchObject({
        succeeded: false,
        error: { status: 403, code: "entitlement_disabled" },
      });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await pending?.catch(() => {});
      await admin.query("UPDATE app.entitlement SET effective_until=NULL WHERE id=$1", [capability]);
    }
  });
});

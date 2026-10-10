import { randomUUID } from "node:crypto";
import net from "node:net";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dispatchOutbox } from "../../apps/worker/src/outbox";
import {
  processWakeup,
  recoverCommittedOutbox,
  RedisWakeups,
  TrustedContextRegistry,
} from "../../apps/worker/src/wakeups";
import { fixtures } from "../../packages/db/fixtures";
import { assertRuntimeRole } from "../../packages/db/runtime-role";
import type { VerifiedIdentityContext } from "../../packages/db/tenant-transaction";
import { createMigrationPool, workerDatabaseUrl } from "../helpers/database";

const admin = createMigrationPool();
const worker = new pg.Pool({ connectionString: workerDatabaseUrl, max: 4 });
const actor = { userId: randomUUID(), organizationId: fixtures.orgA };
const memberId = randomUUID();
const roleId = randomUUID();
const contactId = randomUUID();
const leadId = randomUUID();
const events = new Set<string>();
const registry = () => new TrustedContextRegistry([{ ...actor }]);
const dispatch = (identity: VerifiedIdentityContext) => dispatchOutbox(worker, identity);

beforeAll(async () => {
  await assertRuntimeRole(worker);
  await admin.query(
    "INSERT INTO app.role_definition(tenant_id,id,name,permission_grants) VALUES($1,$2,$3,$4)",
    [
      fixtures.orgA,
      roleId,
      `Synthetic recovery ${roleId}`,
      JSON.stringify([{ code: "crm.leads.read", scope: "own" }]),
    ],
  );
  await admin.query(
    "INSERT INTO app.user_identity(id,issuer,subject,display_name,email_verified) VALUES($1,'https://synthetic.test.invalid',$2,'Synthetic recovery actor',true)",
    [actor.userId, randomUUID()],
  );
  await admin.query(
    "INSERT INTO app.membership(tenant_id,id,user_id,role_id,status,display_name) VALUES($1,$2,$3,$4,'active','Synthetic recovery member')",
    [fixtures.orgA, memberId, actor.userId, roleId],
  );
  await admin.query(
    "INSERT INTO app.contact(tenant_id,id,display_name,created_by_member_id) VALUES($1,$2,'Synthetic recovery contact',$3)",
    [fixtures.orgA, contactId, memberId],
  );
  await admin.query(
    "INSERT INTO app.lead(tenant_id,id,contact_id,source_id,stage_id,owner_member_id,intent) SELECT $1,$2,$3,$4,id,$5,'buyer' FROM app.pipeline_stage WHERE tenant_id=$1 ORDER BY position LIMIT 1",
    [fixtures.orgA, leadId, contactId, fixtures.sourceA, memberId],
  );
});

async function addEvent() {
  const id = randomUUID();
  const now = new Date().toISOString();
  await admin.query(
    "INSERT INTO app.outbox(tenant_id,id,event_type,aggregate_id,payload,initiating_actor_id) VALUES($1,$2,'lead.captured',$3,$4,$5)",
    [
      fixtures.orgA,
      id,
      leadId,
      JSON.stringify({
        eventId: id,
        type: "lead.captured",
        version: 1,
        tenantId: fixtures.orgA,
        occurredAt: now,
        ingestedAt: now,
        producer: "crm",
        aggregateType: "lead",
        aggregateId: leadId,
        correlationId: randomUUID(),
        payload: { resourceId: leadId, resourceVersion: 1, relatedResourceIds: [contactId] },
      }),
      actor.userId,
    ],
  );
  events.add(id);
  return id;
}

async function evidence(id: string) {
  return (
    await admin.query(
      "SELECT o.published_at,o.attempt_count,(SELECT count(*)::int FROM app.outbox_consumer_receipt r WHERE r.tenant_id=o.tenant_id AND r.event_id=o.id) receipts,(SELECT count(*)::int FROM app.audit_event a WHERE a.tenant_id=o.tenant_id AND a.resource_type='outbox' AND a.resource_id=o.id::text AND a.action='outbox.dispatched') audits FROM app.outbox o WHERE o.tenant_id=$1 AND o.id=$2",
      [fixtures.orgA, id],
    )
  ).rows[0];
}

async function unusedLoopbackPort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic loopback port unavailable.");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

afterEach(async () => {
  const ids = [...events];
  await admin.query(
    "DELETE FROM app.outbox_consumer_receipt WHERE tenant_id=$1 AND event_id=ANY($2::uuid[])",
    [fixtures.orgA, ids],
  );
  await admin.query(
    "DELETE FROM app.audit_event WHERE tenant_id=$1 AND resource_type='outbox' AND resource_id=ANY($2::text[])",
    [fixtures.orgA, ids],
  );
  await admin.query("DELETE FROM app.outbox WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [fixtures.orgA, ids]);
  events.clear();
});

afterAll(async () => {
  try {
    await admin.query("DELETE FROM app.lead WHERE tenant_id=$1 AND id=$2", [fixtures.orgA, leadId]);
    await admin.query("DELETE FROM app.contact WHERE tenant_id=$1 AND id=$2", [fixtures.orgA, contactId]);
    await admin.query("DELETE FROM app.membership WHERE tenant_id=$1 AND id=$2", [fixtures.orgA, memberId]);
    await admin.query("DELETE FROM app.user_identity WHERE id=$1", [actor.userId]);
    await admin.query("DELETE FROM app.role_definition WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      roleId,
    ]);
  } finally {
    await Promise.all([admin.end(), worker.end()]);
  }
});

describe("ADR-015 PostgreSQL-authoritative wakeup recovery", () => {
  it("retained wakeups cannot acknowledge work after the current CRM capability is disabled", async () => {
    const id = await addEvent();
    const contexts = registry();
    const entitlement = (
      await admin.query(
        "SELECT id,state,effective_until FROM app.entitlement WHERE tenant_id=$1 AND feature='crm'",
        [fixtures.orgA],
      )
    ).rows[0];
    expect(entitlement).toBeTruthy();
    try {
      await admin.query("UPDATE app.entitlement SET state='disabled' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        entitlement.id,
      ]);
      expect(await processWakeup(contexts, contexts.hintFor(actor), dispatch)).toEqual({
        dispatched: 0,
        deferred: 1,
      });
      expect(await evidence(id)).toMatchObject({ published_at: null, receipts: 0, audits: 0 });
    } finally {
      await admin.query(
        "UPDATE app.entitlement SET state=$3,effective_until=$4 WHERE tenant_id=$1 AND id=$2",
        [fixtures.orgA, entitlement.id, entitlement.state, entitlement.effective_until],
      );
    }
    await admin.query("UPDATE app.outbox SET lease_until=NULL WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      id,
    ]);
    expect((await recoverCommittedOutbox(contexts, dispatch)).dispatched).toBe(1);
    expect(await evidence(id)).toMatchObject({ receipts: 1, audits: 1, attempt_count: 2 });
  });

  it("recovers committed work with unavailable Redis, bounded enqueue and owned shutdown", async () => {
    const id = await addEvent();
    const contexts = registry();
    const redis = new RedisWakeups(
      `redis://127.0.0.1:${await unusedLoopbackPort()}`,
      contexts,
      dispatch,
      `acceptance-${randomUUID().replaceAll("-", "")}`,
    );
    const started = performance.now();
    try {
      expect(await redis.enqueue(contexts.hintFor(actor))).toBe(false);
      expect(await recoverCommittedOutbox(contexts, dispatch)).toEqual({
        contexts: 1,
        failedContexts: 0,
        dispatched: 1,
        deferred: 0,
      });
      expect(await evidence(id)).toMatchObject({ receipts: 1, audits: 1, attempt_count: 1 });
      expect((await evidence(id)).published_at).not.toBeNull();
    } finally {
      await redis.close();
    }
    expect(performance.now() - started).toBeLessThan(5000);
    expect(await redis.enqueue(contexts.hintFor(actor))).toBe(false);
    await redis.close();
  });

  it("lost hints, duplicated concurrent hints and a restarted registry retain one durable acknowledgment", async () => {
    const id = await addEvent();
    const first = registry();
    // No enqueue exists for this committed row: startup recovery alone finds it.
    expect((await recoverCommittedOutbox(first, dispatch)).dispatched).toBe(1);
    const restarted = registry();
    const hint = restarted.hintFor(actor);
    const duplicate = await Promise.all([
      processWakeup(restarted, hint, dispatch),
      processWakeup(restarted, hint, dispatch),
      recoverCommittedOutbox(restarted, dispatch),
    ]);
    expect(duplicate.map((run) => run.dispatched)).toEqual([0, 0, 0]);
    const next = await addEvent();
    const races = await Promise.all([
      processWakeup(restarted, hint, dispatch),
      processWakeup(restarted, hint, dispatch),
      recoverCommittedOutbox(restarted, dispatch),
    ]);
    expect(races.reduce((count, run) => count + run.dispatched, 0)).toBe(1);
    for (const event of [id, next]) {
      expect(await evidence(event)).toMatchObject({ receipts: 1, audits: 1, attempt_count: 1 });
      expect((await evidence(event)).published_at).not.toBeNull();
    }
    expect(
      (
        await worker.query(
          "SELECT current_setting('app.tenant_id',true) tenant,current_setting('app.actor_id',true) actor",
        )
      ).rows[0],
    ).toEqual({ tenant: "", actor: "" });
  });

  it("retained hints recheck revoked membership and current source scope before recording success", async () => {
    const id = await addEvent();
    const contexts = registry();
    const hint = contexts.hintFor(actor);
    try {
      await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        memberId,
      ]);
      expect(await recoverCommittedOutbox(contexts, dispatch)).toEqual({
        contexts: 1,
        failedContexts: 1,
        dispatched: 0,
        deferred: 0,
      });
      await expect(processWakeup(contexts, hint, dispatch)).rejects.toMatchObject({
        code: "membership_required",
      });
      expect(await evidence(id)).toEqual({ published_at: null, attempt_count: 0, receipts: 0, audits: 0 });
    } finally {
      await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        memberId,
      ]);
    }
    try {
      await admin.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        leadId,
        fixtures.ownerMemberA,
      ]);
      expect(await processWakeup(contexts, hint, dispatch)).toEqual({ dispatched: 0, deferred: 1 });
      expect(await evidence(id)).toEqual({ published_at: null, attempt_count: 1, receipts: 0, audits: 0 });
    } finally {
      await admin.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        leadId,
        memberId,
      ]);
    }
    await admin.query("UPDATE app.outbox SET lease_until=NULL WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      id,
    ]);
    expect((await recoverCommittedOutbox(contexts, dispatch)).dispatched).toBe(1);
    expect(await evidence(id)).toMatchObject({ receipts: 1, audits: 1, attempt_count: 2 });
  });

  it("retained hints recheck changed role grants and archive state rather than cached registry authority", async () => {
    const id = await addEvent();
    const contexts = registry();
    const hint = contexts.hintFor(actor);
    try {
      await admin.query(
        "UPDATE app.role_definition SET permission_grants='[]' WHERE tenant_id=$1 AND id=$2",
        [fixtures.orgA, roleId],
      );
      expect((await recoverCommittedOutbox(contexts, dispatch)).deferred).toBe(1);
      expect(await evidence(id)).toMatchObject({ published_at: null, receipts: 0, audits: 0 });
    } finally {
      await admin.query("UPDATE app.role_definition SET permission_grants=$3 WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        roleId,
        JSON.stringify([{ code: "crm.leads.read", scope: "own" }]),
      ]);
    }
    try {
      await admin.query("UPDATE app.lead SET archived_at=now() WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        leadId,
      ]);
      await admin.query("UPDATE app.outbox SET lease_until=NULL WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        id,
      ]);
      expect(await processWakeup(contexts, hint, dispatch)).toEqual({ dispatched: 0, deferred: 1 });
      expect(await evidence(id)).toMatchObject({ published_at: null, receipts: 0, audits: 0 });
    } finally {
      await admin.query("UPDATE app.lead SET archived_at=NULL WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        leadId,
      ]);
    }
  });
});

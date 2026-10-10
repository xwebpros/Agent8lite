import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dispatchOutbox } from "../../apps/worker/src/outbox";
import { fixtures } from "../../packages/db/fixtures";
import { createMigrationPool, workerDatabaseUrl } from "../helpers/database";

const admin = createMigrationPool();
const worker = new pg.Pool({ connectionString: workerDatabaseUrl, max: 4 });
const userId = randomUUID();
const memberId = randomUUID();
const contactId = randomUUID();
const leadId = randomUUID();
const inaccessibleLeadId = randomUUID();
const archivedLeadId = randomUUID();
const identity = { userId, organizationId: fixtures.orgA };
const events = new Set<string>();

beforeAll(async () => {
  const role = (
    await admin.query("SELECT role_id FROM app.membership WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      fixtures.agentMemberA,
    ])
  ).rows[0].role_id;
  const stage = (
    await admin.query("SELECT id FROM app.pipeline_stage WHERE tenant_id=$1 ORDER BY position LIMIT 1", [
      fixtures.orgA,
    ])
  ).rows[0].id;
  await admin.query(
    "INSERT INTO app.user_identity(id,issuer,subject,display_name,email_verified) VALUES($1,'https://synthetic.test.invalid',$2,'Synthetic outbox actor',true)",
    [userId, randomUUID()],
  );
  await admin.query(
    "INSERT INTO app.membership(tenant_id,id,user_id,role_id,status,display_name) VALUES($1,$2,$3,$4,'active','Synthetic outbox member')",
    [fixtures.orgA, memberId, userId, role],
  );
  await admin.query(
    "INSERT INTO app.contact(tenant_id,id,display_name,created_by_member_id) VALUES($1,$2,'Synthetic outbox source',$3)",
    [fixtures.orgA, contactId, memberId],
  );
  for (const [id, owner, archived] of [
    [leadId, memberId, false],
    [inaccessibleLeadId, fixtures.ownerMemberA, false],
    [archivedLeadId, memberId, true],
  ] as const) {
    await admin.query(
      "INSERT INTO app.lead(tenant_id,id,contact_id,source_id,stage_id,owner_member_id,intent,archived_at) VALUES($1,$2,$3,$4,$5,$6,'buyer',$7)",
      [fixtures.orgA, id, contactId, fixtures.sourceA, stage, owner, archived ? new Date() : null],
    );
  }
});

async function addEvent(
  options: {
    tenantId?: string;
    actorId?: string;
    sourceId?: string;
    mutate?: (event: Record<string, unknown>) => void;
  } = {},
) {
  const id = randomUUID();
  const tenantId = options.tenantId ?? fixtures.orgA;
  const sourceId = options.sourceId ?? leadId;
  const now = new Date().toISOString();
  const envelope: Record<string, unknown> = {
    eventId: id,
    type: "lead.captured",
    version: 1,
    tenantId,
    occurredAt: now,
    ingestedAt: now,
    producer: "crm",
    aggregateType: "lead",
    aggregateId: sourceId,
    correlationId: randomUUID(),
    payload: { resourceId: sourceId, resourceVersion: 1, relatedResourceIds: [contactId] },
  };
  options.mutate?.(envelope);
  await admin.query(
    "INSERT INTO app.outbox(tenant_id,id,event_type,aggregate_id,payload,initiating_actor_id) VALUES($1,$2,$3,$4,$5,$6)",
    [tenantId, id, "lead.captured", sourceId, JSON.stringify(envelope), options.actorId ?? userId],
  );
  events.add(id);
  return id;
}

afterEach(async () => {
  const ids = [...events];
  if (!ids.length) return;
  await admin.query("DELETE FROM app.outbox_consumer_receipt WHERE event_id=ANY($1::uuid[])", [ids]);
  await admin.query(
    "DELETE FROM app.audit_event WHERE resource_type='outbox' AND resource_id=ANY($1::text[])",
    [ids],
  );
  await admin.query("DELETE FROM app.outbox WHERE id=ANY($1::uuid[])", [ids]);
  events.clear();
});

afterAll(async () => {
  await admin.query("DELETE FROM app.lead WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [
    fixtures.orgA,
    [leadId, inaccessibleLeadId, archivedLeadId],
  ]);
  await admin.query("DELETE FROM app.contact WHERE tenant_id=$1 AND id=$2", [fixtures.orgA, contactId]);
  await admin.query("DELETE FROM app.membership WHERE tenant_id=$1 AND id=$2", [fixtures.orgA, memberId]);
  await admin.query("DELETE FROM app.user_identity WHERE id=$1", [userId]);
  await Promise.all([admin.end(), worker.end()]);
});

describe("M1 — scoped durable outbox ledger, without external delivery", () => {
  it("atomically records one immutable receipt, audit and published acknowledgment; repeat dispatch is empty", async () => {
    const eventId = await addEvent();
    expect(await dispatchOutbox(worker, identity)).toEqual({ dispatched: 1, deferred: 0 });
    const evidence = await admin.query(
      "SELECT o.published_at,o.attempt_count,(SELECT count(*)::int FROM app.outbox_consumer_receipt r WHERE r.tenant_id=o.tenant_id AND r.event_id=o.id) receipts,(SELECT count(*)::int FROM app.audit_event a WHERE a.tenant_id=o.tenant_id AND a.resource_type='outbox' AND a.resource_id=o.id::text AND a.safe_diff->>'externalDelivery'='false') audits FROM app.outbox o WHERE o.id=$1",
      [eventId],
    );
    expect(evidence.rows[0]).toMatchObject({ attempt_count: 1, receipts: 1, audits: 1 });
    expect(evidence.rows[0].published_at).not.toBeNull();
    expect(await dispatchOutbox(worker, identity)).toEqual({ dispatched: 0, deferred: 0 });
    const grants = await worker.query(
      "SELECT has_table_privilege(current_user,'app.outbox_consumer_receipt','UPDATE') can_update,has_table_privilege(current_user,'app.outbox_consumer_receipt','DELETE') can_delete,has_table_privilege(current_user,'app.membership','UPDATE') can_change_membership",
    );
    expect(grants.rows[0]).toEqual({ can_update: false, can_delete: false, can_change_membership: false });
  });

  it("concurrent workers claim each event once and commit matching acknowledgments", async () => {
    const ids = await Promise.all([addEvent(), addEvent(), addEvent()]);
    const runs = await Promise.all([
      dispatchOutbox(worker, identity, 2),
      dispatchOutbox(worker, identity, 2),
      dispatchOutbox(worker, identity, 2),
    ]);
    expect(runs.reduce((count, run) => count + run.dispatched, 0)).toBe(3);
    expect(runs.reduce((count, run) => count + run.deferred, 0)).toBe(0);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int count FROM app.outbox_consumer_receipt WHERE event_id=ANY($1::uuid[])",
          [ids],
        )
      ).rows[0].count,
    ).toBe(3);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int count FROM app.outbox WHERE id=ANY($1::uuid[]) AND published_at IS NOT NULL",
          [ids],
        )
      ).rows[0].count,
    ).toBe(3);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int count FROM app.audit_event WHERE resource_type='outbox' AND resource_id=ANY($1::text[])",
          [ids],
        )
      ).rows[0].count,
    ).toBe(3);
  });

  it("cannot dispatch another tenant or initiating actor even when supplied a valid envelope", async () => {
    const otherTenant = await addEvent({ tenantId: fixtures.orgB, sourceId: fixtures.leadB });
    const otherActor = await addEvent({ actorId: fixtures.otherAgentUser });
    expect(await dispatchOutbox(worker, identity)).toEqual({ dispatched: 0, deferred: 0 });
    const rows = (
      await admin.query("SELECT published_at,attempt_count FROM app.outbox WHERE id=ANY($1::uuid[])", [
        [otherTenant, otherActor],
      ])
    ).rows;
    expect(rows).toEqual([
      { published_at: null, attempt_count: 0 },
      { published_at: null, attempt_count: 0 },
    ]);
  });

  it("defers malformed, mismatched or unauthorized source records without acknowledgments", async () => {
    const ids = await Promise.all([
      addEvent({
        mutate: (event) => {
          event.tenantId = fixtures.orgB;
        },
      }),
      addEvent({
        mutate: (event) => {
          event.eventId = randomUUID();
        },
      }),
      addEvent({
        mutate: (event) => {
          event.payload = { body: "Forbidden message payload" };
        },
      }),
      addEvent({ sourceId: inaccessibleLeadId }),
      addEvent({ sourceId: archivedLeadId }),
    ]);
    expect(await dispatchOutbox(worker, identity)).toEqual({ dispatched: 0, deferred: 5 });
    const rows = (
      await admin.query(
        "SELECT published_at,lease_until,attempt_count FROM app.outbox WHERE id=ANY($1::uuid[])",
        [ids],
      )
    ).rows;
    for (const row of rows) {
      expect(row.published_at).toBeNull();
      expect(row.lease_until.getTime()).toBeGreaterThan(Date.now());
      expect(row.attempt_count).toBe(1);
    }
    expect(
      (
        await admin.query("SELECT event_id FROM app.outbox_consumer_receipt WHERE event_id=ANY($1::uuid[])", [
          ids,
        ])
      ).rows,
    ).toEqual([]);
    expect(await dispatchOutbox(worker, identity)).toEqual({ dispatched: 0, deferred: 0 });
  });

  it("membership revocation and source reassignment are rechecked at dispatch", async () => {
    const eventId = await addEvent();
    try {
      await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        memberId,
      ]);
      await expect(dispatchOutbox(worker, identity)).rejects.toMatchObject({
        status: 403,
        code: "membership_required",
      });
      expect(
        (await admin.query("SELECT attempt_count,published_at FROM app.outbox WHERE id=$1", [eventId]))
          .rows[0],
      ).toEqual({ attempt_count: 0, published_at: null });
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
      expect(await dispatchOutbox(worker, identity)).toEqual({ dispatched: 0, deferred: 1 });
      expect(
        (await admin.query("SELECT event_id FROM app.outbox_consumer_receipt WHERE event_id=$1", [eventId]))
          .rows,
      ).toEqual([]);
    } finally {
      await admin.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        leadId,
        memberId,
      ]);
    }
  });

  it("a failed acknowledgment transaction cannot leave a successful consumer receipt", async () => {
    const eventId = await addEvent();
    const restricted = new pg.Pool({ connectionString: workerDatabaseUrl, max: 1 });
    try {
      // Revoking a specific grant temporarily injects a real failure after receipt insertion.
      await admin.query("REVOKE INSERT ON app.audit_event FROM estate_worker");
      await expect(dispatchOutbox(restricted, identity)).rejects.toMatchObject({ code: "42501" });
      expect(
        (await admin.query("SELECT event_id FROM app.outbox_consumer_receipt WHERE event_id=$1", [eventId]))
          .rows,
      ).toEqual([]);
      expect(
        (await admin.query("SELECT attempt_count,published_at FROM app.outbox WHERE id=$1", [eventId]))
          .rows[0],
      ).toEqual({ attempt_count: 0, published_at: null });
    } finally {
      await admin.query("GRANT INSERT ON app.audit_event TO estate_worker");
      await restricted.end();
    }
    expect(await dispatchOutbox(worker, identity)).toEqual({ dispatched: 1, deferred: 0 });
  });

  it("disabled and expired entitlements defer dispatch until the current entitlement is enabled", async () => {
    const entitlement = (
      await admin.query(
        "SELECT id,state,effective_until FROM app.entitlement WHERE tenant_id=$1 AND feature='crm'",
        [fixtures.orgA],
      )
    ).rows[0];
    expect(entitlement).toBeTruthy();
    const eventId = await addEvent();
    try {
      await admin.query("UPDATE app.entitlement SET state='disabled' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        entitlement.id,
      ]);
      expect(await dispatchOutbox(worker, identity)).toEqual({ dispatched: 0, deferred: 1 });
      await admin.query(
        "UPDATE app.entitlement SET state='enabled',effective_until=now()-interval '1 minute' WHERE tenant_id=$1 AND id=$2",
        [fixtures.orgA, entitlement.id],
      );
      await admin.query("UPDATE app.outbox SET lease_until=NULL WHERE id=$1", [eventId]);
      expect(await dispatchOutbox(worker, identity)).toEqual({ dispatched: 0, deferred: 1 });
      expect(
        (await admin.query("SELECT event_id FROM app.outbox_consumer_receipt WHERE event_id=$1", [eventId]))
          .rows,
      ).toEqual([]);
      await admin.query(
        "UPDATE app.entitlement SET state='enabled',effective_until=now()+interval '1 day' WHERE tenant_id=$1 AND id=$2",
        [fixtures.orgA, entitlement.id],
      );
      await admin.query("UPDATE app.outbox SET lease_until=NULL WHERE id=$1", [eventId]);
      expect(await dispatchOutbox(worker, identity)).toEqual({ dispatched: 1, deferred: 0 });
    } finally {
      await admin.query(
        "UPDATE app.entitlement SET state=$3,effective_until=$4 WHERE tenant_id=$1 AND id=$2",
        [fixtures.orgA, entitlement.id, entitlement.state, entitlement.effective_until],
      );
    }
  });
});

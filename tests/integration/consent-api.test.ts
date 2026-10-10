// ADR-014 bounded synthetic acceptance; this suite makes no transport/delivery claim.
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SyntheticEvidenceResponse } from "../../packages/contracts/internal/consent-port";
import { fixtures, stageId } from "../../packages/db/fixtures";
import { ApiSession, assertContract, assertProblem, type Schemas } from "../helpers/api";
import { createMigrationPool, createRuntimePool } from "../helpers/database";

const admin = createMigrationPool();
const runtime = createRuntimePool();
let owner: ApiSession;
let agent: ApiSession;
let originalMember: Record<string, any>;
let originalEntitlement: Record<string, any>;
const customRole = randomUUID();
const contacts = new Set<string>();
const channels = new Set<string>();
const destinations = new Set<string>();
const leads = new Set<string>();
const jobs = new Set<string>();
const keys = new Set<string>();
const grants: Schemas["RoleWrite"]["permissions"] = [
  { code: "crm.contacts.read", scope: "own" },
  { code: "crm.contacts.write", scope: "own" },
  { code: "consent.write", scope: "organization" },
  { code: "jobs.read", scope: "organization" },
];
const orgPath = (session: ApiSession) => `/v1/orgs/${session.orgId}/consent-events`;

async function person(
  options: { kind?: "email" | "phone"; destination?: string; tenant?: string; creator?: string } = {},
) {
  const contactId = randomUUID();
  const channelId = randomUUID();
  const kind = options.kind ?? "email";
  const destination =
    options.destination ??
    (kind === "email" ? `${randomUUID()}@example.test` : `+1555${randomInt(1_000_000, 9_000_000)}`);
  const tenant = options.tenant ?? fixtures.orgA;
  contacts.add(contactId);
  channels.add(channelId);
  destinations.add(destination);
  await admin.query(
    "INSERT INTO app.contact(tenant_id,id,display_name,created_by_member_id)VALUES($1,$2,$3,$4)",
    [tenant, contactId, `Synthetic consent ${randomUUID()}`, options.creator ?? agent.memberId],
  );
  await admin.query(
    "INSERT INTO app.contact_channel(tenant_id,id,contact_id,kind,normalized_value,is_primary)VALUES($1,$2,$3,$4,$5,true)",
    [tenant, channelId, contactId, kind, destination],
  );
  return { contactId, channelId, destination, tenant };
}

async function mutation(session: ApiSession, path: string, body: unknown, key = randomUUID(), csrf?: string) {
  keys.add(key);
  const response = await session.command(path, body, { key, csrf });
  if (response.status === 202) {
    const job = await response.clone().json();
    assertContract("Job", job);
    jobs.add(job.id);
  }
  return response;
}

async function issue(
  channelId: string,
  purpose: Schemas["ConsentWrite"]["purpose"] = "email_marketing",
  session = owner,
  key = randomUUID(),
) {
  const response = await mutation(
    session,
    "/dev/consent-evidence",
    { contactChannelId: channelId, purpose },
    key,
  );
  expect(response.status, await response.clone().text()).toBe(201);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const proof = (await response.json()) as SyntheticEvidenceResponse;
  expect(proof).toMatchObject({ policyVersion: "synthetic-communication-v1", synthetic: true });
  expect(proof.evidenceRef).toMatch(/^synthetic-evidence:[0-9a-f-]{36}$/);
  // Prove the persisted deadline using one clock domain; JS and PostgreSQL clocks may drift.
  const persisted = await admin.query(
    "SELECT expires_at,expires_at>clock_timestamp()AS current,extract(epoch FROM(expires_at-created_at))*1000 AS lifetime_ms FROM app.consent_evidence WHERE tenant_id=$1 AND id=$2",
    [session.orgId, proof.evidenceRef.slice("synthetic-evidence:".length)],
  );
  expect(persisted.rowCount).toBe(1);
  expect(persisted.rows[0].current).toBe(true);
  expect(Number(persisted.rows[0].lifetime_ms)).toBeGreaterThan(0);
  expect(Number(persisted.rows[0].lifetime_ms)).toBeLessThanOrEqual(15 * 60_000);
  expect(new Date(persisted.rows[0].expires_at).toISOString()).toBe(proof.expiresAt);
  return { proof, key };
}

function grant(
  channelId: string,
  proof: SyntheticEvidenceResponse,
  purpose: Schemas["ConsentWrite"]["purpose"] = "email_marketing",
): Schemas["ConsentWrite"] {
  return {
    contactChannelId: channelId,
    purpose,
    action: "grant",
    policyVersion: proof.policyVersion,
    evidenceRef: proof.evidenceRef,
  };
}
function withdrawal(
  channelId: string,
  purpose: Schemas["ConsentWrite"]["purpose"] = "email_marketing",
): Schemas["ConsentWrite"] {
  return {
    contactChannelId: channelId,
    purpose,
    action: "withdraw",
    policyVersion: "synthetic-staff-opt-out-v1",
    evidenceRef: `staff-withdrawal:${randomUUID()}`,
  };
}
async function record(body: Schemas["ConsentWrite"], session = owner, key = randomUUID()) {
  const response = await mutation(session, orgPath(session), body, key);
  expect(response.status, await response.clone().text()).toBe(202);
  const job = await response.json();
  assertContract("Job", job);
  expect(job.state).toBe("succeeded");
  return { job, key, body };
}
async function state(channelId: string, purpose = "email_marketing") {
  return (
    await admin.query("SELECT * FROM app.consent_state WHERE contact_channel_id=$1 AND purpose=$2", [
      channelId,
      purpose,
    ])
  ).rows[0];
}
async function setGrants(value: Schemas["RoleWrite"]["permissions"]) {
  await admin.query(
    "UPDATE app.role_definition SET permission_grants=$2,row_version=row_version+1 WHERE id=$1",
    [customRole, JSON.stringify(value)],
  );
}

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
  agent = await new ApiSession().signIn("agent");
  originalMember = (
    await admin.query("SELECT role_id,status FROM app.membership WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      agent.memberId,
    ])
  ).rows[0];
  originalEntitlement = (
    await admin.query(
      "SELECT state,effective_until FROM app.entitlement WHERE tenant_id=$1 AND feature='crm'",
      [fixtures.orgA],
    )
  ).rows[0];
  await admin.query(
    "INSERT INTO app.role_definition(tenant_id,id,name,permission_grants)VALUES($1,$2,$3,$4)",
    [fixtures.orgA, customRole, `Synthetic consent role ${customRole}`, JSON.stringify(grants)],
  );
});
beforeEach(async () => {
  await setGrants(grants);
  await admin.query(
    "UPDATE app.membership SET role_id=$3,status='active',row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
    [fixtures.orgA, agent.memberId, customRole],
  );
});
afterEach(async () => {
  if (owner.orgId !== fixtures.orgA) expect((await owner.switchOrganization(fixtures.orgA)).status).toBe(200);
  await admin.query(
    "UPDATE app.membership SET role_id=$3,status=$4,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
    [fixtures.orgA, agent.memberId, originalMember.role_id, originalMember.status],
  );
  await admin.query(
    "UPDATE app.entitlement SET state=$2,effective_until=$3,row_version=row_version+1 WHERE tenant_id=$1 AND feature='crm'",
    [fixtures.orgA, originalEntitlement.state, originalEntitlement.effective_until],
  );
  const channelIds = [...channels];
  const eventIds = channelIds.length
    ? (
        await admin.query("SELECT id FROM app.consent_event WHERE contact_channel_id=ANY($1::uuid[])", [
          channelIds,
        ])
      ).rows.map((row) => row.id)
    : [];
  const evidenceIds = channelIds.length
    ? (
        await admin.query("SELECT id FROM app.consent_evidence WHERE contact_channel_id=ANY($1::uuid[])", [
          channelIds,
        ])
      ).rows.map((row) => row.id)
    : [];
  if (keys.size)
    for (const row of (
      await admin.query(
        "SELECT response_body FROM app.idempotency_record WHERE key=ANY($1::text[]) AND status_code=202",
        [[...keys]],
      )
    ).rows)
      if (typeof row.response_body?.id === "string") jobs.add(row.response_body.id);
  const resources = [...channelIds, ...eventIds, ...evidenceIds, ...jobs];
  if (resources.length) {
    const events = (
      await admin.query("SELECT id FROM app.outbox WHERE aggregate_id=ANY($1::text[])", [resources])
    ).rows.map((row) => row.id);
    if (events.length) {
      await admin.query("DELETE FROM app.outbox_consumer_receipt WHERE event_id=ANY($1::uuid[])", [events]);
      await admin.query("DELETE FROM app.outbox WHERE id=ANY($1::uuid[])", [events]);
    }
    await admin.query("DELETE FROM app.audit_event WHERE resource_id=ANY($1::text[])", [resources]);
  }
  if (channelIds.length) {
    await admin.query("DELETE FROM app.consent_state WHERE contact_channel_id=ANY($1::uuid[])", [channelIds]);
    await admin.query("DELETE FROM app.consent_event WHERE contact_channel_id=ANY($1::uuid[])", [channelIds]);
    await admin.query("DELETE FROM app.consent_evidence WHERE contact_channel_id=ANY($1::uuid[])", [
      channelIds,
    ]);
    await admin.query("DELETE FROM app.contact_channel WHERE id=ANY($1::uuid[])", [channelIds]);
  }
  if (destinations.size)
    await admin.query(
      "DELETE FROM app.suppression WHERE tenant_id=ANY($1::uuid[]) AND normalized_destination=ANY($2::text[])",
      [[fixtures.orgA, fixtures.orgB], [...destinations]],
    );
  if (leads.size) await admin.query("DELETE FROM app.lead WHERE id=ANY($1::uuid[])", [[...leads]]);
  if (contacts.size) await admin.query("DELETE FROM app.contact WHERE id=ANY($1::uuid[])", [[...contacts]]);
  if (jobs.size) await admin.query("DELETE FROM app.integration_job WHERE id=ANY($1::uuid[])", [[...jobs]]);
  if (keys.size)
    await admin.query("DELETE FROM app.idempotency_record WHERE key=ANY($1::text[])", [[...keys]]);
  for (const set of [contacts, channels, destinations, leads, jobs, keys]) set.clear();
});
afterAll(async () => {
  try {
    await admin.query("DELETE FROM app.role_definition WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      customRole,
    ]);
  } finally {
    await Promise.all([admin.end(), runtime.end()]);
  }
});

describe("bounded consent — verified proof, durable opt-out and scoped retry", () => {
  it("returns generic channel labels only to current permitted source readers", async () => {
    const own = await person();
    const response = await agent.request(`/dev/consent-channels/${own.contactId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    expect(body).toEqual({
      contactId: own.contactId,
      channels: [{ id: own.channelId, kind: "email", label: "Email channel 1" }],
    });
    expect(JSON.stringify(body)).not.toContain(own.destination);
    const other = await person({ creator: owner.memberId });
    await assertProblem(await agent.request(`/dev/consent-channels/${other.contactId}`), 404);
    await assertProblem(
      await mutation(agent, "/dev/consent-evidence", {
        contactChannelId: other.channelId,
        purpose: "email_marketing",
      }),
      404,
    );
  });

  it("keeps proof issuance idempotent and records one ledger, event, audit and requester Job for concurrent exact retries", async () => {
    const source = await person();
    const issued = await issue(source.channelId, "email_marketing", agent);
    expect((await issue(source.channelId, "email_marketing", agent, issued.key)).proof).toEqual(issued.proof);
    const body = grant(source.channelId, issued.proof);
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => mutation(agent, orgPath(agent), body, key)),
    );
    for (const response of responses) expect(response.status).toBe(202);
    const job = await responses[0].json();
    for (const response of responses.slice(1)) expect(await response.json()).toEqual(job);
    const events = (
      await admin.query("SELECT * FROM app.consent_event WHERE contact_channel_id=$1", [source.channelId])
    ).rows;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "grant",
      initiating_member_id: agent.memberId,
      evidence_id: issued.proof.evidenceRef.split(":")[1],
    });
    expect((await state(source.channelId)).state).toBe("granted");
    expect(
      (
        await admin.query(
          "SELECT count(*)::int count FROM app.outbox WHERE event_type='consent.changed' AND aggregate_id=$1",
          [events[0].id],
        )
      ).rows[0].count,
    ).toBe(1);
    await assertProblem(await owner.request(`/v1/orgs/${owner.orgId}/jobs/${job.id}`), 404);
    expect((await agent.read(`/v1/orgs/${agent.orgId}/jobs/${job.id}`, "Job", 202)).body).toEqual(job);
    await assertProblem(
      await mutation(agent, orgPath(agent), { ...body, policyVersion: "changed" }, key),
      409,
    );
  });

  it("rejects unknown reference/policy, mismatched purpose/channel, wrong actor and incompatible channel kind", async () => {
    const source = await person();
    const other = await person();
    const phone = await person({
      kind: "phone",
      destination: `+1555${randomInt(1_000_000, 9_000_000)}`,
    });
    const issued = await issue(source.channelId);
    const body = grant(source.channelId, issued.proof);
    for (const changed of [
      { ...body, evidenceRef: `synthetic-evidence:${randomUUID()}` },
      { ...body, evidenceRef: "https://untrusted.example.test/proof" },
      { ...body, policyVersion: "unapproved-policy" },
      { ...body, purpose: "listing_alert" as const },
      { ...body, contactChannelId: other.channelId },
    ])
      await assertProblem(await mutation(owner, orgPath(owner), changed), 422);
    await assertProblem(await mutation(agent, orgPath(agent), body), 403);
    await assertProblem(
      await mutation(owner, "/dev/consent-evidence", {
        contactChannelId: phone.channelId,
        purpose: "email_marketing",
      }),
      422,
    );
    await assertProblem(
      await mutation(owner, "/dev/consent-evidence", {
        contactChannelId: source.channelId,
        purpose: "sms_marketing",
      }),
      422,
    );
    await assertProblem(
      await mutation(owner, "/dev/consent-evidence", {
        contactChannelId: phone.channelId,
        purpose: "listing_alert",
      }),
      422,
    );
    expect(
      (await admin.query("SELECT id FROM app.consent_event WHERE contact_channel_id=$1", [source.channelId]))
        .rows,
    ).toEqual([]);
  });

  it("rejects expired and consumed proof, and issuance retries never renew the original evidence", async () => {
    const source = await person();
    const issued = await issue(source.channelId);
    const recorded = await record(grant(source.channelId, issued.proof));
    await assertProblem(await mutation(owner, orgPath(owner), recorded.body), 409);
    const replay = await issue(source.channelId, "email_marketing", owner, issued.key);
    expect(replay.proof).toEqual(issued.proof);
    const expired = await issue(source.channelId);
    const evidenceId = expired.proof.evidenceRef.split(":")[1];
    await admin.query(
      "UPDATE app.consent_evidence SET created_at=now()-interval '30 minutes',expires_at=now()-interval '15 minutes' WHERE id=$1",
      [evidenceId],
    );
    await assertProblem(await mutation(owner, orgPath(owner), grant(source.channelId, expired.proof)), 409);
    const response = await mutation(
      owner,
      "/dev/consent-evidence",
      { contactChannelId: source.channelId, purpose: "email_marketing" },
      expired.key,
    );
    expect(response.status).toBe(201);
    expect((await response.json()).evidenceRef).toBe(expired.proof.evidenceRef);
  });

  it("invalidates proof when contact/channel source revisions or consent state changed", async () => {
    for (const target of ["contact", "contact_channel"] as const) {
      const source = await person();
      const issued = await issue(source.channelId);
      await admin.query(`UPDATE app.${target} SET row_version=row_version+1 WHERE id=$1`, [
        target === "contact" ? source.contactId : source.channelId,
      ]);
      await assertProblem(await mutation(owner, orgPath(owner), grant(source.channelId, issued.proof)), 409);
    }
    const source = await person();
    const issued = await issue(source.channelId);
    await record(withdrawal(source.channelId));
    await assertProblem(await mutation(owner, orgPath(owner), grant(source.channelId, issued.proof)), 409);
    expect((await state(source.channelId)).state).toBe("withdrawn");
  });

  it("serializes grant/withdraw races so an issued-before-withdraw proof cannot revive the opt-out", async () => {
    const source = await person();
    const issued = await issue(source.channelId);
    const [granted, withdrawn] = await Promise.all([
      mutation(owner, orgPath(owner), grant(source.channelId, issued.proof)),
      mutation(owner, orgPath(owner), withdrawal(source.channelId)),
    ]);
    expect([202, 409]).toContain(granted.status);
    expect(withdrawn.status).toBe(202);
    expect((await state(source.channelId)).state).toBe("withdrawn");
    const projection = (
      await admin.query(
        "SELECT * FROM app.suppression WHERE tenant_id=$1 AND normalized_destination=$2 AND purpose='email_marketing'",
        [fixtures.orgA, source.destination],
      )
    ).rows;
    expect(projection).toHaveLength(1);
    expect(projection[0]).toMatchObject({ reason: "consent_withdrawal", expires_at: null });
  });

  it("rechecks permission, source ownership and membership before returning a cached grant Job", async () => {
    const source = await person();
    const issued = await issue(source.channelId, "email_marketing", agent);
    const created = await record(grant(source.channelId, issued.proof), agent);
    await setGrants(grants.filter((item) => item.code !== "consent.write"));
    await assertProblem(await mutation(agent, orgPath(agent), created.body, created.key), 403);
    await setGrants(grants);
    const lead = randomUUID();
    leads.add(lead);
    await admin.query(
      "INSERT INTO app.lead(tenant_id,id,contact_id,source_id,stage_id,owner_member_id,intent)VALUES($1,$2,$3,$4,$5,$6,'unknown')",
      [fixtures.orgA, lead, source.contactId, fixtures.sourceA, stageId(1, 1), owner.memberId],
    );
    await assertProblem(await mutation(agent, orgPath(agent), created.body, created.key), 404);
    await admin.query("DELETE FROM app.lead WHERE id=$1", [lead]);
    leads.delete(lead);
    await admin.query(
      "UPDATE app.membership SET status='disabled',row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, agent.memberId],
    );
    await assertProblem(await mutation(agent, orgPath(agent), created.body, created.key), 403);
  });

  it("blocks grant/evidence under suspended CRM but permits authorized withdrawal and its exact replay", async () => {
    const source = await person();
    const issued = await issue(source.channelId);
    const granted = await record(grant(source.channelId, issued.proof));
    await admin.query(
      "UPDATE app.entitlement SET state='disabled',row_version=row_version+1 WHERE tenant_id=$1 AND feature='crm'",
      [fixtures.orgA],
    );
    await assertProblem(await mutation(owner, orgPath(owner), granted.body, granted.key), 403);
    await assertProblem(
      await mutation(owner, "/dev/consent-evidence", {
        contactChannelId: source.channelId,
        purpose: "email_marketing",
      }),
      403,
    );
    const withdrawn = await record(withdrawal(source.channelId));
    expect((await record(withdrawn.body, owner, withdrawn.key)).job).toEqual(withdrawn.job);
    expect((await state(source.channelId)).state).toBe("withdrawn");
  });

  it("preserves shared destination withdrawal after original contact archive and channel deactivation", async () => {
    const first = await person();
    const second = await person({ destination: first.destination });
    await record(withdrawal(first.channelId));
    await admin.query("UPDATE app.contact SET archived_at=now(),row_version=row_version+1 WHERE id=$1", [
      first.contactId,
    ]);
    await admin.query("UPDATE app.contact_channel SET active=false,row_version=row_version+1 WHERE id=$1", [
      first.channelId,
    ]);
    await record(grant(second.channelId, (await issue(second.channelId)).proof));
    expect((await state(second.channelId)).state).toBe("granted");
    const projection = (
      await admin.query(
        "SELECT reason,expires_at FROM app.suppression WHERE tenant_id=$1 AND normalized_destination=$2 AND purpose='email_marketing'",
        [fixtures.orgA, first.destination],
      )
    ).rows;
    expect(projection).toEqual([{ reason: "consent_withdrawal", expires_at: null }]);
  });

  it("allows source-authorized archived/inactive-channel withdrawal while proof issuance and grant remain denied", async () => {
    const source = await person();
    const issued = await issue(source.channelId, "email_marketing", agent);
    await admin.query("UPDATE app.contact SET archived_at=now(),row_version=row_version+1 WHERE id=$1", [
      source.contactId,
    ]);
    await admin.query("UPDATE app.contact_channel SET active=false,row_version=row_version+1 WHERE id=$1", [
      source.channelId,
    ]);
    await assertProblem(
      await mutation(agent, "/dev/consent-evidence", {
        contactChannelId: source.channelId,
        purpose: "email_marketing",
      }),
      404,
    );
    await assertProblem(await mutation(agent, orgPath(agent), grant(source.channelId, issued.proof)), 404);
    const withdrawn = await record(withdrawal(source.channelId), agent);
    expect((await record(withdrawn.body, agent, withdrawn.key)).job).toEqual(withdrawn.job);
  });

  it("never removes independent bounce/complaint suppression after a fresh verified grant", async () => {
    const source = await person();
    await admin.query(
      "INSERT INTO app.suppression(tenant_id,channel_kind,normalized_destination,purpose,reason)VALUES($1,'email',$2,'email_marketing','bounce')",
      [fixtures.orgA, source.destination],
    );
    await record(withdrawal(source.channelId));
    await record(grant(source.channelId, (await issue(source.channelId)).proof));
    expect(
      (
        await admin.query(
          "SELECT reason,expires_at FROM app.suppression WHERE tenant_id=$1 AND normalized_destination=$2",
          [fixtures.orgA, source.destination],
        )
      ).rows,
    ).toEqual([{ reason: "bounce", expires_at: null }]);
  });

  it("denies foreign source/proof and forged tenant/producer fields, and requires CSRF", async () => {
    const foreign = await person({ tenant: fixtures.orgB, creator: fixtures.ownerMemberB });
    const local = await person();
    await assertProblem(
      await mutation(owner, "/dev/consent-evidence", {
        contactChannelId: foreign.channelId,
        purpose: "email_marketing",
      }),
      404,
    );
    await assertProblem(await mutation(owner, orgPath(owner), withdrawal(foreign.channelId)), 404);
    await assertProblem(
      await mutation(owner, orgPath(owner), { ...withdrawal(local.channelId), producer: "form" }),
      422,
    );
    await assertProblem(
      await mutation(owner, orgPath(owner), { ...withdrawal(local.channelId), tenantId: fixtures.orgB }),
      422,
    );
    await assertProblem(
      await mutation(
        owner,
        "/dev/consent-evidence",
        { contactChannelId: local.channelId, purpose: "email_marketing" },
        randomUUID(),
        "wrong-csrf",
      ),
      403,
    );
  });
});

// Add direct transaction-bound port cases after the approved service constructor is available:
// - forged unknown/withdrawn snapshots cannot become eligible; accepted proof consumption deadline
//   does not expire an already valid recorded grant; stale source/state/grant revisions reject.
// - shared destination and independent provider suppression return safe reasons only.
// - caller rollback removes ledger/state/suppression/Job/idempotency/event/audit atomically.
// - real runtime role has no evidence/ledger UPDATE/DELETE or suppression DELETE, missing context
//   sees no consent rows, foreign tenant reads deny, and pool context clears after rollback.

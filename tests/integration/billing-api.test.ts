import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fixtures } from "../../packages/db/fixtures";
import { MockBillingProvider, SYNTHETIC_BILLING_TERMS } from "../../packages/providers/billing/mock";
import type { BillingWebhookEvent } from "../../packages/providers/billing/port";
import { ApiSession, assertContract, assertProblem, type Schemas } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
const signer = new MockBillingProvider({
  mode: "test",
  webhookSecret:
    process.env.BILLING_MOCK_WEBHOOK_SECRET ?? "synthetic-billing-webhook-secret-for-loopback-only-v1",
});
let owner: ApiSession;
let agent: ApiSession;
let subscription: Record<string, any>;
let entitlement: Record<string, any>;
const previews = new Set<string>();
const jobs = new Set<string>();
const keys = new Set<string>();
const webhookIds = new Set<string>();
const reconciledVersions = new Set<number>();
const path = (action = "") => `/v1/orgs/${owner.orgId}/billing${action ? `/${action}` : ""}`;
const target: Schemas["BillingPreviewRequest"] = {
  action: "change_plan",
  planCode: "synthetic-team",
  billingInterval: "year",
};

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
  agent = await new ApiSession().signIn("agent");
  subscription = (await admin.query("SELECT * FROM app.subscription WHERE tenant_id=$1", [fixtures.orgA]))
    .rows[0];
  entitlement = (
    await admin.query("SELECT * FROM app.entitlement WHERE tenant_id=$1 AND feature='crm'", [fixtures.orgA])
  ).rows[0];
  expect(subscription).toBeTruthy();
  expect(entitlement.state).toBe("enabled");
});

afterEach(async () => {
  if (owner.orgId !== fixtures.orgA) expect((await owner.switchOrganization(fixtures.orgA)).status).toBe(200);
  const ids = [...previews];
  if (webhookIds.size)
    await admin.query(
      "DELETE FROM app.webhook_inbox WHERE tenant_id=$1 AND provider_event_id=ANY($2::text[])",
      [fixtures.orgA, [...webhookIds]],
    );
  if (ids.length) {
    const outbox = (
      await admin.query(
        "SELECT id FROM app.outbox WHERE tenant_id=$1 AND event_type='subscription.reconciled' AND payload->'payload'->'relatedResourceIds' ?| $2::text[]",
        [fixtures.orgA, ids],
      )
    ).rows.map((row) => row.id);
    if (outbox.length) {
      await admin.query("DELETE FROM app.outbox_consumer_receipt WHERE event_id=ANY($1::uuid[])", [outbox]);
      await admin.query("DELETE FROM app.outbox WHERE id=ANY($1::uuid[])", [outbox]);
    }
    await admin.query(
      "DELETE FROM app.audit_event WHERE tenant_id=$1 AND resource_type='billing_change' AND resource_id=ANY($2::text[])",
      [fixtures.orgA, ids],
    );
    await admin.query("DELETE FROM app.billing_change WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [
      fixtures.orgA,
      ids,
    ]);
  }
  if (reconciledVersions.size)
    await admin.query(
      "DELETE FROM app.audit_event WHERE tenant_id=$1 AND action='subscription.reconciled' AND resource_id=$2 AND (safe_diff->>'resourceVersion')::bigint=ANY($3::bigint[])",
      [fixtures.orgA, subscription.id, [...reconciledVersions]],
    );
  if (jobs.size)
    await admin.query("DELETE FROM app.integration_job WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [
      fixtures.orgA,
      [...jobs],
    ]);
  if (keys.size)
    await admin.query("DELETE FROM app.idempotency_record WHERE tenant_id=$1 AND key=ANY($2::text[])", [
      fixtures.orgA,
      [...keys],
    ]);
  // Restore only the subscription/capability changed by these synthetic tests; versions stay monotonic.
  await admin.query(
    "UPDATE app.subscription SET plan_id=$2,status=$3,period_end=$4,reconciled_at=$5,row_version=row_version+1,updated_at=now() WHERE tenant_id=$1 AND id=$6",
    [
      fixtures.orgA,
      subscription.plan_id,
      subscription.status,
      subscription.period_end,
      subscription.reconciled_at,
      subscription.id,
    ],
  );
  await admin.query(
    "UPDATE app.entitlement SET state=$2,limit_value=$3,effective_until=$4,row_version=row_version+1,updated_at=now() WHERE tenant_id=$1 AND id=$5",
    [fixtures.orgA, entitlement.state, entitlement.limit_value, entitlement.effective_until, entitlement.id],
  );
  for (const set of [previews, jobs, keys, webhookIds, reconciledVersions]) set.clear();
});
afterAll(async () => admin.end());

async function preview(body = target, key = randomUUID()) {
  keys.add(key);
  const response = await owner.command(path("change-previews"), body, { key });
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-billing-terms-version")).toBe(SYNTHETIC_BILLING_TERMS);
  const value = await response.json();
  assertContract("BillingPreview", value);
  previews.add(value.id);
  return { value, key, body };
}
function confirmation(previewId: string): Schemas["PreviewConfirm"] {
  return { previewId, acceptedTermsVersion: SYNTHETIC_BILLING_TERMS };
}
async function confirm(previewId: string, key = randomUUID()) {
  keys.add(key);
  const response = await owner.command(path("change-confirmations"), confirmation(previewId), { key });
  expect(response.status, await response.clone().text()).toBe(202);
  const value = await response.json();
  assertContract("Job", value);
  jobs.add(value.id);
  return { value, key };
}
async function reconcile(previewId: string) {
  const response = await owner.command("/dev/billing/reconcile", { previewId });
  expect(response.status).toBe(202);
  const value = await response.json();
  assertContract("Job", value);
  if (value.state === "succeeded")
    reconciledVersions.add(
      Number(
        (await admin.query("SELECT row_version FROM app.subscription WHERE tenant_id=$1", [fixtures.orgA]))
          .rows[0].row_version,
      ),
    );
  return value;
}
const event = (previewId: string, id: string = randomUUID()): BillingWebhookEvent => ({
  id,
  type: "billing.changed",
  tenantId: fixtures.orgA,
  commandId: previewId,
  providerReference: `synthetic_${createHash("sha256").update(`${fixtures.orgA}:${previewId}`).digest("hex").slice(0, 32)}`,
});
async function webhook(input: BillingWebhookEvent, time = new Date()) {
  webhookIds.add(input.id);
  return owner.command("/dev/billing/webhook", signer.syntheticWebhook(input, time));
}

describe("M2 — explicit billing commands, durable jobs and authoritative reconciliation", () => {
  it("shows separate annual totals and monthly equivalents; agents cannot manage billing", async () => {
    const overview = (await owner.read(path(), "BillingOverview")).body;
    expect(overview.currency).toBe("USD");
    expect(overview.annualTotalMinor).toBeNull();
    expect(overview.monthlyEquivalentMinor).toBe(4900);
    const created = await preview();
    expect(created.value).toMatchObject({ dueNowMinor: 0, recurringTotalMinor: 99000, interval: "year" });
    expect(created.value.terms.join(" ")).toContain("no money will be charged");
    await assertProblem(await agent.command(`/v1/orgs/${agent.orgId}/billing/change-previews`, target), 403);
    await assertProblem(await agent.command("/dev/billing/reconcile", { previewId: created.value.id }), 403);
    await assertProblem(
      await owner.command(path("change-previews"), {
        action: "change_plan",
        planCode: "not-a-plan",
        billingInterval: "month",
      }),
      422,
    );
  });

  it("rejects expired previews, wrong terms and changed subscription or entitlement versions", async () => {
    const wrongTerms = await preview();
    await assertProblem(
      await owner.command(path("change-confirmations"), {
        ...confirmation(wrongTerms.value.id),
        acceptedTermsVersion: "unreviewed",
      }),
      409,
    );
    const expired = await preview();
    await admin.query(
      "UPDATE app.billing_change SET expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, expired.value.id],
    );
    await assertProblem(
      await owner.command(path("change-confirmations"), confirmation(expired.value.id)),
      409,
    );
    const staleSubscription = await preview();
    await admin.query("UPDATE app.subscription SET row_version=row_version+1 WHERE tenant_id=$1", [
      fixtures.orgA,
    ]);
    await assertProblem(
      await owner.command(path("change-confirmations"), confirmation(staleSubscription.value.id)),
      409,
    );
    const staleEntitlement = await preview();
    await admin.query(
      "UPDATE app.entitlement SET row_version=row_version+1 WHERE tenant_id=$1 AND feature='crm'",
      [fixtures.orgA],
    );
    await assertProblem(
      await owner.command(path("change-confirmations"), confirmation(staleEntitlement.value.id)),
      409,
    );
    expect(
      (
        await admin.query("SELECT job_id FROM app.billing_change WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [
          fixtures.orgA,
          [...previews],
        ])
      ).rows.every((row) => row.job_id === null),
    ).toBe(true);
  });

  it("concurrent identical confirmations create one queued operation and do not change capabilities before reconciliation", async () => {
    const created = await preview();
    const key = randomUUID();
    keys.add(key);
    const before = (await owner.read(path(), "BillingOverview")).body;
    const responses = await Promise.all([
      owner.command(path("change-confirmations"), confirmation(created.value.id), { key }),
      owner.command(path("change-confirmations"), confirmation(created.value.id), { key }),
    ]);
    for (const response of responses) expect(response.status, await response.clone().text()).toBe(202);
    const operation = await responses[0].json();
    assertContract("Job", operation);
    jobs.add(operation.id);
    expect(operation.state).toBe("queued");
    expect(await responses[1].json()).toEqual(operation);
    expect((await owner.read(path(), "BillingOverview")).body).toEqual(before);
    expect(
      (
        await admin.query(
          "SELECT safe_result FROM app.integration_job WHERE tenant_id=$1 AND result_ref=$2",
          [fixtures.orgA, created.value.id],
        )
      ).rows,
    ).toEqual([{ safe_result: { externalCharge: false, reconciliationRequired: true } }]);
    await assertProblem(
      await owner.command(path("change-confirmations"), confirmation(created.value.id)),
      409,
    );
    const competing = await preview({ action: "cancel" });
    await assertProblem(
      await owner.command(path("change-confirmations"), confirmation(competing.value.id)),
      409,
    );
    const completed = await reconcile(created.value.id);
    expect(completed).toMatchObject({ id: operation.id, state: "succeeded", error: null });
    expect(await reconcile(created.value.id)).toEqual(completed);
    const overview = (await owner.read(path(), "BillingOverview")).body;
    expect(overview).toMatchObject({
      planCode: "synthetic-team",
      status: "mock_active",
      annualTotalMinor: 99000,
      monthlyEquivalentMinor: 8250,
    });
    expect((await owner.read(`/v1/orgs/${owner.orgId}/jobs/${operation.id}`, "Job", 202)).body).toEqual(
      completed,
    );
    expect(
      (
        await admin.query(
          "SELECT id FROM app.outbox WHERE tenant_id=$1 AND event_type='subscription.reconciled' AND payload->'payload'->'relatedResourceIds' ? $2",
          [fixtures.orgA, created.value.id],
        )
      ).rows,
    ).toHaveLength(1);
  });

  it("another organization cannot consume a preview even when the identity belongs to both", async () => {
    const created = await preview();
    expect((await owner.switchOrganization(fixtures.orgB)).status).toBe(200);
    await assertProblem(
      await owner.command(path("change-confirmations"), confirmation(created.value.id)),
      404,
    );
    await assertProblem(await owner.command("/dev/billing/reconcile", { previewId: created.value.id }), 404);
  });

  it("a current entitlement revocation after confirmation prevents reconciliation from restoring CRM", async () => {
    const created = await preview();
    const operation = await confirm(created.value.id);
    await admin.query(
      "UPDATE app.entitlement SET state='disabled',row_version=row_version+1 WHERE tenant_id=$1 AND feature='crm'",
      [fixtures.orgA],
    );
    await assertProblem(await owner.command("/dev/billing/reconcile", { previewId: created.value.id }), 409);
    expect(
      (
        await admin.query("SELECT state FROM app.entitlement WHERE tenant_id=$1 AND feature='crm'", [
          fixtures.orgA,
        ])
      ).rows[0].state,
    ).toBe("disabled");
    expect(
      (await owner.read(`/v1/orgs/${owner.orgId}/jobs/${operation.value.id}`, "Job", 202)).body.state,
    ).toBe("queued");
    expect((await owner.read(path(), "BillingOverview")).body.planCode).toBe("synthetic-starter");
    await assertProblem(await owner.request(`/v1/orgs/${owner.orgId}/leads`), 403);
  });

  it("cancellation changes CRM only after reconciliation and billing remains available to resume", async () => {
    const cancellation = await preview({ action: "cancel" });
    await confirm(cancellation.value.id);
    expect((await owner.request(`/v1/orgs/${owner.orgId}/leads`)).status).toBe(200);
    expect((await reconcile(cancellation.value.id)).state).toBe("succeeded");
    await assertProblem(await owner.request(`/v1/orgs/${owner.orgId}/leads`), 403);
    expect((await owner.read(path(), "BillingOverview")).body.status).toBe("mock_canceled");
    const resumption = await preview({ action: "resume" });
    await confirm(resumption.value.id);
    expect((await reconcile(resumption.value.id)).state).toBe("succeeded");
    expect((await owner.request(`/v1/orgs/${owner.orgId}/leads`)).status).toBe(200);
  });

  it("signed duplicate and old-command events re-read state without reapplying completed operations", async () => {
    const old = await preview();
    await confirm(old.value.id);
    const notification = event(old.value.id);
    const initial = await webhook(notification);
    expect(initial.status).toBe(202);
    const completed = await initial.json();
    assertContract("Job", completed);
    expect(completed.state).toBe("succeeded");
    reconciledVersions.add(
      Number(
        (await admin.query("SELECT row_version FROM app.subscription WHERE tenant_id=$1", [fixtures.orgA]))
          .rows[0].row_version,
      ),
    );
    const beforeRepeat = (
      await admin.query("SELECT row_version FROM app.subscription WHERE tenant_id=$1", [fixtures.orgA])
    ).rows[0].row_version;
    const repeated = await webhook(notification);
    expect(repeated.status).toBe(202);
    expect(await repeated.json()).toEqual(completed);
    expect(
      (await admin.query("SELECT row_version FROM app.subscription WHERE tenant_id=$1", [fixtures.orgA]))
        .rows[0].row_version,
    ).toBe(beforeRepeat);
    const latest = await preview({ action: "cancel" });
    await confirm(latest.value.id);
    await reconcile(latest.value.id);
    const delayed = await webhook(event(old.value.id));
    expect(delayed.status).toBe(202);
    expect((await owner.read(path(), "BillingOverview")).body.status).toBe("mock_canceled");
    expect(
      (
        await admin.query(
          "SELECT count(*)::int count FROM app.webhook_inbox WHERE tenant_id=$1 AND provider_event_id=ANY($2::text[])",
          [fixtures.orgA, [...webhookIds]],
        )
      ).rows[0].count,
    ).toBe(2);
    const stored = (
      await admin.query(
        "SELECT payload_ref FROM app.webhook_inbox WHERE tenant_id=$1 AND provider_event_id=ANY($2::text[])",
        [fixtures.orgA, [...webhookIds]],
      )
    ).rows;
    for (const row of stored) {
      expect(row.payload_ref).toMatch(new RegExp(`^billing-change:${old.value.id}:[0-9a-f]{64}$`));
      expect(row.payload_ref).not.toContain(JSON.stringify(notification));
    }
  });

  it("rejects invalid signatures, cross-tenant events, mismatched provider references and changed duplicate event payloads", async () => {
    const first = await preview();
    await confirm(first.value.id);
    const notification = event(first.value.id);
    await assertProblem(
      await owner.command("/dev/billing/webhook", {
        rawBody: JSON.stringify(notification),
        signature: "invalid",
      }),
      403,
    );
    await assertProblem(await webhook(notification, new Date(Date.now() - 301_000)), 403);
    await assertProblem(await webhook({ ...notification, tenantId: fixtures.orgB }), 403);
    await assertProblem(
      await webhook({ ...notification, providerReference: `synthetic_${"0".repeat(32)}` }),
      409,
    );
    const valid = await webhook(notification);
    expect(valid.status).toBe(202);
    reconciledVersions.add(
      Number(
        (await admin.query("SELECT row_version FROM app.subscription WHERE tenant_id=$1", [fixtures.orgA]))
          .rows[0].row_version,
      ),
    );
    const second = await preview({ action: "cancel" });
    const pending = await confirm(second.value.id);
    await assertProblem(await webhook(event(second.value.id, notification.id)), 409);
    expect(
      (await owner.read(`/v1/orgs/${owner.orgId}/jobs/${pending.value.id}`, "Job", 202)).body.state,
    ).toBe("queued");
    expect((await owner.read(path(), "BillingOverview")).body.status).toBe("mock_active");
  });
});

describe("billing portal", () => {
  it("opens a portal session", async () => {
    const result = await owner.command(path("customer-portal"), {}, "HostedFlow", 201);
    expect(result.body.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/dev\/billing\/portal/);
    expect(new Date(result.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects without billing.manage", async () => {
    await assertProblem(await agent.raw("POST", path("customer-portal"), {}), 403);
  });
});

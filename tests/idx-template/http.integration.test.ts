import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signIdxTemplateRequest } from "../../packages/auth/idx-template-bridge";
import { fixtures as platform } from "../../packages/db/fixtures";
import { createIdxTemplateRuntimeProvider } from "../../apps/api/src/idx-template-runtime";
import { withTenantTransaction } from "../../packages/db/tenant-transaction";
import { projectIdxTemplateContent } from "../../packages/templates/idx-template";
import type { components } from "../../packages/contracts/generated/api";
import { createSiteFixture, type IdxSiteFixture } from "./fixtures";
import { createIdxPools, requireIdxIsolation } from "./isolation";

type Schemas = components["schemas"];
const { admin, runtime } = createIdxPools();
const target = requireIdxIsolation();
let fixture: IdxSiteFixture;
const inquiry = () => ({
  formId: fixture.formId,
  formVersion: 1,
  listingKey: fixture.listingKey,
  listingId: fixture.listingId,
  name: "Synthetic HTTP visitor",
  email: `http-${randomUUID()}@example.test`,
  message: "HTTP PRIVATE MESSAGE FIXTURE\nPreserve this second line.",
});

async function call(
  suffix: string,
  body?: unknown,
  options: { key?: string; signedBody?: unknown; headers?: Record<string, string>; unsigned?: boolean } = {},
) {
  const path = `/v1/public/sites/${fixture.siteId}/idx-template/${suffix}`;
  const method = body === undefined ? "GET" : "POST";
  const key = body === undefined ? "" : (options.key ?? randomUUID());
  const proof = options.unsigned
    ? {}
    : signIdxTemplateRequest(method, path, fixture.origin, options.signedBody ?? body, key);
  const response = await fetch(new URL(path, target.api), {
    method,
    headers: {
      ...proof,
      origin: fixture.origin,
      ...(key ? { "idempotency-key": key } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  return { response, body: await response.json() };
}

beforeAll(async () => {
  fixture = await createSiteFixture(admin, { title: "PUBLIC HTTP SYNTHETIC CMS TITLE" });
  await admin.query(
    `INSERT INTO app.listing_media(tenant_id,listing_id,source_media_key,source_url,position,expires_at,cache_allowed)
     SELECT $1,id,'http-fixture-' || n,'/idx-template-fixtures/gallery-' || n || '.svg',n,
       clock_timestamp()+interval '30 minutes',false
     FROM app.listing CROSS JOIN generate_series(1,65) n
     WHERE tenant_id=$1 AND feed_id=$2 AND source_listing_key=$3`,
    [fixture.tenant, fixture.feedId, fixture.listingKey],
  );
});
afterAll(async () => {
  await Promise.all([admin.end(), runtime.end()]);
});

describe("actual signed public IDX HTTP through the owned API", () => {
  it("keeps the new media read grant tenant-scoped and refuses every runtime media mutation", async () => {
    const foreign = await createSiteFixture(admin, { tenant: platform.orgB });
    await admin.query(
      "INSERT INTO app.listing_media(tenant_id,listing_id,source_media_key,source_url,position,expires_at) SELECT $1,id,'foreign-http','/idx-template-fixtures/foreign.svg',1,clock_timestamp()+interval '30 minutes' FROM app.listing WHERE tenant_id=$1 AND feed_id=$2 AND source_listing_key=$3",
      [foreign.tenant, foreign.feedId, foreign.listingKey],
    );
    expect((await runtime.query("SELECT id,source_url FROM app.listing_media")).rowCount).toBe(0);
    await withTenantTransaction(
      runtime,
      { userId: fixture.machineUser, organizationId: fixture.tenant },
      async (client) => {
        expect((await client.query("SELECT tenant_id,id,source_url FROM app.listing_media")).rowCount).toBe(
          65,
        );
        expect(
          (
            await client.query("SELECT id,source_url FROM app.listing_media WHERE tenant_id=$1", [
              foreign.tenant,
            ])
          ).rowCount,
        ).toBe(0);
      },
    );
    for (const sql of [
      "UPDATE app.listing_media SET row_version=row_version+1 WHERE tenant_id=app.current_tenant()",
      "INSERT INTO app.listing_media(tenant_id,listing_id,source_media_key,source_url,position,expires_at) SELECT tenant_id,id,'runtime-invalid','/idx-template-fixtures/invalid.svg',1,clock_timestamp()+interval '1 minute' FROM app.listing WHERE tenant_id=app.current_tenant() LIMIT 1",
      "SELECT source_media_key FROM app.listing_media WHERE tenant_id=app.current_tenant()",
    ])
      await expect(
        withTenantTransaction(
          runtime,
          { userId: fixture.machineUser, organizationId: fixture.tenant },
          (client) => client.query(sql),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    expect((await runtime.query("SELECT id,source_url FROM app.listing_media")).rowCount).toBe(0);
  });
  it("reads the real native mock source and validates the published CMS slots before HTTP projection", async () => {
    const revision = (
      await admin.query("SELECT block_data,seo FROM app.content_revision WHERE tenant_id=$1 AND id=$2", [
        fixture.tenant,
        fixture.revisionId,
      ])
    ).rows[0];
    expect(
      projectIdxTemplateContent({ schemaVersion: 1, blocks: revision.block_data, seo: revision.seo }).content
        .heroTitle,
    ).toBe(fixture.title);
    await withTenantTransaction(
      runtime,
      { userId: fixture.machineUser, organizationId: fixture.tenant },
      async (client) => {
        const deadline = new Date(Date.now() + 60_000).toISOString();
        const provider = createIdxTemplateRuntimeProvider(
          {
            bindingId: fixture.bindingId,
            siteId: fixture.siteId,
            organizationId: fixture.tenant,
            feedId: fixture.feedId,
            mode: "mock",
            policyVersion: fixture.policyVersion,
            policyExpiresAt: deadline,
            expiresAt: deadline,
          },
          async () => {},
          client,
        );
        try {
          const status = await provider.status();
          expect(status).toMatchObject({ property: true, synthetic: true, live: false });
          const listing = await provider.detail(fixture.listingKey);
          expect(listing.photos).toHaveLength(65);
        } catch (error) {
          const value = error as { name?: string; code?: string };
          throw new Error(
            `native_mock_snapshot_failed:${value.name ?? "unknown"}:${value.code ?? "unknown"}`,
          );
        }
      },
    );
  });
  it("renders published native CMS content and policy-aware native mock listings over all four read routes", async () => {
    const content = await call("content");
    expect(content.response.status, (content.body as { code?: string }).code).toBe(200);
    expect(content.response.headers.get("cache-control")).toContain("no-store");
    expect(content.body).toMatchObject({
      dataMode: "mock",
      content: { heroTitle: fixture.title, heroEyebrow: "SYNTHETIC IDX fixture" },
      inquiryForm: { id: fixture.formId, version: 1 },
    });
    expect(JSON.stringify(content.body)).not.toContain("PRIVATE DRAFT");
    const status = await call("status");
    expect(status.response.status).toBe(200);
    expect(status.body).toMatchObject({ configured: true, property: true, live: false, synthetic: true });
    const listings = await call("listings");
    expect(listings.response.status).toBe(200);
    expect(
      (listings.body as Schemas["IdxTemplateListingPage"]).items.some(
        (row) => row.listingKey === fixture.listingKey,
      ),
    ).toBe(true);
    const detail = await call(`listings/${encodeURIComponent(fixture.listingKey)}`);
    expect(detail.response.status).toBe(200);
    expect(detail.body).toMatchObject({ listingKey: fixture.listingKey, synthetic: true });
    expect((detail.body as Schemas["IdxTemplateListing"]).photos).toHaveLength(65);
  });

  it("requires a current signed bridge proof instead of a member cookie or spoofed forwarding host", async () => {
    const response = await call("content", undefined, {
      unsigned: true,
      headers: { "x-forwarded-host": "localhost:3000", cookie: "estate_session=not-authority" },
    });
    expect(response.response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "idx_bridge_proof_invalid" });
  });

  it("preserves the original message through real HTTP concurrent retries with one durable CRM effect", async () => {
    const original = inquiry();
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 4 }, () => call("inquiries", original, { key })));
    expect(results.map((result) => result.response.status)).toEqual([200, 200, 200, 200]);
    const receipts = results.map((result) => (result.body as Schemas["SubmissionReceipt"]).receiptId);
    expect(new Set(receipts).size).toBe(1);
    const entries = await admin.query(
      "SELECT lead_id,private_payload FROM app.form_entry WHERE tenant_id=$1 AND form_schema_id=$2",
      [fixture.tenant, fixture.formId],
    );
    expect(entries.rowCount).toBe(1);
    const stored = entries.rows[0];
    expect(stored.private_payload.inquiry).toEqual(original);
    expect(stored.private_payload.provenance).toMatchObject({
      siteId: fixture.siteId,
      feedId: fixture.feedId,
      providerListingKey: fixture.listingKey,
    });
    const note = await admin.query("SELECT body FROM app.note WHERE tenant_id=$1 AND id=$2", [
      fixture.tenant,
      stored.private_payload.noteId,
    ]);
    expect(note.rows[0].body).toBe(original.message);
    const event = await admin.query(
      "SELECT count(*)::int AS count FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2 AND event_type='lead.captured'",
      [fixture.tenant, stored.lead_id],
    );
    expect(event.rows[0].count).toBe(1);
    expect(JSON.stringify(results[0].body)).not.toContain(original.message);
    const conflict = await call(
      "inquiries",
      { ...original, message: "Changed body with the same key." },
      { key },
    );
    expect(conflict.response.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: "idempotency_conflict" });
  });

  it("rejects signed-body tampering and mismatched Origin before any inquiry effect", async () => {
    const original = inquiry();
    const before = (
      await admin.query("SELECT count(*)::int AS count FROM app.form_entry WHERE form_schema_id=$1", [
        fixture.formId,
      ])
    ).rows[0].count;
    const changed = await call(
      "inquiries",
      { ...original, message: "Tampered on the transport." },
      { signedBody: original },
    );
    expect(changed.response.status).toBe(403);
    expect(changed.body).toMatchObject({ code: "idx_bridge_proof_invalid" });
    const wrongOrigin = await call("inquiries", original, {
      headers: { origin: "https://attacker.example.test" },
    });
    expect(wrongOrigin.response.status).toBe(403);
    const after = (
      await admin.query("SELECT count(*)::int AS count FROM app.form_entry WHERE form_schema_id=$1", [
        fixture.formId,
      ])
    ).rows[0].count;
    expect(after).toBe(before);
  });

  it("rejects a newly revoked binding through actual HTTP without returning a stale published page", async () => {
    await admin.query(
      "UPDATE app.idx_template_binding SET state='revoked',row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
      [fixture.tenant, fixture.bindingId],
    );
    const response = await call("content");
    expect(response.response.status).toBe(404);
  });
});

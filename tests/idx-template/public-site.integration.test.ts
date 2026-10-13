import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IdxTemplateHttpAdapter } from "../../apps/api/src/idx-template";
import { CrmService } from "../../apps/api/src/crm-service";
import type { components } from "../../packages/contracts/generated/api";
import type { IdxTemplateProviderFactory } from "../../packages/contracts/internal/idx-template-provider";
import { fixtures as platform } from "../../packages/db/fixtures";
import { AccessError, withTenantTransaction } from "../../packages/db/tenant-transaction";
import { createSiteFixture, fixturePolicyHash, type IdxSiteFixture, projectFixtureContent } from "./fixtures";
import { createIdxPools } from "./isolation";

type Schemas = components["schemas"];
const { admin, runtime } = createIdxPools();
const sites = new Map<string, IdxSiteFixture>();
let siteA: IdxSiteFixture;
let siteB: IdxSiteFixture;
const forbiddenNetwork = vi.fn(() => {
  throw new Error("idx_test_external_network_forbidden");
});

async function site(options: Parameters<typeof createSiteFixture>[1] = {}) {
  const fixture = await createSiteFixture(admin, options);
  sites.set(fixture.siteId, fixture);
  return fixture;
}
function adapter(
  hooks: {
    detail?: () => Promise<void>;
    status?: () => Promise<void>;
    search?: (query: Record<string, unknown>) => Promise<void>;
  } = {},
) {
  const createProvider: IdxTemplateProviderFactory = (binding, assertCurrent) => {
    const fixture = sites.get(binding.siteId)!;
    const listing = (): Schemas["IdxTemplateListing"] => ({
      listingKey: fixture.listingKey,
      listingId: fixture.listingId,
      synthetic: true,
      status: "Active",
      streetAddress: "Synthetic Fixture Street",
      city: "Las Vegas",
      postalCode: "89109",
      price: 500000,
      bedrooms: 3,
      bathrooms: 2,
      livingArea: 1800,
      publicRemarks: "Fictional property. No real listing or offer.",
      photos: Array.from({ length: 65 }, (_, index) => `/templates/las-vegas-idx/fixture-${index}.svg`),
      expiresAt: new Date(
        Math.min(Date.parse(binding.expiresAt), Date.parse(binding.policyExpiresAt)),
      ).toISOString(),
    });
    return {
      async status() {
        await assertCurrent();
        await hooks.status?.();
        return {
          configured: true,
          authenticated: false,
          metadata: true,
          property: true,
          media: true,
          live: false,
          synthetic: true,
          message: "SYNTHETIC fixture provider",
        };
      },
      async search(query) {
        await assertCurrent();
        await hooks.search?.(query);
        return {
          items: [listing()],
          page: query.page ?? 1,
          pageSize: 24,
          hasMore: false,
          live: false,
          synthetic: true,
          expiresAt: listing().expiresAt,
        };
      },
      async detail(key) {
        await assertCurrent();
        await hooks.detail?.();
        if (key !== fixture.listingKey)
          throw new AccessError(404, "listing_unavailable", "Listing unavailable.");
        return listing();
      },
    };
  };
  return new IdxTemplateHttpAdapter(runtime, {
    allowedOrigins: new Set(["http://localhost:3000", "http://localhost:3002"]),
    trustedOrigin(request) {
      const host = request.headers.host;
      if (!["localhost:3000", "localhost:3002"].includes(host ?? ""))
        throw new AccessError(403, "fixture_host_denied", "Host unavailable.");
      return `http://${host}`;
    },
    createProvider,
    projectContent: projectFixtureContent,
  });
}
const inquiry = (
  fixture: IdxSiteFixture,
  changes: Partial<Schemas["IdxTemplateInquiryWrite"]> = {},
): Schemas["IdxTemplateInquiryWrite"] => ({
  formId: fixture.formId,
  formVersion: 1,
  listingKey: fixture.listingKey,
  listingId: fixture.listingId,
  name: "Synthetic Inquiry Visitor",
  email: `inquiry-${randomUUID()}@example.test`,
  phone: "+12025550123",
  message: "PRIVATE MESSAGE FIXTURE\nKeep this second line unchanged.",
  ...changes,
});
function request(
  fixture: IdxSiteFixture,
  suffix: string,
  body?: unknown,
  key = randomUUID(),
  controller = adapter(),
  extraHeaders: Record<string, string> = {},
) {
  return controller.handle({
    method: body === undefined ? "GET" : "POST",
    url: `/v1/public/sites/${fixture.siteId}/idx-template/${suffix}`,
    headers: {
      host: new URL(fixture.origin).host,
      origin: fixture.origin,
      "idempotency-key": key,
      ...extraHeaders,
    },
    body,
    remoteAddress: "127.0.0.1",
  });
}
async function entry(receiptId: string) {
  const row = (
    await admin.query(
      "SELECT tenant_id,lead_id,form_schema_id,private_payload FROM app.form_entry WHERE id=$1",
      [receiptId],
    )
  ).rows[0];
  expect(row).toBeTruthy();
  return row;
}

beforeAll(async () => {
  vi.stubGlobal("fetch", forbiddenNetwork);
  siteA = await site({ title: "PUBLIC TENANT A" });
  siteB = await site({ tenant: platform.orgB, title: "PUBLIC TENANT B" });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await Promise.all([admin.end(), runtime.end()]);
});

describe("real RLS and published template authority", () => {
  it("runs under a non-owner non-bypass runtime role with no tenant context leaked through the pool", async () => {
    const role = (
      await runtime.query(
        "SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    expect(role).toEqual({ current_user: "estate_runtime", rolsuper: false, rolbypassrls: false });
    expect(
      (await runtime.query("SELECT count(*)::int AS count FROM app.idx_template_binding")).rows[0].count,
    ).toBe(0);
    const policies = await admin.query(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('app.idx_template_binding'::regclass,'app.idx_template_listing_assignment'::regclass)",
    );
    expect(policies.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });
  it("renders only the selected published revision and each site's own content", async () => {
    const first = await request(siteA, "content");
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toContain("no-store");
    expect((first.body as Schemas["IdxTemplateContent"]).content.heroTitle).toBe(siteA.title);
    expect(JSON.stringify(first.body)).not.toMatch(/PRIVATE DRAFT|PUBLIC TENANT B/);
    const second = await request(siteB, "content");
    expect((second.body as Schemas["IdxTemplateContent"]).content.heroTitle).toBe(siteB.title);
    expect(forbiddenNetwork).not.toHaveBeenCalled();
  });

  it("prevents the same active public UUID and origin from bootstrapping two tenants", async () => {
    await expect(
      createSiteFixture(admin, {
        tenant: platform.orgB,
        siteId: siteA.siteId,
        machineUser: siteA.machineUser,
      }),
    ).rejects.toMatchObject({ code: "23505" });
    expect(((await request(siteA, "content")).body as Schemas["IdxTemplateContent"]).content.heroTitle).toBe(
      siteA.title,
    );
  });
  it("selects an explicitly published revision then restores the previous immutable revision", async () => {
    const fixture = await site();
    await admin.query(
      "UPDATE app.content_document SET published_revision_id=$1 WHERE tenant_id=$2 AND id=$3",
      [fixture.draftId, fixture.tenant, fixture.documentId],
    );
    expect(
      ((await request(fixture, "content")).body as Schemas["IdxTemplateContent"]).content.heroTitle,
    ).toBe(`PRIVATE DRAFT ${fixture.siteId}`);
    await admin.query(
      "UPDATE app.content_document SET published_revision_id=$1 WHERE tenant_id=$2 AND id=$3",
      [fixture.revisionId, fixture.tenant, fixture.documentId],
    );
    expect(((await request(fixture, "content")).body as Schemas["IdxTemplateContent"]).revisionId).toBe(
      fixture.revisionId,
    );
  });
  it("rejects the wrong current host and never trusts forwarded host or public authority fields", async () => {
    const isolated = await site({ origin: "http://localhost:3002" });
    expect(
      (
        await request(isolated, "content", undefined, randomUUID(), adapter(), {
          host: "localhost:3000",
          "x-forwarded-host": "localhost:3002",
        })
      ).status,
    ).toBe(404);
    expect((await request(siteA, "inquiries", { ...inquiry(siteA), tenantId: platform.orgB })).status).toBe(
      422,
    );
  });
  it.each(["site", "document", "machine"])(
    "denies revoked %s authority before any inquiry effect",
    async (kind) => {
      const fixture = await site();
      if (kind === "site")
        await admin.query("UPDATE app.site SET state='suspended' WHERE tenant_id=$1 AND id=$2", [
          fixture.tenant,
          fixture.siteId,
        ]);
      if (kind === "document")
        await admin.query(
          "UPDATE app.content_document SET archived_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
          [fixture.tenant, fixture.documentId],
        );
      if (kind === "machine")
        await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
          fixture.tenant,
          fixture.machineMember,
        ]);
      expect((await request(fixture, "inquiries", inquiry(fixture))).status).toBe(404);
      expect(
        (
          await admin.query("SELECT count(*)::int AS count FROM app.form_entry WHERE form_schema_id=$1", [
            fixture.formId,
          ])
        ).rows[0].count,
      ).toBe(0);
    },
  );
  it("does not allow runtime to activate or rewrite a binding", async () => {
    await expect(
      withTenantTransaction(runtime, { userId: siteA.machineUser, organizationId: siteA.tenant }, (client) =>
        client.query("UPDATE app.idx_template_binding SET row_version=row_version+1 WHERE id=$1", [
          siteA.bindingId,
        ]),
      ),
    ).rejects.toThrow();
    expect((await request(siteA, "content")).status).toBe(200);
    expect(
      (await runtime.query("SELECT count(*)::int AS count FROM app.idx_template_binding")).rows[0].count,
    ).toBe(0);
  });
  it("denies an unknown template version even when the site and binding pins agree", async () => {
    const fixture = await site();
    await admin.query(
      "UPDATE app.site SET theme_version='las-vegas-idx-agent@99.0.0' WHERE tenant_id=$1 AND id=$2",
      [fixture.tenant, fixture.siteId],
    );
    await admin.query(
      "UPDATE app.idx_template_binding SET template_version='99.0.0' WHERE tenant_id=$1 AND id=$2",
      [fixture.tenant, fixture.bindingId],
    );
    expect((await request(fixture, "content")).status).toBe(404);
    expect((await request(fixture, "inquiries", inquiry(fixture))).status).toBe(404);
    expect(
      (
        await admin.query("SELECT count(*)::int AS count FROM app.form_entry WHERE form_schema_id=$1", [
          fixture.formId,
        ])
      ).rows[0].count,
    ).toBe(0);
  });

  it("refuses a human Owner as the public capture identity even with a supplied member cookie", async () => {
    const fixture = await site();
    await admin.query(
      "UPDATE app.idx_template_binding SET capture_member_id=$1 WHERE tenant_id=$2 AND id=$3",
      [platform.ownerMemberA, fixture.tenant, fixture.bindingId],
    );
    const result = await request(fixture, "inquiries", inquiry(fixture), randomUUID(), adapter(), {
      cookie: "estate_session=untrusted-owner-cookie",
      "x-member-id": platform.ownerMemberA,
    });
    expect(result.status).toBe(404);
    expect(
      (
        await admin.query("SELECT count(*)::int AS count FROM app.form_entry WHERE form_schema_id=$1", [
          fixture.formId,
        ])
      ).rows[0].count,
    ).toBe(0);
  });

  it("denies revoked published-site purpose and reduced MLS organization scope", async () => {
    const revoked = await site();
    await admin.query(
      "UPDATE app.role_definition SET permission_grants=(SELECT jsonb_agg(grant_item) FROM jsonb_array_elements(permission_grants) AS grant_item WHERE grant_item->>'code'<>'published.site') WHERE tenant_id=$1 AND id=$2",
      [revoked.tenant, revoked.roleId],
    );
    expect((await request(revoked, "content")).status).toBe(403);
    const reduced = await site();
    await admin.query(
      "UPDATE app.role_definition SET permission_grants=(SELECT jsonb_agg(CASE WHEN grant_item->>'code'='mls.read' THEN jsonb_set(grant_item,'{scope}','\"own\"'::jsonb) ELSE grant_item END) FROM jsonb_array_elements(permission_grants) AS grant_item) WHERE tenant_id=$1 AND id=$2",
      [reduced.tenant, reduced.roleId],
    );
    expect((await request(reduced, "listings")).status).toBe(403);
    expect((await request(reduced, "inquiries", inquiry(reduced))).status).toBe(403);
    expect(((await request(reduced, "content")).body as Schemas["IdxTemplateContent"]).dataMode).toBe(
      "unavailable",
    );
  });
});

describe("durable native inquiry, routing and private message fidelity", () => {
  it("saves the full inquiry and trusted provenance with a CRM-readable private note and no marketing grant", async () => {
    const fixture = await site();
    const original = inquiry(fixture);
    const result = await request(fixture, "inquiries", original);
    expect(result.status).toBe(200);
    const stored = await entry((result.body as Schemas["SubmissionReceipt"]).receiptId);
    expect(stored.tenant_id).toBe(fixture.tenant);
    expect(stored.form_schema_id).toBe(fixture.formId);
    expect(stored.private_payload.inquiry).toEqual(original);
    expect(stored.private_payload.provenance).toMatchObject({
      siteId: fixture.siteId,
      bindingId: fixture.bindingId,
      feedId: fixture.feedId,
      providerListingKey: fixture.listingKey,
      providerListingId: fixture.listingId,
    });
    const notes = (await withTenantTransaction(
      runtime,
      { userId: platform.agentUser, organizationId: fixture.tenant },
      (client, context) => new CrmService(client, context, randomUUID()).notes(stored.lead_id),
    )) as Schemas["PageNote"];
    expect(notes.items.find((note) => note.id === stored.private_payload.noteId)?.body).toBe(
      original.message,
    );
    const lead = (
      await admin.query("SELECT owner_member_id FROM app.lead WHERE tenant_id=$1 AND id=$2", [
        fixture.tenant,
        stored.lead_id,
      ])
    ).rows[0];
    expect(lead.owner_member_id).toBe(fixture.agentMember);
    const marketing = await admin.query(
      "SELECT count(*)::int AS count FROM app.consent_event WHERE tenant_id=$1 AND contact_channel_id IN(SELECT id FROM app.contact_channel WHERE contact_id=(SELECT contact_id FROM app.lead WHERE id=$2))",
      [fixture.tenant, stored.lead_id],
    );
    expect(marketing.rows[0].count).toBe(0);
    const references = await admin.query(
      "SELECT safe_diff::text AS data FROM app.audit_event WHERE tenant_id=$1 UNION ALL SELECT payload::text AS data FROM app.outbox WHERE tenant_id=$1",
      [fixture.tenant],
    );
    expect(
      references.rows.some(
        (row) => row.data.includes("PRIVATE MESSAGE FIXTURE") || row.data.includes(original.email),
      ),
    ).toBe(false);
    expect(JSON.stringify(result.body)).not.toContain("PRIVATE MESSAGE FIXTURE");
    await expect(
      withTenantTransaction(
        runtime,
        { userId: platform.otherAgentUser, organizationId: platform.orgB },
        (client, context) => new CrmService(client, context, randomUUID()).notes(stored.lead_id),
      ),
    ).rejects.toThrow();
  });
  it("serializes concurrent identical retries into one receipt, lead, note and decision", async () => {
    const fixture = await site();
    const original = inquiry(fixture);
    const key = randomUUID();
    const controller = adapter();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(fixture, "inquiries", original, key, controller)),
    );
    expect(results.map((result) => result.status)).toEqual(Array(5).fill(200));
    expect(
      new Set(results.map((result) => (result.body as Schemas["SubmissionReceipt"]).receiptId)).size,
    ).toBe(1);
    const rows = await admin.query(
      "SELECT lead_id,private_payload FROM app.form_entry WHERE form_schema_id=$1",
      [fixture.formId],
    );
    expect(rows.rowCount).toBe(1);
    expect(
      (
        await admin.query("SELECT count(*)::int AS count FROM app.note WHERE lead_id=$1", [
          rows.rows[0].lead_id,
        ])
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2 AND event_type='lead.captured'",
          [fixture.tenant, rows.rows[0].lead_id],
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM app.contact_channel WHERE tenant_id=$1 AND kind='email' AND normalized_value=$2",
          [fixture.tenant, original.email],
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await admin.query("SELECT count(*)::int AS count FROM app.capture_decision WHERE lead_id=$1", [
          rows.rows[0].lead_id,
        ])
      ).rows[0].count,
    ).toBe(1);
  });
  it("conflicts on changed message with the same key and reconciles a lost acknowledgement", async () => {
    const fixture = await site();
    const original = inquiry(fixture);
    const key = randomUUID();
    const first = await request(fixture, "inquiries", original, key);
    expect(first.status).toBe(200);
    expect(
      (await request(fixture, "inquiries", { ...original, message: "Changed message" }, key)).status,
    ).toBe(409);
    const recovered = await request(fixture, "inquiries", original, key);
    expect(recovered.status).toBe(200);
    expect(recovered.body).toEqual(first.body);
  });
  it("keeps identical UUID keys separate for different bound sites and sources", async () => {
    const firstSite = await site();
    const secondSite = await site();
    const key = randomUUID();
    const first = await request(firstSite, "inquiries", inquiry(firstSite), key);
    const second = await request(secondSite, "inquiries", inquiry(secondSite), key);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect((first.body as Schemas["SubmissionReceipt"]).receiptId).not.toBe(
      (second.body as Schemas["SubmissionReceipt"]).receiptId,
    );
  });
  it("rejects foreign form, changed form version and spoofed provider identifier", async () => {
    const fixture = await site();
    for (const [changed, status, code] of [
      [{ formId: siteB.formId }, 404, "idx_form_unavailable"],
      [{ formVersion: 2 }, 409, "form_version_changed"],
      [{ listingId: "SPOOFED-MLS-ID" }, 422, "listing_identifier_mismatch"],
    ] as const) {
      const result = await request(fixture, "inquiries", inquiry(fixture, changed));
      expect(result.status).toBe(status);
      expect(result.body).toMatchObject({ code });
    }
    expect(
      (
        await admin.query("SELECT count(*)::int AS count FROM app.form_entry WHERE form_schema_id=$1", [
          fixture.formId,
        ])
      ).rows[0].count,
    ).toBe(0);
  });

  it("preserves first-touch ownership across independently bound sites without merging household phones", async () => {
    const brokerage = await site({ brokerage: true });
    const agent = await site();
    const email = `first-touch-${randomUUID()}@example.test`;
    const first = await request(brokerage, "inquiries", inquiry(brokerage, { email }));
    expect(first.status).toBe(200);
    const firstEntry = await entry((first.body as Schemas["SubmissionReceipt"]).receiptId);
    const firstLead = (
      await admin.query("SELECT contact_id,owner_member_id FROM app.lead WHERE id=$1", [firstEntry.lead_id])
    ).rows[0];
    const second = await request(agent, "inquiries", inquiry(agent, { email }));
    expect(second.status).toBe(200);
    const secondEntry = await entry((second.body as Schemas["SubmissionReceipt"]).receiptId);
    const secondLead = (
      await admin.query("SELECT contact_id,owner_member_id FROM app.lead WHERE id=$1", [secondEntry.lead_id])
    ).rows[0];
    expect(secondLead).toEqual(firstLead);
    expect(secondEntry.private_payload.routing.reasonCodes).toContain("first_touch_selected");
    const other = await request(agent, "inquiries", inquiry(agent));
    expect(other.status).toBe(200);
    const otherEntry = await entry((other.body as Schemas["SubmissionReceipt"]).receiptId);
    expect(
      (await admin.query("SELECT contact_id FROM app.lead WHERE id=$1", [otherEntry.lead_id])).rows[0]
        .contact_id,
    ).not.toBe(firstLead.contact_id);
  });

  it("routes to a current server-provisioned listing agent before the site agent", async () => {
    const fixture = await site();
    await admin.query(
      "INSERT INTO app.idx_template_listing_assignment(tenant_id,binding_id,feed_id,source_listing_key,member_id,policy_version,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,'active',clock_timestamp()+interval '30 minutes')",
      [
        fixture.tenant,
        fixture.bindingId,
        fixture.feedId,
        fixture.listingKey,
        platform.ownerMemberA,
        fixture.policyVersion,
      ],
    );
    const result = await request(fixture, "inquiries", inquiry(fixture));
    expect(result.status).toBe(200);
    const stored = await entry((result.body as Schemas["SubmissionReceipt"]).receiptId);
    expect(stored.private_payload.provenance.listingAgentMemberId).toBe(platform.ownerMemberA);
    expect(stored.private_payload.routing.reasonCodes).toContain("listing_agent_selected");
    expect(
      (
        await admin.query("SELECT owner_member_id FROM app.lead WHERE tenant_id=$1 AND id=$2", [
          fixture.tenant,
          stored.lead_id,
        ])
      ).rows[0].owner_member_id,
    ).toBe(platform.ownerMemberA);
  });

  it("rejects a foreign tenant's member in a trusted listing assignment", async () => {
    const fixture = await site();
    await expect(
      admin.query(
        "INSERT INTO app.idx_template_listing_assignment(tenant_id,binding_id,feed_id,source_listing_key,member_id,policy_version,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,'active',clock_timestamp()+interval '30 minutes')",
        [
          fixture.tenant,
          fixture.bindingId,
          fixture.feedId,
          fixture.listingKey,
          platform.agentMemberB,
          fixture.policyVersion,
        ],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM app.idx_template_listing_assignment WHERE binding_id=$1",
          [fixture.bindingId],
        )
      ).rows[0].count,
    ).toBe(0);
  });

  it.each(["expired", "inactive"] as const)(
    "skips an %s listing assignment and uses the currently eligible site agent",
    async (condition) => {
      const fixture = await site();
      await admin.query(
        "INSERT INTO app.idx_template_listing_assignment(tenant_id,binding_id,feed_id,source_listing_key,member_id,policy_version,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,'active',clock_timestamp()+$7::interval)",
        [
          fixture.tenant,
          fixture.bindingId,
          fixture.feedId,
          fixture.listingKey,
          platform.ownerMemberA,
          fixture.policyVersion,
          condition === "expired" ? "-1 second" : "30 minutes",
        ],
      );
      try {
        if (condition === "inactive")
          await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
            fixture.tenant,
            platform.ownerMemberA,
          ]);
        const result = await request(fixture, "inquiries", inquiry(fixture));
        expect(result.status).toBe(200);
        const stored = await entry((result.body as Schemas["SubmissionReceipt"]).receiptId);
        expect(stored.private_payload.provenance.listingAgentMemberId).toBeNull();
        expect(stored.private_payload.routing.reasonCodes).toContain("site_agent_selected");
        expect(
          (await admin.query("SELECT owner_member_id FROM app.lead WHERE id=$1", [stored.lead_id])).rows[0]
            .owner_member_id,
        ).toBe(fixture.agentMember);
      } finally {
        if (condition === "inactive")
          await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
            fixture.tenant,
            platform.ownerMemberA,
          ]);
      }
    },
  );

  it("restricts brokerage weighted routing to the current office and uses the unassigned queue after office access is removed", async () => {
    const fixture = await site({ brokerage: true });
    const office = randomUUID();
    await admin.query(
      "INSERT INTO app.office(tenant_id,id,name,timezone) VALUES($1,$2,$3,'America/Los_Angeles')",
      [fixture.tenant, office, `Synthetic Office ${office}`],
    );
    await admin.query("INSERT INTO app.office_member(tenant_id,office_id,member_id) VALUES($1,$2,$3)", [
      fixture.tenant,
      office,
      fixture.agentMember,
    ]);
    await admin.query(
      "UPDATE app.idx_template_binding SET brokerage_office_id=$1 WHERE tenant_id=$2 AND id=$3",
      [office, fixture.tenant, fixture.bindingId],
    );
    const result = await request(fixture, "inquiries", inquiry(fixture));
    expect(result.status).toBe(200);
    const stored = await entry((result.body as Schemas["SubmissionReceipt"]).receiptId);
    expect(stored.private_payload.provenance.siteAgentMemberId).toBeNull();
    expect(stored.private_payload.routing.reasonCodes).toContain("round_robin_selected");
    expect(
      (await admin.query("SELECT owner_member_id FROM app.lead WHERE id=$1", [stored.lead_id])).rows[0]
        .owner_member_id,
    ).toBe(fixture.agentMember);
    await admin.query("DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2", [
      fixture.tenant,
      office,
    ]);
    const later = await request(fixture, "inquiries", inquiry(fixture));
    expect(later.status).toBe(200);
    const unassigned = await entry((later.body as Schemas["SubmissionReceipt"]).receiptId);
    expect(unassigned.private_payload.routing.reasonCodes).toContain("unassigned_queue");
    expect(
      (await admin.query("SELECT owner_member_id FROM app.lead WHERE id=$1", [unassigned.lead_id])).rows[0]
        .owner_member_id,
    ).toBeNull();
  });
  it("stops selecting a team-scoped listing agent after their last office membership is removed", async () => {
    const fixture = await site();
    const member = randomUUID();
    const user = randomUUID();
    const role = randomUUID();
    const office = randomUUID();
    await admin.query(
      "INSERT INTO app.user_identity(id,issuer,subject,display_name,email,email_verified) VALUES($1,'urn:estate:synthetic-team-fixture',$2,'Synthetic team recipient',$3,true)",
      [user, user, `team-${user}@example.test`],
    );
    await admin.query(
      "INSERT INTO app.role_definition(tenant_id,id,name,permission_grants) VALUES($1,$2,$3,$4)",
      [
        fixture.tenant,
        role,
        `Synthetic team ${role}`,
        JSON.stringify([
          { code: "crm.leads.read", scope: "team" },
          { code: "crm.leads.write", scope: "team" },
        ]),
      ],
    );
    await admin.query(
      "INSERT INTO app.membership(tenant_id,id,user_id,role_id,status,display_name) VALUES($1,$2,$3,$4,'active','Synthetic team recipient')",
      [fixture.tenant, member, user, role],
    );
    await admin.query(
      "INSERT INTO app.office(tenant_id,id,name,timezone) VALUES($1,$2,$3,'America/Los_Angeles')",
      [fixture.tenant, office, `Synthetic team office ${office}`],
    );
    await admin.query("INSERT INTO app.office_member(tenant_id,office_id,member_id) VALUES($1,$2,$3)", [
      fixture.tenant,
      office,
      member,
    ]);
    await admin.query(
      "INSERT INTO app.idx_template_listing_assignment(tenant_id,binding_id,feed_id,source_listing_key,member_id,policy_version,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,'active',clock_timestamp()+interval '30 minutes')",
      [fixture.tenant, fixture.bindingId, fixture.feedId, fixture.listingKey, member, fixture.policyVersion],
    );
    const first = await request(fixture, "inquiries", inquiry(fixture));
    expect(first.status).toBe(200);
    const stored = await entry((first.body as Schemas["SubmissionReceipt"]).receiptId);
    expect(stored.private_payload.routing.reasonCodes).toContain("listing_agent_selected");
    expect(
      (await admin.query("SELECT owner_member_id FROM app.lead WHERE id=$1", [stored.lead_id])).rows[0]
        .owner_member_id,
    ).toBe(member);
    await admin.query("DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3", [
      fixture.tenant,
      office,
      member,
    ]);
    const second = await request(fixture, "inquiries", inquiry(fixture));
    expect(second.status).toBe(200);
    const later = await entry((second.body as Schemas["SubmissionReceipt"]).receiptId);
    expect(later.private_payload.provenance.listingAgentMemberId).toBeNull();
    expect(later.private_payload.routing.reasonCodes).toContain("site_agent_selected");
    expect(
      (await admin.query("SELECT owner_member_id FROM app.lead WHERE id=$1", [later.lead_id])).rows[0]
        .owner_member_id,
    ).toBe(fixture.agentMember);
  });

  it("uses native geography routing when the trusted current listing ZIP matches", async () => {
    const fixture = await site({ brokerage: true });
    const rule = randomUUID();
    await admin.query(
      "INSERT INTO app.routing_rule(tenant_id,id,priority,condition,assignment) VALUES($1,$2,20,$3,$4)",
      [
        fixture.tenant,
        rule,
        { kind: "geography", postalCodes: ["89109"], retired: false },
        { memberWeights: [{ memberId: fixture.agentMember, weight: 1 }] },
      ],
    );
    try {
      const result = await request(fixture, "inquiries", inquiry(fixture));
      expect(result.status).toBe(200);
      const stored = await entry((result.body as Schemas["SubmissionReceipt"]).receiptId);
      expect(stored.private_payload.routing).toMatchObject({
        winningRuleId: rule,
        reasonCodes: expect.arrayContaining(["geography_selected"]),
      });
      expect(
        (await admin.query("SELECT owner_member_id FROM app.lead WHERE id=$1", [stored.lead_id])).rows[0]
          .owner_member_id,
      ).toBe(fixture.agentMember);
    } finally {
      await admin.query("UPDATE app.routing_rule SET enabled=false WHERE tenant_id=$1 AND id=$2", [
        fixture.tenant,
        rule,
      ]);
    }
  });

  it("rechecks revocation after an actual database row-lock wait and rolls back every private effect", async () => {
    const fixture = await site();
    const original = inquiry(fixture);
    const blocker = await admin.connect();
    let pending: ReturnType<typeof request> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "UPDATE app.idx_template_binding SET state='revoked',row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
        [fixture.tenant, fixture.bindingId],
      );
      pending = request(fixture, "inquiries", original);
      let waiting = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const wait = await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='estate_runtime' AND wait_event_type='Lock' AND position('idx_template_binding' IN query)>0",
        );
        if (wait.rowCount) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await blocker.query("COMMIT");
      expect((await pending).status).toBe(404);
      expect(
        (
          await admin.query("SELECT count(*)::int AS count FROM app.form_entry WHERE form_schema_id=$1", [
            fixture.formId,
          ])
        ).rows[0].count,
      ).toBe(0);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM app.contact_channel WHERE normalized_value=$1",
            [original.email],
          )
        ).rows[0].count,
      ).toBe(0);
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
      await pending;
    }
  });
});

describe("provider and current policy failure", () => {
  it.each(["transport", "secret-reference", "synthetic-flag", "live-rights"] as const)(
    "denies a wrongly classified mock source (%s) before using an injected provider",
    async (kind) => {
      const fixture = await site();
      const source = (
        await admin.query(
          "SELECT f.connection_id,f.transport,c.secret_ref,c.safe_config FROM app.mls_feed f JOIN app.integration_connection c ON(c.tenant_id,c.id)=(f.tenant_id,f.connection_id) WHERE f.tenant_id=$1 AND f.id=$2",
          [fixture.tenant, fixture.feedId],
        )
      ).rows[0];
      const detail = vi.fn(async () => {});
      const controller = adapter({ detail });
      try {
        if (kind === "transport")
          await admin.query("UPDATE app.mls_feed SET transport='reso' WHERE tenant_id=$1 AND id=$2", [
            fixture.tenant,
            fixture.feedId,
          ]);
        if (kind === "secret-reference")
          await admin.query(
            "UPDATE app.integration_connection SET secret_ref='synthetic-forbidden-reference' WHERE tenant_id=$1 AND id=$2",
            [fixture.tenant, source.connection_id],
          );
        if (kind === "synthetic-flag" || kind === "live-rights")
          await admin.query(
            "UPDATE app.integration_connection SET safe_config=$1 WHERE tenant_id=$2 AND id=$3",
            [
              {
                ...source.safe_config,
                ...(kind === "synthetic-flag" ? { synthetic: false } : { liveFeedRights: "approved" }),
              },
              fixture.tenant,
              source.connection_id,
            ],
          );
        const result = await request(fixture, "inquiries", inquiry(fixture), randomUUID(), controller);
        expect(result.status).toBe(503);
        expect(detail).not.toHaveBeenCalled();
        expect(
          (
            await admin.query("SELECT count(*)::int AS count FROM app.form_entry WHERE form_schema_id=$1", [
              fixture.formId,
            ])
          ).rows[0].count,
        ).toBe(0);
        const content = await request(fixture, "content", undefined, randomUUID(), controller);
        expect(content.status).toBe(200);
        expect(content.body).toMatchObject({
          dataMode: "unavailable",
          content: { heroTitle: fixture.title },
        });
      } finally {
        await admin.query("UPDATE app.mls_feed SET transport=$1 WHERE tenant_id=$2 AND id=$3", [
          source.transport,
          fixture.tenant,
          fixture.feedId,
        ]);
        await admin.query(
          "UPDATE app.integration_connection SET secret_ref=$1,safe_config=$2 WHERE tenant_id=$3 AND id=$4",
          [source.secret_ref, source.safe_config, fixture.tenant, source.connection_id],
        );
      }
    },
  );
  it("passes canonical false flags and address search to the provider and rejects reversed bounds", async () => {
    let parsed: Record<string, unknown> | undefined;
    const controller = adapter({
      search: async (query) => {
        parsed = query;
      },
    });
    const result = await request(
      siteA,
      "listings?pool=false&hoa=false&page=2&address=Synthetic%20Street",
      undefined,
      randomUUID(),
      controller,
    );
    expect(result.status).toBe(200);
    expect(parsed).toMatchObject({ pool: false, hoa: false, page: 2, address: "Synthetic Street" });
    expect((await request(siteA, "listings?minPrice=500000&maxPrice=100000")).status).toBe(422);
    expect((await request(siteA, "listings?page=1.5")).status).toBe(422);
    expect((await request(siteA, "listings?%24filter=arbitrary")).status).toBe(422);
  });
  it("does not call the provider to filter on a field lacking current display rights", async () => {
    const search = vi.fn(async () => {});
    const result = await request(siteA, "listings?gated=true", undefined, randomUUID(), adapter({ search }));
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ code: "query_policy_denied" });
    expect(search).not.toHaveBeenCalled();
  });
  it.each(["hidden", "listing_specific"])(
    "denies address filtering before provider access under the %s address policy",
    async (addressRule) => {
      const fixture = await site();
      const feed = (
        await admin.query(
          "SELECT display_policy,native_rights FROM app.mls_feed WHERE tenant_id=$1 AND id=$2",
          [fixture.tenant, fixture.feedId],
        )
      ).rows[0];
      const changedRights = { ...feed.native_rights, addressRule };
      const search = vi.fn(async () => {});
      try {
        await admin.query("UPDATE app.mls_feed SET native_rights=$1 WHERE tenant_id=$2 AND id=$3", [
          changedRights,
          fixture.tenant,
          fixture.feedId,
        ]);
        await admin.query(
          "UPDATE app.idx_template_binding SET policy_sha256=$1 WHERE tenant_id=$2 AND id=$3",
          [fixturePolicyHash(feed.display_policy, changedRights), fixture.tenant, fixture.bindingId],
        );
        const result = await request(
          fixture,
          "listings?address=Synthetic",
          undefined,
          randomUUID(),
          adapter({ search }),
        );
        expect(result.status).toBe(422);
        expect(result.body).toMatchObject({ code: "query_policy_denied" });
        expect(search).not.toHaveBeenCalled();
      } finally {
        await admin.query("UPDATE app.mls_feed SET native_rights=$1 WHERE tenant_id=$2 AND id=$3", [
          feed.native_rights,
          fixture.tenant,
          fixture.feedId,
        ]);
      }
    },
  );
  it("retains the complete sixty-five-photo gallery under explicit current display rights", async () => {
    const result = await request(siteA, `listings/${siteA.listingKey}`);
    expect(result.status).toBe(200);
    expect((result.body as Schemas["IdxTemplateListing"]).photos).toHaveLength(65);
  });
  it("keeps published content available with unavailable data when the provider is disabled", async () => {
    const controller = adapter({
      status: async () => {
        throw new AccessError(503, "provider_disabled", "Unavailable.");
      },
    });
    const result = await request(siteA, "content", undefined, randomUUID(), controller);
    expect(result.status).toBe(200);
    expect((result.body as Schemas["IdxTemplateContent"]).dataMode).toBe("unavailable");
    expect((result.body as Schemas["IdxTemplateContent"]).content.heroTitle).toBe(siteA.title);
  });
  it("returns a provider failure without creating an inquiry or treating unavailable data as empty", async () => {
    const fixture = await site();
    const controller = adapter({
      detail: async () => {
        throw new AccessError(503, "provider_timeout", "Unavailable.");
      },
    });
    expect((await request(fixture, "inquiries", inquiry(fixture), randomUUID(), controller)).status).toBe(
      503,
    );
    expect(
      (
        await admin.query("SELECT count(*)::int AS count FROM app.form_entry WHERE form_schema_id=$1", [
          fixture.formId,
        ])
      ).rows[0].count,
    ).toBe(0);
  });
  it("rejects replay after site revocation rather than returning a stale receipt", async () => {
    const fixture = await site();
    const original = inquiry(fixture);
    const key = randomUUID();
    expect((await request(fixture, "inquiries", original, key)).status).toBe(200);
    await admin.query(
      "UPDATE app.idx_template_binding SET state='revoked',row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
      [fixture.tenant, fixture.bindingId],
    );
    expect((await request(fixture, "inquiries", original, key)).status).toBe(404);
  });

  it("rechecks policy expiry after provider latency before committing an inquiry", async () => {
    const fixture = await site();
    await admin.query(
      "UPDATE app.idx_template_binding SET policy_expires_at=clock_timestamp()+interval '750 milliseconds' WHERE tenant_id=$1 AND id=$2",
      [fixture.tenant, fixture.bindingId],
    );
    let awaitedProvider = false;
    const controller = adapter({
      detail: async () => {
        awaitedProvider = true;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      },
    });
    const result = await request(fixture, "inquiries", inquiry(fixture), randomUUID(), controller);
    expect(awaitedProvider).toBe(true);
    expect(result.status).toBe(503);
    expect(
      (
        await admin.query("SELECT count(*)::int AS count FROM app.form_entry WHERE form_schema_id=$1", [
          fixture.formId,
        ])
      ).rows[0].count,
    ).toBe(0);
  });

  it("rejects a withdrawn native listing across detail, search and inquiry despite a cached provider projection", async () => {
    const fixture = await site();
    await admin.query(
      "UPDATE app.listing SET withdrawn_at=clock_timestamp(),display_allowed=false WHERE tenant_id=$1 AND feed_id=$2 AND source_listing_key=$3",
      [fixture.tenant, fixture.feedId, fixture.listingKey],
    );
    const detail = await request(fixture, `listings/${fixture.listingKey}`);
    expect(detail.status).toBe(404);
    const search = await request(fixture, "listings");
    if (search.status === 200) expect((search.body as Schemas["IdxTemplateListingPage"]).items).toEqual([]);
    else expect([404, 503]).toContain(search.status);
    expect((await request(fixture, "inquiries", inquiry(fixture))).status).toBe(404);
    expect(
      (
        await admin.query("SELECT count(*)::int AS count FROM app.form_entry WHERE form_schema_id=$1", [
          fixture.formId,
        ])
      ).rows[0].count,
    ).toBe(0);
  });
});

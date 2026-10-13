import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createCmsProfileReferencePort } from "../../apps/api/src/admin-profile-reference";
import { CmsService } from "../../apps/api/src/cms";
import { fixtures as platform } from "../../packages/db/fixtures";
import { withTenantTransaction } from "../../packages/db/tenant-transaction";
import { MockStorageProvider } from "../../packages/providers/storage/mock";
import {
  type MockIdxProvisionOptions,
  provisionIdxTemplateMock,
} from "../../scripts/idx-template/provision-mock";
import { createSiteFixture, type IdxSiteFixture } from "./fixtures";
import { createIdxPools, requireIdxIsolation } from "./isolation";

const { admin, runtime } = createIdxPools();
const target = requireIdxIsolation();
const environment = { APP_ENV: "test", DEV_AUTH_ENABLED: "true", MIGRATION_DATABASE_URL: target.migration };
vi.stubGlobal("fetch", () => {
  throw new Error("Provisioning must not contact an external provider.");
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await Promise.all([admin.end(), runtime.end()]);
});
const options = (fixture: IdxSiteFixture): MockIdxProvisionOptions => ({
  tenantId: fixture.tenant,
  siteId: fixture.siteId,
  documentId: fixture.documentId,
  feedId: fixture.feedId,
  profileId: fixture.profileId,
  origin: fixture.origin,
  sourceId: fixture.sourceId,
  formId: fixture.formId,
  siteAgentMemberId: fixture.agentMember,
});
async function binding(siteId: string) {
  return (await admin.query("SELECT * FROM app.idx_template_binding WHERE site_id=$1", [siteId])).rows[0];
}

describe("explicit local mock IDX provisioning", () => {
  it("creates a disabled binding and draft form, then activates only after explicit publication without duplicating or renewing it", async () => {
    const fixture = await createSiteFixture(admin, { unbound: true });
    await admin.query("UPDATE app.site SET state='draft' WHERE tenant_id=$1 AND id=$2", [
      fixture.tenant,
      fixture.siteId,
    ]);
    await admin.query(
      "UPDATE app.content_document SET published_revision_id=NULL WHERE tenant_id=$1 AND id=$2",
      [fixture.tenant, fixture.documentId],
    );
    const input: MockIdxProvisionOptions = {
      ...options(fixture),
      sourceId: undefined,
      formId: undefined,
      createSource: true,
      createForm: true,
    };
    const initial = await provisionIdxTemplateMock(input, environment);
    expect(initial).toMatchObject({
      synthetic: true,
      mode: "mock",
      state: "disabled",
      siteId: fixture.siteId,
    });
    expect(initial.pending.length).toBeGreaterThan(0);
    expect(
      (
        await admin.query("SELECT state FROM app.form_schema WHERE tenant_id=$1 AND id=$2", [
          fixture.tenant,
          initial.formId,
        ])
      ).rows[0].state,
    ).toBe("draft");
    expect(
      (
        await admin.query("SELECT state FROM app.site WHERE tenant_id=$1 AND id=$2", [
          fixture.tenant,
          fixture.siteId,
        ])
      ).rows[0].state,
    ).toBe("draft");
    const identity = (
      await admin.query(
        "SELECT u.issuer,u.subject,r.permission_grants FROM app.membership m JOIN app.user_identity u ON u.id=m.user_id JOIN app.role_definition r ON(r.tenant_id,r.id)=(m.tenant_id,m.role_id) WHERE m.tenant_id=$1 AND m.id=$2",
        [fixture.tenant, initial.captureMemberId],
      )
    ).rows[0];
    expect(identity).toMatchObject({ issuer: "urn:estate:idx-template-capture", subject: fixture.siteId });
    expect(
      identity.permission_grants.every((grant: { scope: string }) => grant.scope === "organization"),
    ).toBe(true);
    expect(
      identity.permission_grants.some(
        (grant: { code: string }) => grant.code === "content.publish" || grant.code === "crm.routing.manage",
      ),
    ).toBe(false);
    const initialRow = await binding(fixture.siteId);
    expect(await provisionIdxTemplateMock(input, environment)).toEqual(initial);
    expect(await binding(fixture.siteId)).toEqual(initialRow);
    await withTenantTransaction(
      runtime,
      { userId: platform.ownerUser, organizationId: fixture.tenant },
      async (client, context) => {
        const service = new CmsService(client, context, randomUUID(), {
          profiles: createCmsProfileReferencePort(client, context),
          trustedLinkPolicy: { approvedLinkOrigins: new Set() },
          storage: new MockStorageProvider(fixture.origin),
        });
        expect(
          (
            await service.publishDocument(
              fixture.documentId,
              { revisionId: fixture.revisionId, expectedDocumentVersion: 1 },
              { key: randomUUID() },
            )
          ).status,
        ).toBe(202);
      },
    );
    // Explicit owner-controlled fixture publication is separate from provisioning.
    await admin.query("UPDATE app.site SET state='published' WHERE tenant_id=$1 AND id=$2", [
      fixture.tenant,
      fixture.siteId,
    ]);
    await admin.query("UPDATE app.form_schema SET state='published' WHERE tenant_id=$1 AND id=$2", [
      fixture.tenant,
      initial.formId,
    ]);
    const activated = await provisionIdxTemplateMock(input, environment);
    expect(activated).toMatchObject({
      bindingId: initial.bindingId,
      captureMemberId: initial.captureMemberId,
      formId: initial.formId,
      sourceId: initial.sourceId,
      state: "active",
      pending: [],
      expiresAt: initial.expiresAt,
    });
    const activeRow = await binding(fixture.siteId);
    expect(activeRow.row_version).toBe("2");
    expect(await provisionIdxTemplateMock(input, environment)).toEqual(activated);
    expect(await binding(fixture.siteId)).toEqual(activeRow);
    expect(
      (
        await admin.query("SELECT count(*)::int AS count FROM app.idx_template_binding WHERE site_id=$1", [
          fixture.siteId,
        ])
      ).rows[0].count,
    ).toBe(1);
  });

  it("refuses changed source authority instead of rewriting an active binding", async () => {
    const fixture = await createSiteFixture(admin, { unbound: true });
    const input = options(fixture);
    const first = await provisionIdxTemplateMock(input, environment);
    expect(first.state).toBe("active");
    const before = await binding(fixture.siteId);
    await expect(
      provisionIdxTemplateMock({ ...input, origin: "http://localhost:3002" }, environment),
    ).rejects.toMatchObject({ code: "binding_conflict" });
    expect(await binding(fixture.siteId)).toEqual(before);
  });

  it.each(["revoked", "expired"] as const)("does not reactivate or renew a %s binding", async (condition) => {
    const fixture = await createSiteFixture(admin, { unbound: true });
    const input = options(fixture);
    await provisionIdxTemplateMock(input, environment);
    if (condition === "revoked")
      await admin.query("UPDATE app.idx_template_binding SET state='revoked' WHERE site_id=$1", [
        fixture.siteId,
      ]);
    else
      await admin.query(
        "UPDATE app.idx_template_binding SET expires_at=clock_timestamp()-interval '1 second' WHERE site_id=$1",
        [fixture.siteId],
      );
    const before = await binding(fixture.siteId);
    await expect(provisionIdxTemplateMock(input, environment)).rejects.toMatchObject({
      code: condition === "revoked" ? "binding_conflict" : "binding_expired",
    });
    expect(await binding(fixture.siteId)).toEqual(before);
  });

  it("rejects foreign site/feed/form/member references without provisioning authority effects", async () => {
    const fixture = await createSiteFixture(admin, { unbound: true });
    const foreign = await createSiteFixture(admin, { tenant: platform.orgB, unbound: true });
    for (const changed of [
      { profileId: foreign.profileId },
      { feedId: foreign.feedId },
      { formId: foreign.formId },
      { siteAgentMemberId: foreign.agentMember },
    ]) {
      await expect(
        provisionIdxTemplateMock({ ...options(fixture), ...changed }, environment),
      ).rejects.toBeInstanceOf(Error);
      expect(await binding(fixture.siteId)).toBeUndefined();
    }
  });

  it("requires explicit development/test mode, a loopback origin, and the separate migration identity", async () => {
    const fixture = await createSiteFixture(admin, { unbound: true });
    await expect(
      provisionIdxTemplateMock(options(fixture), { ...environment, APP_ENV: "production" }),
    ).rejects.toMatchObject({ code: "local_mode_required" });
    await expect(
      provisionIdxTemplateMock({ ...options(fixture), origin: "https://example.test" }, environment),
    ).rejects.toMatchObject({ code: "loopback_origin_required" });
    await expect(
      provisionIdxTemplateMock(options(fixture), { ...environment, MIGRATION_DATABASE_URL: target.runtime }),
    ).rejects.toMatchObject({ code: "migration_identity_required" });
    await expect(
      provisionIdxTemplateMock(options(fixture), {
        ...environment,
        MIGRATION_DATABASE_URL: target.migration.replace("127.0.0.1", "remote.example.test"),
      }),
    ).rejects.toMatchObject({ code: "loopback_database_required" });
    expect(await binding(fixture.siteId)).toBeUndefined();
  });
});

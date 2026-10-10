import { createHash, randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  SupportResource,
  SyntheticStaffSessionResponse,
} from "../../packages/contracts/internal/control-plane-port";
import staffSchema from "../../packages/contracts/internal/synthetic-staff-v1.schema.json";
import { fixtures } from "../../packages/db/fixtures";
import { ApiSession, apiOrigin, assertContract, assertProblem, type Schemas } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

// Registered support acceptance runs only in the owned disposable API/database fixture.
for (const name of ["TEST_DATABASE_URL", "TEST_MIGRATION_DATABASE_URL"] as const) {
  const url = new URL(process.env[name] ?? "http://missing.invalid");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/estate_acceptance_[a-f0-9]{16}$/.test(url.pathname)
  )
    throw new Error("Run registered support acceptance through the disposable isolated batch runner.");
}
const isolatedApi = new URL(process.env.TEST_API_ORIGIN ?? "http://missing.invalid");
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(isolatedApi.hostname) ||
  ["", "3000", "3001"].includes(isolatedApi.port)
)
  throw new Error("Support acceptance requires the owned ephemeral API listener.");

export const supportRoutes = {
  select: "/dev/staff/support/select",
  clear: "/dev/staff/support/clear",
  grant: (organizationId: string) => "/v1/platform/organizations/" + organizationId + "/access-grants",
  revoke: (organizationId: string, grantId: string) =>
    "/dev/staff/support/organizations/" + organizationId + "/access-grants/" + grantId + "/revoke",
  job: (jobId: string) => "/dev/staff/support/jobs/" + jobId,
  list: (organizationId: string, resource: SupportResource) =>
    "/dev/staff/support/organizations/" + organizationId + "/crm/" + resource,
  detail: (organizationId: string, resource: SupportResource, id: string) =>
    "/dev/staff/support/organizations/" + organizationId + "/crm/" + resource + "/" + id,
} as const;

export const readPermissions = [
  "crm.contacts.read",
  "crm.leads.read",
  "crm.tasks.read",
  "crm.deals.read",
  "crm.pipeline.read",
  "crm.sources.read",
  "crm.tags.read",
] as const;

const admin = createMigrationPool();
const webOrigin = process.env.TEST_WEB_ORIGIN ?? "http://localhost:3000";
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
ajv.addSchema(staffSchema);
const validateStaffResponse = ajv.compile({ $ref: staffSchema.$id + "#/$defs/SessionResponse" });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function privateResponse(response: Response) {
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-trace-id")).toBeTruthy();
}

export function grantReference(response: Response) {
  const id = response.headers.get("x-synthetic-support-grant-id") ?? "";
  const revision = response.headers.get("x-synthetic-support-grant-etag") ?? "";
  expect(id).toMatch(uuid);
  expect(revision).toMatch(/^"[1-9]\d*"$/);
  expect(Number.isSafeInteger(Number(revision.slice(1, -1)))).toBe(true);
  return { id, revision };
}

export class SupportStaffSession {
  cookie = "";
  csrf = "";
  body!: SyntheticStaffSessionResponse;

  request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    if (!headers.has("origin")) headers.set("origin", webOrigin);
    if (this.cookie && !headers.has("cookie")) headers.set("cookie", this.cookie);
    return fetch(apiOrigin + path, { ...init, headers });
  }

  command(path: string, body: unknown, options: { key?: string; csrf?: string; revision?: string } = {}) {
    const headers: Record<string, string> = {
      "idempotency-key": options.key ?? randomUUID(),
      "x-csrf-token": options.csrf ?? this.csrf,
    };
    if (options.revision) headers["if-match"] = options.revision;
    return this.request(path, { method: "POST", headers, body: JSON.stringify(body) });
  }

  async verifySession(response: Response, state: "none" | "active" | "stale") {
    expect(response.status).toBe(200);
    privateResponse(response);
    expect(response.headers.get("x-synthetic-support-state")).toBe(state);
    expect(response.headers.get("etag")).toBeNull();
    const csrf = response.headers.get("x-csrf-token") ?? "";
    expect(csrf).toMatch(/^[0-9a-f]{64}$/);
    if (this.csrf) expect(csrf).toBe(this.csrf);
    this.csrf = csrf;
    const body: unknown = await response.json();
    expect(validateStaffResponse(body), JSON.stringify(validateStaffResponse.errors)).toBe(true);
    this.body = body as SyntheticStaffSessionResponse;
    if (state === "active") {
      expect(this.body.supportContext).not.toBeNull();
      expect(grantReference(response).id).toBe(this.body.supportContext?.accessGrantId);
    } else {
      expect(this.body.supportContext).toBeNull();
      expect(response.headers.get("x-synthetic-support-grant-id")).toBeNull();
      expect(response.headers.get("x-synthetic-support-grant-etag")).toBeNull();
    }
    return this.body;
  }

  async signIn(identity: "administrator" | "support" = "support") {
    const response = await this.request("/dev/staff/session", {
      method: "POST",
      body: JSON.stringify({ identity }),
    });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    this.cookie = cookie.split(";")[0];
    expect(this.cookie).toMatch(/^estate_staff_session=[a-f0-9]{64}$/);
    await this.verifySession(response, "none");
    return this;
  }

  async select(organizationId: string, grantId: string, key = randomUUID()) {
    return this.verifySession(
      await this.command(supportRoutes.select, { organizationId, accessGrantId: grantId }, { key }),
      "active",
    );
  }
}

export async function grantInput(
  permissions: readonly string[] = readPermissions,
  recipient: string = fixtures.staffSupportUser,
): Promise<Schemas["AccessGrant"]> {
  const stamp = (await admin.query("SELECT clock_timestamp() AS stamp")).rows[0].stamp;
  return {
    staffUserId: recipient,
    permissions: [...permissions],
    reason: "Synthetic support investigation " + randomUUID(),
    expiresAt: new Date(new Date(stamp).getTime() + 30 * 60 * 1000).toISOString(),
  };
}

export async function frozenResponse<T extends keyof Schemas>(response: Response, schema: T, status = 200) {
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(response.headers.get("cache-control")).toContain("no-store");
  assertContract(schema, body);
  return body;
}

export async function issueGrant(
  issuer: SupportStaffSession,
  organizationId: string,
  input: Schemas["AccessGrant"],
  key = randomUUID(),
) {
  const response = await issuer.command(supportRoutes.grant(organizationId), input, { key });
  const reference = grantReference(response);
  const job = await frozenResponse(response, "Job", 202);
  expect(job.kind).toBe("staff.support.grant");
  expect(job.state).toBe("succeeded");
  return { ...reference, job, input, key };
}

export async function customerRecords(owner: ApiSession) {
  const contact = await frozenResponse(
    await owner.command("/v1/orgs/" + owner.orgId + "/contacts", {
      displayName: "Synthetic support customer " + randomUUID(),
      emails: [randomUUID() + "@example.test"],
    } satisfies Schemas["ContactWrite"]),
    "Contact",
    201,
  );
  const sources = (await owner.read("/v1/orgs/" + owner.orgId + "/lead-sources", "PageLeadSource")).body;
  const lead = await frozenResponse(
    await owner.command("/v1/orgs/" + owner.orgId + "/leads", {
      contactId: contact.id,
      sourceId: sources.items[0].id,
      ownerMemberId: owner.memberId,
      intent: "buyer",
    } satisfies Schemas["LeadCreate"]),
    "Lead",
    201,
  );
  const task = await frozenResponse(
    await owner.command("/v1/orgs/" + owner.orgId + "/tasks", {
      leadId: lead.id,
      assigneeMemberId: owner.memberId,
      title: "Synthetic support task",
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      timezone: "UTC",
    } satisfies Schemas["TaskWrite"]),
    "Task",
    201,
  );
  const deal = await frozenResponse(
    await owner.command("/v1/orgs/" + owner.orgId + "/deals", {
      leadId: lead.id,
      name: "Synthetic support deal",
      currency: "USD",
      state: "open",
    } satisfies Schemas["DealWrite"]),
    "Deal",
    201,
  );
  return { contact, lead, task, deal };
}

const schemas = {
  contacts: ["Contact", "PageContact"],
  leads: ["Lead", "PageLead"],
  tasks: ["Task", "PageTask"],
  deals: ["Deal", "PageDeal"],
  "pipeline-stages": ["PipelineStage", "PagePipelineStage"],
  "lead-sources": ["LeadSource", "PageLeadSource"],
  tags: ["Tag", "PageTag"],
} as const satisfies Record<SupportResource, readonly [keyof Schemas, keyof Schemas]>;

async function denied(response: Response, statuses: readonly number[] = [403, 404]) {
  privateResponse(response);
  expect(statuses).toContain(response.status);
  const problem = await assertProblem(response, response.status);
  expect(response.headers.get("x-synthetic-support-grant-id")).toBeNull();
  expect(response.headers.get("x-synthetic-support-grant-etag")).toBeNull();
  return problem;
}

async function current(session: SupportStaffSession, state: "none" | "active" | "stale") {
  return session.verifySession(await session.request("/dev/staff/session"), state);
}

async function safeReplay(
  session: SupportStaffSession,
  response: Response,
  organizationId: string,
  grantId: string,
) {
  if (response.status === 409) await denied(response, [409]);
  else {
    const body = await session.verifySession(response, "active");
    expect(body.supportContext).toMatchObject({ organizationId, accessGrantId: grantId });
  }
  expect((await current(session, "active")).supportContext).toMatchObject({
    organizationId,
    accessGrantId: grantId,
  });
}

const sessionHash = (session: SupportStaffSession) =>
  createHash("sha256").update(session.cookie.split("=")[1]).digest("hex");
const sessionBinding = (session: SupportStaffSession) =>
  createHash("sha256")
    .update("control-command-session-v1:" + sessionHash(session))
    .digest("hex");

// Coordinator/backend source readiness must precede invoking this registration.
export function registerSupportAcceptance() {
  const locks = createMigrationPool();
  let issuer: SupportStaffSession;
  let recipient: SupportStaffSession;
  let secondRecipient: SupportStaffSession;
  let ownerA: ApiSession;
  let ownerB: ApiSession;
  let recordsA: Awaited<ReturnType<typeof customerRecords>>;
  let recordsB: Awaited<ReturnType<typeof customerRecords>>;
  let grantA: Awaited<ReturnType<typeof issueGrant>>;
  let grantB: Awaited<ReturnType<typeof issueGrant>>;
  let tagA: Schemas["Tag"];
  let secondTagA: Schemas["Tag"];
  let tagB: Schemas["Tag"];

  beforeAll(async () => {
    issuer = await new SupportStaffSession().signIn("administrator");
    recipient = await new SupportStaffSession().signIn();
    secondRecipient = await new SupportStaffSession().signIn();
    ownerA = await new ApiSession().signIn("owner");
    ownerB = await new ApiSession().signIn("owner");
    expect((await ownerB.switchOrganization(fixtures.orgB)).status).toBe(200);
    recordsA = await customerRecords(ownerA);
    recordsB = await customerRecords(ownerB);
    tagA = await frozenResponse(
      await ownerA.command("/v1/orgs/" + ownerA.orgId + "/tags", {
        name: "Synthetic support tag " + randomUUID(),
      }),
      "Tag",
      201,
    );
    secondTagA = await frozenResponse(
      await ownerA.command("/v1/orgs/" + ownerA.orgId + "/tags", {
        name: "Synthetic second support tag " + randomUUID(),
      }),
      "Tag",
      201,
    );
    tagB = await frozenResponse(
      await ownerB.command("/v1/orgs/" + ownerB.orgId + "/tags", {
        name: "Synthetic foreign support tag " + randomUUID(),
      }),
      "Tag",
      201,
    );
    recordsA.lead = await frozenResponse(
      await ownerA.command(
        "/v1/orgs/" + ownerA.orgId + "/leads/" + recordsA.lead.id + "/tags",
        { tagIds: [tagA.id, secondTagA.id] },
        { method: "PUT", revision: '"' + recordsA.lead.version + '"' },
      ),
      "Lead",
    );
    grantA = await issueGrant(issuer, fixtures.orgA, await grantInput());
    grantB = await issueGrant(issuer, fixtures.orgB, await grantInput());
  }, 30_000);

  afterAll(async () => {
    await locks.end();
    await admin.end();
  });

  describe("registered synthetic reasoned staff support", () => {
    it("requires separate staff identity and a selected grant without creating membership authority", async () => {
      await denied(await recipient.request(supportRoutes.list(fixtures.orgA, "contacts")));
      await denied(
        await new SupportStaffSession().request(supportRoutes.list(fixtures.orgA, "contacts")),
        [401],
      );
      await denied(await ownerA.request(supportRoutes.list(fixtures.orgA, "contacts")), [401]);
      await denied(await recipient.command(supportRoutes.grant(fixtures.orgA), await grantInput()), [403]);
      expect(
        (
          await admin.query("SELECT count(*)::int AS count FROM app.membership WHERE user_id=ANY($1)", [
            [fixtures.staffAdministratorUser, fixtures.staffSupportUser],
          ])
        ).rows[0].count,
      ).toBe(0);
      expect((await current(recipient, "none")).permissions).not.toContain("crm.contacts.read");
    });

    it("validates the closed grant body and bounded read-only business rules without creating operations", async () => {
      const valid = await grantInput();
      const stamp = (await admin.query("SELECT clock_timestamp() AS stamp")).rows[0].stamp;
      const invalid: unknown[] = [
        { ...valid, permissions: [] },
        { ...valid, permissions: ["crm.contacts.read", "crm.contacts.read"] },
        { ...valid, permissions: ["crm.contacts.write"] },
        { ...valid, permissions: ["data.export"] },
        { ...valid, permissions: ["platform.orgs.read"] },
        { ...valid, reason: "   " },
        { ...valid, reason: "x".repeat(1001) },
        { ...valid, expiresAt: new Date(new Date(stamp).getTime() - 1000).toISOString() },
        { ...valid, expiresAt: new Date(new Date(stamp).getTime() + 3_660_000).toISOString() },
        { ...valid, staffUserId: fixtures.ownerUser },
        { ...valid, staffUserId: randomUUID() },
        { ...valid, ownerMemberId: ownerA.memberId },
      ];
      const before = (await admin.query("SELECT count(*)::int AS count FROM app.support_access_grant"))
        .rows[0].count;
      for (const input of invalid)
        await denied(await issuer.command(supportRoutes.grant(fixtures.orgA), input), [422]);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM app.support_access_grant")).rows[0].count,
      ).toBe(before);
      await denied(await issuer.command(supportRoutes.grant(randomUUID()), valid), [404]);
    });

    it("commits one concurrent creation and preserves the original grant expiry and durable result", async () => {
      const key = randomUUID();
      const input = await grantInput();
      const results = await Promise.all(
        Array.from({ length: 4 }, () => issueGrant(issuer, fixtures.orgA, input, key)),
      );
      const original = results[0];
      expect(new Set(results.map((result) => result.id)).size).toBe(1);
      expect(results.every((result) => result.job.id === original.job.id)).toBe(true);
      const persisted = (
        await admin.query(
          "SELECT expires_at,row_version,reason FROM app.support_access_grant WHERE tenant_id=$1 AND id=$2",
          [fixtures.orgA, original.id],
        )
      ).rows[0];
      expect(new Date(persisted.expires_at).toISOString()).toBe(input.expiresAt);
      expect(Number(persisted.row_version)).toBe(1);
      expect(persisted.reason).toBe(input.reason);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM app.control_idempotency WHERE staff_user_id=$1 AND key=$2",
            [fixtures.staffAdministratorUser, key],
          )
        ).rows[0].count,
      ).toBe(1);
      expect(
        (
          await admin.query("SELECT count(*)::int AS count FROM app.audit_event WHERE resource_id=ANY($1)", [
            [original.id, original.job.id],
          ])
        ).rows[0].count,
      ).toBe(1);
      expect(await issueGrant(issuer, fixtures.orgA, input, key)).toEqual(original);
      await denied(
        await issuer.command(
          supportRoutes.grant(fixtures.orgA),
          { ...input, reason: "Changed synthetic request" },
          { key },
        ),
        [409],
      );
      expect(
        new Date(
          (await admin.query("SELECT expires_at FROM app.support_access_grant WHERE id=$1", [original.id]))
            .rows[0].expires_at,
        ).toISOString(),
      ).toBe(input.expiresAt);
    });

    it("recovers requester-only support Jobs with grant metadata separate from frozen Job fields", async () => {
      const response = await issuer.request(supportRoutes.job(grantA.job.id));
      privateResponse(response);
      expect(grantReference(response)).toEqual({ id: grantA.id, revision: grantA.revision });
      expect(await frozenResponse(response, "Job")).toEqual(grantA.job);
      await denied(await recipient.request(supportRoutes.job(grantA.job.id)), [403]);
      const original = (
        await admin.query("SELECT permission_codes,row_version FROM app.staff_principal WHERE user_id=$1", [
          fixtures.staffSupportUser,
        ])
      ).rows[0];
      try {
        await admin.query(
          "UPDATE app.staff_principal SET permission_codes=array_append(permission_codes,'platform.support.grant'),row_version=row_version+1 WHERE user_id=$1",
          [fixtures.staffSupportUser],
        );
        await denied(await recipient.request(supportRoutes.job(grantA.job.id)), [404]);
      } finally {
        await admin.query(
          "UPDATE app.staff_principal SET permission_codes=$2,row_version=$3 WHERE user_id=$1",
          [fixtures.staffSupportUser, original.permission_codes, original.row_version],
        );
      }
      await denied(await issuer.request(supportRoutes.job(randomUUID())), [404]);
      await denied(await issuer.request("/dev/staff/jobs/" + grantA.job.id), [403, 404]);
    });

    it("returns all seven closed projections only from the selected organization", async () => {
      const selected = await recipient.select(fixtures.orgA, grantA.id);
      expect({
        ...selected.supportContext,
        permissions: [...selected.supportContext!.permissions].sort(),
      }).toEqual({
        organizationId: fixtures.orgA,
        accessGrantId: grantA.id,
        permissions: [...readPermissions].sort(),
        reason: grantA.input.reason,
        expiresAt: grantA.input.expiresAt,
      });
      const details: Record<SupportResource, { id: string }> = {
        contacts: recordsA.contact,
        leads: recordsA.lead,
        tasks: recordsA.task,
        deals: recordsA.deal,
        "pipeline-stages": {
          id: (await ownerA.read("/v1/orgs/" + ownerA.orgId + "/pipeline-stages", "PagePipelineStage")).body
            .items[0].id,
        },
        "lead-sources": {
          id: (await ownerA.read("/v1/orgs/" + ownerA.orgId + "/lead-sources", "PageLeadSource")).body
            .items[0].id,
        },
        tags: tagA,
      };
      for (const resource of Object.keys(schemas) as SupportResource[]) {
        const [entitySchema, pageSchema] = schemas[resource];
        const response = await recipient.request(
          supportRoutes.detail(fixtures.orgA, resource, details[resource].id),
        );
        privateResponse(response);
        expect(grantReference(response)).toEqual({ id: grantA.id, revision: grantA.revision });
        if (resource === "leads")
          expect(response.headers.get("etag")).toBe('"' + recordsA.lead.version + '"');
        expect((await frozenResponse(response, entitySchema)).id).toBe(details[resource].id);
        const pageResponse = await recipient.request(supportRoutes.list(fixtures.orgA, resource));
        privateResponse(pageResponse);
        expect(grantReference(pageResponse)).toEqual({ id: grantA.id, revision: grantA.revision });
        const page = await frozenResponse(pageResponse, pageSchema);
        expect(page.items.map((item) => item.id)).toContain(details[resource].id);
        if (resource === "leads") expect(page.items.map((item) => item.id)).toContain(fixtures.leadA);
      }
      await denied(await recipient.request(supportRoutes.list(fixtures.orgB, "contacts")));
      expect(
        (
          await frozenResponse(
            await recipient.request(supportRoutes.detail(fixtures.orgA, "contacts", recordsA.contact.id), {
              headers: { "x-tenant-id": fixtures.orgB, "x-support-grant-id": grantB.id },
            }),
            "Contact",
          )
        ).id,
      ).toBe(recordsA.contact.id);
      await denied(
        await recipient.request(supportRoutes.detail(fixtures.orgA, "contacts", recordsB.contact.id)),
        [404],
      );
      await denied(
        await recipient.command(supportRoutes.select, {
          organizationId: fixtures.orgA,
          accessGrantId: grantB.id,
        }),
      );
      await denied(
        await issuer.command(supportRoutes.select, {
          organizationId: fixtures.orgA,
          accessGrantId: grantA.id,
        }),
      );
      expect((await current(recipient, "active")).supportContext?.organizationId).toBe(fixtures.orgA);
    });

    it("keeps an unlinked task visible while requiring related permissions for linked records", async () => {
      const unlinked = await frozenResponse(
        await ownerA.command("/v1/orgs/" + ownerA.orgId + "/tasks", {
          assigneeMemberId: ownerA.memberId,
          title: "Synthetic unlinked support task",
          dueAt: new Date(Date.now() + 86_400_000).toISOString(),
          timezone: "UTC",
        }),
        "Task",
        201,
      );
      const tasksOnly = await issueGrant(issuer, fixtures.orgA, await grantInput(["crm.tasks.read"]));
      await recipient.select(fixtures.orgA, tasksOnly.id);
      expect(
        await frozenResponse(
          await recipient.request(supportRoutes.detail(fixtures.orgA, "tasks", unlinked.id)),
          "Task",
        ),
      ).toEqual(unlinked);
      await denied(await recipient.request(supportRoutes.detail(fixtures.orgA, "tasks", recordsA.task.id)));
      const tasks = await frozenResponse(
        await recipient.request(supportRoutes.list(fixtures.orgA, "tasks")),
        "PageTask",
      );
      expect(tasks.items.map((task) => task.id)).toContain(unlinked.id);
      expect(tasks.items.map((task) => task.id)).not.toContain(recordsA.task.id);
      await denied(await recipient.request(supportRoutes.list(fixtures.orgA, "contacts")), [403]);
      const dealsOnly = await issueGrant(issuer, fixtures.orgA, await grantInput(["crm.deals.read"]));
      await recipient.select(fixtures.orgA, dealsOnly.id);
      await denied(await recipient.request(supportRoutes.detail(fixtures.orgA, "deals", recordsA.deal.id)));
      const tagsWithoutLeads = await issueGrant(
        issuer,
        fixtures.orgA,
        await grantInput(["crm.contacts.read", "crm.tags.read"]),
      );
      await recipient.select(fixtures.orgA, tagsWithoutLeads.id);
      await denied(
        await recipient.request(
          supportRoutes.list(fixtures.orgA, "contacts") +
            "?filter=" +
            encodeURIComponent(JSON.stringify({ tagIds: [tagA.id] })),
        ),
        [403],
      );
    });

    it("uses ALL-tag semantics and rejects foreign tags, malformed filters and duplicate query keys", async () => {
      await recipient.select(fixtures.orgA, grantA.id);
      const partial = await customerRecords(ownerA);
      await frozenResponse(
        await ownerA.command(
          "/v1/orgs/" + ownerA.orgId + "/leads/" + partial.lead.id + "/tags",
          { tagIds: [tagA.id] },
          { method: "PUT", revision: '"' + partial.lead.version + '"' },
        ),
        "Lead",
      );
      const path =
        supportRoutes.list(fixtures.orgA, "contacts") +
        "?filter=" +
        encodeURIComponent(JSON.stringify({ tagIds: [tagA.id, secondTagA.id] }));
      const page = await frozenResponse(await recipient.request(path), "PageContact");
      expect(page.items.map((contact) => contact.id)).toContain(recordsA.contact.id);
      expect(page.items.map((contact) => contact.id)).not.toContain(partial.contact.id);
      const base = supportRoutes.list(fixtures.orgA, "contacts");
      for (const query of [
        "?limit=1&limit=2",
        "?limit=0",
        "?extra=private",
        "?filter=%7B",
        "?filter=" + encodeURIComponent(JSON.stringify({ tagIds: [tagB.id] })),
        "?filter=" + encodeURIComponent(JSON.stringify({ tagIds: [tagA.id, tagA.id] })),
      ])
        await denied(await recipient.request(base + query), [422]);
    });

    it("binds cursors to the exact opaque session and current selected grant/context", async () => {
      await recipient.select(fixtures.orgA, grantA.id);
      const first = await frozenResponse(
        await recipient.request(supportRoutes.list(fixtures.orgA, "contacts") + "?limit=1"),
        "PageContact",
      );
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBeTruthy();
      const cursorQuery = "?limit=1&cursor=" + encodeURIComponent(first.nextCursor!);
      await secondRecipient.select(fixtures.orgA, grantA.id);
      await denied(
        await secondRecipient.request(supportRoutes.list(fixtures.orgA, "contacts") + cursorQuery),
        [422],
      );
      await recipient.select(fixtures.orgB, grantB.id);
      await denied(
        await recipient.request(supportRoutes.list(fixtures.orgB, "contacts") + cursorQuery),
        [422],
      );
      await denied(await recipient.request(supportRoutes.list(fixtures.orgA, "contacts") + cursorQuery));
    });

    it("isolates identical keys across opaque sessions and never reselects an old context on replay", async () => {
      const key = randomUUID();
      await recipient.select(fixtures.orgA, grantA.id, key);
      await recipient.select(fixtures.orgB, grantB.id);
      await safeReplay(
        recipient,
        await recipient.command(
          supportRoutes.select,
          { organizationId: fixtures.orgA, accessGrantId: grantA.id },
          { key },
        ),
        fixtures.orgB,
        grantB.id,
      );
      await secondRecipient.select(fixtures.orgA, grantA.id, key);
      expect((await current(secondRecipient, "active")).supportContext?.organizationId).toBe(fixtures.orgA);
      expect((await current(recipient, "active")).supportContext?.organizationId).toBe(fixtures.orgB);
      await denied(
        await recipient.command(
          supportRoutes.select,
          { organizationId: fixtures.orgB, accessGrantId: grantB.id },
          { key },
        ),
        [409],
      );
      const rows = await admin.query(
        "SELECT selected_tenant_id FROM app.staff_session WHERE token_hash=ANY($1)ORDER BY token_hash",
        [[sessionHash(recipient), sessionHash(secondRecipient)]],
      );
      expect(rows.rows.map((row) => row.selected_tenant_id).sort()).toEqual(
        [fixtures.orgA, fixtures.orgB].sort(),
      );
    });

    it("records clear atomically once and old clear replay cannot clear a newer selection", async () => {
      await recipient.select(fixtures.orgA, grantA.id);
      const key = randomUUID();
      const before = (
        await admin.query(
          "SELECT count(*)::int AS count FROM app.control_command_audit WHERE session_binding=$1",
          [sessionBinding(recipient)],
        )
      ).rows[0].count;
      await recipient.verifySession(await recipient.command(supportRoutes.clear, {}, { key }), "none");
      await recipient.verifySession(await recipient.command(supportRoutes.clear, {}, { key }), "none");
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM app.control_command_audit WHERE session_binding=$1",
            [sessionBinding(recipient)],
          )
        ).rows[0].count,
      ).toBe(before + 1);
      await recipient.select(fixtures.orgB, grantB.id);
      await safeReplay(
        recipient,
        await recipient.command(supportRoutes.clear, {}, { key }),
        fixtures.orgB,
        grantB.id,
      );
      await secondRecipient.select(fixtures.orgA, grantA.id);
      await secondRecipient.verifySession(
        await secondRecipient.command(supportRoutes.clear, {}, { key }),
        "none",
      );
      expect((await current(recipient, "active")).supportContext?.organizationId).toBe(fixtures.orgB);
    });

    it("serializes concurrent selection and clear without deadlock or unbound evidence", async () => {
      await recipient.select(fixtures.orgA, grantA.id);
      const keys = [randomUUID(), randomUUID()];
      const before = (
        await admin.query(
          "SELECT count(*)::int AS count FROM app.control_command_audit WHERE session_binding=$1",
          [sessionBinding(recipient)],
        )
      ).rows[0].count;
      const responses = await Promise.all([
        recipient.command(
          supportRoutes.select,
          { organizationId: fixtures.orgB, accessGrantId: grantB.id },
          { key: keys[0] },
        ),
        recipient.command(supportRoutes.clear, {}, { key: keys[1] }),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(200);
        const state = response.headers.get("x-synthetic-support-state");
        expect(["none", "active"]).toContain(state);
        await recipient.verifySession(response, state as "none" | "active");
      }
      const source = (
        await admin.query(
          "SELECT selected_tenant_id,selected_grant_id FROM app.staff_session WHERE token_hash=$1",
          [sessionHash(recipient)],
        )
      ).rows[0];
      const session = await current(recipient, source.selected_tenant_id ? "active" : "none");
      expect(session.supportContext?.organizationId ?? null).toBe(source.selected_tenant_id);
      expect(session.supportContext?.accessGrantId ?? null).toBe(source.selected_grant_id);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM app.control_idempotency WHERE staff_user_id=$1 AND key=ANY($2)",
            [fixtures.staffSupportUser, keys],
          )
        ).rows[0].count,
      ).toBe(2);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM app.control_command_audit WHERE session_binding=$1",
            [sessionBinding(recipient)],
          )
        ).rows[0].count,
      ).toBe(before + 1);
    });

    it("supports recipients without platform metadata privileges while preserving metadata denial", async () => {
      await recipient.select(fixtures.orgA, grantA.id);
      const original = (
        await admin.query("SELECT permission_codes,row_version FROM app.staff_principal WHERE user_id=$1", [
          fixtures.staffSupportUser,
        ])
      ).rows[0];
      try {
        await admin.query(
          "UPDATE app.staff_principal SET permission_codes='{}',row_version=row_version+1 WHERE user_id=$1",
          [fixtures.staffSupportUser],
        );
        expect((await current(recipient, "active")).permissions).toEqual([]);
        expect(
          (
            await frozenResponse(
              await recipient.request(supportRoutes.detail(fixtures.orgA, "contacts", recordsA.contact.id)),
              "Contact",
            )
          ).id,
        ).toBe(recordsA.contact.id);
        await denied(await recipient.request("/v1/platform/organizations"), [403]);
      } finally {
        await admin.query(
          "UPDATE app.staff_principal SET permission_codes=$2,row_version=$3 WHERE user_id=$1",
          [fixtures.staffSupportUser, original.permission_codes, original.row_version],
        );
      }
    });

    it("filters inactive channels and archived contacts/leads from linked projections and lists", async () => {
      await recipient.select(fixtures.orgA, grantA.id);
      const archived = await customerRecords(ownerA);
      await admin.query("UPDATE app.contact_channel SET active=false WHERE tenant_id=$1 AND contact_id=$2", [
        fixtures.orgA,
        archived.contact.id,
      ]);
      const contact = await frozenResponse(
        await recipient.request(supportRoutes.detail(fixtures.orgA, "contacts", archived.contact.id)),
        "Contact",
      );
      expect(contact.emails).toEqual([]);
      await admin.query("UPDATE app.contact SET archived_at=clock_timestamp()WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        archived.contact.id,
      ]);
      const resources = {
        contacts: archived.contact.id,
        leads: archived.lead.id,
        tasks: archived.task.id,
        deals: archived.deal.id,
      } as const;
      for (const resource of Object.keys(resources) as (keyof typeof resources)[]) {
        await denied(
          await recipient.request(supportRoutes.detail(fixtures.orgA, resource, resources[resource])),
          [404],
        );
        const page = await frozenResponse(
          await recipient.request(supportRoutes.list(fixtures.orgA, resource)),
          schemas[resource][1],
        );
        expect(page.items.map((item) => item.id)).not.toContain(resources[resource]);
      }
      await admin.query("UPDATE app.contact SET archived_at=NULL WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        archived.contact.id,
      ]);
      await admin.query("UPDATE app.lead SET archived_at=clock_timestamp()WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        archived.lead.id,
      ]);
      for (const resource of ["leads", "tasks", "deals"] as const)
        await denied(
          await recipient.request(supportRoutes.detail(fixtures.orgA, resource, resources[resource])),
          [404],
        );
    });

    it("denies disabled/expired CRM and suspended/archived organizations while allowing identity-only clear", async () => {
      const capability = (
        await admin.query(
          "SELECT state,effective_until,row_version FROM app.entitlement WHERE tenant_id=$1 AND feature='crm'",
          [fixtures.orgA],
        )
      ).rows[0];
      const organization = (
        await admin.query("SELECT status,row_version FROM app.organization WHERE id=$1", [fixtures.orgA])
      ).rows[0];
      const restoreCapability = () =>
        admin.query(
          "UPDATE app.entitlement SET state=$2,effective_until=$3,row_version=$4 WHERE tenant_id=$1 AND feature='crm'",
          [fixtures.orgA, capability.state, capability.effective_until, capability.row_version],
        );
      try {
        for (const condition of ["disabled", "expired"] as const) {
          await restoreCapability();
          await recipient.select(fixtures.orgA, grantA.id);
          if (condition === "disabled")
            await admin.query(
              "UPDATE app.entitlement SET state='disabled',row_version=row_version+1 WHERE tenant_id=$1 AND feature='crm'",
              [fixtures.orgA],
            );
          else
            await admin.query(
              "UPDATE app.entitlement SET effective_until=clock_timestamp()-interval '1 second',row_version=row_version+1 WHERE tenant_id=$1 AND feature='crm'",
              [fixtures.orgA],
            );
          await denied(await recipient.request(supportRoutes.list(fixtures.orgA, "contacts")));
          await current(recipient, "stale");
          await recipient.verifySession(await recipient.command(supportRoutes.clear, {}), "none");
        }
        await restoreCapability();
        for (const status of ["suspended", "archived"]) {
          await admin.query("UPDATE app.organization SET status=$2,row_version=$3 WHERE id=$1", [
            fixtures.orgA,
            organization.status,
            organization.row_version,
          ]);
          await recipient.select(fixtures.orgA, grantA.id);
          await admin.query("UPDATE app.organization SET status=$2,row_version=row_version+1 WHERE id=$1", [
            fixtures.orgA,
            status,
          ]);
          await denied(await recipient.request(supportRoutes.list(fixtures.orgA, "contacts")));
          await current(recipient, "stale");
          await recipient.verifySession(await recipient.command(supportRoutes.clear, {}), "none");
        }
      } finally {
        await restoreCapability();
        await admin.query("UPDATE app.organization SET status=$2,row_version=$3 WHERE id=$1", [
          fixtures.orgA,
          organization.status,
          organization.row_version,
        ]);
      }
    });

    it("uses grant If-Match, preserves exact revocation replay and exposes stale identity without grant metadata", async () => {
      const granted = await issueGrant(issuer, fixtures.orgA, await grantInput());
      await recipient.select(fixtures.orgA, granted.id);
      const route = supportRoutes.revoke(fixtures.orgA, granted.id);
      await denied(await issuer.command(route, {}), [400]);
      await denied(await issuer.command(route, {}, { revision: '"999"' }), [412]);
      const key = randomUUID();
      const response = await issuer.command(route, {}, { key, revision: granted.revision });
      const revoked = await frozenResponse(response, "Job", 202);
      expect(revoked.kind).toBe("staff.support.revoke");
      expect(revoked.state).toBe("succeeded");
      const stamp = (
        await admin.query(
          "SELECT revoked_at,row_version,expires_at FROM app.support_access_grant WHERE id=$1",
          [granted.id],
        )
      ).rows[0];
      expect(Number(stamp.row_version)).toBe(2);
      expect(stamp.revoked_at).not.toBeNull();
      expect(
        await frozenResponse(
          await issuer.command(route, {}, { key, revision: granted.revision }),
          "Job",
          202,
        ),
      ).toEqual(revoked);
      expect(
        (
          await admin.query(
            "SELECT revoked_at,row_version,expires_at FROM app.support_access_grant WHERE id=$1",
            [granted.id],
          )
        ).rows[0],
      ).toEqual(stamp);
      await denied(await recipient.request(supportRoutes.list(fixtures.orgA, "contacts")));
      await current(recipient, "stale");
      await recipient.verifySession(await recipient.command(supportRoutes.clear, {}), "none");
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM app.control_job WHERE requesting_staff_user_id=$1",
            [fixtures.staffSupportUser],
          )
        ).rows[0].count,
      ).toBe(0);
      await denied(await recipient.command(route, {}, { revision: '"2"' }), [403]);
    });

    it("rejects a projection whose organization lock wait crosses grant expiry and still permits clearing", async () => {
      const granted = await issueGrant(issuer, fixtures.orgA, await grantInput());
      await recipient.select(fixtures.orgA, granted.id);
      const blocker = await locks.connect();
      let pending: Promise<Response> | undefined;
      let released = false;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM app.organization WHERE id=$1 FOR UPDATE", [fixtures.orgA]);
        await admin.query(
          "UPDATE app.support_access_grant SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",
          [granted.id],
        );
        pending = recipient.request(supportRoutes.detail(fixtures.orgA, "contacts", recordsA.contact.id));
        const deadline = Date.now() + 5000;
        let waiting = false;
        while (!waiting && Date.now() < deadline) {
          waiting = Boolean(
            (
              await admin.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname=current_database()AND usename='estate_control'AND wait_event_type='Lock'AND query LIKE '%app.organization%'",
              )
            ).rowCount,
          );
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(true);
        let expired = false;
        while (!expired && Date.now() < deadline) {
          expired = (
            await admin.query(
              "SELECT expires_at<=clock_timestamp() AS expired FROM app.support_access_grant WHERE id=$1",
              [granted.id],
            )
          ).rows[0].expired;
          if (!expired) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(expired).toBe(true);
        await blocker.query("ROLLBACK");
        released = true;
        await denied(await pending);
        pending = undefined;
        await current(recipient, "stale");
        const key = randomUUID();
        await recipient.verifySession(await recipient.command(supportRoutes.clear, {}, { key }), "none");
        await recipient.verifySession(await recipient.command(supportRoutes.clear, {}, { key }), "none");
      } finally {
        if (!released) await blocker.query("ROLLBACK");
        blocker.release();
        if (pending) await pending;
      }
    }, 15_000);

    it("rechecks issuer permission on command recovery/replay and recipient principal on every read", async () => {
      const granted = await issueGrant(issuer, fixtures.orgA, await grantInput());
      await recipient.select(fixtures.orgA, granted.id);
      const original = (
        await admin.query("SELECT permission_codes,row_version FROM app.staff_principal WHERE user_id=$1", [
          fixtures.staffAdministratorUser,
        ])
      ).rows[0];
      try {
        await admin.query(
          "UPDATE app.staff_principal SET permission_codes=array_remove(permission_codes,'platform.support.grant'),row_version=row_version+1 WHERE user_id=$1",
          [fixtures.staffAdministratorUser],
        );
        await denied(
          await issuer.command(supportRoutes.grant(fixtures.orgA), granted.input, { key: granted.key }),
          [403],
        );
        await denied(await issuer.request(supportRoutes.job(granted.job.id)), [403]);
        await denied(
          await issuer.command(
            supportRoutes.revoke(fixtures.orgA, granted.id),
            {},
            { revision: granted.revision },
          ),
          [403],
        );
      } finally {
        await admin.query(
          "UPDATE app.staff_principal SET permission_codes=$2,row_version=$3 WHERE user_id=$1",
          [fixtures.staffAdministratorUser, original.permission_codes, original.row_version],
        );
      }
      try {
        await admin.query("UPDATE app.staff_principal SET active=false WHERE user_id=$1", [
          fixtures.staffSupportUser,
        ]);
        await denied(await recipient.request(supportRoutes.list(fixtures.orgA, "contacts")), [403]);
        await denied(await recipient.request("/dev/staff/session"), [403]);
      } finally {
        await admin.query("UPDATE app.staff_principal SET active=true WHERE user_id=$1", [
          fixtures.staffSupportUser,
        ]);
      }
    });

    it("denies provisioning from a selected administrator context without creating tenant state", async () => {
      const administrator = await new SupportStaffSession().signIn("administrator");
      const granted = await issueGrant(
        issuer,
        fixtures.orgA,
        await grantInput(readPermissions, fixtures.staffAdministratorUser),
      );
      await administrator.select(fixtures.orgA, granted.id);
      const name = "Synthetic forbidden selected provisioning " + randomUUID();
      await denied(
        await administrator.command("/v1/platform/organizations", { name, timezone: "UTC" }),
        [403, 409],
      );
      expect((await admin.query("SELECT id FROM app.organization WHERE name=$1", [name])).rowCount).toBe(0);
      await administrator.verifySession(await administrator.command(supportRoutes.clear, {}), "none");
      expect(
        (
          await admin.query("SELECT count(*)::int AS count FROM app.membership WHERE user_id=ANY($1)", [
            [fixtures.staffAdministratorUser, fixtures.staffSupportUser],
          ])
        ).rows[0].count,
      ).toBe(0);
    });

    it("revokes the opaque session on logout even when its preserved selection has expired", async () => {
      const transient = await new SupportStaffSession().signIn();
      const granted = await issueGrant(issuer, fixtures.orgA, await grantInput());
      await transient.select(fixtures.orgA, granted.id);
      await admin.query(
        "UPDATE app.support_access_grant SET expires_at=created_at+interval '1 millisecond'WHERE id=$1",
        [granted.id],
      );
      await current(transient, "stale");
      const response = await transient.command("/dev/staff/logout", {});
      privateResponse(response);
      expect(response.status).toBe(204);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(response.headers.get("x-synthetic-support-grant-id")).toBeNull();
      expect(
        (await admin.query("SELECT 1 FROM app.staff_session WHERE token_hash=$1", [sessionHash(transient)]))
          .rowCount,
      ).toBe(0);
      await denied(await transient.request("/dev/staff/session"), [401]);
      await denied(await transient.request(supportRoutes.list(fixtures.orgA, "contacts")), [401]);
    });

    it("retains mixed-cookie, Origin/CSRF, closed-command and read-only route boundaries", async () => {
      await recipient.select(fixtures.orgA, grantA.id);
      const mixed = ownerA.cookie + "; " + recipient.cookie;
      for (const path of [
        supportRoutes.list(fixtures.orgA, "contacts"),
        supportRoutes.select,
        "/v1/orgs/" + fixtures.orgA + "/contacts",
      ])
        await denied(await recipient.request(path, { headers: { cookie: mixed } }), [403]);
      await denied(await recipient.command(supportRoutes.clear, {}, { csrf: "invalid" }), [403]);
      const invalidHeaders: Record<string, string>[] = [
        { origin: "https://unapproved.example" },
        { "x-forwarded-for": "127.0.0.1" },
        { forwarded: "for=127.0.0.1" },
      ];
      for (const headers of invalidHeaders)
        await denied(
          await recipient.request(supportRoutes.clear, {
            method: "POST",
            headers: { "idempotency-key": randomUUID(), "x-csrf-token": recipient.csrf, ...headers },
            body: "{}",
          }),
          [403],
        );
      await denied(await recipient.command(supportRoutes.clear, { grantId: grantA.id }), [422]);
      await denied(
        await recipient.request(supportRoutes.clear, {
          method: "POST",
          headers: { "x-csrf-token": recipient.csrf },
          body: "{}",
        }),
        [422],
      );
      await denied(
        await recipient.command(supportRoutes.select, {
          organizationId: fixtures.orgA,
          accessGrantId: grantA.id,
          permissions: ["crm.contacts.write"],
        }),
        [422],
      );
      for (const resource of ["notes", "exports", "consent", "billing", "media", "listings"])
        await denied(
          await recipient.request("/dev/staff/support/organizations/" + fixtures.orgA + "/crm/" + resource),
          [404],
        );
      for (const method of ["POST", "PATCH", "DELETE"])
        await denied(
          await recipient.request(supportRoutes.detail(fixtures.orgA, "contacts", recordsA.contact.id), {
            method,
            headers: { "idempotency-key": randomUUID(), "x-csrf-token": recipient.csrf },
            body: JSON.stringify({ displayName: "PRIVATE_SUPPORT_MUTATION_MARKER" }),
          }),
          [404, 405],
        );
      const ownerContact = (
        await ownerA.read("/v1/orgs/" + ownerA.orgId + "/contacts/" + recordsA.contact.id, "Contact")
      ).body;
      expect(ownerContact).toEqual(recordsA.contact);
      expect((await current(recipient, "active")).supportContext?.accessGrantId).toBe(grantA.id);
    });
  });
}

registerSupportAcceptance();

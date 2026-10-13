import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CrmService } from "../../apps/api/src/crm-service";
import { fixtures, stageId } from "../../packages/db/fixtures";
import { assertRuntimeRole } from "../../packages/db/runtime-role";
import {
  withTenantTransaction,
  type PermissionGrant,
  type TenantContext,
  type VerifiedIdentityContext,
} from "../../packages/db/tenant-transaction";
import { ApiSession, apiOrigin, assertContract, assertProblem, type Schemas } from "../helpers/api";

for (const name of ["TEST_DATABASE_URL", "TEST_MIGRATION_DATABASE_URL"]) {
  const url = new URL(process.env[name] ?? "http://missing.invalid");
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/estate_acceptance_[a-f0-9]{16}$/.test(url.pathname)
  )
    throw new Error("Contact search requires its file-fresh owned disposable batch.");
}
const applicationName = "contact_search_" + randomUUID();
const runtime = new Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  max: 1,
  application_name: applicationName,
});
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL, max: 3 });
const ownerIdentity = { userId: fixtures.ownerUser, organizationId: fixtures.orgA };
const agentIdentity = { userId: fixtures.agentUser, organizationId: fixtures.orgA };
let owner: ApiSession, agent: ApiSession, otherOrg: ApiSession;
const sessions: ApiSession[] = [];
let target: string,
  linkedOwner: { contact: string; lead: string },
  linkedAgent: { contact: string; lead: string };
const endpoint = (session: ApiSession = owner) => "/v1/orgs/" + session.orgId + "/contacts";
const query = (filter: Schemas["LeadFilter"] = {}, limit = 25, cursor?: string | null) =>
  "?limit=" +
  limit +
  "&filter=" +
  encodeURIComponent(JSON.stringify(filter)) +
  (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
function privateResponse(response: Response) {
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("etag")).toBeNull();
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}
async function read(
  filter: Schemas["LeadFilter"] = {},
  session: ApiSession = owner,
  limit = 25,
  cursor?: string | null,
) {
  const response = await session.request(endpoint(session) + query(filter, limit, cursor));
  privateResponse(response);
  const result: unknown = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  assertContract("PageContact", result);
  return result;
}
async function denied(response: Response, status: number) {
  privateResponse(response);
  return assertProblem(response, status);
}
async function contact(
  name: string,
  options: { id?: string; creator?: string; tenant?: string; archived?: boolean } = {},
) {
  const id = options.id ?? randomUUID();
  await admin.query(
    "INSERT INTO app.contact(tenant_id,id,display_name,created_by_member_id,archived_at)VALUES($1,$2,$3,$4,CASE WHEN $5 THEN clock_timestamp() END)",
    [
      options.tenant ?? fixtures.orgA,
      id,
      name,
      options.creator ?? fixtures.ownerMemberA,
      options.archived ?? false,
    ],
  );
  return id;
}
async function linked(name: string, ownerMember: string, creator: string) {
  const id = await contact(name, { creator }),
    lead = randomUUID();
  await admin.query(
    "INSERT INTO app.lead(tenant_id,id,contact_id,source_id,stage_id,owner_member_id)VALUES($1,$2,$3,$4,$5,$6)",
    [fixtures.orgA, lead, id, fixtures.sourceA, stageId(1, 1), ownerMember],
  );
  return { contact: id, lead };
}
async function direct<T>(
  operation: (client: PoolClient, context: TenantContext) => Promise<T>,
  identity: VerifiedIdentityContext = ownerIdentity,
) {
  return withTenantTransaction(runtime, identity, operation);
}
async function searchDirect(
  filter: Schemas["LeadFilter"] = {},
  identity: VerifiedIdentityContext = ownerIdentity,
) {
  return direct(
    (client, context) =>
      new CrmService(client, context, randomUUID()).list("contacts", {
        limit: 100,
        filter: JSON.stringify(filter),
      }),
    identity,
  );
}
async function role<T>(
  operation: () => Promise<T>,
  options: {
    member?: string;
    remove?: string[];
    contactScope?: PermissionGrant["scope"];
    leadScope?: PermissionGrant["scope"];
  } = {},
) {
  const row = (
    await admin.query(
      "SELECT r.id,r.permission_grants FROM app.role_definition r JOIN app.membership m ON(r.tenant_id,r.id)=(m.tenant_id,m.role_id)WHERE m.tenant_id=$1 AND m.id=$2",
      [fixtures.orgA, options.member ?? fixtures.agentMemberA],
    )
  ).rows[0];
  const original = row.permission_grants as PermissionGrant[];
  const next = original
    .filter((g) => !options.remove?.includes(g.code))
    .map((g) =>
      g.code === "crm.contacts.read" && options.contactScope
        ? { ...g, scope: options.contactScope }
        : g.code === "crm.leads.read" && options.leadScope
          ? { ...g, scope: options.leadScope }
          : g,
    );
  try {
    await admin.query("UPDATE app.role_definition SET permission_grants=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      row.id,
      JSON.stringify(next),
    ]);
    return await operation();
  } finally {
    await admin.query("UPDATE app.role_definition SET permission_grants=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      row.id,
      JSON.stringify(original),
    ]);
  }
}
async function capability<T>(operation: () => Promise<T>, state = "enabled", until: string | null = null) {
  const original = (
    await admin.query(
      "SELECT state,effective_until FROM app.entitlement WHERE tenant_id=$1 AND feature='crm'",
      [fixtures.orgA],
    )
  ).rows[0];
  try {
    await admin.query(
      "UPDATE app.entitlement SET state=$2,effective_until=$3 WHERE tenant_id=$1 AND feature='crm'",
      [fixtures.orgA, state, until],
    );
    return await operation();
  } finally {
    await admin.query(
      "UPDATE app.entitlement SET state=$2,effective_until=$3 WHERE tenant_id=$1 AND feature='crm'",
      [fixtures.orgA, original.state, original.effective_until],
    );
  }
}
async function waitForLock() {
  for (let index = 0; index < 100; index++) {
    if (
      (
        await admin.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting",
          [applicationName],
        )
      ).rows[0].waiting
    )
      return;
    await admin.query("SELECT pg_sleep(0.01)");
  }
  throw new Error("Owned contact search did not observe its real lock wait.");
}
function getBody(body: string, contentType: string, chunked = false): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      cookie: owner.cookie,
      origin: process.env.TEST_WEB_ORIGIN ?? "http://localhost:3000",
      "content-type": contentType,
    };
    if (chunked) headers["transfer-encoding"] = "chunked";
    else headers["content-length"] = Buffer.byteLength(body);
    const request = httpRequest(
      new URL(endpoint(), apiOrigin),
      { method: "GET", headers, timeout: 5000 },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 65536) request.destroy(new Error("Owned contact response exceeded bounds."));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          const h = new Headers();
          for (const [key, value] of Object.entries(response.headers))
            if (value !== undefined) h.set(key, Array.isArray(value) ? value.join(",") : value);
          resolve(
            new Response(Buffer.concat(chunks).toString("utf8"), { status: response.statusCode, headers: h }),
          );
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("Owned contact body probe timed out.")));
    request.end(body);
  });
}
beforeAll(async () => {
  await assertRuntimeRole(runtime);
  owner = await new ApiSession().signIn();
  agent = await new ApiSession().signIn("agent");
  otherOrg = await new ApiSession().signIn();
  sessions.push(owner, agent, otherOrg);
  expect((await otherOrg.switchOrganization(fixtures.orgB)).status).toBe(200);
  for (let index = 1; index <= 110; index++)
    await contact("Search pager group " + index, {
      id: "01000000-0000-4000-8000-" + String(index).padStart(12, "0"),
    });
  target = await contact("Beyond hundred SearchNeedle", { id: "f1000000-0000-4000-8000-000000000001" });
  linkedOwner = await linked("Scoped search source Owner", fixtures.ownerMemberA, fixtures.agentMemberA);
  linkedAgent = await linked("Scoped search source Agent", fixtures.agentMemberA, fixtures.ownerMemberA);
  await contact("Scoped search source Foreign", { tenant: fixtures.orgB, creator: fixtures.ownerMemberB });
});
afterAll(async () => {
  for (const session of sessions)
    if (session.cookie) await session.command("/dev/logout", undefined).catch(() => undefined);
  await Promise.all([runtime.end(), admin.end()]);
});

describe("file-fresh registered literal contact name search", () => {
  it("finds a name outside the unfiltered first hundred using the server predicate", async () => {
    expect((await read({}, owner, 100)).items.some((item) => item.id === target)).toBe(false);
    const found = await read({ q: "beyond HUNDRED" });
    expect(found.items.map((item) => item.id)).toEqual([target]);
    expect(found).toMatchObject({ nextCursor: null, hasMore: false });
  });
  it("treats SQL percent, underscore and backslash as literal name characters", async () => {
    const literal = await contact("Literal%_\\needle"),
      nearby = await contact("LiteralXYneedle");
    for (const q of ["%", "_", "\\", "Literal%_\\needle"]) {
      const result = await read({ q });
      expect(result.items.some((item) => item.id === literal)).toBe(true);
      expect(result.items.some((item) => item.id === nearby)).toBe(false);
    }
  });
  it("preserves leading/trailing spaces, Unicode and the exact200-codepoint query limit", async () => {
    const id = await contact("  Padded 安居 🏠  ");
    expect((await read({ q: "  Padded 安居 🏠  " })).items.map((item) => item.id)).toEqual([id]);
    expect((await read({ q: "   Padded" })).items).toEqual([]);
    expect((await read({ q: "😀".repeat(200) })).items).toEqual([]);
    await denied(await owner.request(endpoint() + query({ q: "😀".repeat(201) })), 422);
  });
  it("does not search private email/phone channels as a fallback for display name", async () => {
    const id = await contact("Channel unrelated display");
    await admin.query(
      "INSERT INTO app.contact_channel(tenant_id,contact_id,kind,normalized_value)VALUES($1,$2,'email','unique-search-channel@example.test'),($1,$2,'phone','+15551239999')",
      [fixtures.orgA, id],
    );
    for (const q of ["unique-search-channel", "+15551239999"]) expect((await read({ q })).items).toEqual([]);
  });
  it("uses current scope and explicit owner filter rather than treating a name or owner UUID as authority", async () => {
    const filter = { q: "Scoped search source" };
    expect((await read(filter, owner)).items.map((i) => i.id).sort()).toEqual(
      [linkedOwner.contact, linkedAgent.contact].sort(),
    );
    expect((await read(filter, agent)).items.map((i) => i.id)).toEqual([linkedAgent.contact]);
    expect((await read({ ...filter, ownerMemberId: owner.memberId }, owner)).items.map((i) => i.id)).toEqual([
      linkedOwner.contact,
    ]);
    expect((await read({ ...filter, ownerMemberId: owner.memberId }, agent)).items).toEqual([]);
    expect((await read({ ...filter, ownerMemberId: fixtures.ownerMemberB }, owner)).items).toEqual([]);
    expect((await read(filter, otherOrg)).items).toHaveLength(1);
    await denied(await owner.request("/v1/orgs/" + fixtures.orgB + "/contacts" + query(filter)), 403);
  });
  it("retains creator versus current active-lead scope when a linked source is archived", async () => {
    await admin.query("UPDATE app.lead SET archived_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      linkedAgent.lead,
    ]);
    try {
      expect((await read({ q: "Scoped search source" }, agent)).items).toEqual([]);
      expect(
        (await read({ q: "Scoped search source", ownerMemberId: owner.memberId })).items
          .map((i) => i.id)
          .sort(),
      ).toEqual([linkedOwner.contact, linkedAgent.contact].sort());
    } finally {
      await admin.query("UPDATE app.lead SET archived_at=NULL WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        linkedAgent.lead,
      ]);
    }
    await admin.query("UPDATE app.contact SET archived_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      linkedOwner.contact,
    ]);
    try {
      expect((await read({ q: "Scoped search source" }, owner)).items.map((i) => i.id)).toEqual([
        linkedAgent.contact,
      ]);
    } finally {
      await admin.query("UPDATE app.contact SET archived_at=NULL WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        linkedOwner.contact,
      ]);
    }
  });
  it("intersects team office relationships and can authorize organization scope only through the actual role", async () => {
    await role(
      async () => {
        expect((await read({ q: "Scoped search source" }, agent)).items).toEqual([]);
        const office = randomUUID();
        await admin.query("INSERT INTO app.office(tenant_id,id,name,timezone)VALUES($1,$2,$3,'UTC')", [
          fixtures.orgA,
          office,
          "Owned contact search office " + office,
        ]);
        await admin.query(
          "INSERT INTO app.office_member(tenant_id,office_id,member_id)VALUES($1,$2,$3),($1,$2,$4)",
          [fixtures.orgA, office, fixtures.agentMemberA, fixtures.ownerMemberA],
        );
        try {
          expect((await read({ q: "Scoped search source" }, agent)).items).toHaveLength(2);
        } finally {
          await admin.query("DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2", [
            fixtures.orgA,
            office,
          ]);
        }
      },
      { contactScope: "team" },
    );
    await role(
      async () => {
        expect((await read({ q: "Scoped search source" }, agent)).items).toHaveLength(2);
      },
      { contactScope: "organization" },
    );
  });
  it("returns exact generated bounded ID-ascending pages and does not duplicate rows across current pagination", async () => {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await read({ q: "Search pager group" }, owner, 25, cursor);
      expect(page.items.length).toBeLessThanOrEqual(25);
      ids.push(...page.items.map((item) => item.id));
      expect(page.hasMore).toBe(Boolean(page.nextCursor));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(110);
    expect(new Set(ids).size).toBe(110);
    expect(ids).toEqual([...ids].sort());
  });
  it("binds an opaque cursor to exact filter, actor, tenant, role and current full grants", async () => {
    const first = await read({ q: "Search pager group" }, owner, 1);
    expect(first.nextCursor).toBeTruthy();
    for (const [filter, session] of [
      [{ q: "search PAGER group" }, owner],
      [{ q: "Search pager group" }, agent],
      [{ q: "Search pager group" }, otherOrg],
    ] as const)
      await denied(await session.request(endpoint(session) + query(filter, 1, first.nextCursor)), 422);
    await denied(
      await owner.request(endpoint() + query({ q: "Search pager group" }, 1, first.nextCursor + "tampered")),
      422,
    );
    await role(
      async () => {
        await denied(
          await owner.request(endpoint() + query({ q: "Search pager group" }, 1, first.nextCursor)),
          422,
        );
      },
      { member: fixtures.ownerMemberA, remove: ["ai.accept"] },
    );
  });
  it("requires current tag and scoped lead read permissions for related tag filters", async () => {
    expect(
      (await read({ q: "Scoped search source", tagIds: [] }, owner)).items.map((i) => i.id).sort(),
    ).toEqual([linkedOwner.contact, linkedAgent.contact].sort());
    const tag = randomUUID();
    await admin.query("INSERT INTO app.tag(tenant_id,id,name)VALUES($1,$2,$3)", [
      fixtures.orgA,
      tag,
      "Owned search tag " + tag,
    ]);
    await admin.query("INSERT INTO app.lead_tag(tenant_id,lead_id,tag_id)VALUES($1,$2,$3)", [
      fixtures.orgA,
      linkedOwner.lead,
      tag,
    ]);
    expect((await read({ q: "Scoped search source", tagIds: [tag] }, owner)).items.map((i) => i.id)).toEqual([
      linkedOwner.contact,
    ]);
    expect((await read({ q: "Scoped search source", tagIds: [tag] }, agent)).items).toEqual([]);
    for (const permission of ["crm.tags.read", "crm.leads.read"])
      await role(
        async () => {
          await denied(await owner.request(endpoint() + query({ tagIds: [tag] })), 403);
        },
        { member: fixtures.ownerMemberA, remove: [permission] },
      );
    await denied(await owner.request(endpoint() + query({ tagIds: [tag, tag] })), 422);
    await denied(await owner.request(endpoint() + query({ tagIds: [randomUUID()] })), 422);
  });
  it("intersects approved stage, source and intent predicates with active lead and contact scope", async () => {
    const ownerLead = await linked(
      "Approved relational search Owner",
      fixtures.ownerMemberA,
      fixtures.agentMemberA,
    );
    const agentLead = await linked(
      "Approved relational search Agent",
      fixtures.agentMemberA,
      fixtures.ownerMemberA,
    );
    const unlinked = await contact("Approved relational search Unlinked");
    await admin.query("UPDATE app.lead SET stage_id=$3,intent='seller' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      ownerLead.lead,
      stageId(1, 2),
    ]);
    await admin.query("UPDATE app.lead SET intent='buyer' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      agentLead.lead,
    ]);
    const q = "Approved relational search";
    expect((await read({ q })).items.map((item) => item.id).sort()).toEqual(
      [ownerLead.contact, agentLead.contact, unlinked].sort(),
    );
    for (const filter of [
      { q, stageId: stageId(1, 1) },
      { q, intent: "buyer" },
      { q, sourceId: fixtures.sourceA, stageId: stageId(1, 1), intent: "buyer" },
    ] satisfies Schemas["LeadFilter"][])
      expect((await read(filter)).items.map((item) => item.id)).toEqual([agentLead.contact]);
    expect(
      (await read({ q, stageId: stageId(1, 2), intent: "seller" })).items.map((item) => item.id),
    ).toEqual([ownerLead.contact]);
    expect((await read({ q, sourceId: fixtures.sourceA })).items.map((item) => item.id).sort()).toEqual(
      [ownerLead.contact, agentLead.contact].sort(),
    );
    expect((await read({ q, sourceId: fixtures.sourceB })).items).toEqual([]);
    expect((await read({ q, stageId: stageId(1, 2) }, agent)).items).toEqual([]);
    expect((await read({ q, intent: "seller", ownerMemberId: owner.memberId }, agent)).items).toEqual([]);
    await admin.query("UPDATE app.lead SET archived_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      agentLead.lead,
    ]);
    expect((await read({ q, intent: "buyer" })).items).toEqual([]);
  });
  it("requires current lead read authority for every approved relational filter", async () => {
    await role(
      async () => {
        for (const filter of [
          { stageId: stageId(1, 1) },
          { sourceId: fixtures.sourceA },
          { intent: "unknown" },
        ] satisfies Schemas["LeadFilter"][])
          await denied(await owner.request(endpoint() + query(filter)), 403);
        // Standalone literal contact search does not acquire lead authority implicitly.
        expect((await read({ q: "Beyond hundred" })).items.map((item) => item.id)).toEqual([target]);
      },
      { member: fixtures.ownerMemberA, remove: ["crm.leads.read"] },
    );
  });
  it("denies absent current permissions, disabled membership and CRM capability rather than an empty result", async () => {
    await role(
      async () => {
        await denied(await agent.request(endpoint(agent)), 403);
      },
      { remove: ["crm.contacts.read"] },
    );
    await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      fixtures.agentMemberA,
    ]);
    try {
      await denied(await agent.request(endpoint(agent)), 403);
    } finally {
      await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.agentMemberA,
      ]);
    }
    await capability(async () => {
      await denied(await owner.request(endpoint()), 403);
    }, "disabled");
    await capability(
      async () => {
        await denied(await owner.request(endpoint()), 403);
      },
      "enabled",
      "2000-01-01T00:00:00.000Z",
    );
  });
  it("denies forged or stale service context and never retains tenant context on pool reuse", async () => {
    const snapshot = await direct(async (_client, context) => context);
    const client = await runtime.connect();
    try {
      await expect(new CrmService(client, snapshot, randomUUID()).list("contacts", {})).rejects.toMatchObject(
        { status: 403 },
      );
      expect((await client.query("SELECT id FROM app.contact")).rowCount).toBe(0);
    } finally {
      client.release();
    }
    for (const patch of [
      { memberId: fixtures.agentMemberA },
      { userId: fixtures.agentUser },
      { organizationId: fixtures.orgB },
      { roleId: randomUUID() },
      { permissions: [] },
    ])
      await direct(async (current, context) => {
        await expect(
          new CrmService(current, { ...context, ...patch }, randomUUID()).list("contacts", {}),
        ).rejects.toMatchObject({ status: 403 });
      });
    await role(
      async () =>
        direct(async (current) => {
          await expect(
            new CrmService(current, snapshot, randomUUID()).list("contacts", {}),
          ).rejects.toMatchObject({ status: 403 });
        }),
      { member: fixtures.ownerMemberA, remove: ["crm.contacts.read"] },
    );
    expect((await searchDirect({ q: "Beyond hundred" })).items).toHaveLength(1);
    expect((await searchDirect({ q: "Beyond hundred" }, agentIdentity)).items).toEqual([]);
    expect((await runtime.query("SELECT id FROM app.contact")).rowCount).toBe(0);
  });
  it("uses the post-wait database clock after a real membership lock expires CRM access", async () => {
    await capability(async () => {
      await admin.query(
        "UPDATE app.entitlement SET effective_until=clock_timestamp()+interval '400 milliseconds'WHERE tenant_id=$1 AND feature='crm'",
        [fixtures.orgA],
      );
      const blocker = await admin.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM app.membership WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
          fixtures.orgA,
          fixtures.ownerMemberA,
        ]);
        pending = searchDirect({ q: "Beyond hundred" });
        await waitForLock();
        await admin.query("SELECT pg_sleep(0.55)");
        await blocker.query("COMMIT");
        await expect(pending).rejects.toMatchObject({ status: 403, code: "entitlement_disabled" });
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
        await pending?.catch(() => undefined);
      }
    });
  });
  it("rejects undeclared, repeated, coercive and malformed query or filter values", async () => {
    for (const suffix of [
      "?q=needle",
      "?sort=name",
      "?limit=",
      "?limit=0",
      "?limit=101",
      "?limit=01",
      "?limit=1.0",
      "?limit=1junk",
      "?limit=1&limit=2",
      "?limit[]=1",
      "?cursor=",
      "?cursor=a&cursor=b",
      "?cursor[]=a",
      "?filter=",
      "?filter=null",
      "?filter=[]",
      "?filter={",
      "?filter=%7B%22q%22%3A1%7D",
      "?filter={}&filter={}",
      "?filter[]=x",
      "?filter=" + encodeURIComponent(JSON.stringify({ stageId: "not-a-uuid" })),
      "?filter=" + encodeURIComponent(JSON.stringify({ stageId: 1 })),
      "?filter=" + encodeURIComponent(JSON.stringify({ sourceId: "not-a-uuid" })),
      "?filter=" + encodeURIComponent(JSON.stringify({ sourceId: null })),
      "?filter=" + encodeURIComponent(JSON.stringify({ intent: "undeclared-intent" })),
      "?filter=" + encodeURIComponent(JSON.stringify({ intent: true })),
      "?filter=" + encodeURIComponent(JSON.stringify({ private: "UNDECLARED" })),
    ])
      await denied(await owner.request(endpoint() + suffix), 422);
  });
  it("rejects GET bodies including unsupported media and transfer framing while accepting bodyless length0", async () => {
    for (const [body, type, chunked] of [
      ["{}", "application/json", false],
      ["PRIVATE", "text/plain", false],
      ["", "text/plain", true],
    ] as const)
      await denied(await getBody(body, type, chunked), 422);
    const bodyless = await getBody("", "text/plain");
    expect(bodyless.status).toBe(200);
    privateResponse(bodyless);
  });
  it("denies anonymous/forwarded access and performs no CRM/audit/outbox mutation when searching", async () => {
    await denied(await new ApiSession().request(endpoint()), 401);
    await denied(await owner.request(endpoint(), { headers: { "x-forwarded-for": "203.0.113.7" } }), 403);
    const state = async () =>
      (
        await admin.query(
          "SELECT(SELECT count(*) FROM app.audit_event WHERE tenant_id=$1) audits,(SELECT count(*) FROM app.outbox WHERE tenant_id=$1) events,(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM app.contact c WHERE tenant_id=$1) contacts",
          [fixtures.orgA],
        )
      ).rows[0];
    const before = await state();
    await read({ q: "Search" });
    await read({ q: "Beyond hundred" });
    expect(await state()).toEqual(before);
  });
});

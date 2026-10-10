import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtures } from "../../packages/db/fixtures";
import { ApiSession, assertContract, assertProblem, type Schemas } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
let agent: ApiSession;
const tickets = new Set<string>();
const keys = new Set<string>();
const input = (): Schemas["TicketWrite"] => ({
  subject: `Synthetic support ${randomUUID()}`,
  category: "technical",
  description: `Synthetic private diagnostic ${randomUUID()}`,
});

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
  agent = await new ApiSession().signIn("agent");
});
afterAll(async () => {
  const ids = [...tickets];
  if (ids.length) {
    await admin.query("DELETE FROM app.ticket_event WHERE ticket_id=ANY($1::uuid[])", [ids]);
    await admin.query(
      "DELETE FROM app.audit_event WHERE resource_type='ticket' AND resource_id=ANY($1::text[])",
      [ids],
    );
    await admin.query("DELETE FROM app.ticket WHERE id=ANY($1::uuid[])", [ids]);
  }
  if (keys.size)
    await admin.query("DELETE FROM app.idempotency_record WHERE key=ANY($1::text[])", [[...keys]]);
  await admin.end();
});

async function create(session: ApiSession, body = input(), key = randomUUID()) {
  keys.add(key);
  const response = await session.command(`/v1/orgs/${session.orgId}/tickets`, body, { key });
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const ticket = await response.json();
  assertContract("Ticket", ticket);
  tickets.add(ticket.id);
  return { ticket, body, key };
}

describe("M2 — scoped support tickets and safe diagnostics", () => {
  it("concurrent retries create one ticket, actor event and redacted audit; changed input conflicts", async () => {
    const body = input();
    const key = randomUUID();
    keys.add(key);
    const responses = await Promise.all([
      owner.command(`/v1/orgs/${owner.orgId}/tickets`, body, { key }),
      owner.command(`/v1/orgs/${owner.orgId}/tickets`, body, { key }),
    ]);
    for (const response of responses) expect(response.status).toBe(201);
    const ticket = await responses[0].json();
    assertContract("Ticket", ticket);
    tickets.add(ticket.id);
    expect(await responses[1].json()).toEqual(ticket);
    expect(ticket).toMatchObject({ ...body, state: "open", version: 1 });
    expect((await owner.read(`/v1/orgs/${owner.orgId}/tickets/${ticket.id}`, "Ticket")).body).toEqual(ticket);
    await assertProblem(
      await owner.command(
        `/v1/orgs/${owner.orgId}/tickets`,
        { ...body, description: "Changed synthetic detail" },
        { key },
      ),
      409,
    );
    const events = (
      await admin.query("SELECT actor_ref,kind FROM app.ticket_event WHERE ticket_id=$1", [ticket.id])
    ).rows;
    expect(events).toEqual([{ actor_ref: fixtures.ownerUser, kind: "created" }]);
    const audit = (
      await admin.query(
        "SELECT actor_ref,safe_diff FROM app.audit_event WHERE resource_type='ticket' AND resource_id=$1",
        [ticket.id],
      )
    ).rows;
    expect(audit).toEqual([{ actor_ref: fixtures.ownerUser, safe_diff: { resourceVersion: 1 } }]);
    expect(JSON.stringify([...events, ...audit])).not.toContain(body.description);
  });

  it("another requester or organization cannot retrieve a ticket even with its ID", async () => {
    const created = await create(agent);
    await assertProblem(await owner.request(`/v1/orgs/${owner.orgId}/tickets/${created.ticket.id}`), 404);
    expect(
      (await owner.read(`/v1/orgs/${owner.orgId}/tickets`, "PageTicket")).body.items.map(
        (ticket) => ticket.id,
      ),
    ).not.toContain(created.ticket.id);
    expect((await owner.switchOrganization(fixtures.orgB)).status).toBe(200);
    try {
      await assertProblem(await owner.request(`/v1/orgs/${owner.orgId}/tickets/${created.ticket.id}`), 404);
      expect(
        (await owner.read(`/v1/orgs/${owner.orgId}/tickets`, "PageTicket")).body.items.map(
          (ticket) => ticket.id,
        ),
      ).not.toContain(created.ticket.id);
    } finally {
      expect((await owner.switchOrganization(fixtures.orgA)).status).toBe(200);
    }
  });

  it("cursor paging stays requester bound and rejects altered cursors or invalid limits", async () => {
    const created = await Promise.all([create(agent), create(agent), create(agent)]);
    const first = await agent.read(`/v1/orgs/${agent.orgId}/tickets?limit=1`, "PageTicket");
    expect(first.body.hasMore).toBe(true);
    expect(first.body.nextCursor).toBeTruthy();
    const cursor = first.body.nextCursor!;
    const second = await agent.read(
      `/v1/orgs/${agent.orgId}/tickets?limit=1&cursor=${encodeURIComponent(cursor)}`,
      "PageTicket",
    );
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
    await assertProblem(
      await owner.request(`/v1/orgs/${owner.orgId}/tickets?limit=1&cursor=${encodeURIComponent(cursor)}`),
      422,
    );
    await assertProblem(
      await agent.request(
        `/v1/orgs/${agent.orgId}/tickets?cursor=${encodeURIComponent(`${cursor}tampered`)}`,
      ),
      422,
    );
    for (const limit of ["0", "101", "1.5", "invalid"])
      await assertProblem(await agent.request(`/v1/orgs/${agent.orgId}/tickets?limit=${limit}`), 422);
    const observed = new Set(first.body.items.map((ticket) => ticket.id));
    let page = second.body;
    for (let count = 0; count < 100; count++) {
      for (const ticket of page.items) expect(observed.has(ticket.id)).toBe(false);
      for (const ticket of page.items) observed.add(ticket.id);
      if (!page.hasMore) break;
      page = (
        await agent.read(
          `/v1/orgs/${agent.orgId}/tickets?limit=100&cursor=${encodeURIComponent(page.nextCursor!)}`,
          "PageTicket",
        )
      ).body;
    }
    for (const ticket of created) expect(observed.has(ticket.ticket.id)).toBe(true);
  });

  it("rejects empty text, undeclared diagnostics and revoked access before returning cached retries", async () => {
    for (const body of [
      { ...input(), subject: "  " },
      { ...input(), description: "\n " },
      { ...input(), providerSecret: "forbidden" },
    ])
      await assertProblem(await agent.command(`/v1/orgs/${agent.orgId}/tickets`, body), 422);
    const created = await create(agent);
    try {
      await admin.query(
        "UPDATE app.membership SET status='disabled',row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
        [fixtures.orgA, agent.memberId],
      );
      await assertProblem(await agent.request(`/v1/orgs/${agent.orgId}/tickets/${created.ticket.id}`), 403);
      await assertProblem(
        await agent.command(`/v1/orgs/${agent.orgId}/tickets`, created.body, { key: created.key }),
        403,
      );
    } finally {
      await admin.query(
        "UPDATE app.membership SET status='active',row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
        [fixtures.orgA, agent.memberId],
      );
    }
  });
});

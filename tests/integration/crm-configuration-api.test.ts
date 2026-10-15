import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ApiSession, assertContract, assertProblem } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
const tagIds = new Set<string>();
const sourceIds = new Set<string>();
const keys = new Set<string>();

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
});
afterEach(async () => {
  if (tagIds.size)
    await admin.query("DELETE FROM app.tag WHERE id=ANY($1::uuid[])", [[...tagIds]]);
  if (sourceIds.size)
    await admin.query("DELETE FROM app.lead_source WHERE id=ANY($1::uuid[])", [[...sourceIds]]);
  if (keys.size)
    await admin.query("DELETE FROM app.idempotency_record WHERE key=ANY($1::text[])", [[...keys]]);
  tagIds.clear();
  sourceIds.clear();
  keys.clear();
});
afterAll(async () => {
  await admin.end();
});

function cmd(resource: string, body: unknown, opts: { method?: string; revision?: string } = {}) {
  const key = randomUUID();
  keys.add(key);
  return owner.command(`/v1/orgs/${owner.orgId}/${resource}`, body, { key, ...opts });
}

describe("tags CRUD", () => {
  it("creates and lists tags with contract-valid structure", async () => {
    const name = `Synthetic tag ${randomUUID()}`;
    const created = await cmd("tags", { name });
    expect(created.status).toBe(201);
    const tag = await created.json();
    assertContract("Tag", tag);
    tagIds.add(tag.id);
    expect(tag.name).toBe(name);
    expect(tag.version).toBe(1);

    const list = await owner.read(`/v1/orgs/${owner.orgId}/tags`, "PageTag");
    expect(list.body.items.length).toBeGreaterThan(0);
    expect(typeof list.body.hasMore).toBe("boolean");
    const found = list.body.items.find((t: { id: string }) => t.id === tag.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe(name);
  });

  it("returns a single tag by id", async () => {
    const name = `Synthetic tag detail ${randomUUID()}`;
    const created = await cmd("tags", { name });
    const tag = await created.json();
    tagIds.add(tag.id);

    const detail = await owner.read(`/v1/orgs/${owner.orgId}/tags/${tag.id}`, "Tag");
    expect(detail.body.id).toBe(tag.id);
    expect(detail.body.name).toBe(name);
  });

  it("updates a tag with optimistic concurrency", async () => {
    const created = await cmd("tags", { name: `Synthetic tag update ${randomUUID()}` });
    const tag = await created.json();
    tagIds.add(tag.id);

    const newName = `Updated tag ${randomUUID()}`;
    const updated = await cmd(`tags/${tag.id}`, { name: newName }, {
      method: "PATCH",
      revision: `"${tag.version}"`,
    });
    expect(updated.status).toBe(200);
    const body = await updated.json();
    assertContract("Tag", body);
    expect(body.name).toBe(newName);
    expect(body.version).toBe(tag.version + 1);
  });

  it("rejects stale tag revision", async () => {
    const created = await cmd("tags", { name: `Synthetic tag stale ${randomUUID()}` });
    const tag = await created.json();
    tagIds.add(tag.id);

    await cmd(`tags/${tag.id}`, { name: `Updated ${randomUUID()}` }, {
      method: "PATCH",
      revision: `"${tag.version}"`,
    });
    await assertProblem(
      await cmd(`tags/${tag.id}`, { name: "Stale write" }, {
        method: "PATCH",
        revision: `"${tag.version}"`,
      }),
      412,
    );
  });

  it("rejects empty tag name", async () => {
    await assertProblem(await cmd("tags", { name: "   " }), 422);
  });

  it("rejects unknown tag id", async () => {
    await assertProblem(await owner.request(`/v1/orgs/${owner.orgId}/tags/${randomUUID()}`), 404);
  });
});

describe("lead-sources CRUD", () => {
  it("creates and lists lead sources with contract-valid structure", async () => {
    const code = `synth-${randomUUID().slice(0, 8)}`;
    const label = `Synthetic source ${randomUUID()}`;
    const created = await cmd("lead-sources", { code, label });
    expect(created.status).toBe(201);
    const source = await created.json();
    assertContract("LeadSource", source);
    sourceIds.add(source.id);
    expect(source.code).toBe(code);
    expect(source.label).toBe(label);
    expect(source.version).toBe(1);

    const list = await owner.read(`/v1/orgs/${owner.orgId}/lead-sources`, "PageLeadSource");
    expect(list.body.items.length).toBeGreaterThan(0);
    const found = list.body.items.find((s: { id: string }) => s.id === source.id);
    expect(found).toBeDefined();
  });

  it("returns a single lead source by id", async () => {
    const code = `synth-${randomUUID().slice(0, 8)}`;
    const created = await cmd("lead-sources", { code, label: `Detail source ${randomUUID()}` });
    const source = await created.json();
    sourceIds.add(source.id);

    const detail = await owner.read(`/v1/orgs/${owner.orgId}/lead-sources/${source.id}`, "LeadSource");
    expect(detail.body.id).toBe(source.id);
    expect(detail.body.code).toBe(code);
  });

  it("updates label but rejects code change", async () => {
    const code = `synth-${randomUUID().slice(0, 8)}`;
    const created = await cmd("lead-sources", { code, label: `Update source ${randomUUID()}` });
    const source = await created.json();
    sourceIds.add(source.id);

    const newLabel = `Updated label ${randomUUID()}`;
    const updated = await cmd(`lead-sources/${source.id}`, { code, label: newLabel }, {
      method: "PATCH",
      revision: `"${source.version}"`,
    });
    expect(updated.status).toBe(200);
    const body = await updated.json();
    assertContract("LeadSource", body);
    expect(body.label).toBe(newLabel);

    await assertProblem(
      await cmd(`lead-sources/${source.id}`, { code: "different-code", label: newLabel }, {
        method: "PATCH",
        revision: `"${body.version}"`,
      }),
      422,
    );
  });

  it("rejects invalid source code format", async () => {
    await assertProblem(
      await cmd("lead-sources", { code: "INVALID CODE!", label: "Bad code" }),
      422,
    );
  });

  it("rejects empty label", async () => {
    await assertProblem(
      await cmd("lead-sources", { code: `synth-${randomUUID().slice(0, 8)}`, label: "   " }),
      422,
    );
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ApiSession, assertContract, assertProblem, type Schemas } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
const officeIds = new Set<string>();
const profileIds = new Set<string>();
const keys = new Set<string>();

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
});
afterEach(async () => {
  if (officeIds.size) {
    await admin.query("DELETE FROM app.office_member WHERE office_id=ANY($1::uuid[])", [[...officeIds]]);
    await admin.query(
      "DELETE FROM app.audit_event WHERE resource_id=ANY($1::text[]) AND resource_type='office'",
      [[...officeIds]],
    );
    await admin.query("DELETE FROM app.office WHERE id=ANY($1::uuid[])", [[...officeIds]]);
  }
  if (profileIds.size) {
    await admin.query(
      "DELETE FROM app.audit_event WHERE resource_id=ANY($1::text[]) AND resource_type='business_profile'",
      [[...profileIds]],
    );
    await admin.query("DELETE FROM app.business_profile WHERE id=ANY($1::uuid[])", [[...profileIds]]);
  }
  if (keys.size)
    await admin.query("DELETE FROM app.idempotency_record WHERE key=ANY($1::text[])", [[...keys]]);
  officeIds.clear();
  profileIds.clear();
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

describe("offices CRUD", () => {
  it("creates and lists offices with contract-valid structure", async () => {
    const input: Schemas["OfficeWrite"] = {
      name: `Synthetic office ${randomUUID()}`,
      timezone: "America/Chicago",
    };
    const created = await cmd("offices", input);
    expect(created.status).toBe(201);
    const office = await created.json();
    assertContract("Office", office);
    officeIds.add(office.id);
    expect(office.name).toBe(input.name);
    expect(office.timezone).toBe("America/Chicago");
    expect(office.version).toBe(1);

    const list = await owner.read(`/v1/orgs/${owner.orgId}/offices`, "PageOffice");
    expect(list.body.items.length).toBeGreaterThan(0);
    const found = list.body.items.find((o: { id: string }) => o.id === office.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe(input.name);
  });

  it("returns a single office by id", async () => {
    const created = await cmd("offices", { name: `Detail office ${randomUUID()}`, timezone: "UTC" });
    const office = await created.json();
    officeIds.add(office.id);

    const detail = await owner.read(`/v1/orgs/${owner.orgId}/offices/${office.id}`, "Office");
    expect(detail.body.id).toBe(office.id);
    expect(detail.body.timezone).toBe("UTC");
  });

  it("updates an office with optimistic concurrency", async () => {
    const created = await cmd("offices", { name: `Update office ${randomUUID()}`, timezone: "UTC" });
    const office = await created.json();
    officeIds.add(office.id);

    const newName = `Updated office ${randomUUID()}`;
    const updated = await cmd(
      `offices/${office.id}`,
      { name: newName, timezone: "America/New_York" },
      {
        method: "PATCH",
        revision: `"${office.version}"`,
      },
    );
    expect(updated.status).toBe(200);
    const body = await updated.json();
    assertContract("Office", body);
    expect(body.name).toBe(newName);
    expect(body.timezone).toBe("America/New_York");
    expect(body.version).toBe(2);
  });

  it("rejects invalid timezone", async () => {
    await assertProblem(
      await cmd("offices", { name: `Bad tz office ${randomUUID()}`, timezone: "Not/A/Zone" }),
      422,
    );
  });

  it("rejects empty name", async () => {
    await assertProblem(await cmd("offices", { name: "   ", timezone: "UTC" }), 422);
  });

  it("rejects unknown office id", async () => {
    await assertProblem(await owner.request(`/v1/orgs/${owner.orgId}/offices/${randomUUID()}`), 404);
  });
});

describe("business-profiles CRUD", () => {
  const brand: Schemas["Brand"] = { primaryColor: "#FF5733", logoAssetId: null, fontToken: "sans" };

  it("creates and lists business profiles", async () => {
    const input: Schemas["BusinessProfileWrite"] = { name: `Synthetic profile ${randomUUID()}`, brand };
    const created = await cmd("business-profiles", input);
    expect(created.status).toBe(201);
    const profile = await created.json();
    assertContract("BusinessProfile", profile);
    profileIds.add(profile.id);
    expect(profile.name).toBe(input.name);
    expect(profile.version).toBe(1);

    const list = await owner.read(
      `/v1/orgs/${owner.orgId}/business-profiles?limit=100`,
      "PageBusinessProfile",
    );
    expect(list.body.items.length).toBeGreaterThan(0);
    const found = list.body.items.find((p: { id: string }) => p.id === profile.id);
    expect(found).toBeDefined();
  });

  it("returns a single profile by id", async () => {
    const created = await cmd("business-profiles", { name: `Detail profile ${randomUUID()}`, brand });
    const profile = await created.json();
    profileIds.add(profile.id);

    const detail = await owner.read(
      `/v1/orgs/${owner.orgId}/business-profiles/${profile.id}`,
      "BusinessProfile",
    );
    expect(detail.body.id).toBe(profile.id);
  });

  it("updates a profile with optimistic concurrency", async () => {
    const created = await cmd("business-profiles", { name: `Update profile ${randomUUID()}`, brand });
    const profile = await created.json();
    profileIds.add(profile.id);

    const newName = `Updated profile ${randomUUID()}`;
    const updated = await cmd(
      `business-profiles/${profile.id}`,
      {
        name: newName,
        brand: { ...brand, primaryColor: "#00FF00" },
      },
      { method: "PATCH", revision: `"${profile.version}"` },
    );
    expect(updated.status).toBe(200);
    const body = await updated.json();
    assertContract("BusinessProfile", body);
    expect(body.name).toBe(newName);
    expect(body.version).toBe(2);
  });

  it("rejects logo asset id (media module unavailable)", async () => {
    await assertProblem(
      await cmd("business-profiles", {
        name: `Logo profile ${randomUUID()}`,
        brand: { primaryColor: "#000000", logoAssetId: randomUUID(), fontToken: "serif" },
      }),
      422,
    );
  });

  it("accepts optional website URL", async () => {
    const created = await cmd("business-profiles", {
      name: `Website profile ${randomUUID()}`,
      websiteUrl: "https://example.com",
      brand,
    });
    expect(created.status).toBe(201);
    const profile = await created.json();
    profileIds.add(profile.id);
    expect(profile.websiteUrl).toBe("https://example.com");
  });

  it("rejects non-http website URL", async () => {
    await assertProblem(
      await cmd("business-profiles", {
        name: `Bad URL profile ${randomUUID()}`,
        websiteUrl: "ftp://example.com",
        brand,
      }),
      422,
    );
  });
});

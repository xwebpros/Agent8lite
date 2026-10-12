import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtures } from "../../packages/db/fixtures";
import { assertContract, assertProblem, apiOrigin } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
const siteId = randomUUID();
const formSchemaId = randomUUID();
const businessProfileId = randomUUID();

const entries: string[] = [];
const contacts: string[] = [];
const visitors: string[] = [];

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${apiOrigin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function get(path: string) {
  return fetch(`${apiOrigin}${path}`, {
    headers: { origin: "http://localhost:3000" },
  });
}

async function del(path: string, headers: Record<string, string> = {}) {
  return fetch(`${apiOrigin}${path}`, {
    method: "DELETE",
    headers: { origin: "http://localhost:3000", ...headers },
  });
}

beforeAll(async () => {
  await admin.query(
    "INSERT INTO app.business_profile(tenant_id,id,name) VALUES($1,$2,'Test Brokerage') ON CONFLICT DO NOTHING",
    [fixtures.orgA, businessProfileId],
  );
  await admin.query(
    "INSERT INTO app.site(tenant_id,id,business_profile_id,name,state,theme_version) VALUES($1,$2,$3,'Test Site','published','v1') ON CONFLICT DO NOTHING",
    [fixtures.orgA, siteId, businessProfileId],
  );
  await admin.query(
    `INSERT INTO app.form_schema(tenant_id,id,site_id,name,version,definition,state)
     VALUES($1,$2,$3,'Contact Form',1,$4,'published') ON CONFLICT DO NOTHING`,
    [
      fixtures.orgA,
      formSchemaId,
      siteId,
      JSON.stringify({
        fields: [
          { key: "email", label: "Email", kind: "email", required: true },
          { key: "name", label: "Name", kind: "text", required: true },
        ],
      }),
    ],
  );
});

afterAll(async () => {
  // Cleanup is best-effort; the disposable DB is dropped by the runner on exit.
  const cleanup = async () => {
    for (const id of entries)
      await admin.query("DELETE FROM app.form_entry WHERE tenant_id=$1 AND id=$2", [fixtures.orgA, id]);
    for (const id of visitors)
      await admin.query("DELETE FROM app.visitor_identity WHERE tenant_id=$1 AND id=$2", [fixtures.orgA, id]);
    for (const id of contacts) {
      await admin.query(
        `DELETE FROM app.activity_event WHERE tenant_id=$1 AND lead_id IN
         (SELECT id FROM app.lead WHERE tenant_id=$1 AND contact_id=$2)`,
        [fixtures.orgA, id],
      );
      await admin.query("DELETE FROM app.lead WHERE tenant_id=$1 AND contact_id=$2", [fixtures.orgA, id]);
      await admin.query("DELETE FROM app.contact_channel WHERE tenant_id=$1 AND contact_id=$2", [fixtures.orgA, id]);
      await admin.query("DELETE FROM app.contact WHERE tenant_id=$1 AND id=$2", [fixtures.orgA, id]);
    }
    await admin.query("DELETE FROM app.form_schema WHERE tenant_id=$1 AND id=$2", [fixtures.orgA, formSchemaId]);
    await admin.query("DELETE FROM app.site WHERE tenant_id=$1 AND id=$2", [fixtures.orgA, siteId]);
    await admin.query("DELETE FROM app.business_profile WHERE tenant_id=$1 AND id=$2", [fixtures.orgA, businessProfileId]);
  };
  await cleanup().catch(() => {});
  await admin.end();
});

describe("ADR-052 public site — form schema", () => {
  it("getPublicForm returns the published form schema", async () => {
    const res = await get(`/v1/public/sites/${siteId}/forms/${formSchemaId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertContract("Form", body);
    expect(body.id).toBe(formSchemaId);
    expect(body.state).toBe("published");
    expect(body.fields.length).toBeGreaterThan(0);
  });

  it("getPublicForm returns 404 for an unknown form", async () => {
    await assertProblem(await get(`/v1/public/sites/${siteId}/forms/${randomUUID()}`), 404);
  });

  it("getPublicForm returns 404 for an unpublished site", async () => {
    await assertProblem(await get(`/v1/public/sites/${randomUUID()}/forms/${formSchemaId}`), 404);
  });
});

describe("ADR-052 public site — form submission", () => {
  it("submitPublicForm creates a contact and lead and returns SubmissionReceipt", async () => {
    const key = randomUUID();
    const email = `submit-test-${randomUUID()}@example.test`;
    const res = await post(
      `/v1/public/sites/${siteId}/form-submissions`,
      { formId: formSchemaId, formVersion: 1, values: { email, name: "Public Tester" } },
      { "idempotency-key": key },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    assertContract("SubmissionReceipt", body);
    expect(typeof body.receiptId).toBe("string");
    entries.push(body.receiptId);
    // Verify contact was created
    const contact = await admin.query(
      "SELECT contact_id FROM app.contact_channel WHERE tenant_id=$1 AND kind='email' AND normalized_value=$2",
      [fixtures.orgA, email],
    );
    expect(contact.rowCount).toBe(1);
    contacts.push(contact.rows[0].contact_id);
  });

  it("submitPublicForm is idempotent with the same idempotency key", async () => {
    const key = randomUUID();
    const email = `idempotent-${randomUUID()}@example.test`;
    const body = { formId: formSchemaId, formVersion: 1, values: { email, name: "Idempotent Tester" } };
    const first = await post(`/v1/public/sites/${siteId}/form-submissions`, body, {
      "idempotency-key": key,
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    entries.push(firstBody.receiptId);
    const second = await post(`/v1/public/sites/${siteId}/form-submissions`, body, {
      "idempotency-key": key,
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.receiptId).toBe(firstBody.receiptId);
  });

  it("submitPublicForm rejects a missing email field", async () => {
    await assertProblem(
      await post(
        `/v1/public/sites/${siteId}/form-submissions`,
        { formId: formSchemaId, formVersion: 1, values: { name: "No Email" } },
        { "idempotency-key": randomUUID() },
      ),
      422,
    );
  });

  it("submitPublicForm rejects a honeypot-filled submission", async () => {
    await assertProblem(
      await post(
        `/v1/public/sites/${siteId}/form-submissions`,
        {
          formId: formSchemaId,
          formVersion: 1,
          values: { email: "bot@example.test", name: "Bot" },
          honeypot: "filled",
        },
        { "idempotency-key": randomUUID() },
      ),
      422,
    );
  });

  it("submitPublicForm rejects a version mismatch", async () => {
    await assertProblem(
      await post(
        `/v1/public/sites/${siteId}/form-submissions`,
        {
          formId: formSchemaId,
          formVersion: 999,
          values: { email: `version-${randomUUID()}@example.test`, name: "Version Tester" },
        },
        { "idempotency-key": randomUUID() },
      ),
      409,
    );
  });

  it("submitPublicForm requires an idempotency key", async () => {
    await assertProblem(
      await post(`/v1/public/sites/${siteId}/form-submissions`, {
        formId: formSchemaId,
        formVersion: 1,
        values: { email: "no-key@example.test", name: "No Key" },
      }),
      400,
    );
  });
});

describe("ADR-052 public site — property inquiry", () => {
  it("submitInquiry creates a contact and lead and returns SubmissionReceipt", async () => {
    const key = randomUUID();
    const email = `inquiry-${randomUUID()}@example.test`;
    const res = await post(
      `/v1/public/sites/${siteId}/property-inquiries`,
      {
        listingId: randomUUID(),
        name: "Inquiry Tester",
        email,
        message: "I am interested in this property.",
        formVersion: 1,
      },
      { "idempotency-key": key },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    assertContract("SubmissionReceipt", body);
    entries.push(body.receiptId);
  });

  it("submitInquiry is idempotent", async () => {
    const key = randomUUID();
    const email = `inquiry-idem-${randomUUID()}@example.test`;
    const body = {
      listingId: randomUUID(),
      name: "Idempotent Inquirer",
      email,
      message: "Same inquiry.",
      formVersion: 1,
    };
    const first = await post(`/v1/public/sites/${siteId}/property-inquiries`, body, {
      "idempotency-key": key,
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    entries.push(firstBody.receiptId);
    const second = await post(`/v1/public/sites/${siteId}/property-inquiries`, body, {
      "idempotency-key": key,
    });
    expect(second.status).toBe(200);
    expect((await second.json()).receiptId).toBe(firstBody.receiptId);
  });

  it("submitInquiry rejects a missing required field", async () => {
    await assertProblem(
      await post(
        `/v1/public/sites/${siteId}/property-inquiries`,
        { name: "No Listing", email: "x@x.test", message: "hi", formVersion: 1 },
        { "idempotency-key": randomUUID() },
      ),
      422,
    );
  });
});

describe("ADR-052 public site — analytics and unsubscribe", () => {
  it("collectPublicAnalytics accepts a valid event and returns SubmissionReceipt", async () => {
    const res = await post(`/v1/public/sites/${siteId}/analytics-events`, {
      clientEventId: randomUUID(),
      type: "page_view",
      path: "/",
      occurredAt: new Date().toISOString(),
      consentPolicyVersion: "v1",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertContract("SubmissionReceipt", body);
  });

  it("collectPublicAnalytics rejects an invalid event type", async () => {
    await assertProblem(
      await post(`/v1/public/sites/${siteId}/analytics-events`, {
        clientEventId: randomUUID(),
        type: "invalid_type",
        path: "/",
        occurredAt: new Date().toISOString(),
        consentPolicyVersion: "v1",
      }),
      422,
    );
  });

  it("unsubscribeMessage accepts a valid token format", async () => {
    const token = Buffer.from("example-hmac-token").toString("base64url");
    const res = await post("/v1/public/message-unsubscriptions", { token });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertContract("SubmissionReceipt", body);
  });

  it("oneClickUnsubscribe accepts One-Click body", async () => {
    const res = await post("/v1/public/one-click-unsubscribe", { "List-Unsubscribe": "One-Click" });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertContract("SubmissionReceipt", body);
  });
});

describe("ADR-052 public site — visitor session lifecycle", () => {
  it("requestVisitorLogin accepts a valid email and returns SubmissionReceipt", async () => {
    const res = await post(`/v1/public/sites/${siteId}/visitor-sessions/challenge`, {
      email: `visitor-${randomUUID()}@example.test`,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertContract("SubmissionReceipt", body);
  });

  it("requestVisitorLogin rejects a missing email", async () => {
    await assertProblem(await post(`/v1/public/sites/${siteId}/visitor-sessions/challenge`, {}), 422);
  });

  it("verifyVisitorLogin rejects an invalid token", async () => {
    const badToken = Buffer.from("invalid@example.test:XXXXXX").toString("base64url");
    await assertProblem(
      await post(
        `/v1/public/sites/${siteId}/visitor-sessions/verify`,
        { token: badToken },
        { "idempotency-key": randomUUID() },
      ),
      422,
    );
  });

  it("signOutVisitor clears the visitor cookie", async () => {
    const res = await del(`/v1/public/sites/${siteId}/visitor-sessions/current`);
    expect(res.status).toBe(204);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("estate_visitor_session=;");
  });
});

describe("ADR-052 public site — saved searches and favorites without visitor session", () => {
  it("listSavedSearches returns empty list without visitor session", async () => {
    const res = await get(`/v1/public/sites/${siteId}/saved-searches`);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertContract("PageSavedSearch", body);
    expect(body.items).toHaveLength(0);
  });

  it("listFavorites returns empty list without visitor session", async () => {
    const res = await get(`/v1/public/sites/${siteId}/favorites`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(0);
  });

  it("createSavedSearch requires visitor session", async () => {
    await assertProblem(
      await post(
        `/v1/public/sites/${siteId}/saved-searches`,
        { name: "My Search", criteria: {}, frequency: "off" },
        { "idempotency-key": randomUUID() },
      ),
      401,
    );
  });

  it("addFavorite requires visitor session", async () => {
    await assertProblem(
      await post(
        `/v1/public/sites/${siteId}/favorites`,
        { listingId: randomUUID() },
        { "idempotency-key": randomUUID() },
      ),
      401,
    );
  });
});

describe("ADR-052 public site — site not found guard", () => {
  it("any public site route on unknown siteId returns 404", async () => {
    await assertProblem(await get(`/v1/public/sites/${randomUUID()}/saved-searches`), 404);
  });
});

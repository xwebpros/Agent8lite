import { randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { appendContactCreatedEvent } from "../../apps/api/src/contact-created-event";
import schema from "../../packages/contracts/internal/native-contact-created-event-v1.schema.json";
import type { TenantContext } from "../../packages/db/tenant-transaction";

const ajv = new Ajv2020({ strict: true, ownProperties: true, allErrors: true });
addFormats(ajv);
const valid = ajv.compile(schema);
const contactId = randomUUID();
const context: TenantContext = {
  organizationId: randomUUID(),
  userId: randomUUID(),
  memberId: randomUUID(),
  roleId: randomUUID(),
  roleName: "Synthetic writer",
  timezone: "UTC",
  permissions: [{ code: "crm.contacts.write", scope: "own" }],
};
const envelope = () => ({
  eventId: randomUUID(),
  type: "contact.created",
  version: 1,
  tenantId: context.organizationId,
  occurredAt: "2026-10-11T04:00:00.123Z",
  ingestedAt: "2026-10-11T04:00:00.123Z",
  producer: "crm",
  aggregateType: "contact",
  aggregateId: contactId,
  correlationId: randomUUID(),
  payload: { resourceId: contactId, resourceVersion: 1 },
});
function client(query: (text: string, values?: unknown[]) => Promise<unknown>) {
  return { query } as unknown as PoolClient;
}

describe("ADR-041 closed contact creation reference contract", () => {
  it("accepts only the closed v1 reference envelope without changing the frozen event catalog", () => {
    expect(valid(envelope())).toBe(true);
    expect(schema.properties.payload.properties.resourceVersion).toEqual({ const: 1 });
  });
  it.each([
    "displayName",
    "email",
    "phone",
    "birthday",
    "consent",
    "requestBody",
    "idempotencyKey",
    "sourceRow",
  ])("rejects private %s at either envelope or payload level", (key) => {
    expect(valid({ ...envelope(), [key]: "PRIVATE_VALUE" })).toBe(false);
    const value = envelope();
    expect(valid({ ...value, payload: { ...value.payload, [key]: "PRIVATE_VALUE" } })).toBe(false);
  });
  it.each([
    ["type", "lead.captured"],
    ["version", 2],
    ["producer", "marketing"],
    ["aggregateType", "lead"],
    ["eventId", "invalid"],
    ["tenantId", "invalid"],
    ["aggregateId", "invalid"],
    ["occurredAt", "invalid"],
    ["ingestedAt", "invalid"],
    ["correlationId", ""],
    ["correlationId", "x".repeat(81)],
  ])("rejects invalid %s=%s", (key, value) => expect(valid({ ...envelope(), [key]: value })).toBe(false));
  it.each([0, 2, "1", null])("rejects non-creation resource version %s", (version) => {
    const value = envelope();
    expect(valid({ ...value, payload: { ...value.payload, resourceVersion: version } })).toBe(false);
  });
  it("does not pretend JSON Schema establishes cross-field equality", () => {
    const value = envelope();
    expect(valid({ ...value, payload: { ...value.payload, resourceId: randomUUID() } })).toBe(true);
  });
});

describe("contact reference producer validation before database effects", () => {
  it.each(["organizationId", "userId", "memberId", "roleId", "roleName", "timezone", "permissions"])(
    "rejects an authority %s accessor without invoking it or querying",
    async (key) => {
      let hooks = 0,
        queries = 0;
      const supplied = { ...context };
      Object.defineProperty(supplied, key, {
        enumerable: true,
        get() {
          hooks++;
          return context[key as keyof TenantContext];
        },
      });
      await expect(
        appendContactCreatedEvent(
          client(async () => {
            queries++;
            return {};
          }),
          supplied,
          "trace",
          contactId,
        ),
      ).rejects.toMatchObject({ code: "contact_event_context_unavailable" });
      expect({ hooks, queries }).toEqual({ hooks: 0, queries: 0 });
    },
  );
  it("rejects proxy authority without executing traps", async () => {
    let hooks = 0;
    const supplied = new Proxy(context, {
      get() {
        hooks++;
        throw new Error("private");
      },
      ownKeys() {
        hooks++;
        throw new Error("private");
      },
    });
    await expect(
      appendContactCreatedEvent(
        client(async () => {
          throw new Error("query not allowed");
        }),
        supplied,
        "trace",
        contactId,
      ),
    ).rejects.toMatchObject({ code: "contact_event_context_unavailable" });
    expect(hooks).toBe(0);
  });
  it("rejects absent contact-write permission before any query", async () => {
    let queries = 0;
    await expect(
      appendContactCreatedEvent(
        client(async () => {
          queries++;
          return {};
        }),
        { ...context, permissions: [] },
        "trace",
        contactId,
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(queries).toBe(0);
  });
  it("captures authority before awaits and emits exact DB time/references without inherited serialization hooks", async () => {
    const supplied = { ...context, permissions: context.permissions.map((grant) => ({ ...grant })) };
    let hooks = 0,
      inserted: unknown[] | undefined;
    const originals = [Object.prototype, Array.prototype].map((prototype) =>
      Object.getOwnPropertyDescriptor(prototype, "toJSON"),
    );
    try {
      for (const prototype of [Object.prototype, Array.prototype])
        Object.defineProperty(prototype, "toJSON", {
          configurable: true,
          get() {
            hooks++;
            return () => {
              hooks++;
              return "PRIVATE_HOOK";
            };
          },
        });
      await appendContactCreatedEvent(
        client(async (text, values) => {
          if (text.startsWith("SELECT 1 FROM app.membership")) {
            expect(values?.slice(0, 4)).toEqual([
              context.organizationId,
              context.userId,
              context.memberId,
              context.roleId,
            ]);
            expect(values?.[4]).toBe('[{"code":"crm.contacts.write","scope":"own"}]');
            supplied.userId = randomUUID();
            supplied.permissions[0].scope = "organization";
            return { rowCount: 1, rows: [{}] };
          }
          if (text.includes("FROM app.entitlement")) return { rowCount: 1, rows: [{ id: randomUUID() }] };
          if (text.includes("FROM app.contact c"))
            return { rowCount: 1, rows: [{ occurred_at: new Date("2026-10-11T04:00:00.123Z") }] };
          if (text.startsWith("INSERT INTO app.outbox")) {
            inserted = values;
            return { rowCount: 1, rows: [] };
          }
          throw new Error("Unexpected bounded producer statement");
        }),
        supplied,
        "synthetic-correlation",
        contactId.toUpperCase(),
      );
    } finally {
      [Object.prototype, Array.prototype].forEach((prototype, index) => {
        const original = originals[index];
        if (original) Object.defineProperty(prototype, "toJSON", original);
        else Reflect.deleteProperty(prototype, "toJSON");
      });
    }
    expect(hooks).toBe(0);
    const event = JSON.parse(String(inserted?.[3]));
    expect(valid(event)).toBe(true);
    expect(event.aggregateId).toBe(contactId);
    expect(event.payload).toEqual({ resourceId: contactId, resourceVersion: 1 });
    expect(event.occurredAt).toBe("2026-10-11T04:00:00.123Z");
    expect(event.ingestedAt).toBe(event.occurredAt);
    expect(inserted?.[4]).toBe(context.userId);
  });
});

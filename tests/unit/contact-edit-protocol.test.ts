import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContactEditProtocol,
  contactEditContext,
  contactEditRetryWindowMs,
  requireContactEditContact,
  requireContactEditWrite,
} from "../../apps/web/components/contact-edit";
import { ApiError, type Schema } from "../../apps/web/lib/api";
import { CrmService } from "../../apps/api/src/crm-service";
import type { PoolClient } from "pg";
import type { TenantContext } from "../../packages/db/tenant-transaction";

const id = "dc000000-0000-4000-8000-000000000001",
  key = "dc000000-0000-4000-8000-000000000002";
const context = "verified-user/org/member/csrf/access/permissions";
function write(): Schema<"ContactWrite"> {
  return {
    displayName: " Original name ",
    emails: ["FIRST@example.test", "second@example.test", "first@example.test"],
    phones: ["+1 (555) 333-4444", "+15553334444"],
    birthday: null,
  };
}
function contact(): Schema<"Contact"> {
  return {
    id,
    displayName: "Original name",
    emails: ["second@example.test", "first@example.test"],
    phones: ["+15553334444"],
    birthday: null,
    version: 8,
  };
}
function setup(body: Schema<"ContactWrite"> = write()) {
  let wall = 1000000,
    monotonic = 1000;
  const protocol = new ContactEditProtocol({ wallNow: () => wall, monotonicNow: () => monotonic });
  protocol.bind(context);
  const command = protocol.begin({ contactId: id, version: 7, body }, key);
  return {
    protocol,
    command,
    body,
    clocks: (w: number, m: number) => {
      wall = w;
      monotonic = m;
    },
  };
}
afterEach(() => vi.restoreAllMocks());

describe("immutable contact PATCH snapshot and exact normalization", () => {
  it("retains original bytes/key/version and detached frozen fields before any await", () => {
    const { protocol, command, body } = setup();
    const original = JSON.stringify(body);
    body.displayName = "later";
    body.emails![0] = "later@example.test";
    expect(command.serializedBody).toBe(original);
    expect(command.body.displayName).toBe(" Original name ");
    expect(command.body.emails![0]).toBe("FIRST@example.test");
    expect(command).toMatchObject({
      context,
      contactId: id,
      version: 7,
      key,
      firstWall: 1000000,
      firstMonotonic: 1000,
    });
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.body)).toBe(true);
    expect(Object.isFrozen(command.body.emails)).toBe(true);
    expect(protocol.getSnapshot()).toEqual({ phase: "sending", command });
    expect(() => protocol.begin({ contactId: id, version: 8, body: write() }, key)).toThrow();
    expect(() => protocol.retry()).toThrow();
  });
  it("acknowledges same UUID/name and normalized unique channel sets independent of source order", () => {
    const { protocol, command } = setup();
    expect(protocol.acknowledge(command, contact(), '"8"')).toBe(true);
    expect(protocol.getSnapshot()).toEqual({ phase: "acknowledged", command: null });
    expect(protocol.isCurrent(command)).toBe(false);
  });
  it("accepts database lowercase UUID from an original uppercase ID without changing original input", () => {
    const protocol = new ContactEditProtocol();
    protocol.bind(context);
    const command = protocol.begin({ contactId: id.toUpperCase(), version: 7, body: write() }, key);
    expect(protocol.acknowledge(command, contact(), '"8"')).toBe(true);
    expect(command.contactId).toBe(id.toUpperCase());
  });
  it("compares only supplied optional fields and does not infer omitted channel/birthday clearing", () => {
    const { protocol, command } = setup({ displayName: " Original name " });
    expect(
      protocol.acknowledge(
        command,
        {
          ...contact(),
          birthday: "2000-02-29",
          emails: ["preserved@example.test"],
          phones: ["+15558889999"],
        },
        '"8"',
      ),
    ).toBe(true);
    expect(Object.hasOwn(command.body, "birthday")).toBe(false);
    expect(Object.hasOwn(command.body, "emails")).toBe(false);
  });
  it("explicit empty channels and birthday null require matching clearing receipts", () => {
    const { protocol, command } = setup({
      displayName: " Original name ",
      emails: [],
      phones: [],
      birthday: null,
    });
    expect(protocol.acknowledge(command, contact(), '"8"')).toBe(false);
    const original = protocol.retry();
    expect(protocol.acknowledge(original, { ...contact(), emails: [], phones: [] }, '"8"')).toBe(true);
  });
  it("a supplied nullable birthday remains unverified when the receipt omits that field", () => {
    const { protocol, command } = setup({ displayName: " Original name ", birthday: null });
    const receipt = contact();
    Reflect.deleteProperty(receipt, "birthday");
    expect(protocol.acknowledge(command, receipt, '"8"')).toBe(false);
    expect(protocol.getSnapshot()).toEqual({ command, phase: "unknown" });
  });
  it.each([
    "id",
    "name",
    "email",
    "phone",
    "birthday",
    "version",
    "extra",
    "etag",
    "weak",
    "missing",
  ] as const)("retains uncertain command after a mismatching receipt %s", (kind) => {
    const { protocol, command } = setup(),
      receipt = contact() as Schema<"Contact"> & { extra?: string };
    let etag: string | null = '"8"';
    if (kind === "id") receipt.id = key;
    if (kind === "name") receipt.displayName = "changed";
    if (kind === "email") receipt.emails = ["wrong@example.test"];
    if (kind === "phone") receipt.phones = ["+15551112222"];
    if (kind === "birthday") receipt.birthday = "2000-02-29";
    if (kind === "version") receipt.version = 9;
    if (kind === "extra") receipt.extra = "PRIVATE";
    if (kind === "etag") etag = '"9"';
    if (kind === "weak") etag = 'W/"8"';
    if (kind === "missing") etag = null;
    expect(protocol.acknowledge(command, receipt, etag)).toBe(false);
    expect(protocol.getSnapshot()).toEqual({ phase: "unknown", command });
    expect(protocol.retry()).toBe(command);
  });
  it.each([
    {},
    null,
    { displayName: "" },
    { displayName: "x", extra: true },
    { displayName: "x", emails: ["invalid"] },
    { displayName: "x", phones: ["BAD"] },
    { displayName: "x", birthday: "2001-02-29" },
  ])("rejects invalid frozen write before creating a command case%#", (body) => {
    const protocol = new ContactEditProtocol();
    protocol.bind(context);
    expect(() =>
      protocol.begin({ contactId: id, version: 1, body: body as Schema<"ContactWrite"> }, key),
    ).toThrow();
    expect(protocol.getSnapshot().command).toBeNull();
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER, Infinity, NaN])(
    "rejects unsafe original revision%s",
    (version) => {
      const protocol = new ContactEditProtocol();
      protocol.bind(context);
      expect(() => protocol.begin({ contactId: id, version, body: write() }, key)).toThrow();
    },
  );
  it("does not execute accessor input or retain sparse/extraneous arrays", () => {
    let hooks = 0;
    const body = Object.defineProperty({}, "displayName", {
      enumerable: true,
      get() {
        hooks++;
        return "PRIVATE";
      },
    });
    expect(() => requireContactEditWrite(body)).toThrow();
    expect(hooks).toBe(0);
    expect(() => requireContactEditWrite({ displayName: "x", emails: new Array(1) })).toThrow();
    const channels = ["email@example.test"];
    Object.assign(channels, { extra: "PRIVATE" });
    expect(() => requireContactEditWrite({ displayName: "x", emails: channels })).toThrow();
  });
  it.each(["object-getter", "array-getter", "object-function", "array-function"] as const)(
    "does not consult inherited snapshot/receipt hooks %s",
    (kind) => {
      const prototype = kind.startsWith("array") ? Array.prototype : Object.prototype,
        previous = Object.getOwnPropertyDescriptor(prototype, "toJSON");
      let hooks = 0,
        acknowledged = false,
        serialized = "";
      try {
        Object.defineProperty(
          prototype,
          "toJSON",
          kind.endsWith("getter")
            ? {
                configurable: true,
                get() {
                  hooks++;
                  return undefined;
                },
              }
            : {
                configurable: true,
                value() {
                  hooks++;
                  return null;
                },
              },
        );
        const { protocol, command } = setup();
        serialized = command.serializedBody;
        acknowledged = protocol.acknowledge(command, contact(), '"8"');
      } finally {
        if (previous) Object.defineProperty(prototype, "toJSON", previous);
        else Reflect.deleteProperty(prototype, "toJSON");
      }
      expect(hooks).toBe(0);
      expect(acknowledged).toBe(true);
      expect(JSON.parse(serialized)).toEqual(write());
    },
  );
  it("closed current-contact data never treats unsafe revision or unsupported metadata as verified", () => {
    for (const value of [
      { ...contact(), version: Number.MAX_SAFE_INTEGER + 1 },
      { ...contact(), extra: "PRIVATE" },
      { ...contact(), displayName: "" },
    ])
      expect(() => requireContactEditContact(value)).toThrow();
  });
  it("direct keyless legacy contact-update entry denies before any database call", async () => {
    const query = vi.fn(),
      service = new CrmService({ query } as unknown as PoolClient, {} as TenantContext, "owned-no-db");
    await expect(service.update("contacts", id, write(), '"7"')).rejects.toMatchObject({
      status: 503,
      code: "contact_command_required",
    });
    expect(query).not.toHaveBeenCalled();
  });
});

describe("unknown outcomes, conservative horizon and current complete binding", () => {
  it.each([
    new TypeError("network"),
    new SyntaxError("interrupted JSON"),
    new ApiError(408, "timeout"),
    new ApiError(500, "failed"),
    new ApiError(503, "unavailable"),
  ])("keeps ambiguous initial outcome case%# and retries the exact same object", (error) => {
    const { protocol, command } = setup();
    expect(protocol.reject(command, error)).toBe("unknown");
    expect(protocol.retry()).toBe(command);
    expect(protocol.getSnapshot()).toEqual({ phase: "sending", command });
  });
  it.each([400, 404, 409, 412, 422, 429])(
    "initial definitive%d releases without falsely acknowledging",
    (status) => {
      const { protocol, command } = setup();
      expect(protocol.reject(command, new ApiError(status, "rejected"))).toBe("cleared");
      expect(protocol.getSnapshot()).toEqual({
        command: null,
        phase: status === 412 ? "conflict" : "rejected",
      });
    },
  );
  it.each([400, 404, 409, 412, 422, 429])(
    "a later%d rejection cannot establish the original unknown attempt failed",
    (status) => {
      const { protocol, command } = setup();
      protocol.reject(command, new TypeError("unknown"));
      const retained = protocol.retry();
      expect(protocol.reject(retained, new ApiError(status, "retry rejected"))).toBe("unknown");
      expect(protocol.getSnapshot()).toEqual({ command, phase: "unknown" });
    },
  );
  it.each([401, 403])("current%d denial clears private data without claiming saved", (status) => {
    const { protocol, command } = setup();
    expect(protocol.reject(command, new ApiError(status, "denied"))).toBe("cleared");
    expect(protocol.getSnapshot()).toEqual({ command: null, phase: "denied" });
    expect(protocol.acknowledge(command, contact(), '"8"')).toBe(false);
  });
  it("uses both wall and monotonic elapsed clocks at the exact23-hour boundary", () => {
    const { protocol, command, clocks } = setup();
    protocol.reject(command, new TypeError("unknown"));
    clocks(1000000 + contactEditRetryWindowMs - 1, 1000 + contactEditRetryWindowMs - 1);
    expect(protocol.canRetry()).toBe(true);
    clocks(1000000 + contactEditRetryWindowMs, 1000);
    expect(protocol.canRetry()).toBe(false);
    clocks(1000000, 1000 + contactEditRetryWindowMs);
    expect(protocol.canRetry()).toBe(false);
    expect(() => protocol.retry()).toThrow();
    expect(protocol.getSnapshot()).toEqual({ command, phase: "unknown" });
  });
  it.each([
    [999999, 1000],
    [1000000, 999],
    [NaN, 1000],
    [1000000, Infinity],
    [-1, 1000],
  ] as const)(
    "invalid/backwards clocks stop resend but retain unconfirmed input case%#",
    (wall, monotonic) => {
      const { protocol, command, clocks } = setup();
      protocol.reject(command, new TypeError("unknown"));
      clocks(wall, monotonic);
      expect(protocol.canRetry()).toBe(false);
      expect(() => protocol.retry()).toThrow();
      expect(protocol.getSnapshot().command).toBe(command);
    },
  );
  it.each([null, "", "different verified context"])(
    "context cut%s invalidates retained callbacks at begin/retry/acknowledgment",
    (next) => {
      const { protocol, command } = setup();
      protocol.reject(command, new TypeError("unknown"));
      protocol.bind(next);
      expect(protocol.isBoundTo(context)).toBe(false);
      expect(protocol.isCurrent(command)).toBe(false);
      expect(protocol.getSnapshot()).toEqual({ command: null, phase: "idle" });
      expect(() => protocol.retry()).toThrow();
      expect(protocol.acknowledge(command, contact(), '"8"')).toBe(false);
      expect(protocol.reject(command, new ApiError(503, "late"))).toBe("ignored");
    },
  );
  it("binds user/org/member/CSRF/access revision/full permissions and rejects missing current grants", () => {
    const session = {
      userId: id,
      activeOrgId: key,
      permissions: ["crm.contacts.read", "crm.contacts.write", "dashboard.read"],
    } as Schema<"Session">;
    const input = { session, memberId: id, csrf: "synthetic-csrf", accessRevision: 1 },
      binding = contactEditContext(input);
    expect(binding).not.toBeNull();
    for (const changed of [
      { ...input, memberId: key },
      { ...input, csrf: "rotated" },
      { ...input, accessRevision: 2 },
      { ...input, session: { ...session, userId: key } },
      { ...input, session: { ...session, activeOrgId: id } },
      { ...input, session: { ...session, permissions: ["crm.contacts.read", "crm.contacts.write"] } },
    ])
      expect(contactEditContext(changed)).not.toBe(binding);
    for (const changed of [
      { ...input, session: null },
      { ...input, csrf: "" },
      { ...input, session: { ...session, permissions: ["crm.contacts.read"] } },
      { ...input, session: { ...session, permissions: ["crm.contacts.write"] } },
    ])
      expect(contactEditContext(changed)).toBeNull();
    expect(
      contactEditContext({
        ...input,
        session: { ...session, permissions: [...session.permissions].reverse() },
      }),
    ).toBe(binding);
  });
});

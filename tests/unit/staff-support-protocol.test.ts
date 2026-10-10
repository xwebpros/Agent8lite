import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  StaffSupportLifetime,
  canReconcileSupportCommand,
  commandAccessUnchanged,
  parseStrongSupportEtag,
  pendingSupportJob,
  selectionMatchesCurrent,
  snapshotSupportClear,
  snapshotSupportGrant,
  snapshotSupportRevoke,
  snapshotSupportSelection,
  supportAccessIdentity,
  supportCommandFailure,
  supportContextUnexpired,
  supportReadPermissions,
  verifyStaffSupportSession,
  verifySupportGrantReceipt,
} from "../../apps/web/components/staff-support-protocol";
import type { components } from "../../packages/contracts/generated/api";
import type {
  SyntheticStaffSessionResponse,
  SyntheticSupportSelection,
} from "../../packages/contracts/internal/control-plane-port";
import staffSchema from "../../packages/contracts/internal/synthetic-staff-v1.schema.json";
import openapi from "../../packages/contracts/openapi.json";
import catalogue from "../../packages/contracts/permission-catalog.json";

type Schemas = components["schemas"];
const staffId = "00000000-0000-4000-8000-000000000001";
const organizationId = "00000000-0000-4000-8000-000000000002";
const grantId = "00000000-0000-4000-8000-000000000003";
const jobId = "00000000-0000-4000-8000-000000000004";
const anotherId = "00000000-0000-4000-8000-000000000005";
const now = Date.parse("2026-10-10T10:00:00.000Z");
const expiresAt = "2026-10-10T10:30:00.000Z";
const originalKey = "original-command-key";
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const frozenSession = ajv.compile({ ...staffSchema, $ref: "#/$defs/SessionResponse" });
const frozenJob = ajv.compile({ components: openapi.components, $ref: "#/components/schemas/Job" });
const frozenGrant = ajv.compile(openapi.components.schemas.AccessGrant);
const session = (active = false): SyntheticStaffSessionResponse => ({
  staffUserId: staffId,
  permissions: ["platform.orgs.read", "platform.support.grant"],
  synthetic: true,
  supportContext: active
    ? {
        organizationId,
        accessGrantId: grantId,
        permissions: ["crm.contacts.read", "crm.leads.read"],
        reason: "<strong>Approved synthetic troubleshooting</strong>",
        expiresAt,
      }
    : null,
});
const selection = (): SyntheticSupportSelection => ({ organizationId, accessGrantId: grantId });
const grant = (): Schemas["AccessGrant"] => ({
  staffUserId: anotherId,
  permissions: ["crm.contacts.read", "crm.leads.read"],
  reason: "Reviewed synthetic investigation",
  expiresAt,
});
const job = (state: Schemas["Job"]["state"] = "succeeded"): Schemas["Job"] => ({
  id: jobId,
  kind: "staff.support.grant",
  state,
  createdAt: "2026-10-10T09:59:00.000Z",
  resultUrl: null,
});
const grantHeaders = () =>
  new Headers({ "X-Synthetic-Support-Grant-Id": grantId, "X-Synthetic-Support-Grant-ETag": '"3"' });
const sessionHeaders = (state = "none", csrf = "opaque-session-csrf") => {
  const headers = state === "active" ? grantHeaders() : new Headers();
  headers.set("X-CSRF-Token", csrf);
  headers.set("X-Synthetic-Support-State", state);
  return headers;
};
const lifetime = () => {
  const state = new StaffSupportLifetime();
  state.acceptSession(state.beginRequest(), session(), sessionHeaders(), now);
  return state;
};
const adopt = (state: StaffSupportLifetime, value: SyntheticStaffSessionResponse, headers: Headers) =>
  state.acceptSession(state.beginRequest(), value, headers, now);

describe("synthetic support protocol boundaries", () => {
  it("uses the frozen staff projection and only the seven approved catalogue reads", () => {
    expect(frozenSession(session(true))).toBe(true);
    const view = verifyStaffSupportSession(session(true), sessionHeaders("active"), now);
    expect(view.session).toEqual(session(true));
    expect(view.grant).toEqual({ grantId, grantEtag: '"3"' });
    expect(view.session.supportContext?.reason).toBe(session(true).supportContext?.reason);
    expect(Object.isFrozen(view.session.supportContext?.permissions)).toBe(true);
    const codes = catalogue.codes.map((item) => item.code);
    expect(supportReadPermissions).toHaveLength(7);
    expect(supportReadPermissions.every((code) => codes.includes(code))).toBe(true);
  });

  it.each(["none", "stale"])("%s keeps staff identity but removes grant projection and metadata", (state) => {
    const view = verifyStaffSupportSession(session(), sessionHeaders(state), now);
    expect(view.supportState).toBe(state);
    expect(view.session.staffUserId).toBe(staffId);
    expect(view.session.supportContext).toBeNull();
    expect(view.grant).toBeNull();
    expect(supportContextUnexpired(view, now)).toBe(false);
    expect(() => verifyStaffSupportSession(session(true), sessionHeaders(state), now)).toThrow();
    for (const name of ["X-Synthetic-Support-Grant-Id", "X-Synthetic-Support-Grant-ETag"]) {
      const headers = sessionHeaders(state);
      headers.set(name, name.endsWith("Id") ? grantId : '"3"');
      expect(() => verifyStaffSupportSession(session(), headers, now)).toThrow();
    }
  });

  it.each([
    ["missing current support state", null],
    ["invented support state", "authorized"],
    ["case-changed state", "ACTIVE"],
  ])("rejects %s", (_label, state) => {
    const headers = sessionHeaders();
    if (state === null) headers.delete("X-Synthetic-Support-State");
    else headers.set("X-Synthetic-Support-State", state);
    expect(() => verifyStaffSupportSession(session(), headers, now)).toThrow();
  });

  it("rejects malformed identity, customer membership fields and unverified CSRF", () => {
    for (const value of [
      { ...session(), synthetic: false },
      { ...session(), activeOrgId: organizationId },
      { ...session(), staffUserId: "owner" },
      { ...session(), permissions: ["platform.orgs.read", "platform.orgs.read"] },
      Object.create(session()),
    ])
      expect(() => verifyStaffSupportSession(value, sessionHeaders(), now)).toThrow();
    const headers = sessionHeaders();
    headers.delete("X-CSRF-Token");
    expect(() => verifyStaffSupportSession(session(), headers, now)).toThrow();
  });

  it("rejects missing, mismatched, expired or writable selected context", () => {
    const active = session(true);
    for (const value of [
      session(),
      { ...active, supportContext: { ...active.supportContext!, accessGrantId: anotherId } },
      { ...active, supportContext: { ...active.supportContext!, permissions: ["crm.contacts.write"] } },
      { ...active, supportContext: { ...active.supportContext!, permissions: ["crm.notes.read"] } },
      { ...active, supportContext: { ...active.supportContext!, reason: "   " } },
      { ...active, supportContext: { ...active.supportContext!, expiresAt: "2026-02-30T11:00:00Z" } },
      { ...active, supportContext: { ...active.supportContext!, expiresAt: new Date(now).toISOString() } },
    ])
      expect(() => verifyStaffSupportSession(value, sessionHeaders("active"), now)).toThrow();
    const headers = sessionHeaders("active");
    headers.delete("X-Synthetic-Support-Grant-ETag");
    expect(() => verifyStaffSupportSession(active, headers, now)).toThrow();
    expect(() => verifyStaffSupportSession(active, sessionHeaders("active"), Number.NaN)).toThrow();
  });

  it("stops displaying an expired selection without rewriting its original expiry", () => {
    const view = verifyStaffSupportSession(session(true), sessionHeaders("active"), now);
    expect(supportContextUnexpired(view, now)).toBe(true);
    expect(supportContextUnexpired(view, Date.parse(expiresAt))).toBe(false);
    expect(view.session.supportContext?.expiresAt).toBe(expiresAt);
  });

  it.each([
    null,
    "",
    "3",
    'W/"3"',
    '"0"',
    '"03"',
    '"-1"',
    '"1.5"',
    '"1", "2"',
    "*",
    ' "3"',
    '"9007199254740992"',
  ])("rejects ambiguous or unsafe version %s", (value) => {
    expect(() => parseStrongSupportEtag(value)).toThrow();
  });
  it("retains strong numeric grant versions exactly", () => {
    expect(parseStrongSupportEtag('"1"')).toBe('"1"');
    expect(parseStrongSupportEtag('"9007199254740991"')).toBe('"9007199254740991"');
  });

  it("keeps Job transport metadata distinct from the current grant version", () => {
    const headers = grantHeaders();
    headers.set("ETag", '"91"');
    const receipt = verifySupportGrantReceipt(job(), headers, "staff.support.grant", jobId);
    expect(frozenJob(receipt.job)).toBe(true);
    expect(receipt.jobEtag).toBe('"91"');
    expect(receipt.grant.grantEtag).toBe('"3"');
    expect(receipt.job).not.toHaveProperty("version");
    expect(verifySupportGrantReceipt(job(), grantHeaders(), "staff.support.grant").jobEtag).toBeNull();
    headers.set("ETag", '"opaque-job-transport-reference"');
    expect(verifySupportGrantReceipt(job(), headers, "staff.support.grant").jobEtag).toBe(
      '"opaque-job-transport-reference"',
    );
    headers.set("ETag", 'W/"91"');
    expect(() => verifySupportGrantReceipt(job(), headers, "staff.support.grant")).toThrow();
  });

  it("rejects a mismatched job, foreign kind or added grant body fields", () => {
    for (const value of [
      { ...job(), id: anotherId },
      { ...job(), kind: "organization.provision" },
      { ...job(), accessGrantId: grantId },
      { ...job(), version: 3 },
      { ...job(), state: "complete" },
      { ...job(), error: { secret: "hidden tenant data" } },
      Object.create(job()),
    ])
      expect(() => verifySupportGrantReceipt(value, grantHeaders(), "staff.support.grant", jobId)).toThrow();
    const revoke = { ...job(), kind: "staff.support.revoke" };
    expect(verifySupportGrantReceipt(revoke, grantHeaders(), "staff.support.revoke").job).toEqual(revoke);
    expect(() => verifySupportGrantReceipt(job(), new Headers(), "staff.support.grant")).toThrow();
  });

  it.each(["queued", "running", "unknown"] as const)(
    "retains %s as pending rather than completed",
    (state) => {
      const receipt = verifySupportGrantReceipt(job(state), grantHeaders(), "staff.support.grant");
      expect(pendingSupportJob(receipt.job)).toBe(true);
    },
  );
  it.each(["succeeded", "failed", "cancelled"] as const)(
    "recognizes terminal %s without inferring eligibility",
    (state) => {
      expect(pendingSupportJob(job(state))).toBe(false);
      expect(verifySupportGrantReceipt(job(state), grantHeaders(), "staff.support.grant").job.state).toBe(
        state,
      );
      expect(
        selectionMatchesCurrent(
          verifyStaffSupportSession(session(), sessionHeaders(), now),
          selection(),
          now,
        ),
      ).toBe(false);
    },
  );
});

describe("memory-only support command lifetime", () => {
  it("retains detached immutable input and original key while context changes", () => {
    const state = lifetime();
    const input = { ...selection() };
    const command = snapshotSupportSelection(state, input, originalKey);
    input.accessGrantId = anotherId;
    const generation = state.generation;
    const revision = state.accessRevision;
    adopt(state, session(true), sessionHeaders("active"));
    expect(state.generation).toBe(generation);
    expect(state.accessRevision).toBeGreaterThan(revision);
    expect(canReconcileSupportCommand(state, command)).toBe(true);
    expect(commandAccessUnchanged(state, command)).toBe(false);
    expect(command.input.accessGrantId).toBe(grantId);
    expect(command.idempotencyKey).toBe(originalKey);
    expect(Object.isFrozen(command.input)).toBe(true);
    expect(selectionMatchesCurrent(state.current!, command.input, now)).toBe(true);
  });

  it("an old-key acknowledgement can describe a different current context without restoring its input", () => {
    const state = lifetime();
    const command = snapshotSupportSelection(state, selection(), originalKey);
    const other: SyntheticStaffSessionResponse = {
      ...session(true),
      supportContext: { ...session(true).supportContext!, accessGrantId: anotherId },
    };
    const headers = sessionHeaders("active");
    headers.set("X-Synthetic-Support-Grant-Id", anotherId);
    adopt(state, other, headers);
    expect(canReconcileSupportCommand(state, command)).toBe(true);
    expect(selectionMatchesCurrent(state.current!, command.input, now)).toBe(false);
    expect(state.current?.session.supportContext?.accessGrantId).toBe(anotherId);
    expect(command.input.accessGrantId).toBe(grantId);
  });

  it("ignores late and duplicated responses before validating or exposing their projection", () => {
    const state = lifetime();
    const older = state.beginRequest();
    const newer = state.beginRequest();
    const current = state.acceptSession(newer, session(true), sessionHeaders("active"), now);
    expect(current?.supportState).toBe("active");
    expect(state.acceptSession(older, { private: "late malformed payload" }, new Headers(), now)).toBeNull();
    expect(state.acceptSession(newer, session(), sessionHeaders(), now)).toBeNull();
    expect(state.current).toBe(current);
  });

  it("an older401/403/session failure cannot invalidate a newer verified selection or identity", () => {
    const state = lifetime();
    const command = snapshotSupportSelection(state, selection(), originalKey);
    const oldRead = state.beginRequest();
    const newSelection = state.beginRequest();
    state.acceptSession(newSelection, session(true), sessionHeaders("active"), now);
    expect(state.isCurrentRequest(oldRead)).toBe(false);
    for (const status of [401, 403, 503]) {
      if (state.isCurrentRequest(oldRead) && supportCommandFailure(status) === "invalidate")
        state.invalidate();
      expect(state.current?.supportState).toBe("active");
      expect(canReconcileSupportCommand(state, command)).toBe(true);
    }
    const oldIdentityRead = state.beginRequest();
    adopt(state, session(), sessionHeaders("none", "new-opaque-csrf"));
    expect(state.isCurrentRequest(oldIdentityRead)).toBe(false);
    expect(state.current?.csrf).toBe("new-opaque-csrf");
    expect(canReconcileSupportCommand(state, command)).toBe(false);
  });

  it.each(["csrf", "identity", "logout", "issue", "loss"])(
    "invalidates commands across %s changes",
    (change) => {
      const state = lifetime();
      const command = snapshotSupportClear(state, originalKey);
      const oldResponse = state.beginRequest();
      if (change === "csrf") adopt(state, session(), sessionHeaders("none", "replacement-session-csrf"));
      else if (change === "identity")
        adopt(state, { ...session(), staffUserId: anotherId }, sessionHeaders());
      else state.invalidate();
      expect(canReconcileSupportCommand(state, command)).toBe(false);
      expect(state.acceptSession(oldResponse, session(true), sessionHeaders("active"), now)).toBeNull();
      expect(command.idempotencyKey).toBe(originalKey);
    },
  );

  it("permission changes invalidate access identity without discarding an uncertain opaque-session command", () => {
    const state = lifetime();
    const command = snapshotSupportClear(state, originalKey);
    adopt(state, { ...session(), permissions: ["platform.orgs.read"] }, sessionHeaders());
    expect(canReconcileSupportCommand(state, command)).toBe(true);
    expect(commandAccessUnchanged(state, command)).toBe(false);
    expect(supportAccessIdentity(state.current!)).not.toBe(command.accessIdentity);
  });

  it("fails closed on an unverifiable acknowledgement yet retains the key for same-session recovery", () => {
    const state = lifetime();
    const command = snapshotSupportSelection(state, selection(), originalKey);
    const generation = state.generation;
    expect(() => state.acceptSession(state.beginRequest(), session(true), sessionHeaders(), now)).toThrow();
    expect(state.current).toBeNull();
    expect(state.generation).toBe(generation);
    expect(canReconcileSupportCommand(state, command)).toBe(false);
    adopt(state, session(true), sessionHeaders("active"));
    expect(canReconcileSupportCommand(state, command)).toBe(true);
    expect(command.idempotencyKey).toBe(originalKey);
  });

  it("unverifies a mismatched projection, rejects late responses and recovers only the same opaque lifetime", () => {
    const state = lifetime();
    const command = snapshotSupportSelection(state, selection(), originalKey);
    const late = state.beginRequest();
    const generation = state.generation;
    state.unverify();
    expect(state.current).toBeNull();
    expect(state.generation).toBe(generation);
    expect(canReconcileSupportCommand(state, command)).toBe(false);
    expect(state.acceptSession(late, session(true), sessionHeaders("active"), now)).toBeNull();
    adopt(state, session(), sessionHeaders());
    expect(canReconcileSupportCommand(state, command)).toBe(true);
    expect(command.idempotencyKey).toBe(originalKey);
    state.unverify();
    adopt(state, session(), sessionHeaders("none", "replacement-session-csrf"));
    expect(canReconcileSupportCommand(state, command)).toBe(false);
  });

  it("does not erase a stored grant request expiry or revoke If-Match on receipt refresh", () => {
    const state = lifetime();
    const input = grant();
    expect(frozenGrant(input)).toBe(true);
    const create = snapshotSupportGrant(state, organizationId, input, originalKey);
    input.expiresAt = "2026-10-10T11:00:00.000Z";
    input.permissions.push("crm.tasks.read");
    const revoke = snapshotSupportRevoke(
      state,
      organizationId,
      { grantId, grantEtag: '"3"' },
      "original-revoke-key",
    );
    const headers = grantHeaders();
    headers.set("X-Synthetic-Support-Grant-ETag", '"4"');
    const newer = verifySupportGrantReceipt(job(), headers, "staff.support.grant");
    expect(newer.grant.grantEtag).toBe('"4"');
    expect(revoke.grant.grantEtag).toBe('"3"');
    expect(create.input.expiresAt).toBe(expiresAt);
    expect(create.input.permissions).toEqual(["crm.contacts.read", "crm.leads.read"]);
    expect(Object.isFrozen(create.input.permissions)).toBe(true);
  });

  it("rejects extra selection fields, writable grants, duplicate permissions, empty reasons and bad keys", () => {
    const state = lifetime();
    expect(() =>
      snapshotSupportSelection(
        state,
        { ...selection(), memberId: anotherId } as SyntheticSupportSelection,
        originalKey,
      ),
    ).toThrow();
    for (const input of [
      { ...grant(), permissions: ["crm.contacts.write"] },
      { ...grant(), permissions: ["crm.contacts.read", "crm.contacts.read"] },
      { ...grant(), permissions: [] },
      { ...grant(), reason: "   " },
      { ...grant(), ownerMemberId: anotherId },
    ])
      expect(() => snapshotSupportGrant(state, organizationId, input, originalKey)).toThrow();
    for (const key of ["", "   ", "x".repeat(101), "key\nheader"])
      expect(() => snapshotSupportClear(state, key)).toThrow();
    expect(() => snapshotSupportClear(new StaffSupportLifetime(), originalKey)).toThrow();
    expect(() =>
      snapshotSupportRevoke(state, organizationId, { grantId, grantEtag: 'W/"3"' }, originalKey),
    ).toThrow();
  });

  it("does not invoke inherited or accessor-shaped data while validating commands", () => {
    const state = lifetime();
    let reads = 0;
    const malicious = Object.defineProperty({ ...grant() }, "reason", {
      get: () => {
        reads++;
        return "reason";
      },
    });
    expect(() => snapshotSupportGrant(state, organizationId, malicious, originalKey)).toThrow();
    const permissions = ["crm.contacts.read"];
    Object.defineProperty(permissions, "0", {
      get: () => {
        reads++;
        return "crm.contacts.read";
      },
    });
    expect(() =>
      snapshotSupportGrant(state, organizationId, { ...grant(), permissions }, originalKey),
    ).toThrow();
    expect(reads).toBe(0);
  });

  it("bounds cyclic, deeply nested, sparse, excessive-node and oversized acknowledgements without losing the original command", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let deep: unknown = "leaf";
    for (let index = 0; index < 100; index++) deep = { child: deep };
    const sparse = new Array(5);
    const many = Array.from({ length: 20_001 }, () => 1);
    const oversized = "界".repeat(100_000);
    for (const malformed of [cycle, deep, sparse, many, oversized]) {
      const state = lifetime();
      const command = snapshotSupportClear(state, originalKey);
      const generation = state.generation;
      let failure: unknown;
      try {
        state.acceptSession(state.beginRequest(), { ...session(), malformed }, sessionHeaders(), now);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(RangeError);
      expect(state.current).toBeNull();
      expect(state.generation).toBe(generation);
      adopt(state, session(), sessionHeaders());
      expect(canReconcileSupportCommand(state, command)).toBe(true);
      expect(command.idempotencyKey).toBe(originalKey);
    }
  });

  it("requires actual clear state, not a stale or historical selection acknowledgement", () => {
    expect(
      selectionMatchesCurrent(verifyStaffSupportSession(session(), sessionHeaders(), now), null, now),
    ).toBe(true);
    expect(
      selectionMatchesCurrent(verifyStaffSupportSession(session(), sessionHeaders("stale"), now), null, now),
    ).toBe(false);
    expect(
      selectionMatchesCurrent(
        verifyStaffSupportSession(session(true), sessionHeaders("active"), now),
        null,
        now,
      ),
    ).toBe(false);
  });

  it.each([
    [undefined, "uncertain"],
    [503, "uncertain"],
    [408, "uncertain"],
    [401, "invalidate"],
    [403, "invalidate"],
    [409, "review-current"],
    [412, "review-current"],
    [400, "rejected"],
    [404, "rejected"],
    [422, "rejected"],
    [429, "rejected"],
  ] as const)("classifies %s without creating a replacement command key", (status, expected) => {
    expect(supportCommandFailure(status)).toBe(expected);
    const state = lifetime();
    const command = snapshotSupportClear(state, originalKey);
    if (expected === "invalidate") state.invalidate();
    expect(command.idempotencyKey).toBe(originalKey);
    expect(canReconcileSupportCommand(state, command)).toBe(expected !== "invalidate");
  });
});

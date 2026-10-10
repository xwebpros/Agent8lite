import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  pendingStaffJob,
  staffContextKey,
  validStaffJobId,
  verifyOrganizationPage,
  verifyStaffJob,
  verifyStaffSession,
} from "../../apps/web/components/staff-console-protocol";
import type { components } from "../../packages/contracts/generated/api";
import type { SyntheticStaffSessionResponse } from "../../packages/contracts/internal/control-plane-port";
import staffSchema from "../../packages/contracts/internal/synthetic-staff-v1.schema.json";
import openapi from "../../packages/contracts/openapi.json";

type Schemas = components["schemas"];
const staffId = "00000000-0000-4000-8000-000000000001";
const organizationId = "00000000-0000-4000-8000-000000000002";
const grantId = "00000000-0000-4000-8000-000000000003";
const jobId = "00000000-0000-4000-8000-000000000004";
const anotherId = "00000000-0000-4000-8000-000000000005";
const instant = "2026-10-10T10:30:00.000Z";
const csrf = "synthetic-csrf-value";
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const frozenSession = ajv.compile({ ...staffSchema, $ref: "#/$defs/SessionResponse" });
const frozenPage = ajv.compile({
  components: openapi.components,
  $ref: "#/components/schemas/PageOrganization",
});
const frozenJob = ajv.compile({ components: openapi.components, $ref: "#/components/schemas/Job" });

const session = (): SyntheticStaffSessionResponse => ({
  staffUserId: staffId,
  permissions: ["platform.orgs.read", "platform.orgs.provision"],
  synthetic: true,
  supportContext: null,
});
const supportSession = (): SyntheticStaffSessionResponse => ({
  ...session(),
  supportContext: {
    organizationId,
    accessGrantId: grantId,
    permissions: ["crm.contacts.read", "crm.leads.read"],
    reason: "Approved synthetic troubleshooting",
    expiresAt: instant,
  },
});
const job = (state: Schemas["Job"]["state"] = "queued"): Schemas["Job"] => ({
  id: jobId,
  kind: "organization.provision",
  state,
  createdAt: instant,
  resultUrl: null,
});
const organization = (): Schemas["Organization"] => ({
  id: organizationId,
  name: "Synthetic brokerage",
  status: "provisioning",
  timezone: "America/Los_Angeles",
  locale: "en-US",
  version: 1,
});
const page = (): Schemas["PageOrganization"] => ({
  items: [organization()],
  nextCursor: null,
  hasMore: false,
});
const checkSession = (value: unknown, token: string | null = csrf) =>
  verifyStaffSession(value as SyntheticStaffSessionResponse, token);
const checkJob = (value: unknown) => verifyStaffJob(value as Schemas["Job"], jobId);
const checkPage = (value: unknown) => verifyOrganizationPage(value as Schemas["PageOrganization"]);

describe("synthetic staff console protocol", () => {
  it("accepts only the approved staff projection with a separately supplied CSRF value", () => {
    expect(frozenSession(session())).toBe(true);
    expect(frozenSession(supportSession())).toBe(true);
    expect(checkSession(session())).toEqual(session());
    expect(checkSession(supportSession())).toEqual(supportSession());
    for (const token of [null, "", "x".repeat(4097)]) expect(() => checkSession(session(), token)).toThrow();
    expect(() => checkSession({ userId: staffId, activeOrgId: organizationId, permissions: [] })).toThrow();
  });

  it.each([
    ["synthetic false", { ...session(), synthetic: false }],
    ["synthetic string", { ...session(), synthetic: "true" }],
    ["malformed staff ID", { ...session(), staffUserId: "owner" }],
    ["duplicate permission", { ...session(), permissions: ["platform.orgs.read", "platform.orgs.read"] }],
    [
      "excess permissions",
      { ...session(), permissions: Array.from({ length: 21 }, (_, index) => `p${index}`) },
    ],
    ["long permission", { ...session(), permissions: ["x".repeat(101)] }],
    ["foreign authority field", { ...session(), organizationId }],
    ["missing support context", { staffUserId: staffId, permissions: [], synthetic: true }],
  ])("rejects %s using the committed closed session contract", (_label, value) => {
    expect(frozenSession(value)).toBe(false);
    expect(() => checkSession(value)).toThrow();
  });

  it.each([
    ["malformed organization", { ...supportSession().supportContext!, organizationId: "tenant" }],
    ["malformed grant", { ...supportSession().supportContext!, accessGrantId: "all" }],
    ["empty permission projection", { ...supportSession().supportContext!, permissions: [] }],
    [
      "duplicate support permission",
      { ...supportSession().supportContext!, permissions: ["crm.contacts.read", "crm.contacts.read"] },
    ],
    ["unknown context authority", { ...supportSession().supportContext!, writable: true }],
    ["missing grant reason", { ...supportSession().supportContext!, reason: "" }],
    ["non date-time expiry", { ...supportSession().supportContext!, expiresAt: "2026-10-10" }],
    ["impossible expiry", { ...supportSession().supportContext!, expiresAt: "2026-02-30T10:30:00Z" }],
  ])("rejects %s before binding the selected support context", (_label, supportContext) => {
    const value = { ...session(), supportContext };
    expect(frozenSession(value)).toBe(false);
    expect(() => checkSession(value)).toThrow();
  });

  it("does not accept inherited or array-shaped identity authority", () => {
    expect(() => checkSession(Object.create(session()))).toThrow();
    expect(() => checkSession(Object.assign([], session()))).toThrow();
  });

  it("binds all access-bearing identity fields while canonicalizing permission and object order", () => {
    const original = supportSession();
    const context = original.supportContext!;
    const key = staffContextKey(original);
    const reordered: SyntheticStaffSessionResponse = {
      ...original,
      permissions: [...original.permissions].reverse(),
      supportContext: {
        expiresAt: context.expiresAt,
        reason: context.reason,
        permissions: [...context.permissions].reverse(),
        accessGrantId: context.accessGrantId,
        organizationId: context.organizationId,
      },
    };
    expect(staffContextKey(reordered)).toBe(key);
    expect(original.permissions).toEqual(session().permissions);
    expect(context.permissions).toEqual(supportSession().supportContext!.permissions);
    for (const changed of [
      { ...original, staffUserId: anotherId },
      { ...original, permissions: ["platform.orgs.read"] },
      { ...original, supportContext: null },
      { ...original, supportContext: { ...context, organizationId: anotherId } },
      { ...original, supportContext: { ...context, accessGrantId: anotherId } },
      { ...original, supportContext: { ...context, permissions: ["crm.contacts.read"] } },
      { ...original, supportContext: { ...context, reason: "Reapproved reason" } },
      { ...original, supportContext: { ...context, expiresAt: "2026-10-10T11:30:00Z" } },
    ])
      expect(staffContextKey(changed)).not.toBe(key);
  });

  it.each(["queued", "running", "unknown", "succeeded", "failed", "cancelled"] as const)(
    "recognizes %s without interpreting a queued or uncertain command as completed",
    (state) => {
      const value = job(state);
      expect(frozenJob(value)).toBe(true);
      expect(checkJob(value)).toEqual(value);
      expect(pendingStaffJob(value)).toBe(["queued", "running", "unknown"].includes(state));
    },
  );

  it("binds requester reconciliation to the exact known provisioning job", () => {
    expect(validStaffJobId(jobId)).toBe(true);
    expect(validStaffJobId("../../session")).toBe(false);
    expect(validStaffJobId(`${jobId}/run`)).toBe(false);
    expect(() => verifyStaffJob(job(), anotherId)).toThrow(/original request/);
    const wrongKind = { ...job(), kind: "billing.change" };
    expect(frozenJob(wrongKind)).toBe(true);
    expect(() => checkJob(wrongKind)).toThrow(/original request/);
  });

  it.each([
    ["unknown state", { ...job(), state: "ready" }],
    ["invalid job identity", { ...job(), id: "latest" }],
    ["date without time", { ...job(), createdAt: "2026-10-10" }],
    ["invalid result URI", { ...job(), resultUrl: "/download" }],
    ["unverified failure detail", { ...job(), error: { detail: "Trust me" } }],
    ["unknown private job field", { ...job(), ownerUserId: staffId }],
  ])("rejects %s rather than discarding or normalizing malformed job metadata", (_label, value) => {
    expect(frozenJob(value)).toBe(false);
    expect(() => checkJob(value)).toThrow(/original request/);
  });

  it("accepts published failure metadata without confusing failure with pending work", () => {
    const value: Schemas["Job"] = {
      ...job("failed"),
      error: {
        type: "https://estate.example/problems/bootstrap",
        title: "Failed",
        status: 409,
        code: "bootstrap_owner_unavailable",
        traceId: "synthetic-trace",
        errors: [{ field: "owner", message: "Unavailable" }],
      },
    };
    expect(frozenJob(value)).toBe(true);
    expect(checkJob(value)).toEqual(value);
    expect(pendingStaffJob(value)).toBe(false);
    const invalid = {
      ...value,
      error: { ...value.error, errors: [{ field: "owner", message: "x".repeat(301) }] },
    };
    expect(frozenJob(invalid)).toBe(false);
    expect(() => checkJob(invalid)).toThrow();
  });

  it("accepts closed organization metadata and a real continuation cursor", () => {
    const value = { ...page(), hasMore: true, nextCursor: "opaque-cursor" };
    expect(frozenPage(value)).toBe(true);
    expect(checkPage(value)).toEqual(value);
    expect(checkPage({ items: [], hasMore: false, nextCursor: null })).toEqual({
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    expect(() => checkPage({ ...page(), hasMore: true })).toThrow();
  });

  it.each([
    ["foreign page field", { ...page(), contacts: [] }],
    ["excess rows", { ...page(), items: Array.from({ length: 101 }, organization) }],
    ["long cursor", { ...page(), nextCursor: "x".repeat(4097) }],
    ["unknown row field", { ...page(), items: [{ ...organization(), memberEmail: "private@example.test" }] }],
    ["long organization name", { ...page(), items: [{ ...organization(), name: "x".repeat(121) }] }],
    ["long timezone", { ...page(), items: [{ ...organization(), timezone: "x".repeat(81) }] }],
    ["long locale", { ...page(), items: [{ ...organization(), locale: "x".repeat(21) }] }],
    [
      "missing locale",
      {
        ...page(),
        items: [{ id: organizationId, name: "Synthetic", status: "active", timezone: "UTC", version: 1 }],
      },
    ],
    ["unknown status", { ...page(), items: [{ ...organization(), status: "ready" }] }],
    ["invalid version", { ...page(), items: [{ ...organization(), version: 0 }] }],
  ])("rejects %s according to the frozen organization projection", (_label, value) => {
    expect(frozenPage(value)).toBe(false);
    expect(() => checkPage(value)).toThrow();
  });
});

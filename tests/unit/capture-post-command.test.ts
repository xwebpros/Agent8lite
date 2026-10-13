import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { leadPostReceipt, prepareCapturePost } from "../../apps/api/src/capture-post-command";
import type { components } from "../../packages/contracts/generated/api";

const org = randomUUID(),
  member = randomUUID();
const body: components["schemas"]["LeadCreate"] = {
  contactId: randomUUID(),
  sourceId: randomUUID(),
  ownerMemberId: member,
  intent: "buyer",
  timeline: "Private timeline retained only in the receipt",
};
const command = prepareCapturePost("leads", body, randomUUID(), `POST /v1/orgs/${org}/leads`, org);
const lead: components["schemas"]["Lead"] = {
  ...body,
  id: randomUUID(),
  stageId: randomUUID(),
  version: 1,
  score: 10,
  scoreVersion: "v1",
};

describe("Lead POST immutable receipt accepts measured scoring and legacy unscored state", () => {
  it.each([0, 10, 100])(
    "retains measured score %s and its bounded version without inventing a value",
    (score) => {
      const value = { ...lead, score };
      expect(leadPostReceipt(value, command, member)).toEqual(value);
      expect(Object.isFrozen(leadPostReceipt(value, command, member))).toBe(true);
    },
  );
  it("retains an old null/null receipt exactly even though a fresh command can now be scored", () => {
    const historical = { ...lead, score: null, scoreVersion: null };
    expect(leadPostReceipt(historical, command, member)).toEqual(historical);
    const { score: _score, scoreVersion: _version, ...oldOptional } = historical;
    expect(leadPostReceipt(oldOptional, command, member)).toEqual(oldOptional);
  });
  it.each([
    { score: -1 },
    { score: 101 },
    { score: Number.NaN },
    { score: Number.POSITIVE_INFINITY },
    { score: "10" },
    { score: 10, scoreVersion: null },
    { score: null, scoreVersion: "v1" },
    { scoreVersion: "" },
    { scoreVersion: "   " },
    { scoreVersion: "v".repeat(81) },
  ])("rejects malformed or unpaired scoring case %#", (patch) => {
    expect(() => leadPostReceipt({ ...lead, ...patch }, command, member)).toThrowError(
      expect.objectContaining({ status: 503, code: "receipt_unavailable" }),
    );
  });
  it.each([
    { id: "not-a-uuid" },
    { contactId: randomUUID() },
    { sourceId: randomUUID() },
    { ownerMemberId: randomUUID() },
    { stageId: "not-a-uuid" },
    { intent: "seller" },
    { timeline: "Wrong timeline" },
    { version: 2 },
    { extra: "Unapproved payload" },
  ])("scoring does not relax exact business-field and generated-contract validation case %#", (patch) => {
    expect(() => leadPostReceipt({ ...lead, ...patch }, command, member)).toThrowError(
      expect.objectContaining({ status: 503, code: "receipt_unavailable" }),
    );
  });
  it("detaches a scored receipt without evaluating an accessor", () => {
    let calls = 0;
    const value = { ...lead };
    Object.defineProperty(value, "score", {
      enumerable: true,
      get: () => {
        calls++;
        return 10;
      },
    });
    expect(() => leadPostReceipt(value, command, member)).toThrowError(
      expect.objectContaining({ status: 503, code: "receipt_unavailable" }),
    );
    expect(calls).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import {
  isCreateModalReady,
  type CreateModalReadiness,
} from "../../apps/web/components/create-modal-readiness";

const ready: CreateModalReadiness = {
  busy: false,
  loading: false,
  detailLoading: false,
  protectedDraftOrCommand: false,
  online: true,
  visible: true,
  memberAvailable: true,
  bindingAvailable: true,
  forgotten: false,
};
describe("lead/task editor creation readiness", () => {
  it("does not advertise creation during the initial workspace or detail read", () => {
    expect(isCreateModalReady({ ...ready, loading: true })).toBe(false);
    expect(isCreateModalReady({ ...ready, detailLoading: true })).toBe(false);
    expect(isCreateModalReady(ready)).toBe(true);
  });
  it("acknowledgement does not release the control before command settlement and current-list refresh", () => {
    expect(isCreateModalReady({ ...ready, busy: true, loading: true })).toBe(false);
    expect(isCreateModalReady({ ...ready, busy: true })).toBe(false);
    expect(isCreateModalReady({ ...ready, loading: true })).toBe(false);
    expect(isCreateModalReady(ready)).toBe(true);
  });
  it("dirty drafts and uncertain commands remain protected after their network work stops", () => {
    expect(isCreateModalReady({ ...ready, protectedDraftOrCommand: true })).toBe(false);
    expect(isCreateModalReady({ ...ready, protectedDraftOrCommand: true, online: false })).toBe(false);
    expect(isCreateModalReady({ ...ready, protectedDraftOrCommand: true, online: true })).toBe(false);
  });
  it("requires current member/binding and cannot restart a forgotten creation protocol", () => {
    expect(isCreateModalReady({ ...ready, memberAvailable: false })).toBe(false);
    expect(isCreateModalReady({ ...ready, bindingAvailable: false })).toBe(false);
    expect(isCreateModalReady({ ...ready, forgotten: true })).toBe(false);
  });
  it("never enables private creation offline or in an inactive view", () => {
    expect(isCreateModalReady({ ...ready, online: false })).toBe(false);
    expect(isCreateModalReady({ ...ready, visible: false })).toBe(false);
  });
});

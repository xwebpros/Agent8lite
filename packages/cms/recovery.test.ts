import { describe, expect, it } from "vitest";
import { requireRevisionRecovery, revisionRecovery, RecoveryEnvelopeError } from "./recovery";

const id = "a2000000-0000-4000-8000-000000000099";
const documentId = "a2000000-0000-4000-8000-000000000010";
function response() {
  return revisionRecovery(
    id,
    documentId,
    {
      schemaVersion: 7,
      blocks: [{ type: "future", original: ["<script>", { keep: true }] }],
      seo: { future: "Keep the original" },
    },
    [{ path: "/schemaVersion", code: "schema_version_unsupported" }],
  );
}

describe("approved closed revision recovery envelope", () => {
  it("preserves unknown JSON in a detached, always-read-only response", () => {
    const original = response();
    const read = requireRevisionRecovery(original);
    expect(read).toEqual(original);
    expect(read).not.toBe(original);
    original.data.seo = { changed: true };
    expect(read.data.seo).toEqual({ future: "Keep the original" });
    expect(read.canSave).toBe(false);
    expect(read.canPublish).toBe(false);
  });
  it.each([
    [
      "save flag",
      (value: Record<string, unknown>) => {
        value.canSave = true;
      },
    ],
    [
      "publish flag",
      (value: Record<string, unknown>) => {
        value.canPublish = true;
      },
    ],
    [
      "extra envelope field",
      (value: Record<string, unknown>) => {
        value.extra = "private";
      },
    ],
    [
      "invalid identity",
      (value: Record<string, unknown>) => {
        value.id = "not-a-uuid";
      },
    ],
    [
      "extra original wrapper field",
      (value: Record<string, unknown>) => {
        (value.data as Record<string, unknown>).extra = true;
      },
    ],
    [
      "invalid version",
      (value: Record<string, unknown>) => {
        (value.data as Record<string, unknown>).schemaVersion = 2147483648;
      },
    ],
    [
      "extra issue field",
      (value: Record<string, unknown>) => {
        value.issues = [{ path: "", code: "safe", body: "private" }];
      },
    ],
    [
      "unsafe issue code",
      (value: Record<string, unknown>) => {
        value.issues = [{ path: "", code: "<script>" }];
      },
    ],
    [
      "long issue code",
      (value: Record<string, unknown>) => {
        value.issues = [{ path: "", code: "x".repeat(101) }];
      },
    ],
    [
      "long issue path",
      (value: Record<string, unknown>) => {
        value.issues = [{ path: "x".repeat(1025), code: "safe" }];
      },
    ],
    [
      "excessive issues",
      (value: Record<string, unknown>) => {
        value.issues = Array.from({ length: 2001 }, () => ({ path: "", code: "safe" }));
      },
    ],
  ] as const)("rejects %s without leaking original content", (_label, change) => {
    const value = response();
    change(value);
    expect(() => requireRevisionRecovery(value)).toThrow(RecoveryEnvelopeError);
    expect(() => requireRevisionRecovery(value)).toThrow("supported limits");
  });
  it("accepts the complete 20,000-node original and 2,000-issue boundaries together", () => {
    const original = { schemaVersion: 7, blocks: Array(19_996).fill(null), seo: null };
    const issues = Array.from({ length: 2000 }, () => ({ path: "", code: "safe" }));
    const read = revisionRecovery(id, documentId, original, issues);
    expect(read.data).toEqual(original);
    expect(read.issues).toHaveLength(2000);
    expect(() =>
      revisionRecovery(id, documentId, { ...original, blocks: Array(19_997).fill(null) }, issues),
    ).toThrow(RecoveryEnvelopeError);
  });
  it("bounds depth before the recursive JSON schema runs", () => {
    let nested: unknown = null;
    for (let index = 0; index < 31; index++) nested = { child: nested };
    const original = { schemaVersion: 7, blocks: [], seo: nested };
    expect(revisionRecovery(id, documentId, original, []).data).toEqual(original);
    expect(() => revisionRecovery(id, documentId, { ...original, seo: { child: nested } }, [])).toThrow(
      RecoveryEnvelopeError,
    );
  });
  it("counts UTF-8 original bytes and rejects excessive transport without shortening diagnostics", () => {
    expect(() =>
      revisionRecovery(id, documentId, { schemaVersion: 7, blocks: [], seo: "界".repeat(90_000) }, []),
    ).toThrow(RecoveryEnvelopeError);
    const issues = Array.from({ length: 1100 }, () => ({ path: "x".repeat(1000), code: "safe" }));
    expect(() => revisionRecovery(id, documentId, { schemaVersion: 7, blocks: [], seo: {} }, issues)).toThrow(
      RecoveryEnvelopeError,
    );
    expect(issues).toHaveLength(1100);
  });
  it("refuses accessors, executable values, cycles and nonfinite numbers before copying", () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, "private", {
      enumerable: true,
      get: () => {
        reads++;
        return "secret";
      },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const seo of [accessor, cyclic, { bad: () => "private" }, { bad: Number.NaN }])
      expect(() => revisionRecovery(id, documentId, { schemaVersion: 7, blocks: [], seo }, [])).toThrow(
        RecoveryEnvelopeError,
      );
    expect(reads).toBe(0);
  });
});

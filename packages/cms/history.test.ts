import { describe, expect, it } from "vitest";
import { requireRevisionHistory, HistoryEnvelopeError } from "./history";

const documentId = "a2000000-0000-4000-8000-000000000010";
function page(size = 1) {
  return {
    items: Array.from({ length: size }, (_, index) => ({
      id: `a2000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      documentId,
      schemaVersion: index % 2 ? 7 : 1,
      createdAt: "2026-10-10T00:00:00.000Z",
    })),
    hasMore: false,
    nextCursor: null as string | null,
  };
}
describe("closed document-bound revision history metadata", () => {
  it("accepts a complete 100-row mixed-version page and detaches it without classifying content", () => {
    const value = page(100);
    const body = requireRevisionHistory(value, documentId);
    expect(body).toEqual(value);
    expect(body).not.toBe(value);
    value.items[0].schemaVersion = 9;
    expect(body.items[0].schemaVersion).toBe(1);
    expect(Object.keys(body.items[0]).sort()).toEqual(["createdAt", "documentId", "id", "schemaVersion"]);
  });
  it.each([
    [
      "original JSON",
      (value: ReturnType<typeof page>) => {
        Object.assign(value.items[0], { blocks: [{ private: "secret" }] });
      },
    ],
    [
      "editor eligibility",
      (value: ReturnType<typeof page>) => {
        Object.assign(value.items[0], { canSave: true });
      },
    ],
    [
      "extra envelope field",
      (value: ReturnType<typeof page>) => {
        Object.assign(value, { latestRevisionId: value.items[0].id });
      },
    ],
    [
      "wrong document",
      (value: ReturnType<typeof page>) => {
        value.items[0].documentId = "a2000000-0000-4000-8000-000000000020";
      },
    ],
    [
      "duplicate IDs",
      (value: ReturnType<typeof page>) => {
        value.items.push(value.items[0]);
      },
    ],
    [
      "missing continuation",
      (value: ReturnType<typeof page>) => {
        value.hasMore = true;
      },
    ],
    [
      "unexpected continuation",
      (value: ReturnType<typeof page>) => {
        value.nextCursor = "cursor";
      },
    ],
    [
      "invalid timestamp",
      (value: ReturnType<typeof page>) => {
        value.items[0].createdAt = "not-a-date";
      },
    ],
    [
      "invalid version",
      (value: ReturnType<typeof page>) => {
        value.items[0].schemaVersion = 0;
      },
    ],
    [
      "too many rows",
      (value: ReturnType<typeof page>) => {
        value.items = page(101).items;
      },
    ],
    [
      "excess transport",
      (value: ReturnType<typeof page>) => {
        value.hasMore = true;
        value.nextCursor = "界".repeat(30_000);
      },
    ],
  ] as const)("rejects %s with a safe error", (_label, change) => {
    const value = page();
    change(value);
    expect(() => requireRevisionHistory(value, documentId)).toThrow(HistoryEnvelopeError);
  });
  it("permits empty terminal pages but rejects empty continuation pages", () => {
    expect(requireRevisionHistory(page(0), documentId)).toEqual(page(0));
    expect(() =>
      requireRevisionHistory({ ...page(0), hasMore: true, nextCursor: "cursor" }, documentId),
    ).toThrow(HistoryEnvelopeError);
    expect(
      requireRevisionHistory({ ...page(), hasMore: true, nextCursor: "cursor" }, documentId).nextCursor,
    ).toBe("cursor");
  });
  it("requires a valid path document even for an empty page", () => {
    expect(() => requireRevisionHistory(page(0), "invalid")).toThrow(HistoryEnvelopeError);
  });
  it("rejects sparse or executable item arrays before serialization", () => {
    const value = page(2);
    delete value.items[1];
    expect(() => requireRevisionHistory(value, documentId)).toThrow(HistoryEnvelopeError);
    let calls = 0;
    const items = Object.setPrototypeOf(
      page().items,
      Object.create(Array.prototype, {
        toJSON: {
          value: () => {
            calls++;
            return [];
          },
        },
      }),
    );
    expect(() => requireRevisionHistory({ ...page(), items }, documentId)).toThrow(HistoryEnvelopeError);
    expect(calls).toBe(0);
  });
});

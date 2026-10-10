import { beforeEach, describe, expect, it } from "vitest";
import {
  getNativeMockListing,
  projectNativeMockListing,
  searchNativeMockListings,
  type NativeMockSnapshot,
} from "../../packages/mls";
import { isListing } from "../../packages/mls/contracts";
import type { CanonicalListing } from "../../packages/providers/mls/port";
import {
  context,
  displayPolicy,
  mockSnapshot,
  nativeRights,
  options,
  syntheticAttributionContacts,
} from "./fixtures";

let snapshot: {
  feeds: NativeMockSnapshot["feeds"][number][];
  listings: NativeMockSnapshot["listings"][number][];
};
beforeEach(async () => {
  const initial = await mockSnapshot();
  snapshot = { feeds: [...initial.feeds], listings: [...initial.listings] };
});
const project = () => projectNativeMockListing(snapshot.listings[0], snapshot.feeds[0], options.now);

describe("reviewed participant attribution contact projection", () => {
  it.each(syntheticAttributionContacts)(
    "projects supplied $kind without aliasing source contact",
    (contact) => {
      snapshot.listings[0] = {
        ...snapshot.listings[0],
        canonical: {
          ...snapshot.listings[0].canonical,
          attribution: { ...snapshot.listings[0].canonical.attribution, contact },
        },
      };
      const item = project()!;
      expect(isListing(item)).toBe(true);
      expect(item.attribution.contact).toEqual(contact);
      expect(item.attribution.contact).not.toBe(contact);
      expect(getNativeMockListing(snapshot, context, item.id, options.now)).toEqual(item);
      expect(searchNativeMockListings(snapshot, context, { limit: 100 }, options).items).toContainEqual(item);
    },
  );

  it.each(["native", "display"])("omits contact when the %s field policy does not grant it", (policy) => {
    snapshot.feeds[0] = {
      ...snapshot.feeds[0],
      ...(policy === "native"
        ? {
            nativeRights: {
              ...nativeRights,
              allowedFields: nativeRights.allowedFields.filter((field) => field !== "attribution.contact"),
            },
          }
        : {
            displayPolicy: {
              ...displayPolicy,
              displayFields: displayPolicy.displayFields.filter((field) => field !== "attribution.contact"),
            },
          }),
    };
    const item = project()!;
    expect(item.attribution).not.toHaveProperty("contact");
    expect(JSON.stringify(item)).not.toContain(syntheticAttributionContacts[0].value);
    expect(isListing(item)).toBe(true);
  });

  it.each(["absent", "null"])(
    "preserves %s contact without using the existing agent as fallback",
    (shape) => {
      const attribution = { ...snapshot.listings[0].canonical.attribution };
      delete attribution.contact;
      if (shape === "null") attribution.contact = null;
      snapshot.listings[0] = {
        ...snapshot.listings[0],
        canonical: { ...snapshot.listings[0].canonical, attribution },
      };
      const item = project()!;
      expect(item.attribution.agentName).toBe(attribution.agent);
      if (shape === "null") expect(item.attribution.contact).toBeNull();
      else expect(item.attribution).not.toHaveProperty("contact");
    },
  );

  it.each([
    { kind: "email", value: "not-an-email" },
    { kind: "phone", value: "javascript:private()" },
    { kind: "phone", value: "123" },
    { kind: "phone", value: "123 ext4567" },
    { kind: "owner", value: "owner@example.invalid" },
    { kind: "email", value: "agent@example.invalid", secret: "unreviewed" },
    { kind: "email", value: "" },
    { kind: "email", value: "a".repeat(255) },
  ])("suppresses malformed permitted source contact %j", (contact) => {
    snapshot.listings[0] = {
      ...snapshot.listings[0],
      canonical: {
        ...snapshot.listings[0].canonical,
        attribution: {
          ...snapshot.listings[0].canonical.attribution,
          contact,
        } as CanonicalListing["attribution"],
      },
    };
    expect(project()).toBeNull();
  });

  it("invalidates a signed page when only the supplied contact changes", () => {
    const first = searchNativeMockListings(snapshot, context, { limit: 1 }, options);
    expect(first.nextCursor).not.toBeNull();
    snapshot.listings[0] = {
      ...snapshot.listings[0],
      canonical: {
        ...snapshot.listings[0].canonical,
        attribution: {
          ...snapshot.listings[0].canonical.attribution,
          contact: syntheticAttributionContacts[1],
        },
      },
    };
    expect(() =>
      searchNativeMockListings(snapshot, context, { limit: 1, cursor: first.nextCursor }, options),
    ).toThrowError(expect.objectContaining({ code: "cursor_invalid" }));
  });

  it.each(["withdrawal", "expiry", "context"])("suppresses supplied contact after %s loss", (reason) => {
    snapshot.listings[0] = {
      ...snapshot.listings[0],
      ...(reason === "withdrawal" ? { withdrawnAt: options.now.toISOString() } : {}),
      ...(reason === "context" ? { tenantId: "10000000-0000-4000-8000-000000000099" } : {}),
      canonical: {
        ...snapshot.listings[0].canonical,
        ...(reason === "expiry" ? { expiresAt: options.now.toISOString() } : {}),
      },
    };
    expect(project()).toBeNull();
  });
});

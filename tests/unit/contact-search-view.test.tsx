import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ContactsSearchView } from "../../apps/web/components/contacts-search";
import {
  ContactsSearchController,
  type ContactsSearchScope,
  type ContactsSearchState,
} from "../../apps/web/components/contacts-search-controller";
import type { Schema } from "../../apps/web/lib/api";

const instant = "2026-10-10T12:00:00.000Z";
function page(count = 1, hasMore = false): Schema<"PageContact"> {
  return {
    items: Array.from({ length: count }, (_, index) => ({
      id: "41000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"),
      displayName: "PRIVATE_CONTACT " + index,
      emails: ["private" + index + "@example.test"],
      phones: ["+15550009999"],
      version: 7,
    })),
    hasMore,
    nextCursor: hasMore ? "PRIVATE_CURSOR" : null,
  };
}
function render(
  patch: Partial<ContactsSearchState> = {},
  options: { scope?: ContactsSearchScope; clock?: unknown; blocked?: boolean } = {},
) {
  const state = new ContactsSearchController({
    binding: "PRIVATE_BINDING",
    memberId: "30000000-0000-4000-8000-000000000001",
    scope: "own",
    online: true,
    canRead: true,
    client: { list: async () => page() },
  }).getSnapshot();
  return renderToStaticMarkup(
    <ContactsSearchView
      state={{ ...state, ...patch }}
      scope={options.scope ?? "own"}
      nowInstant={Object.hasOwn(options, "clock") ? options.clock : instant}
      actionsBlocked={options.blocked}
      actions={{
        changeQuery: vi.fn(),
        changeFilter: vi.fn(),
        submit: vi.fn(),
        refresh: vi.fn(),
        more: vi.fn(),
        openContact: vi.fn(),
      }}
    />,
  );
}
function current(patch: Partial<ContactsSearchState> = {}): Partial<ContactsSearchState> {
  return {
    page: page(),
    query: "PRIVATE_QUERY",
    appliedQuery: "PRIVATE_QUERY",
    refreshedAt: instant,
    phase: "ready",
    ...patch,
  };
}
function button(html: string, name: string) {
  return [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(
    ([item]) => item.replace(/<[^>]*>/g, "").trim() === name,
  )?.[0];
}

describe("static contact-search presentation without browser claims", () => {
  it("keeps unrequested distinct from a verified no-match result", () => {
    const initial = render();
    expect(initial).toContain("Enter a name and search");
    expect(initial).not.toContain("No matching contact names");
    const empty = render(current({ page: page(0) }));
    expect(empty).toContain("No matching contact names");
    expect(empty).toContain("0 loaded matches");
    expect(empty).toContain("current scope at this read");
  });
  it("describes exact literal name-only search, preserved spaces and the Unicode bound", () => {
    const html = render();
    for (const text of [
      "ignoring case",
      "does not search email or phone",
      "Spaces are preserved",
      "Maximum 200 characters, including emoji",
      "Saved filters are unavailable",
    ])
      expect(html).toContain(text);
    expect(html).toContain('role="search"');
    expect(html).toContain('aria-label="Contact name search"');
    expect(html).toContain('autoComplete="off"');
    expect(html).not.toContain('maxLength="200"');
  });
  it.each(["own", "authorized"] as const)(
    "labels %s without claiming complete totals or widening authority",
    (scope) => {
      const html = render(current(), { scope });
      expect(html).toContain(scope === "own" ? "My workspace" : "All permitted records");
      expect(html).toContain("contact-read permission");
      expect(html).toContain("loaded count describes this search");
      expect(html).not.toContain("total contacts");
      expect(html).not.toContain("PRIVATE_CURSOR");
      expect(html).not.toContain("PRIVATE_BINDING");
    },
  );
  it("renders only current complete loaded rows with UTC refresh/source and explicit record version", () => {
    const html = render(current());
    for (const text of [
      "PRIVATE_CONTACT 0",
      "private0@example.test",
      "+15550009999",
      "Record version 7",
      "Source: Contacts",
      "Loaded results can change between reads",
      "1 loaded matches",
    ])
      expect(html).toContain(text);
    expect(html).toContain('dateTime="' + instant + '"');
    expect(html).toContain("(UTC)");
    expect(button(html, "Open contact")).not.toContain("disabled");
    expect(button(html, "Refresh contacts")).not.toContain("disabled");
  });
  it("hides previous rows while a fresh batch loads and disables native requests", () => {
    const html = render(current({ reading: true }));
    expect(html).toContain("Verifying the current contact search");
    expect(html).not.toContain("PRIVATE_CONTACT");
    expect(html).not.toContain("private0@example.test");
    expect(button(html, "Search names")).toContain("disabled");
    expect(button(html, "Refresh contacts")).toContain("disabled");
  });
  it("distinguishes an unavailable read from no matches without showing an arbitrary source error", () => {
    const html = render({ phase: "unavailable", error: "PRIVATE_PROVIDER_EXCEPTION" });
    expect(html).toContain("no empty list has been inferred");
    expect(html).not.toContain("No matching contact names");
    expect(html).not.toContain("PRIVATE_PROVIDER_EXCEPTION");
    expect(button(html, "Refresh contacts")).not.toContain("disabled");
  });
  it.each(["offline", "hidden", "denied"] as const)(
    "cuts all private projection and input while %s",
    (cut) => {
      const html = render(
        current({ online: cut !== "offline", visible: cut !== "hidden", canRead: cut !== "denied" }),
      );
      for (const text of [
        "PRIVATE_CONTACT",
        "PRIVATE_QUERY",
        "private0@example.test",
        "+15550009999",
        instant,
      ])
        expect(html).not.toContain(text);
      expect(html).toContain('value=""');
      expect(button(html, "Search names")).toContain("disabled");
      expect(button(html, "Refresh contacts")).toContain("disabled");
      expect(html).toContain('role="status"');
    },
  );
  it("requires verified workspace recovery after denied authority", () => {
    const html = render({ canRead: false, phase: "denied" });
    expect(html).toContain("Use Refresh workspace");
    expect(html).toContain("verify current access");
  });
  it("hides stale rows at the exact five-minute boundary and permits explicit refresh", () => {
    const html = render(current(), { clock: "2026-10-10T12:05:00.000Z" });
    expect(html).toContain("Results are hidden until you refresh");
    expect(html).not.toContain("PRIVATE_CONTACT");
    expect(button(html, "Refresh contacts")).not.toContain("disabled");
  });
  it.each([null, "PRIVATE_BAD_CLOCK", "2026-10-10T11:59:59.999Z"])(
    "withholds source data for an unverifiable clock case%#",
    (clock) => {
      const html = render(current(), { clock });
      expect(html).not.toContain("PRIVATE_CONTACT");
      expect(html).not.toContain("private0@example.test");
      expect(html).not.toContain("PRIVATE_BAD_CLOCK");
    },
  );
  it("does not show old results if the input no longer equals its verified query", () => {
    const html = render(current({ query: "NEW_QUERY" }));
    expect(html).not.toContain("PRIVATE_CONTACT");
    expect(html).not.toContain("Name query:");
    expect(html).toContain('value="NEW_QUERY"');
  });
  it("independently rejects malformed retained data instead of trusting ready", () => {
    const source = page();
    source.items[0].emails = ["PRIVATE_INVALID_EMAIL"];
    const html = render(current({ page: source }));
    expect(html).toContain("Contact search metadata is unavailable");
    expect(html).not.toContain("PRIVATE_CONTACT");
    expect(html).not.toContain("PRIVATE_INVALID_EMAIL");
  });
  it("makes a partial loaded result and its native more action explicit", () => {
    const html = render(current({ page: page(25, true) }));
    expect(html).toContain("25 loaded matches");
    expect(html).toContain("More records are available");
    expect(button(html, "Load more matching contacts")).not.toContain("disabled");
  });
  it("discloses the200 loaded cap without claiming no more matches", () => {
    const html = render(current({ page: page(200, true) }));
    expect(html).toContain("Showing the limit of 200 loaded contacts");
    expect(html).toContain("Refine your name query");
    expect(html).toContain("More records are available");
    expect(button(html, "Load more matching contacts")).toBeUndefined();
  });
  it("blocks native contact navigation for another draft/pending command while search remains read-only", () => {
    const html = render(current(), { blocked: true });
    expect(button(html, "Open contact")).toContain("disabled");
    expect(html).toContain("another draft or command needs attention");
    expect(button(html, "Refresh contacts")).not.toContain("disabled");
  });
  it("escapes tenant text and does not put query/contact/channel data into links or hidden persistence", () => {
    const source = page();
    source.items[0].displayName = '<script>alert("PRIVATE")</script>';
    source.items[0].phones = ['<img src=x onerror="PRIVATE">'];
    const html = render(current({ page: source, query: "<PRIVATE_QUERY>", appliedQuery: "<PRIVATE_QUERY>" }));
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/<(?:a|iframe|textarea)\b/);
    expect(html).not.toContain('type="hidden"');
  });
  it("offers a labeled native form and honest private-memory/presentation lifetime disclosure", () => {
    const html = render();
    expect(html).toMatch(/<section[^>]*aria-labelledby=/);
    expect(html).toMatch(/<label[^>]*for=/);
    expect(html).toContain("aria-describedby=");
    expect(button(html, "Search names")).toContain('type="submit"');
    expect(html).toContain("tab’s memory");
    expect(html).toContain("five minutes");
    expect(html).toContain("presentation limit");
  });
});

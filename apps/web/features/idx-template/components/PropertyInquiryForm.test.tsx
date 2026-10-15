import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InquirySnapshot } from "../inquiry-recovery";
import { PropertyInquiryFormView } from "./PropertyInquiryForm";
import { Filters } from "./Filters";
import { NaturalLanguageSearch } from "./NaturalLanguageSearch";
import { FavoriteButton } from "./FavoriteButton";
import { CompareButton, SaveSearchButton } from "./OrganizerActions";

vi.mock("../context", () => ({
  useTemplateSite: () => ({ capabilities: { favorites: false } }),
}));
const initial: InquirySnapshot = {
  phase: "editing",
  fields: {
    name: "Synthetic Visitor",
    email: "visitor@example.invalid",
    phone: "",
    message: "A synthetic inquiry.",
  },
  fieldErrors: {},
  error: "",
  receipt: null,
};
function render(state = initial) {
  return renderToStaticMarkup(
    <PropertyInquiryFormView
      state={state}
      agentName="Synthetic Agent"
      synthetic
      idPrefix="inquiry-test"
      onUpdate={() => {}}
      onSubmit={() => {}}
    />,
  );
}
function tag(markup: string, id: string) {
  const result = markup.match(new RegExp(`<[^>]+id="${id}"[^>]*>`));
  if (!result) throw new Error(`Missing element ${id}`);
  return result[0];
}
describe("inquiry form static accessibility semantics", () => {
  it("labels every field, supports password managers and mobile keyboards, and names its purpose", () => {
    const markup = render();
    for (const field of ["name", "email", "phone", "message"]) {
      expect(markup).toContain(`for="inquiry-test-${field}"`);
      expect(tag(markup, `inquiry-test-${field}`)).toContain(`name="${field}"`);
    }
    expect(tag(markup, "inquiry-test-name")).toContain('autoComplete="name"');
    expect(tag(markup, "inquiry-test-email")).toContain('type="email"');
    expect(tag(markup, "inquiry-test-email")).toContain('inputMode="email"');
    expect(tag(markup, "inquiry-test-phone")).toContain('type="tel"');
    expect(tag(markup, "inquiry-test-phone")).toContain('autoComplete="tel"');
    expect(markup).toContain('aria-labelledby="inquiry-test-heading"');
    expect(markup).toContain('aria-describedby="inquiry-test-privacy"');
    expect(markup).toContain('<legend class="sr-only">Your inquiry details</legend>');
    expect(markup).toContain("This form does not grant marketing consent.");
    expect(markup).toContain("min-h-11");
    expect(tag(markup, "inquiry-test-name")).toContain("text-base");
  });

  it("associates each invalid field with its error and offers a focusable announced summary", () => {
    const markup = render({
      ...initial,
      error: "Please check your inquiry details.",
      fieldErrors: { email: "Enter a valid email address.", message: "Message is required." },
    });
    for (const field of ["email", "message"]) {
      const input = tag(markup, `inquiry-test-${field}`);
      expect(input).toContain('aria-invalid="true"');
      expect(input).toContain(`aria-describedby="inquiry-test-${field}-error"`);
      expect(tag(markup, `inquiry-test-${field}-error`)).toContain("text-destructive");
    }
    expect(tag(markup, "inquiry-test-name")).toContain('aria-invalid="false"');
    expect(tag(markup, "inquiry-test-error")).toContain('role="alert"');
    expect(tag(markup, "inquiry-test-error")).toContain('tabindex="-1"');
    expect(tag(markup, "inquiry-test-error")).toContain('aria-atomic="true"');
  });

  it("locks inquiry fields while pending or uncertain but exposes the deliberate same-command retry", () => {
    const pending = render({ ...initial, phase: "pending" });
    expect(pending).toContain('aria-busy="true"');
    expect(pending).toMatch(/<fieldset[^>]*disabled=""/);
    expect(pending).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(pending).toContain("Sending inquiry. Please wait.");
    const unknown = render({ ...initial, phase: "unknown", error: "The outcome is unknown." });
    expect(unknown).toMatch(/<fieldset[^>]*disabled=""/);
    expect(unknown.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).not.toMatch(/\sdisabled=/);
    expect(unknown).toContain("Reconcile the same inquiry");
    expect(unknown).toContain("Your details are locked until the original command is reconciled.");
  });

  it("announces only verified receipt success without retaining private form values or claiming delivery", () => {
    const markup = render({
      ...initial,
      phase: "received",
      receipt: { receiptId: "33333333-3333-4333-8333-333333333333", message: "Durably received." },
    });
    expect(markup).toContain('role="status" aria-live="polite"');
    expect(markup).toContain("Receipt: 33333333-3333-4333-8333-333333333333");
    expect(markup).toContain("Synthetic demonstration: no email or text was sent.");
    expect(markup).not.toContain("visitor@example.invalid");
    expect(markup).not.toContain("<input");
  });

  it("gives the icon-only mobile filter trigger a name and does not reference an absent closed panel", () => {
    const markup = renderToStaticMarkup(
      <Filters initialFilters={{}} onFilterChange={() => {}} isLoading={false} />,
    );
    expect(markup).toMatch(/<button[^>]*aria-label="Filters"[^>]*aria-expanded="false"/);
    expect(markup).not.toContain('aria-controls="property-filters"');
    expect(markup).toContain('aria-label="Search listings by address"');
    expect(markup).toContain('aria-label="Sort listings"');
  });

  it("retains source control styles while explicitly disabling unsupported native visitor capabilities", () => {
    const markup = renderToStaticMarkup(
      <>
        <NaturalLanguageSearch onApply={() => {}} />
        <SaveSearchButton filters={{}} />
        <CompareButton listingKey="SYNTHETIC-001" />
        <FavoriteButton listingKey="SYNTHETIC-001" />
      </>,
    );
    const buttons = [...markup.matchAll(/<button[^>]*>/g)].map(([value]) => value);
    expect(buttons).toHaveLength(4);
    for (const button of buttons) expect(button).toContain('disabled=""');
    expect(markup).toContain("The native AI search capability is unavailable.");
    expect(markup).toContain("Native visitor saved searches are unavailable in this release.");
    expect(markup).toContain('aria-label="Compare property SYNTHETIC-001: unavailable"');
    expect(markup).toContain('aria-label="Save property SYNTHETIC-001: unavailable"');
    expect(markup).toContain('aria-describedby="natural-language-search-unavailable"');
    expect(markup).toContain('for="natural-language-search"');
    expect(markup).toContain(
      "inline-flex h-10 w-10 items-center justify-center rounded-full border border-border",
    );
    expect(markup).toContain("mt-3 flex flex-col gap-2 sm:flex-row");
  });
});

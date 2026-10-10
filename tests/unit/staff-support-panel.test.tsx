import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StaffSupportPanel, { SupportRecordDetails } from "../../apps/web/components/staff-support-panel";
import type { StaffSupportPanelProps } from "../../apps/web/components/staff-support-panel";
import {
  StaffSupportLifetime,
  type StaffSupportSessionView,
} from "../../apps/web/components/staff-support-protocol";
import type { components } from "../../packages/contracts/generated/api";
import type { SyntheticStaffSessionResponse } from "../../packages/contracts/internal/control-plane-port";

const now = Date.parse("2026-10-10T10:00:00.000Z");
const expiry = "2026-10-10T10:15:00.000Z";
const staffId = "00000000-0000-4000-8000-000000000001";
const organizationId = "00000000-0000-4000-8000-000000000002";
const grantId = "00000000-0000-4000-8000-000000000003";
const privatePurpose = "Private reviewed investigation";
function props(state: "none" | "active" | "stale" = "none", grantPermission = true): StaffSupportPanelProps {
  const session: SyntheticStaffSessionResponse = {
    staffUserId: staffId,
    synthetic: true,
    permissions: grantPermission ? ["platform.orgs.read", "platform.support.grant"] : ["platform.orgs.read"],
    supportContext:
      state === "active"
        ? {
            organizationId,
            accessGrantId: grantId,
            permissions: ["crm.contacts.read", "crm.leads.read"],
            reason: privatePurpose,
            expiresAt: expiry,
          }
        : null,
  };
  const headers = new Headers({
    "X-CSRF-Token": "never-render-this-csrf",
    "X-Synthetic-Support-State": state,
  });
  if (state === "active") {
    headers.set("X-Synthetic-Support-Grant-Id", grantId);
    headers.set("X-Synthetic-Support-Grant-ETag", '"3"');
  }
  const lifetime = new StaffSupportLifetime();
  const view = lifetime.acceptSession(
    lifetime.beginRequest(),
    session,
    headers,
    now,
  ) as StaffSupportSessionView;
  return {
    lifetime,
    view,
    online: true,
    verified: true,
    locked: false,
    onSession: vi.fn(),
    onUnverified: vi.fn(),
    onAccessLost: vi.fn(),
    onVerifySession: vi.fn(async () => {}),
    onRecoveryRequired: vi.fn(),
  };
}
const render = (options: StaffSupportPanelProps) => renderToStaticMarkup(<StaffSupportPanel {...options} />);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("support panel initial response and privacy rendering", () => {
  it("provides explicitly synthetic labeled forms with seven read permissions and no automatic authority", () => {
    const markup = render(props());
    expect(markup).toContain("Synthetic support access");
    expect(markup).toContain("Active organization UUID");
    expect(markup).toContain("Recipient staff UUID");
    expect(markup).toContain("Known support grant UUID");
    expect(markup).toContain("Nonblank support purpose");
    expect(markup).toContain("Fixed short expiry");
    expect(markup.match(/type="checkbox"/g) || []).toHaveLength(7);
    expect(markup).not.toContain("crm.contacts.write");
    expect(markup).toContain("Create synthetic support grant");
    expect(markup).toContain("Select synthetic read-only grant");
    expect(markup).not.toContain("never-render-this-csrf");
    expect(markup).toContain("No support operation has been acknowledged or recovered.");
  });

  it("does not expose grant creation when the current principal lacks grant permission", () => {
    const markup = render(props("none", false));
    expect(markup).not.toContain("Create synthetic support grant");
    expect(markup).toContain("no platform support-grant permission");
    expect(markup).toContain("Select synthetic read-only grant");
  });

  it("shows the current purpose and fixed expiry only for a usable active read-only context", () => {
    const markup = render(props("active"));
    expect(markup).toContain(privatePurpose);
    expect(markup).toContain(expiry);
    expect(markup).toContain("Synthetic · read only");
    expect(markup).toContain("Every read is reauthorized by the server");
    expect(markup).toContain("Clear selected support context");
    expect(markup).not.toContain("never-render-this-csrf");
  });

  it.each(["offline", "unverified", "expired"])(
    "hides selected customer context during %s even before effects or timers run",
    (condition) => {
      const options = props("active");
      if (condition === "offline") options.online = false;
      if (condition === "unverified") options.verified = false;
      if (condition === "expired") vi.setSystemTime(Date.parse(expiry));
      const markup = render(options);
      expect(markup).not.toContain(privatePurpose);
      expect(markup).not.toContain(`Organization ${organizationId}`);
      expect(markup).toContain("No currently usable customer projection is shown");
      expect(markup).toContain("Verify current support context");
      expect(markup).not.toContain("The server returned no records on this page.");
    },
  );

  it("preserves stale staff warning and explicit clear without displaying inaccessible grant data", () => {
    const markup = render(props("stale"));
    expect(markup).toContain("server reports a stale selection");
    expect(markup).toContain("Clear selected support context");
    expect(markup).not.toContain(privatePurpose);
    expect(markup).not.toContain(grantId);
    expect(markup).not.toContain("Synthetic · read only");
  });

  it("keeps recovery visible when current verification is unavailable", () => {
    const options = props();
    options.lifetime.unverify();
    options.view = null;
    options.verified = false;
    const markup = render(options);
    expect(markup).toContain("Original uncertain commands remain only in this tab");
    expect(markup).toContain("Requester support operation UUID");
    expect(markup).toContain("Expected support operation kind");
    expect(markup).not.toContain("Current authorized grant reference");
  });

  it("escapes purpose and fixed-schema summary values instead of inserting executable content", () => {
    const options = props("active");
    const session = {
      ...options.view!.session,
      supportContext: {
        ...options.view!.session.supportContext!,
        reason: '<script>alert("private")</script>',
      },
    };
    const headers = new Headers({
      "X-CSRF-Token": "never-render-this-csrf",
      "X-Synthetic-Support-State": "active",
      "X-Synthetic-Support-Grant-Id": grantId,
      "X-Synthetic-Support-Grant-ETag": '"3"',
    });
    options.view = options.lifetime.acceptSession(options.lifetime.beginRequest(), session, headers, now);
    const markup = render(options);
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toContain("<script>");
    const contact: components["schemas"]["Contact"] = {
      id: staffId,
      displayName: '<img src=x onerror="alert(1)">',
      emails: [],
      phones: [],
      birthday: null,
      version: 1,
    };
    const details = renderToStaticMarkup(<SupportRecordDetails item={contact} />);
    expect(details).toContain("&lt;img");
    expect(details).not.toContain("<img");
    expect(details).not.toContain("never-render-this-csrf");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CampaignWorkspace, { CampaignWorkspaceView } from "../../apps/web/components/campaign-workspace";
import {
  CampaignDraftController,
  campaignVersion,
  type CampaignDraftClient,
  type CampaignDraftState,
} from "../../apps/web/components/campaign-draft-protocol";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const id = "b2000000-0000-4000-8000-000000000001";
const campaign = (version = 1, name = "Private draft"): Schema<"Campaign"> => ({
  id,
  name,
  category: "Private category",
  state: "draft",
  version,
});
function fixture(canWrite = true) {
  const client = {
    list: vi.fn<CampaignDraftClient["list"]>(async () => ({
      items: [campaign()],
      hasMore: true,
      nextCursor: "private-next-cursor",
    })),
    detail: vi.fn<CampaignDraftClient["detail"]>(async () => ({ data: campaign(), etag: '"1"' })),
    submit: vi.fn<CampaignDraftClient["submit"]>(async (command) => {
      const version = command.ifMatch ? campaignVersion(command.ifMatch) + 1 : 1;
      return { data: { ...campaign(version), ...command.body }, etag: `"${version}"` };
    }),
  };
  const controller = new CampaignDraftController({
    binding: "private-session-binding-never-render",
    client,
    canRead: true,
    canWrite,
    online: true,
    createKey: () => "private-command-key-never-render",
  });
  return { controller, client };
}
function render(state: CampaignDraftState, active = true, online = state.online) {
  const callbacks = {
    onCreate: vi.fn(() => false),
    onRefresh: vi.fn(),
    onNext: vi.fn(),
    onSelect: vi.fn(),
    onEdit: vi.fn(),
    onSave: vi.fn(),
    onDiscard: vi.fn(),
    onEditRejected: vi.fn(),
    onReadConflict: vi.fn(),
    onResolveConflict: vi.fn(),
  };
  return {
    markup: renderToStaticMarkup(
      <CampaignWorkspaceView state={state} active={active} online={online} {...callbacks} />,
    ),
    callbacks,
  };
}
function buttons(markup: string) {
  return Array.from(markup.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g), (match) => ({
    html: match[0],
    text: match[1].replace(/<[^>]*>/g, "").trim(),
  }));
}
function assertDisabled(markup: string, name: string) {
  const button = buttons(markup).find((item) => item.text === name);
  expect(button, `button ${name}`).toBeDefined();
  expect(button!.html).toContain('disabled=""');
}
const session: Schema<"Session"> = {
  userId: "b2000000-0000-4000-8000-000000000002",
  profile: { displayName: "Private person never-render", timezone: "America/Los_Angeles" },
  organizations: [
    {
      id,
      name: "Private organization never-render",
      status: "active",
      timezone: "America/Los_Angeles",
      locale: "en-US",
      version: 1,
    },
  ],
  activeOrgId: id,
  permissions: ["campaigns.read", "campaigns.write"],
};

describe("campaign draft capability and private presentation", () => {
  it("distinguishes synthetic disabled, unread, denied and unavailable states from an empty success", async () => {
    const { controller, client } = fixture();
    expect(render(controller.getSnapshot(), false).markup).toContain("Synthetic campaign drafts unavailable");
    const unread = render(controller.getSnapshot()).markup;
    expect(unread).toContain("The draft index has not been read successfully.");
    expect(unread).not.toContain("No draft metadata on this page");
    client.list.mockRejectedValueOnce(new ApiError(403, "private entitlement", "entitlement_disabled"));
    await controller.loadPage();
    const unavailable = render(controller.getSnapshot()).markup;
    expect(unavailable).toContain("Campaign capability or resource unavailable");
    expect(unavailable).toContain("Verify current campaign access");
    expect(unavailable).not.toContain("No draft metadata");
    expect(unavailable).not.toContain("private entitlement");
    expect(unavailable).not.toContain("New draft metadata");
    controller.revoke();
    const denied = render(controller.getSnapshot()).markup;
    expect(denied).toContain("Campaign access changed");
    expect(denied).not.toContain(">Private draft<");
    expect(denied).not.toContain(id);
  });
  it("shows explicitly selected current versions and escapes private strings without granting publish or delivery controls", async () => {
    const { controller, client } = fixture();
    client.list.mockResolvedValueOnce({
      items: [campaign(3, '<img src=x onerror="secret()">')],
      hasMore: false,
      nextCursor: null,
    });
    await controller.loadPage();
    const { markup, callbacks } = render(controller.getSnapshot());
    expect(markup).toContain("&lt;img src=x onerror=&quot;secret()&quot;&gt;");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("Read version 3");
    expect(markup).toContain("Synthetic · draft metadata");
    expect(markup).not.toContain("UUID");
    expect(buttons(markup).some((button) => /publish|enroll|send|schedule|activate/i.test(button.text))).toBe(
      false,
    );
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
  });
  it("labels both native required fields with unique IDs and exposes current read-only access", async () => {
    const { controller } = fixture(false);
    await controller.select(id);
    const { markup } = render(controller.getSnapshot());
    const labels = Array.from(markup.matchAll(/<label for="([^"]+)">([^<]+)<\/label>/g));
    expect(labels.map((label) => label[2])).toEqual(["Campaign name", "Campaign category"]);
    expect(new Set(labels.map((label) => label[1])).size).toBe(2);
    for (const label of labels) expect(markup).toContain(`id="${label[1]}"`);
    expect(markup.match(/ required=""/g)).toHaveLength(2);
    expect(markup.match(/autoComplete="off"/g)).toHaveLength(2);
    expect(markup).toContain('<fieldset disabled="">');
    expect(markup).toContain("You have read access");
    expect(buttons(markup).some((button) => /Create campaign|Save draft|New draft/.test(button.text))).toBe(
      false,
    );
  });
  it("disables navigation and editing while retaining an unknown original command without exposing keys", async () => {
    const { controller, client } = fixture();
    await controller.loadPage();
    await controller.select(id);
    controller.edit("name", "Protected draft");
    client.submit.mockRejectedValueOnce(new Error("unknown"));
    await controller.save();
    const { markup } = render(controller.getSnapshot());
    expect(markup).toContain("Protected draft");
    expect(markup).toContain('<fieldset disabled="">');
    expect(markup).toContain("Retry original metadata command");
    expect(markup).toContain("The original request is protected");
    assertDisabled(markup, "Refresh index");
    assertDisabled(markup, "New draft metadata");
    assertDisabled(markup, "Read next draft page");
    assertDisabled(markup, "Discard unsaved metadata");
    expect(markup).not.toContain("private-command-key-never-render");
    expect(markup).not.toContain("private-session-binding-never-render");
    expect(markup).not.toContain("Edit rejected metadata");
  });
  it("clears fetched index and cursor offline but keeps the dirty local fields visibly locked", async () => {
    const { controller } = fixture();
    await controller.loadPage();
    await controller.select(id);
    controller.edit("name", "Local fields retained");
    controller.setOnline(false);
    const { markup } = render(controller.getSnapshot());
    expect(markup).toContain("Offline");
    expect(markup).toContain("Local fields retained");
    expect(markup).toContain('<fieldset disabled="">');
    expect(markup).not.toContain("Read next draft page");
    expect(markup).not.toContain("private-next-cursor");
    expect(markup).not.toContain("Read version 1");
    assertDisabled(markup, "Save draft metadata");
    assertDisabled(markup, "Refresh index");
    assertDisabled(markup, "New draft metadata");
  });
  it("displays a historical acknowledgment separately and requires a fresh read for another edit", async () => {
    const { controller } = fixture();
    controller.beginCreate();
    controller.edit("name", "Acknowledged name");
    controller.edit("category", "Acknowledged category");
    await controller.save();
    const { markup } = render(controller.getSnapshot());
    expect(markup).toContain("Metadata command acknowledged");
    expect(markup).toContain("may be historical");
    expect(markup).toContain("Read current acknowledged draft");
    expect(markup).toContain("Acknowledged name");
    expect(markup).not.toContain('value="Acknowledged name"');
    expect(markup).not.toContain("Private campaign draft fields");
    expect(markup).not.toContain("private-command-key-never-render");
    controller.setOnline(false);
    const offline = render(controller.getSnapshot()).markup;
    expect(offline).not.toContain(id);
    expect(offline).not.toContain("Acknowledged name");
    expect(offline).not.toContain("Metadata command acknowledged");
  });
  it("offers separate review and explicit revision decisions without automatic save", async () => {
    const { controller, client } = fixture();
    await controller.select(id);
    controller.edit("name", "Original fields");
    client.submit.mockRejectedValueOnce(new ApiError(412, "stale"));
    await controller.save();
    let markup = render(controller.getSnapshot()).markup;
    expect(markup).toContain("Read current conflict revision");
    expect(markup).not.toContain("Keep my fields with reviewed revision");
    assertDisabled(markup, "Retry original metadata command");
    assertDisabled(markup, "Discard unsaved metadata");
    client.detail.mockResolvedValueOnce({ data: campaign(6, "Reviewed current name"), etag: '"6"' });
    await controller.readConflict();
    const rendered = render(controller.getSnapshot());
    markup = rendered.markup;
    expect(markup).toContain('value="Original fields"');
    expect(markup).toContain("Reviewed current name");
    expect(markup).toContain("Keep my fields with reviewed revision");
    expect(markup).toContain("Use reviewed current fields");
    expect(markup).toContain("does not send an update");
    expect(rendered.callbacks.onSave).not.toHaveBeenCalled();
  });
  it("does not fetch during server/static rendering or expose session metadata and CSRF", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected static fetch"));
    try {
      const markup = renderToStaticMarkup(
        <CampaignWorkspace
          session={session}
          csrf="private-csrf-never-render"
          online
          syntheticFeaturesEnabled
          accessRevision={2}
          onDirty={vi.fn()}
        />,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(markup).toContain("Campaign drafts");
      expect(markup).not.toContain("private-csrf-never-render");
      expect(markup).not.toContain("Private person never-render");
      expect(markup).not.toContain("Private organization never-render");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

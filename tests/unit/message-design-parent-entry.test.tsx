import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CampaignWorkspace, {
  CampaignSubviewFrame,
  CampaignWorkspaceView,
  campaignDraftsProtected,
  canOpenCampaignSubview,
} from "../../apps/web/components/campaign-workspace";
import {
  CampaignDraftController,
  type CampaignDraftClient,
} from "../../apps/web/components/campaign-draft-protocol";
import {
  MessageDesignController,
  type MessageDesignClient,
} from "../../apps/web/components/message-design-controller";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const id = "e5000000-0000-4000-8000-000000000001";
const campaign = (): Schema<"Campaign"> => ({
  id,
  name: "Private campaign",
  category: "Private category",
  state: "draft",
  version: 1,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(canRead = true, canWrite = true) {
  const client = {
    list: vi.fn<CampaignDraftClient["list"]>(async () => ({
      items: [campaign()],
      nextCursor: null,
      hasMore: false,
    })),
    detail: vi.fn<CampaignDraftClient["detail"]>(async () => ({ data: campaign(), etag: '"1"' })),
    submit: vi.fn<CampaignDraftClient["submit"]>(async (command) => ({
      data: { ...campaign(), ...command.body, version: 2 },
      etag: '"2"',
    })),
  };
  const controller = new CampaignDraftController({
    binding: "private-parent-context",
    client,
    online: true,
    canRead,
    canWrite,
    createKey: () => "private-parent-key",
  });
  const openDesigns = vi.fn();
  const render = (active = true, online = controller.getSnapshot().online) =>
    renderToStaticMarkup(
      <CampaignWorkspaceView
        state={controller.getSnapshot()}
        active={active}
        online={online}
        onCreate={() => false}
        onRefresh={vi.fn()}
        onNext={vi.fn()}
        onSelect={vi.fn()}
        onEdit={vi.fn()}
        onSave={vi.fn()}
        onDiscard={vi.fn()}
        onEditRejected={vi.fn()}
        onReadConflict={vi.fn()}
        onResolveConflict={vi.fn()}
        onOpenWorkflow={vi.fn()}
        onOpenMessageDesigns={openDesigns}
      />,
    );
  return { controller, client, openDesigns, render };
}
function button(markup: string, name: string) {
  return Array.from(markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g), (match) => match[0]).find(
    (html) => html.replace(/<[^>]*>/g, "").trim() === name,
  );
}
const entry = (markup: string) => button(markup, "Open message design library");
const frame = (protectedDraft: boolean) =>
  renderToStaticMarkup(
    <CampaignSubviewFrame
      label="Organization message design library"
      protectedDraft={protectedDraft}
      onBack={vi.fn()}
    >
      <p>Authorized child content</p>
    </CampaignSubviewFrame>,
  );

describe("organization message design library entry and shared protection", () => {
  it("offers explicit organization-level entry without any campaign read or selected campaign", async () => {
    const { controller, client, openDesigns, render } = setup();
    expect(controller.getSnapshot().selected).toBeNull();
    expect(canOpenCampaignSubview(controller.getSnapshot(), true, true)).toBe(true);
    const markup = render();
    expect(entry(markup)).toBeDefined();
    expect(entry(markup)).not.toContain('disabled=""');
    expect(button(markup, "Edit workflow drafts")).toBeUndefined();
    expect(client.detail).not.toHaveBeenCalled();
    expect(openDesigns).not.toHaveBeenCalled();
    await controller.loadPage();
    expect(controller.getSnapshot().selected).toBeNull();
    expect(entry(render())).not.toContain('disabled=""');
    expect(client.detail).not.toHaveBeenCalled();
  });
  it("permits read-only library browsing while hiding it without current read/synthetic access", () => {
    const reader = setup(true, false);
    expect(entry(reader.render())).not.toContain('disabled=""');
    expect(button(reader.render(), "New draft metadata")).toBeUndefined();
    expect(canOpenCampaignSubview(reader.controller.getSnapshot(), true, true)).toBe(true);
    const denied = setup(false);
    expect(entry(denied.render())).toBeUndefined();
    expect(canOpenCampaignSubview(denied.controller.getSnapshot(), true, true)).toBe(false);
    expect(entry(reader.render(false))).toBeUndefined();
    expect(canOpenCampaignSubview(reader.controller.getSnapshot(), false, true)).toBe(false);
  });
  it("checks the current read snapshot rather than a previously clean render", async () => {
    const { controller, client, render } = setup();
    const clean = controller.getSnapshot();
    const current = deferred<Awaited<ReturnType<CampaignDraftClient["list"]>>>();
    client.list.mockReturnValueOnce(current.promise);
    const reading = controller.loadPage();
    expect(canOpenCampaignSubview(clean, true, true)).toBe(true);
    expect(canOpenCampaignSubview(controller.getSnapshot(), true, true)).toBe(false);
    expect(entry(render())).toContain('disabled=""');
    current.resolve({ items: [], nextCursor: null, hasMore: false });
    await reading;
    expect(canOpenCampaignSubview(controller.getSnapshot(), true, true)).toBe(true);
  });
  it("blocks entry for dirty/sending/unknown metadata and masks private command identifiers", async () => {
    const { controller, client, render } = setup();
    await controller.select(id);
    controller.edit("name", "Protected metadata");
    expect(canOpenCampaignSubview(controller.getSnapshot(), true, true)).toBe(false);
    expect(entry(render())).toContain('disabled=""');
    const command = deferred<Awaited<ReturnType<CampaignDraftClient["submit"]>>>();
    client.submit.mockReturnValueOnce(command.promise);
    const saving = controller.save();
    expect(controller.getSnapshot().phase).toBe("sending");
    expect(entry(render())).toContain('disabled=""');
    command.reject(new Error("Acceptance unknown"));
    await saving;
    expect(controller.getSnapshot().phase).toBe("uncertain");
    expect(canOpenCampaignSubview(controller.getSnapshot(), true, true)).toBe(false);
    expect(entry(render())).toContain('disabled=""');
    expect(render()).not.toContain("private-parent-key");
    expect(render()).not.toContain("private-parent-context");
  });
  it("denies entry immediately offline, for a protected sibling and after current capability loss", async () => {
    const { controller, client, render } = setup();
    expect(entry(render(true, false))).toContain('disabled=""');
    expect(canOpenCampaignSubview(controller.getSnapshot(), true, false)).toBe(false);
    expect(canOpenCampaignSubview(controller.getSnapshot(), true, true, true)).toBe(false);
    controller.setOnline(false);
    expect(canOpenCampaignSubview(controller.getSnapshot(), true, true)).toBe(false);
    controller.setOnline(true);
    client.list.mockRejectedValueOnce(new ApiError(403, "private", "entitlement_disabled"));
    await controller.loadPage();
    expect(entry(render())).toBeUndefined();
    expect(canOpenCampaignSubview(controller.getSnapshot(), true, true)).toBe(false);
  });
  it("uses the actual shared Back control for metadata, workflow and design protection", () => {
    for (const states of [
      [true, false, false],
      [false, true, false],
      [false, false, true],
      [true, true, true],
    ] as const) {
      const protectedDraft = campaignDraftsProtected(...states);
      expect(protectedDraft).toBe(true);
      expect(button(frame(protectedDraft), "Back to campaign library")).toContain('disabled=""');
    }
    expect(
      button(frame(campaignDraftsProtected(false, false, false)), "Back to campaign library"),
    ).not.toContain('disabled=""');
    expect(frame(false)).toContain('aria-label="Organization message design library"');
  });
  it("pauses metadata projections without releasing a real unknown design command or auto retrying it", async () => {
    const metadata = setup();
    await metadata.controller.loadPage();
    await metadata.controller.select(id);
    let designProtection = false;
    const client: MessageDesignClient = {
      list: vi.fn(),
      detail: vi.fn(),
      submit: vi.fn(async () => {
        throw new DOMException("Timeout", "AbortError");
      }),
    };
    const design = new MessageDesignController({
      binding: "current-design-context",
      client,
      online: true,
      canRead: true,
      canWrite: true,
      createKey: () => "original-design-key",
      onProtectedChange(value) {
        designProtection = value;
      },
    });
    metadata.controller.setOnline(false);
    expect(metadata.controller.getSnapshot()).toMatchObject({ page: null, selected: null });
    design.beginCreate();
    design.edit("name", "Reviewed message");
    design.editBlock(0, "Static text");
    await design.save();
    const original = design.getSnapshot().pending;
    expect(designProtection).toBe(true);
    metadata.controller.setOnline(false);
    expect(campaignDraftsProtected(metadata.controller.isProtected(), false, designProtection)).toBe(true);
    expect(
      button(
        frame(campaignDraftsProtected(metadata.controller.isProtected(), false, designProtection)),
        "Back to campaign library",
      ),
    ).toContain('disabled=""');
    design.setOnline(false);
    design.setOnline(true);
    expect(design.getSnapshot().pending).toBe(original);
    expect(client.submit).toHaveBeenCalledOnce();
    expect(designProtection).toBe(true);
    expect(design.discard()).toBe(false);
  });
  it("requires a fresh metadata read after a clean return and ignores a retired paused read", async () => {
    const { controller, client } = setup();
    const late = deferred<Awaited<ReturnType<CampaignDraftClient["list"]>>>();
    client.list.mockReturnValueOnce(late.promise);
    const oldRead = controller.loadPage();
    controller.setOnline(false);
    late.resolve({ items: [campaign()], hasMore: false, nextCursor: null });
    await oldRead;
    expect(controller.getSnapshot().page).toBeNull();
    controller.setOnline(true);
    expect(controller.getSnapshot().page).toBeNull();
    await controller.loadPage();
    expect(client.list).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().page!.items[0].id).toBe(id);
    expect(controller.getSnapshot().selected).toBeNull();
  });
  it("does not fetch or serialize member/organization/CSRF during server presentation", () => {
    const session: Schema<"Session"> = {
      userId: id,
      profile: { displayName: "Private name never-render", timezone: "UTC" },
      organizations: [
        {
          id,
          name: "Private organization never-render",
          status: "active",
          timezone: "UTC",
          locale: "en-US",
          version: 1,
        },
      ],
      activeOrgId: id,
      permissions: ["campaigns.read", "campaigns.write"],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected"));
    try {
      const markup = renderToStaticMarkup(
        <CampaignWorkspace
          session={session}
          csrf="private-csrf-never-render"
          online
          syntheticFeaturesEnabled
          accessRevision={4}
          onDirty={vi.fn()}
        />,
      );
      expect(entry(markup)).toBeDefined();
      expect(fetchMock).not.toHaveBeenCalled();
      for (const text of [
        "private-csrf-never-render",
        "Private name never-render",
        "Private organization never-render",
      ])
        expect(markup).not.toContain(text);
    } finally {
      fetchMock.mockRestore();
    }
  });
});

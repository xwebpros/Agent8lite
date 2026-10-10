import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CampaignWorkspaceView } from "../../apps/web/components/campaign-workspace";
import {
  CampaignDraftController,
  type CampaignDraftClient,
} from "../../apps/web/components/campaign-draft-protocol";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const campaignId = "d2000000-0000-4000-8000-000000000001";
const campaign = (version = 1): Schema<"Campaign"> => ({
  id: campaignId,
  name: "Private selected campaign",
  category: "Private category",
  state: "draft",
  version,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const protectedChange = vi.fn();
  const client = {
    list: vi.fn<CampaignDraftClient["list"]>(async () => ({
      items: [campaign()],
      nextCursor: null,
      hasMore: false,
    })),
    detail: vi.fn<CampaignDraftClient["detail"]>(async () => ({
      data: campaign(),
      etag: '"1"',
    })),
    submit: vi.fn<CampaignDraftClient["submit"]>(async (command) => ({
      data: { ...campaign(2), ...command.body },
      etag: '"2"',
    })),
  };
  const controller = new CampaignDraftController({
    binding: "private-integration-context",
    client,
    online: true,
    canRead: true,
    canWrite: true,
    createKey: () => "original-private-metadata-key",
    onProtectedChange: protectedChange,
  });
  const openWorkflow = vi.fn();
  function render(online = controller.getSnapshot().online) {
    return renderToStaticMarkup(
      <CampaignWorkspaceView
        state={controller.getSnapshot()}
        active
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
        onOpenWorkflow={openWorkflow}
      />,
    );
  }
  return { controller, client, protectedChange, openWorkflow, render };
}
function workflowEntry(markup: string) {
  return Array.from(markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g), (match) => match[0]).find(
    (button) => button.replace(/<[^>]*>/g, "").trim() === "Edit workflow drafts",
  );
}
function expectEntry(markup: string, disabled: boolean) {
  const entry = workflowEntry(markup);
  expect(entry).toBeDefined();
  expect(entry!.includes('disabled=""')).toBe(disabled);
}

describe("campaign metadata to workflow entry protocol and presentation", () => {
  it("requires a fresh explicit metadata selection rather than an index or historical receipt", async () => {
    const { controller, client, openWorkflow, render } = fixture();
    expect(workflowEntry(render())).toBeUndefined();
    await controller.loadPage();
    expect(workflowEntry(render())).toBeUndefined();
    expect(client.detail).not.toHaveBeenCalled();
    await controller.select(campaignId);
    expectEntry(render(), false);
    expect(openWorkflow).not.toHaveBeenCalled();
    controller.edit("name", "Saved metadata name");
    await controller.save();
    const receipt = render();
    expect(receipt).toContain("Metadata command acknowledged");
    expect(workflowEntry(receipt)).toBeUndefined();
    await controller.select(campaignId);
    expectEntry(render(), false);
    expect(openWorkflow).not.toHaveBeenCalled();
  });

  it("disables the selected campaign entry while another authorized read is in progress", async () => {
    const { controller, client, render } = fixture();
    await controller.select(campaignId);
    const current = deferred<Awaited<ReturnType<CampaignDraftClient["detail"]>>>();
    client.detail.mockReturnValueOnce(current.promise);
    const reading = controller.select(campaignId);
    expect(controller.getSnapshot().reading).toBe("detail");
    expect(controller.getSnapshot().selected!.data.version).toBe(1);
    expectEntry(render(), true);
    current.resolve({ data: campaign(4), etag: '"4"' });
    await reading;
    expect(controller.getSnapshot().selected!.data.version).toBe(4);
    expectEntry(render(), false);
  });

  it("protects entry synchronously for dirty, sending and unknown commands until original-key acknowledgment", async () => {
    const { controller, client, protectedChange, render } = fixture();
    await controller.select(campaignId);
    controller.edit("name", "Protected metadata name");
    expect(protectedChange).toHaveBeenLastCalledWith(true);
    expectEntry(render(), true);
    const uncertain = deferred<Awaited<ReturnType<CampaignDraftClient["submit"]>>>();
    client.submit.mockReturnValueOnce(uncertain.promise);
    const saving = controller.save();
    expect(controller.getSnapshot().phase).toBe("sending");
    expectEntry(render(), true);
    uncertain.reject(new Error("Transport acceptance unknown"));
    await saving;
    expect(controller.getSnapshot().phase).toBe("uncertain");
    expectEntry(render(), true);
    expect(render()).not.toContain("original-private-metadata-key");
    expect(render()).not.toContain("private-integration-context");
    const original = controller.getSnapshot().pending;
    await controller.save();
    expect(client.submit.mock.calls[1][0]).toEqual(original);
    expect(controller.isProtected()).toBe(false);
    expect(protectedChange).toHaveBeenLastCalledWith(false);
    expect(workflowEntry(render())).toBeUndefined();
    await controller.select(campaignId);
    expectEntry(render(), false);
  });

  it("blocks entry immediately offline and retains an uncertain command without automatic retry on reconnect", async () => {
    const { controller, client, render } = fixture();
    await controller.select(campaignId);
    // Offline props mask controls before the controller's lifecycle effect runs.
    expectEntry(render(false), true);
    controller.edit("category", "Protected category");
    client.submit.mockRejectedValueOnce(new Error("Unknown result"));
    await controller.save();
    const original = controller.getSnapshot().pending;
    controller.setOnline(false);
    expect(controller.getSnapshot().pending).toBe(original);
    expectEntry(render(), true);
    controller.setOnline(true);
    expect(controller.getSnapshot().pending).toBe(original);
    expect(controller.isProtected()).toBe(true);
    expectEntry(render(), true);
    expect(client.submit).toHaveBeenCalledOnce();
    await controller.loadPage();
    expect(client.list).not.toHaveBeenCalled();
    expectEntry(render(), true);
  });

  it("removes the entry and private selection on current authority denial and ignores a retired read", async () => {
    const { controller, client, render } = fixture();
    await controller.select(campaignId);
    client.list.mockRejectedValueOnce(new ApiError(403, "Private denial", "permission_denied"));
    await controller.loadPage();
    expect(controller.getSnapshot().selected).toBeNull();
    expect(workflowEntry(render())).toBeUndefined();
    expect(render()).not.toContain("Private selected campaign");

    const replacement = fixture();
    const retired = deferred<Awaited<ReturnType<CampaignDraftClient["detail"]>>>();
    replacement.client.detail.mockReturnValueOnce(retired.promise);
    const reading = replacement.controller.select(campaignId);
    replacement.controller.detach();
    replacement.controller.attach();
    retired.resolve({ data: campaign(), etag: '"1"' });
    await reading;
    expect(replacement.controller.getSnapshot().selected).toBeNull();
    expect(workflowEntry(replacement.render())).toBeUndefined();
    await replacement.controller.select(campaignId);
    expectEntry(replacement.render(), false);
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import MessageDesignWorkspace, {
  MessageDesignView,
  type MessageDesignActions,
} from "../../apps/web/components/message-design-workspace";
import {
  MessageDesignController,
  type MessageDesignClient,
} from "../../apps/web/components/message-design-controller";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const id = "e4000000-0000-4000-8000-000000000001";
const entity = (): Schema<"MessageDesign"> => ({
  id,
  name: "Private design",
  channel: "email",
  editor: "native",
  subject: null,
  design: {
    schemaVersion: 1,
    blocks: [
      { type: "text", text: "First paragraph" },
      { type: "text", text: "Second paragraph" },
    ],
  },
  content: "First paragraph\nSecond paragraph",
  version: 1,
});
const actions: MessageDesignActions = {
  refresh: vi.fn(),
  next: vi.fn(),
  select: vi.fn(),
  begin: vi.fn(),
  copy: vi.fn(),
  edit: vi.fn(),
  block: vi.fn(),
  blocks: vi.fn(),
  save: vi.fn(),
  discard: vi.fn(),
  editRejected: vi.fn(),
  copyImmutable: vi.fn(),
  readConflict: vi.fn(),
  resolveConflict: vi.fn(),
};
function setup(canWrite = true) {
  const client = {
    list: vi.fn<MessageDesignClient["list"]>(async () => ({
      items: [entity()],
      nextCursor: "private-cursor",
      hasMore: true,
    })),
    detail: vi.fn<MessageDesignClient["detail"]>(async () => ({ data: entity(), etag: '"1"' })),
    submit: vi.fn<MessageDesignClient["submit"]>(async (command) => ({
      data: { ...entity(), ...command.body, version: command.kind === "create" ? 1 : 2 },
      etag: command.kind === "create" ? '"1"' : '"2"',
    })),
  };
  const controller = new MessageDesignController({
    binding: "private-context-never-render",
    client,
    online: true,
    canRead: true,
    canWrite,
    createKey: () => "private-command-key-never-render",
  });
  const render = (active = true, online = controller.getSnapshot().online) =>
    renderToStaticMarkup(
      <MessageDesignView
        state={controller.getSnapshot()}
        active={active}
        online={online}
        actions={actions}
      />,
    );
  return { controller, client, render };
}
function button(markup: string, name: string) {
  return Array.from(markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g), (match) => match[0]).find(
    (html) => html.replace(/<[^>]*>/g, "").trim() === name,
  );
}
function disabled(markup: string, name: string) {
  expect(button(markup, name), name).toBeDefined();
  expect(button(markup, name)).toContain('disabled=""');
}
const session: Schema<"Session"> = {
  userId: id,
  profile: { displayName: "Private user never-render", timezone: "UTC" },
  organizations: [
    {
      id,
      name: "Private tenant never-render",
      status: "active",
      timezone: "UTC",
      locale: "en-US",
      version: 1,
    },
  ],
  activeOrgId: id,
  permissions: ["campaigns.read", "campaigns.write"],
};

describe("native text draft accessible and private presentation", () => {
  it("distinguishes disabled, unread and unavailable capability from an empty successful list", async () => {
    const { controller, client, render } = setup();
    expect(render(false)).toContain("Synthetic message drafts unavailable");
    expect(render()).toContain("The message design index has not been read successfully.");
    client.list.mockRejectedValueOnce(new ApiError(403, "Private entitlement", "entitlement_disabled"));
    await controller.loadPage();
    const markup = render();
    expect(markup).toContain("Message capability or resource unavailable");
    expect(markup).not.toContain("No designs are present");
    expect(markup).not.toContain("Private entitlement");
    expect(markup).not.toContain("New native design");
  });
  it("labels native form controls uniquely, provides ordered blocks and disables boundary reorder actions", async () => {
    const { controller, render } = setup();
    await controller.select(id);
    const markup = render();
    expect(markup).toContain("<ol");
    expect(markup).toContain("Text block 1");
    expect(markup).toContain("Text block 2");
    const labels = Array.from(markup.matchAll(/<label for="([^"]+)">([^<]+)<\/label>/g));
    expect(labels.map((match) => match[2])).toEqual([
      "Design name",
      "Message channel",
      "Subject (optional)",
      "Text block 1",
      "Text block 2",
    ]);
    expect(new Set(labels.map((match) => match[1])).size).toBe(5);
    for (const match of labels) expect(markup).toContain(`id="${match[1]}"`);
    expect(markup).toMatch(/<select[^>]*disabled=""/);
    expect(markup).toContain('aria-label="Move text block 1 up"');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Move text block 1 up"/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Move text block 2 down"/);
    expect(markup).toContain("Blocks are joined with one newline.");
    expect(markup).toContain("no SMS segment or price estimate");
  });
  it("exposes human field issues with native aria-invalid references and preserves rejected text", async () => {
    const { controller, render } = setup();
    await controller.select(id);
    controller.editBlock(0, "{{name}}");
    await controller.save();
    const markup = render();
    expect(markup).toContain("Text block 1: Use nonblank static text");
    expect(markup).toMatch(/<textarea[^>]*aria-invalid="true"[^>]*aria-describedby="[^"]+"/);
    expect(markup).toContain("{{name}}");
  });
  it("escapes old content and marks unrecognized editors read-only without execution/conversion controls", async () => {
    const { controller, client, render } = setup();
    client.detail.mockResolvedValueOnce({
      data: {
        ...entity(),
        editor: "unlayer",
        subject: "<img onerror=secret>",
        design: { html: "<script>secret()</script>" },
        content: "<script>secret()</script>",
      },
      etag: '"1"',
    });
    await controller.select(id);
    const markup = render();
    expect(markup).toContain("Read-only original message design");
    expect(markup).toContain("&lt;script&gt;secret()&lt;/script&gt;");
    expect(markup).toContain("&lt;img onerror=secret&gt;");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("Private native text fields");
    expect(button(markup, "Copy to new design")).toBeUndefined();
    expect(button(markup, "Save design changes")).toBeUndefined();
  });
  it("locks unknown original input, navigation, copy and discard without leaking command keys", async () => {
    const { controller, client, render } = setup();
    await controller.loadPage();
    await controller.select(id);
    controller.edit("name", "Protected native draft");
    client.submit.mockRejectedValueOnce(new Error("Unknown transport"));
    await controller.save();
    const markup = render();
    expect(markup).toContain("Protected native draft");
    expect(markup).toContain('<fieldset disabled="">');
    expect(markup).toContain("Retry original design command");
    for (const name of [
      "Refresh designs",
      "Read next design page",
      "New native design",
      "Copy to new design",
      "Discard unsaved design",
    ])
      disabled(markup, name);
    expect(markup).not.toContain("private-command-key-never-render");
    expect(markup).not.toContain("private-context-never-render");
    expect(button(markup, "Prepare new-ID copy")).toBeUndefined();
  });
  it("offers an explicit reviewed copy for referenced designs and keeps saving separate", async () => {
    const { controller, client, render } = setup();
    await controller.select(id);
    controller.editBlock(0, "Changed draft");
    client.submit.mockRejectedValueOnce(new ApiError(409, "private", "design_referenced_immutable"));
    await controller.save();
    const markup = render();
    expect(markup).toContain("Referenced immutable design review");
    expect(markup).toContain("Preparing a copy creates no record until you separately save with a new ID.");
    expect(button(markup, "Prepare new-ID copy")).not.toContain('disabled=""');
    disabled(markup, "Retry original design command");
    expect(client.submit).toHaveBeenCalledOnce();
  });
  it("masks fetched design/index/receipt immediately offline but preserves locked local fields", async () => {
    const { controller, render } = setup();
    await controller.loadPage();
    await controller.select(id);
    controller.edit("name", "Local native fields");
    const beforeEffect = render(true, false);
    expect(beforeEffect).not.toContain("Read version 1");
    expect(beforeEffect).not.toContain("Read next design page");
    expect(beforeEffect).not.toContain("private-cursor");
    controller.setOnline(false);
    const markup = render();
    expect(markup).toContain("Local native fields");
    expect(markup).toContain('<fieldset disabled="">');
    disabled(markup, "Save design changes");
    expect(markup).not.toContain("Version 1");
  });
  it("distinguishes read-only permissions and historical receipts from active editing or sending", async () => {
    const readonly = setup(false);
    await readonly.controller.select(id);
    const readMarkup = readonly.render();
    expect(readMarkup).toContain("Read-only access.");
    expect(readMarkup).toContain('<fieldset disabled="">');
    expect(button(readMarkup, "Save design changes")).toBeUndefined();
    const { controller, render } = setup();
    await controller.select(id);
    controller.edit("name", "Acknowledged draft");
    await controller.save();
    const markup = render();
    expect(markup).toContain("Receipt version 2 may be historical.");
    expect(markup).toContain("Read current acknowledged design");
    expect(markup).not.toContain('value="Acknowledged draft"');
    const names = Array.from(markup.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g), (match) =>
      match[1].replace(/<[^>]*>/g, ""),
    );
    expect(names.some((name) => /send|publish|enroll|activate/i.test(name))).toBe(false);
  });
  it("does not fetch or serialize identity/CSRF/private content during static rendering", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected"));
    try {
      const markup = renderToStaticMarkup(
        <MessageDesignWorkspace
          session={session}
          csrf="private-csrf-never-render"
          online
          syntheticFeaturesEnabled
          accessRevision={1}
          onProtectedChange={vi.fn()}
        />,
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(markup).toContain("Native text designs");
      for (const text of [
        "private-csrf-never-render",
        "Private user never-render",
        "Private tenant never-render",
      ])
        expect(markup).not.toContain(text);
    } finally {
      fetchMock.mockRestore();
    }
  });
});

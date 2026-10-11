import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  RecordArchiveProtocol,
  recordArchiveContext,
  type RecordArchiveCommand,
} from "../../apps/web/components/record-archive";
import { RecordArchiveController } from "../../apps/web/components/record-archive-controller";
import { ApiError } from "../../apps/web/lib/api";

const workspace = path.join(process.cwd(), "apps/web/components/workspace.tsx");

/** Execute only the actual named workspace function; this is not a browser or mounted-workspace claim. */
function workspaceFunction(name: string, scope: Record<string, unknown>) {
  const text = readFileSync(workspace, "utf8");
  const source = ts.createSourceFile(workspace, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node;
    else ts.forEachChild(node, visit);
  };
  visit(source);
  if (!declaration) throw new Error(`The actual workspace function ${name} is missing.`);
  const compiled = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function("scope", `with (scope) { ${compiled}\nreturn ${name}; }`)(
    new Proxy(scope, { has: (_, key) => typeof key === "string" && key in scope }),
  ) as (...args: unknown[]) => Promise<void>;
}

const org = "af000000-0000-4000-8000-000000000001",
  contactId = "af000000-0000-4000-8000-000000000004",
  leadId = "af000000-0000-4000-8000-000000000005",
  key = "af000000-0000-4000-8000-000000000006",
  csrf = "synthetic-csrf";
const active = {
  userId: "af000000-0000-4000-8000-000000000002",
  activeOrgId: org,
  organizations: [],
  permissions: ["crm.contacts.write", "crm.leads.write"],
  profile: { displayName: "Synthetic", timezone: "UTC" },
};
const binding = recordArchiveContext({
  session: active,
  memberId: "af000000-0000-4000-8000-000000000003",
  csrf,
  accessRevision: 1,
})!;
const job = (kind = "crm.contact.archived") => ({
  id: key,
  state: "succeeded",
  kind,
  createdAt: "2026-10-11T10:00:00.000Z",
});

function harness(
  request: (command: RecordArchiveCommand) => Promise<{ data: unknown; etag: string | null }>,
) {
  const protocol = new RecordArchiveProtocol();
  protocol.bind(binding);
  const controller = new RecordArchiveController(protocol, request);
  const ui = {
    binding,
    online: true,
    visible: true,
    changingOrganization: false,
    busy: false,
    loading: false,
    detailLoading: false,
    dirty: false,
    noteDirty: false,
    tagDirty: false,
    modal: null,
    view: "contacts",
    detailKind: "contact",
    detailId: contactId,
    contact: null as unknown,
    lead: null as unknown,
    csrf,
  };
  const scope = {
    retainedSession: { current: active },
    recordArchive: { current: protocol },
    archiveController: { current: controller },
    currentArchiveUI: { current: ui },
    currentArchiveBinding: { current: binding },
    contactLifetimeActive: { current: true },
    archiveAllowed: vi.fn(() => true),
    archiveRefreshAllowed: vi.fn(() => true),
    reloadProtected: { current: false },
    refreshEpoch: { current: 0 },
    emptyData: {},
    setData: vi.fn(),
    setRefreshed: vi.fn(),
    setBusy: vi.fn(),
    setDetailError: vi.fn(),
    setError: vi.fn(),
    setNotice: vi.fn(),
    setDirty: vi.fn(),
    updateArchive: vi.fn(),
    clearArchiveTargetDetail: vi.fn(),
    clearRecordArchiveAccess: vi.fn(),
    refresh: vi.fn(async () => {}),
    router: { push: vi.fn() },
    selectedContactBinding: { current: "contact-read" },
    currentContactBinding: { current: "contact-read" },
    selectedLeadBinding: { current: "lead-read" },
    currentLeadReadBinding: { current: "lead-read" },
    selectedLeadETag: { current: '"3"' },
    crypto: { randomUUID: () => key },
    Boolean,
  };
  scope.archiveAllowed = vi.fn(() => true);
  return { protocol, controller, ui, scope };
}
const contact = { id: contactId, version: 3, displayName: "Synthetic", emails: [], phones: [] };

describe("ADR-047 actual workspace archive wiring", () => {
  it("acknowledgement closes the drawer, clears the selection and refreshes through the authorized path", async () => {
    const request = vi.fn(async (_command: unknown) => ({ data: job(), etag: '"4"' }));
    const { protocol, ui, scope } = harness(request);
    ui.contact = contact;
    await workspaceFunction("startRecordArchive", {
      ...scope,
      runRecordArchive: workspaceFunction("runRecordArchive", scope),
    })("contact", contact, binding);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toMatchObject({
      kind: "contact",
      resourceId: contactId,
      version: 3,
      key,
    });
    expect(scope.reloadProtected.current).toBe(true);
    expect(scope.setData).toHaveBeenCalledWith(scope.emptyData);
    expect(scope.clearArchiveTargetDetail).toHaveBeenCalledWith("contact");
    expect(scope.router.push).toHaveBeenCalledWith("/contacts");
    expect(scope.refresh).toHaveBeenCalledWith(active);
    expect(scope.setBusy).toHaveBeenLastCalledWith(false);
    expect(protocol.getSnapshot()).toMatchObject({ phase: "acknowledged", command: null });
  });
  it("a lead whose loaded ETag does not match its version cannot begin", async () => {
    const request = vi.fn();
    const { protocol, ui, scope } = harness(request);
    const lead = { id: leadId, version: 5 };
    ui.detailKind = "lead";
    ui.detailId = leadId;
    ui.lead = lead;
    await workspaceFunction("startRecordArchive", {
      ...scope,
      runRecordArchive: workspaceFunction("runRecordArchive", scope),
    })("lead", lead, binding);
    expect(request).not.toHaveBeenCalled();
    expect(protocol.getSnapshot().command).toBeNull();
  });
  it("a record other than the drawer's loaded record cannot begin", async () => {
    const request = vi.fn();
    const { protocol, ui, scope } = harness(request);
    ui.contact = { ...contact };
    await workspaceFunction("startRecordArchive", {
      ...scope,
      runRecordArchive: workspaceFunction("runRecordArchive", scope),
    })("contact", contact, binding);
    expect(request).not.toHaveBeenCalled();
    expect(protocol.getSnapshot().command).toBeNull();
  });

  function begun(
    request: (command: RecordArchiveCommand) => Promise<{ data: unknown; etag: string | null }>,
  ) {
    const h = harness(request);
    const command = h.controller.begin({ kind: "contact", resourceId: contactId, version: 3 }, key);
    return { ...h, command, run: workspaceFunction("runRecordArchive", h.scope) };
  }
  it("active-lead refusal keeps the drawer open, releases busy and rereads lists", async () => {
    const v = begun(async () => {
      throw new ApiError(409, "x", "contact_has_active_leads");
    });
    await v.run(v.command, "send");
    expect(v.protocol.getSnapshot()).toMatchObject({ phase: "blocked", command: null });
    expect(v.scope.router.push).not.toHaveBeenCalled();
    expect(v.scope.clearArchiveTargetDetail).not.toHaveBeenCalled();
    expect(v.scope.refresh).toHaveBeenCalledWith(active);
    expect(v.scope.setBusy).toHaveBeenLastCalledWith(false);
  });
  it("initial 404 clears the unavailable record's private detail", async () => {
    const v = begun(async () => {
      throw new ApiError(404, "x", "resource_unavailable");
    });
    await v.run(v.command, "send");
    expect(v.scope.clearArchiveTargetDetail).toHaveBeenCalledWith("contact");
    expect(v.scope.router.push).not.toHaveBeenCalled();
  });
  it("unknown outcome retains the command, blocks refresh and keeps the drawer", async () => {
    const v = begun(async () => {
      throw new TypeError("network");
    });
    await v.run(v.command, "send");
    expect(v.protocol.getSnapshot()).toMatchObject({ phase: "unknown", command: v.command });
    expect(v.scope.refresh).not.toHaveBeenCalled();
    expect(v.scope.router.push).not.toHaveBeenCalled();
    expect(v.scope.reloadProtected.current).toBe(true);
    expect(v.scope.setBusy).toHaveBeenLastCalledWith(false);
  });
  it("reconciliation resends the same key and then acknowledges", async () => {
    let calls = 0;
    const request = vi.fn(async (_command: unknown) => {
      if (++calls === 1) throw new TypeError("network");
      return { data: job(), etag: '"4"' };
    });
    const v = begun(request);
    await v.run(v.command, "send");
    await v.run(v.command, "reconcile");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]![0]).toBe(v.command);
    expect(v.scope.router.push).toHaveBeenCalledWith("/contacts");
  });
  it.each([401, 403])("%s clears archive access and private state without refreshing", async (status) => {
    const v = begun(async () => {
      throw new ApiError(status, "x");
    });
    await v.run(v.command, "send");
    expect(v.scope.clearRecordArchiveAccess).toHaveBeenCalledTimes(1);
    expect(v.scope.refresh).not.toHaveBeenCalled();
    expect(v.scope.router.push).not.toHaveBeenCalled();
  });
  it("a late success after binding loss applies no effects", async () => {
    let resolve!: (value: { data: unknown; etag: string | null }) => void;
    const v = begun(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = v.run(v.command, "send");
    v.protocol.bind(null);
    resolve({ data: job(), etag: '"4"' });
    await pending;
    expect(v.scope.router.push).not.toHaveBeenCalled();
    expect(v.scope.refresh).not.toHaveBeenCalled();
    expect(v.scope.clearArchiveTargetDetail).not.toHaveBeenCalled();
    expect(v.scope.setNotice).not.toHaveBeenCalledWith(expect.stringContaining("acknowledged"));
  });
  it("a failed live guard sends nothing", async () => {
    const request = vi.fn();
    const v = begun(request);
    v.scope.archiveAllowed = vi.fn(() => false);
    await workspaceFunction("runRecordArchive", v.scope)(v.command, "send");
    expect(request).not.toHaveBeenCalled();
    expect(v.scope.setBusy).not.toHaveBeenCalled();
  });
});

describe("ADR-047 workspace lifecycle guards include the archive command", () => {
  const text = readFileSync(workspace, "utf8");
  function body(name: string) {
    const source = ts.createSourceFile(workspace, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let found = "";
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(source);
      else ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }
  it.each([
    "command",
    "loadMore",
    "continueInvitation",
    "closeModal",
    "closeDetail",
    "openModal",
    "switchOrganization",
    "logout",
    "reviewContact",
    "sendContactEdit",
    "reconcileContactEdit",
    "releaseForgottenRecoveryProtection",
    "leadCaptureAllowed",
    "taskCreateAllowed",
    "taskEditAllowed",
    "assignmentAllowed",
    "stageAllowed",
  ])("%s checks the retained archive command", (name) => {
    expect(body(name)).toContain("recordArchive.current.getSnapshot().command");
  });
  it.each(["switchOrganization", "logout", "closeDetail", "continueInvitation"])(
    "%s refuses with an explicit archive message",
    async (name) => {
      const setError = vi.fn();
      const fn = workspaceFunction(name, {
        taskCreate: { current: { getSnapshot: () => ({ command: null }) } },
        recordArchive: { current: { getSnapshot: () => ({ command: { kind: "contact" } }) } },
        setError,
        busy: false,
        online: true,
        window: { confirm: () => true },
      });
      await fn("x");
      expect(setError).toHaveBeenCalledWith(expect.stringContaining("unconfirmed archive"));
    },
  );
  it("refresh, reload protection, service-worker activation and link capture include the archive", () => {
    expect(text).toMatch(
      /taskCreate\.current\.getSnapshot\(\)\.command \|\|\s+recordArchive\.current\.getSnapshot\(\)\.command\s+\) \{\s+setLoading\(false\)/,
    );
    expect(text).toContain("Boolean(recordArchive.current.getSnapshot().command);");
    expect(text).toContain("The app update activated. Reconcile the unconfirmed archive before reloading.");
    expect(text).toContain("Reconcile the unconfirmed archive before navigating away.");
  });
});

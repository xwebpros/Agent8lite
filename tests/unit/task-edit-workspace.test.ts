import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

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
  // Sloppy-mode `with` resolves every free identifier against the explicit stub scope only.
  return new Function("scope", `with (scope) { ${compiled}\nreturn ${name}; }`)(
    new Proxy(scope, { has: (_, key) => typeof key === "string" && key in scope }),
  ) as (...args: unknown[]) => Promise<void>;
}

class ApiError extends Error {
  constructor(readonly status: number) {
    super("api");
  }
}

const task = (overrides: Record<string, unknown> = {}) => ({
  id: "0f0e0d0c-0b0a-4908-8706-050403020100",
  version: 3,
  state: "open",
  title: "Call back",
  assigneeMemberId: "11111111-1111-4111-8111-111111111111",
  dueAt: "2026-10-12T17:00:00.000Z",
  timezone: "America/Los_Angeles",
  priority: "normal",
  leadId: null,
  ...overrides,
});

describe("ADR-046 actual workspace Task completion wiring", () => {
  function completionScope(rows: object[]) {
    const begin = vi.fn((input: { task: unknown }) => ({ input }));
    const sendTaskEdit = vi.fn(async () => {});
    const scope = {
      taskEditBinding: "binding-1",
      currentTaskEditUI: { current: { tasks: rows, binding: "binding-1" } },
      taskEditAllowed: () => true,
      reloadProtected: { current: false },
      taskEdit: { current: { getSnapshot: () => ({ phase: "idle" }), begin } },
      requireTaskEditTask: (value: unknown) => value,
      crypto: { randomUUID: () => "22222222-2222-4222-8222-222222222222" },
      sendTaskEdit,
      contactLifetimeActive: { current: true },
      setError: vi.fn(),
      Object,
    };
    return { scope, begin, sendTaskEdit };
  }

  it("starts agenda completion from the loaded row when given a detached agenda snapshot", async () => {
    const loaded = task();
    const { scope, begin, sendTaskEdit } = completionScope([loaded]);
    const completeTask = workspaceFunction("completeTask", scope);
    await completeTask({ ...loaded, id: loaded.id.toUpperCase() });
    expect(begin).toHaveBeenCalledTimes(1);
    expect(begin.mock.calls[0][0].task).toBe(loaded);
    expect(begin.mock.calls[0][0]).toMatchObject({ body: { state: "done", title: "Call back" } });
    expect(sendTaskEdit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a different loaded version", { version: 4 }],
    ["an already completed row", { state: "done" }],
    ["another task", { id: "99999999-9999-4999-8999-999999999999" }],
  ])("sends nothing for %s", async (_, change) => {
    const { scope, begin, sendTaskEdit } = completionScope([task(change)]);
    await workspaceFunction("completeTask", scope)(task());
    expect(begin).not.toHaveBeenCalled();
    expect(sendTaskEdit).not.toHaveBeenCalled();
  });
});

describe("ADR-046 actual workspace Task rejection handling", () => {
  function rejectionScope(status: number, draftTaskId: string | null) {
    const command = {
      taskId: task().id,
      context: "binding-1",
      ifMatch: '"3"',
    };
    const ui = {
      binding: "binding-1",
      online: true,
      visible: true,
      changingOrganization: false,
      detailKind: draftTaskId ? "task" : null,
      detailId: draftTaskId,
      dirty: false,
      busy: false,
      csrf: "csrf",
    };
    const setDirty = vi.fn();
    const refresh = vi.fn(async () => {});
    const active = { activeOrgId: "33333333-3333-4333-8333-333333333333" };
    const scope = {
      currentTaskEditUI: { current: ui },
      retainedSession: { current: active },
      taskEdit: {
        current: {
          isCurrent: () => true,
          canRetry: () => true,
          isBoundTo: (binding: string) => binding === "binding-1",
          reject: () => "cleared",
          acknowledge: () => true,
        },
      },
      taskEditAllowed: () => true,
      reloadProtected: { current: false },
      activeTaskEdit: { current: null },
      detailEpoch: { current: 0 },
      selectedTaskBinding: { current: null },
      selectedTaskETag: { current: null },
      currentTaskReadBinding: { current: "binding-1" },
      contactLifetimeActive: { current: true },
      taskEditDraftSource: {
        current: draftTaskId ? { binding: "binding-1", task: task({ id: draftTaskId }) } : null,
      },
      currentTaskEditDraft: { current: draftTaskId ? { title: "draft" } : null },
      emptyData: {},
      taskEditRequest: async () => {
        throw new ApiError(status);
      },
      ApiError,
      clearTaskEditAccess: vi.fn(),
      clearTaskEditDetail: vi.fn(),
      refresh,
      setSelectedTask: vi.fn(),
      setData: vi.fn(),
      setRefreshed: vi.fn(),
      setDirty,
      setBusy: vi.fn(),
      setError: vi.fn(),
      setDetailError: vi.fn(),
      setNotice: vi.fn(),
      setTaskEditDraft: vi.fn(),
      updateTaskEdit: vi.fn(),
      reviewTaskEdit: vi.fn(),
      navigator: { onLine: true },
      document: { visibilityState: "visible" },
    };
    return { scope, command, ui, setDirty, refresh, active };
  }

  it("a 412 on list or agenda completion does not mark the workspace dirty and reloads lists", async () => {
    const { scope, command, ui, setDirty, refresh, active } = rejectionScope(412, null);
    await workspaceFunction("sendTaskEdit", scope)(command);
    expect(ui.dirty).toBe(false);
    expect(setDirty).not.toHaveBeenCalledWith(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(active);
  });

  it("a 412 on a drawer save retains the human draft as dirty without reloading over it", async () => {
    const { scope, command, ui, setDirty, refresh } = rejectionScope(412, task().id);
    await workspaceFunction("sendTaskEdit", scope)(command);
    expect(ui.dirty).toBe(true);
    expect(setDirty).toHaveBeenLastCalledWith(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([401, 403])("access denial %s clears authority and does not reload", async (status) => {
    const { scope, command, refresh } = rejectionScope(status, null);
    await workspaceFunction("sendTaskEdit", scope)(command);
    expect(scope.clearTaskEditAccess).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });
});

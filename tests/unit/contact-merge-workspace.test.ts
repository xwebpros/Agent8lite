import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workspacePath = path.join(process.cwd(), "apps/web/components/workspace.tsx");
const workspaceSource = readFileSync(workspacePath, "utf8");

describe("ADR-049 workspace source-wiring: ContactMergeProtocol", () => {
  it("imports ContactMergeProtocol and contactMergeContext from contact-merge", () => {
    expect(workspaceSource).toContain("ContactMergeProtocol");
    expect(workspaceSource).toContain("contactMergeContext");
    expect(workspaceSource).toContain('from "./contact-merge"');
  });

  it("imports ContactMergeController from contact-merge-controller", () => {
    expect(workspaceSource).toContain("ContactMergeController");
    expect(workspaceSource).toContain('from "./contact-merge-controller"');
  });

  it("instantiates ContactMergeProtocol via useRef", () => {
    expect(workspaceSource).toContain("new ContactMergeProtocol()");
    expect(workspaceSource).toContain("new ContactMergeController(contactMerge.current)");
  });

  it("binds contactMerge in access-refresh path", () => {
    expect(workspaceSource).toContain(
      "contactMerge.current.bind(nextContactMergeBinding)",
    );
    expect(workspaceSource).toContain("setContactMergeDenied(false)");
    expect(workspaceSource).toContain("updateContactMerge(");
  });

  it("binds null on cleanup", () => {
    expect(workspaceSource).toContain("contactMerge.current.bind(null)");
    expect(workspaceSource).toContain("currentContactMergeBinding.current = null");
  });

  it("sets contactMergeDenied(true) in clearRecordArchiveAccess", () => {
    // clearRecordArchiveAccess covers org-switch and sign-out
    const clearFn = workspaceSource.slice(
      workspaceSource.indexOf("function clearRecordArchiveAccess()"),
      workspaceSource.indexOf("function archiveAllowed("),
    );
    expect(clearFn).toContain("setContactMergeDenied(true)");
    expect(clearFn).toContain("contactMerge.current.bind(null)");
  });

  it("contactMergePending is included in the unsaved flag", () => {
    // The unsaved variable is the guard that blocks org-switch / sign-out
    expect(workspaceSource).toContain("contactMergePending");
    const unsavedIdx = workspaceSource.indexOf("const unsaved =");
    const unsavedEnd = workspaceSource.indexOf(";", unsavedIdx);
    const unsavedBlock = workspaceSource.slice(unsavedIdx, unsavedEnd + 1);
    expect(unsavedBlock).toContain("contactMergePending");
  });

  it("contactMerge pending command throws in the command() helper", () => {
    const commandFnIdx = workspaceSource.indexOf("async function command<T>(");
    const commandFnEnd = workspaceSource.indexOf("\n  async function ", commandFnIdx + 1);
    const commandFn = workspaceSource.slice(commandFnIdx, commandFnEnd);
    expect(commandFn).toContain("contactMerge.current.getSnapshot().command");
    expect(commandFn).toContain("Reconcile the unconfirmed merge before another command.");
  });

  it("contactMerge pending command guards loadMore", () => {
    const loadFnIdx = workspaceSource.indexOf("async function loadMore(");
    const loadFnEnd = workspaceSource.indexOf("\n  async function ", loadFnIdx + 1);
    const loadFn = workspaceSource.slice(loadFnIdx, loadFnEnd);
    expect(loadFn).toContain("contactMerge.current.getSnapshot().command");
  });

  it("SW-reload notice includes contactMerge pending command check", () => {
    // The setNotice call is inside the changed() function
    const changedIdx = workspaceSource.indexOf("const changed = () => {");
    const changedEnd = workspaceSource.indexOf("\n    if ('serviceWorker'", changedIdx);
    const changedFn = workspaceSource.slice(changedIdx, changedEnd);
    expect(changedFn).toContain("contactMerge.current.getSnapshot().command");
    expect(changedFn).toContain("Reconcile the unconfirmed merge before reloading.");
  });

  it("contactMerge.current.getSnapshot().command appears in all six otherProtected locations", () => {
    let idx = 0;
    let count = 0;
    const needle = "contactMerge.current.getSnapshot().command";
    while ((idx = workspaceSource.indexOf(needle, idx)) !== -1) {
      count++;
      idx += needle.length;
    }
    // At least 6 otherProtected + 1 command throw + 1 loadMore + 1 SW notice = 9 minimum
    expect(count).toBeGreaterThanOrEqual(9);
  });
});

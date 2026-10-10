import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const workspace = path.join(process.cwd(), "apps/web/components/workspace.tsx");
/** Execute only the actual JSX callback expression; this is not a browser or mounted-workspace claim. */
function callback(
  panel: "ContactEditPanel" | "LeadCapturePanel",
  command: object,
  handler: (command: unknown) => void,
) {
  const text = readFileSync(workspace, "utf8");
  const source = ts.createSourceFile(workspace, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === panel) {
      const attribute = node.attributes.properties.find(
        (property) => ts.isJsxAttribute(property) && property.name.getText(source) === "onForget",
      );
      if (
        attribute &&
        ts.isJsxAttribute(attribute) &&
        attribute.initializer &&
        ts.isJsxExpression(attribute.initializer)
      )
        expression = attribute.initializer.expression;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!expression) throw new Error("The actual workspace forgetting callback is missing.");
  const compiled = ts.transpileModule("const selectedCallback = (" + expression.getText(source) + ");", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(
    "forgetContactRecovery",
    "forgetLeadRecovery",
    "contactSnapshot",
    "leadSnapshot",
    compiled + "\nreturn selectedCallback;",
  )(handler, handler, { command }, { command }) as (event: unknown) => void;
}

describe("ADR-042 actual workspace callback expression wiring without browser automation", () => {
  it.each(["ContactEditPanel", "LeadCapturePanel"] as const)(
    "%s passes the rendered command identity instead of React's click event",
    (panel) => {
      const command = Object.freeze({ identity: "original rendered command" });
      const handler = vi.fn<(command: unknown) => void>();
      const onForget = callback(panel, command, handler);
      const event = Object.freeze({ type: "click", currentTarget: "synthetic native button" });
      onForget(event);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]).toEqual([command]);
      expect(handler.mock.calls[0][0]).not.toBe(event);
    },
  );
});

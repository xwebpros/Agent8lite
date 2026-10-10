import { readFile } from "node:fs/promises";
import path from "node:path";

// Install/demo compatibility only. Full application tools retain .node-version.
export const hostedDemoNodeRange = ">=22.13.0 <23 || >=24.0.0 <25";
function stableVersion(value, prefix = "v") {
  if (typeof value !== "string") return null;
  const match = new RegExp(`^${prefix}(0|[1-9][0-9]{0,3})\\.(0|[1-9][0-9]{0,3})\\.(0|[1-9][0-9]{0,3})$`).exec(
    value,
  );
  return match ? match.slice(1).map(Number) : null;
}
export async function readPinnedNode(directory) {
  const pin = (await readFile(path.join(directory, ".node-version"), "utf8")).trim();
  if (!stableVersion(pin, "")) throw new Error("node_pin_configuration_invalid");
  return pin;
}
export function nodeRuntimeAllowed(version, pin, demo = false) {
  const parsed = stableVersion(version);
  if (!parsed || !stableVersion(pin, "")) return false;
  if (demo !== true) return version === `v${pin}`;
  return parsed[0] === 24 || (parsed[0] === 22 && parsed[1] >= 13);
}
export class NodeRuntimeError extends Error {
  #diagnostic;
  constructor(code, version, pin, demo) {
    super(code);
    this.name = "NodeRuntimeError";
    this.#diagnostic = Object.freeze({
      node: stableVersion(version) ? version : "unavailable",
      requiredNode: demo === true ? hostedDemoNodeRange : stableVersion(pin, "") ? pin : "unavailable",
    });
  }
  diagnostics() {
    return { ...this.#diagnostic };
  }
}
export function assertNodeRuntime(version, pin, demo, code) {
  if (!nodeRuntimeAllowed(version, pin, demo)) throw new NodeRuntimeError(code, version, pin, demo);
}

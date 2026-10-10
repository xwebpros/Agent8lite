import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { mergeConfig } from "vitest/config";
import cmsConfig from "./vitest.config.mts";

// Read the shared owner's exact committed clock fix for consumer acceptance in this older-base worktree.
// This test-only loader neither edits the shared file nor introduces a second entitlement implementation.
const reviewedCommit = "aa4cf6513094b7c385ca861ac78b939c9d51283b";
const source = execFileSync("git", ["show", `${reviewedCommit}:packages/auth/entitlements.ts`], {
  encoding: "utf8",
  windowsHide: true,
});
const foundationPath = resolve("packages/auth/entitlements.ts").replaceAll("\\", "/");

export default mergeConfig(cmsConfig, {
  plugins: [
    {
      name: "cms-reviewed-foundation-source",
      enforce: "pre",
      load(id) {
        if (id.split("?")[0].replaceAll("\\", "/") === foundationPath) return source;
      },
    },
  ],
});

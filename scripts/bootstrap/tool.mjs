import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function validToolCommand(command) {
  return (
    command &&
    typeof command.executable === "string" &&
    path.win32.isAbsolute(command.executable) &&
    typeof command.directory === "string" &&
    path.win32.isAbsolute(command.directory) &&
    Array.isArray(command.arguments) &&
    command.arguments.length <= 100 &&
    command.arguments.every((argument) => typeof argument === "string" && !argument.includes("\0")) &&
    (command.interactive === undefined || typeof command.interactive === "boolean") &&
    !command.executable.includes("\0") &&
    !command.directory.includes("\0")
  );
}

async function main() {
  if (process.platform !== "win32" || process.argv.length !== 2)
    throw new Error("bootstrap_tool_parent_required");
  const command = await new Promise((resolve, reject) => {
    let data = "";
    const timeout = setTimeout(() => reject(new Error("bootstrap_tool_handshake_timeout")), 10000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
      if (data.length > 32768) {
        clearTimeout(timeout);
        reject(new Error("bootstrap_tool_command_too_large"));
      }
    });
    process.stdin.once("end", () => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("bootstrap_tool_command_invalid"));
      }
    });
    process.stdin.resume();
  });
  // Parent assigned the kill-on-close Windows Job Object before sending this command.
  if (!validToolCommand(command)) throw new Error("bootstrap_tool_command_invalid");
  let consoleInput;
  if (command.interactive) {
    try {
      consoleInput = openSync("CONIN$", "r");
    } catch {
      throw new Error(
        "bootstrap_tool_requires_console: use Start-Agent8lite.cmd to answer installer prompts.",
      );
    }
  }
  const child = spawn(command.executable, command.arguments, {
    cwd: command.directory,
    env: process.env,
    stdio: [consoleInput ?? "ignore", "inherit", "inherit"],
    windowsHide: !command.interactive,
  });
  if (consoleInput !== undefined) closeSync(consoleInput);
  process.once("SIGINT", () => child.kill("SIGTERM"));
  process.once("SIGTERM", () => child.kill("SIGTERM"));
  child.once("error", () => {
    console.error("bootstrap_tool_start_failed");
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = Number.isInteger(code) ? code : 1;
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(
      error.message.startsWith("bootstrap_tool_requires_console") ? error.message : "bootstrap_tool_failed",
    );
    process.exitCode = 1;
  });
}

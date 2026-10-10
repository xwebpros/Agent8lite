import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  HOST,
  inspectHost,
  inventoryReport,
  main,
  parseArguments,
  parseInventory,
  probeScript,
  sshArguments,
} from "./preflight.mjs";

const nonce = "a".repeat(32);
const sample = {
  kernel: "Linux",
  arch: "x86_64",
  os_id: "almalinux",
  os_version: "10.0",
  cpanel_version: "132.0.17",
  node_version: "24.19.0",
  pnpm_present: "1",
  pnpm_version: "11.25.0",
  psql_client_version: "17.10",
  redis_binary_version: "7.4.6",
  cpu_count: "4",
  memory_kib: "8388608",
  disk_free_kib: "52428800",
  account_class: "unprivileged",
  systemd_present: "1",
  supervisor_present: "0",
  passenger_present: "1",
  nginx_present: "1",
  httpd_present: "1",
  database_roles_verified: "0",
  postgis_verified: "0",
  worker_supervision_verified: "0",
  private_storage_verified: "0",
  https_origin_verified: "0",
  restore_verified: "0",
};
function response(values = sample, token = nonce) {
  return [
    `AEHOST1:${token}:BEGIN`,
    ...Object.entries(values).map(([k, v]) => `AEHOST1:${token}:${k}:${v}`),
    `AEHOST1:${token}:END`,
    "",
  ].join("\n");
}
function fakeSpawn(complete) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit("close", null));
    return true;
  });
  let input = "";
  child.stdin.on("data", (data) => {
    input += data.toString();
  });
  child.stdin.on("finish", () => queueMicrotask(() => complete(child, input)));
  return { child, spawnProcess: vi.fn(() => child) };
}

describe("SSH boundary", () => {
  it("forces the selected IP, strict trust, no forwarding and no shell interpretation", () => {
    const args = sshArguments("agent8lite-staging");
    expect(args).toContain(`HostName=${HOST.ip}`);
    for (const value of [
      "BatchMode=yes",
      "PreferredAuthentications=publickey",
      "PasswordAuthentication=no",
      "KbdInteractiveAuthentication=no",
      "StrictHostKeyChecking=yes",
      "UpdateHostKeys=no",
      "VerifyHostKeyDNS=no",
      "AddKeysToAgent=no",
      "ClearAllForwardings=yes",
      "ForwardAgent=no",
      "ForwardX11=no",
      "PermitLocalCommand=no",
      "ControlPath=none",
    ])
      expect(args).toContain(value);
    expect(args.slice(-10)).toEqual([
      "agent8lite-staging",
      "/usr/bin/env",
      "-u",
      "BASH_ENV",
      "-u",
      "ENV",
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-s",
    ]);
  });
  it.each([
    "-oProxyCommand=evil",
    "user@host",
    "x;rm",
    "x$(touch bad)",
    "a\nssh host",
    "a b",
    "../secret",
    "",
    "a".repeat(65),
    undefined,
  ])("denies unsafe target %s before connecting", async (target) => {
    const spawnProcess = vi.fn();
    await expect(inspectHost({ sshTarget: target, spawnProcess })).rejects.toMatchObject({
      code: "INVALID_TARGET",
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });
  it("accepts no password/key arguments, duplicate options or arbitrary remote command", () => {
    expect(parseArguments(["--ssh-target", "agent8lite-staging", "--dry-run"])).toEqual({
      sshTarget: "agent8lite-staging",
      dryRun: true,
    });
    for (const extra of [
      ["--password", "fixture"],
      ["--identity", "private.key"],
      ["--ssh-target", "other"],
      ["--dry-run", "--dry-run"],
      ["--command", "sudo install"],
    ])
      expect(() => parseArguments(["--ssh-target", "agent8lite-staging", ...extra])).toThrow();
  });
});

describe("closed inventory protocol", () => {
  it("returns only allowed typed facts and discards banners", () => {
    const facts = parseInventory(`Login banner with fixture-secret\n${response()}arbitrary footer\n`, nonce);
    expect(facts.cpu_count).toBe(4);
    expect(facts.memory_kib).toBe(8388608);
    expect(facts.systemd_present).toBe(true);
    expect(facts.supervisor_present).toBe(false);
    expect(facts.database_roles_verified).toBe(false);
    expect(Object.getPrototypeOf(facts)).toBe(null);
    expect(Object.isFrozen(facts)).toBe(true);
    expect(JSON.stringify(facts)).not.toContain("fixture-secret");
  });
  it("represents unreadable versions and resources as unknown", () => {
    const facts = parseInventory(
      response({ ...sample, node_version: "-", pnpm_version: "-", cpu_count: "-", memory_kib: "-" }),
      nonce,
    );
    expect(facts.node_version).toBeNull();
    expect(facts.memory_kib).toBeNull();
    expect(inventoryReport(facts, "agent8lite-staging").checks.find((c) => c.id === "node").status).toBe(
      "unverified",
    );
  });
  it.each([
    [
      "missing fact",
      () => {
        const { arch, ...rest } = sample;
        return response(rest);
      },
    ],
    ["missing end", () => response().replace(`AEHOST1:${nonce}:END`, "")],
    ["wrong nonce", () => response(sample, "b".repeat(32))],
    [
      "duplicate field",
      () => response().replace(`AEHOST1:${nonce}:END`, `AEHOST1:${nonce}:arch:x86_64\nAEHOST1:${nonce}:END`),
    ],
    [
      "prototype field",
      () =>
        response().replace(`AEHOST1:${nonce}:END`, `AEHOST1:${nonce}:__proto__:secret\nAEHOST1:${nonce}:END`),
    ],
    ["unexpected field", () => response({ ...sample, password: "fixture-secret" })],
    ["injected version", () => response({ ...sample, node_version: "24.19.0:fixture-secret" })],
    ["escape controls", () => response({ ...sample, os_id: "alma\x1blinux" })],
    ["zero CPUs", () => response({ ...sample, cpu_count: "0" })],
    ["missing boolean", () => response({ ...sample, pnpm_present: "-" })],
    ["contradictory pnpm", () => response({ ...sample, pnpm_present: "0" })],
    ["claimed release proof", () => response({ ...sample, restore_verified: "1" })],
    ["oversized output", () => "x".repeat(65537)],
    ["extra begin", () => `AEHOST1:${nonce}:BEGIN\n${response()}`],
    ["record after end", () => `${response()}AEHOST1:${nonce}:arch:x86_64\n`],
  ])("rejects %s without copying input into errors", (_name, input) => {
    try {
      parseInventory(input(), nonce);
      throw new Error("unexpected success");
    } catch (error) {
      expect(error.code).toBe("INVALID_RESPONSE");
      expect(error.message).not.toContain("fixture-secret");
    }
  });
  it("rejects an executable nonce before generating the shell program", async () => {
    await expect(probeScript("'; touch unsafe #")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("normalizes Windows checkout newlines and BOM before sending Bash stdin", async () => {
    const source = await fs.readFile(new URL("./host-probe.sh", import.meta.url), "utf8");
    const read = vi.spyOn(fs, "readFile").mockResolvedValue(`\uFEFF${source.replace(/\r?\n/g, "\r\n")}`);
    try {
      const probe = await probeScript(nonce);
      expect(probe.startsWith("#!/bin/bash\n")).toBe(true);
      expect(probe).not.toContain("\r");
      expect(probe).not.toContain("__NONCE__");
    } finally {
      read.mockRestore();
    }
  });
  it("never interprets binary/client inventory as production acceptance", () => {
    const report = inventoryReport(
      parseInventory(response(), nonce),
      "agent8lite-staging",
      "2026-10-10T07:00:00Z",
    );
    expect(report.outcome).toBe("inspection-complete");
    expect(report.deploymentReady).toBe(false);
    expect(report.checks.every((c) => c.status === "observed-match")).toBe(true);
    expect(report.remaining.every((c) => c.status === "unverified")).toBe(true);
    expect(report.remaining.map((c) => c.id)).toEqual(
      expect.arrayContaining(["database", "redis", "workers", "identity", "https", "storage", "acceptance"]),
    );
  });
  it("flags mismatched selected OS, architecture, cPanel release and pinned runtimes", () => {
    const report = inventoryReport(
      parseInventory(
        response({
          ...sample,
          arch: "aarch64",
          os_id: "ubuntu",
          os_version: "24.04",
          cpanel_version: "130.0.8",
          node_version: "22.10.0",
          pnpm_version: "10.1.0",
        }),
        nonce,
      ),
      "agent8lite-staging",
    );
    for (const id of ["architecture", "distribution", "os-major", "cpanel", "node", "pnpm"])
      expect(report.checks.find((c) => c.id === id).status).toBe("mismatch");
    expect(report.deploymentReady).toBe(false);
  });
});

describe("bounded process execution", () => {
  it("uses fixed stdin and an argv array, reporting only validated output", async () => {
    const fake = fakeSpawn((child, input) => {
      const token = input.match(/AEHOST1:([a-f0-9]{32})/)[1];
      child.stdout.write(`banner fixture-secret\n${response(sample, token)}`);
      child.emit("close", 0);
    });
    const report = await inspectHost({ sshTarget: "agent8lite-staging", spawnProcess: fake.spawnProcess });
    expect(fake.spawnProcess).toHaveBeenCalledWith("ssh", sshArguments("agent8lite-staging"), {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(report.facts.node_version).toBe("24.19.0");
    expect(JSON.stringify(report)).not.toContain("fixture-secret");
  });
  it.each([
    ["Permission denied (publickey). fixture-secret", "AUTHENTICATION_FAILED"],
    ["Host key verification failed. fixture-secret", "HOST_KEY_UNVERIFIED"],
    ["WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! fixture-secret", "HOST_KEY_UNVERIFIED"],
    ["connection refused fixture-secret", "CONNECTION_FAILED"],
  ])("summarizes SSH failure without disclosing stderr", async (stderr, code) => {
    const fake = fakeSpawn((child) => {
      child.stderr.write(stderr);
      child.emit("close", 255);
    });
    const failure = await inspectHost({
      sshTarget: "agent8lite-staging",
      spawnProcess: fake.spawnProcess,
    }).catch((error) => error);
    expect(failure.code).toBe(code);
    expect(failure.message).not.toContain("fixture-secret");
  });
  it("stops only its owned SSH child on timeout", async () => {
    const fake = fakeSpawn(() => {});
    await expect(
      inspectHost({ sshTarget: "agent8lite-staging", spawnProcess: fake.spawnProcess, timeoutMs: 15 }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(fake.child.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("caps total stderr/stdout and kills the owned child", async () => {
    const fake = fakeSpawn((child) => child.stderr.write(Buffer.alloc(65537, "x")));
    await expect(
      inspectHost({ sshTarget: "agent8lite-staging", spawnProcess: fake.spawnProcess }),
    ).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
    expect(fake.child.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("escalates a timed-out owned SSH process that ignores termination", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeSpawn(() => {});
      fake.child.kill.mockImplementation(() => true);
      const result = inspectHost({
        sshTarget: "agent8lite-staging",
        spawnProcess: fake.spawnProcess,
        timeoutMs: 15,
      }).catch((error) => error);
      // File loading is real async I/O; wait until the fake process is attached.
      await vi.waitFor(() => expect(fake.spawnProcess).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(15);
      expect((await result).code).toBe("TIMEOUT");
      await vi.advanceTimersByTimeAsync(1000);
      expect(fake.child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      fake.child.emit("close", null);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["stdout", "stderr", "stdin"])("handles %s stream failure without raw errors", async (stream) => {
    const fake = fakeSpawn((child) => child[stream].emit("error", new Error("fixture-secret")));
    const failure = await inspectHost({
      sshTarget: "agent8lite-staging",
      spawnProcess: fake.spawnProcess,
    }).catch((error) => error);
    expect(failure.code).toBe("CONNECTION_FAILED");
    expect(failure.message).not.toContain("fixture-secret");
    expect(fake.child.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("handles a missing SSH executable without raw exception text", async () => {
    const spawnProcess = () => {
      throw Object.assign(new Error("private-key-path fixture-secret"), { code: "ENOENT" });
    };
    await expect(inspectHost({ sshTarget: "agent8lite-staging", spawnProcess })).rejects.toMatchObject({
      code: "SSH_UNAVAILABLE",
    });
  });
  it("exercises real subprocess stdin/chunk handling without any SSH connection", async () => {
    const code = `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const token=input.match(/AEHOST1:([a-f0-9]{32})/)[1];const sample=${JSON.stringify(sample)};console.log('fixture-secret banner');console.log('AEHOST1:'+token+':BEGIN');for(const [k,v]of Object.entries(sample))console.log('AEHOST1:'+token+':'+k+':'+v);console.log('AEHOST1:'+token+':END');});`;
    const report = await inspectHost({
      sshTarget: "agent8lite-staging",
      spawnProcess: (_command, _args, options) => spawn(process.execPath, ["-e", code], options),
    });
    expect(report.facts.memory_kib).toBe(8388608);
    expect(JSON.stringify(report)).not.toContain("fixture-secret");
  });
});

describe("CLI and import safety", () => {
  it("dry-run prints a reviewable probe and makes no network call", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await main(["--ssh-target", "agent8lite-staging", "--dry-run"])).toBe(0);
      const report = JSON.parse(output.mock.calls[0][0]);
      expect(report.outcome).toBe("dry-run");
      expect(report.arguments).toContain(`HostName=${HOST.ip}`);
      expect(report.probe).not.toContain("__NONCE__");
      expect(report.probe).toContain("never invoke pnpm/Corepack");
      expect(report.probe).not.toMatch(/\bsudo\b(?!,)|\byum\b|\bdnf\b|\bnpm install\b|\bpnpm install\b/);
    } finally {
      output.mockRestore();
    }
  });
  it("invalid arguments produce a closed failure report", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await main(["--ssh-target", "fixture-secret;command"])).toBe(1);
      const text = output.mock.calls[0][0];
      expect(text).not.toContain("fixture-secret");
      expect(JSON.parse(text).error.code).toBe("INVALID_TARGET");
    } finally {
      output.mockRestore();
    }
  });
  it("importing the module starts no CLI, listener or SSH process", async () => {
    const url = new URL("./preflight.mjs", import.meta.url).href;
    const child = spawn(
      process.execPath,
      ["-e", `import(${JSON.stringify(url)}).then(()=>console.log('import-ok'))`],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("import-ok");
    expect(stderr).toBe("");
    expect(fileURLToPath(url)).toContain("preflight.mjs");
  });
});

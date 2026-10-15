import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { hostedLaunchRequired } from "../launch-config.mjs";
import {
  apiReady,
  assertAvailablePorts,
  bootstrapEnvironment,
  canReuseState,
  supervise,
  workspaceId,
} from "./runtime.mjs";
import { validToolCommand } from "./tool.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const instanceId = "a".repeat(32);
const anotherInstanceId = "b".repeat(32);
const systemEnvironment = {
  SystemRoot: "C:\\Windows",
  WINDIR: "C:\\Windows",
  PATH: "C:\\Windows\\System32",
  TEMP: "C:\\Users\\Fixture User\\AppData\\Local\\Temp",
  TMP: "C:\\Users\\Fixture User\\AppData\\Local\\Temp",
  USERPROFILE: "C:\\Users\\Fixture User",
};
const health = {
  status: "ready",
  identityMode: "synthetic-loopback",
  mlsMode: "mock",
  deliveryMode: "no-delivery",
};
const response = (body = health, marker = instanceId, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: marker === undefined ? {} : { "X-Verification-Instance": marker },
  });

describe("bootstrap environment confinement", () => {
  it("prevents an inherited hosted configuration or injection from changing local launch mode", () => {
    const parent = {
      ...systemEnvironment,
      PORT: "443",
      NODE_ENV: "production",
      APP_ENV: "production",
      DEV_AUTH_ENABLED: "false",
      HOSTED_DEMO_ENABLED: "true",
      DEMO_ACCESS_PASSWORD: "PRIVATE_PARENT_DEMO_PASSWORD",
      DEMO_SESSION_SECRET: "PRIVATE_PARENT_DEMO_SECRET",
      NODE_OPTIONS: "--import C:\\private\\startup.mjs",
      API_HOST: "0.0.0.0",
      API_PORT: "443",
      API_ORIGIN: "https://private.example.test",
      WEB_ORIGIN: "https://private.example.test",
      API_VERIFICATION_ID: anotherInstanceId,
      MLS_PROVIDER: "trestle",
      DELIVERY_PROVIDER: "live",
      DOCKER_HOST: "tcp://private.example.test:2375",
      DOCKER_CONTEXT: "production",
      DOCKER_TLS_VERIFY: "1",
      DOCKER_CERT_PATH: "C:\\private\\certificates",
      STRIPE_SECRET_KEY: "PRIVATE_PAYMENT_SECRET",
      TRESTLE_CLIENT_SECRET: "PRIVATE_MLS_SECRET",
      NEXT_PUBLIC_API_ORIGIN: "https://private.example.test",
      ESTATE_BUILD_DIR: "C:\\private\\build",
    };
    const original = structuredClone(parent);
    const env = bootstrapEnvironment(parent, root, { instanceId });

    expect(hostedLaunchRequired(env)).toBe(false);
    expect(env.APP_ENV).toBe("development");
    expect(env.DEV_AUTH_ENABLED).toBe("true");
    expect(env.API_HOST).toBe("127.0.0.1");
    expect(env.API_VERIFICATION_ID).toBe(instanceId);
    expect(env.MLS_PROVIDER).toBe("mock");
    expect(env.DELIVERY_PROVIDER).toBe("no-delivery");
    expect(new URL(env.API_ORIGIN).hostname).toBe("127.0.0.1");
    expect(new URL(env.WEB_ORIGIN).hostname).toBe("localhost");
    for (const key of Object.keys(parent)) {
      if (/^(DOCKER_|DEMO_|STRIPE_|TRESTLE_|NEXT_PUBLIC_)/.test(key)) expect(env).not.toHaveProperty(key);
    }
    expect(env).not.toHaveProperty("PORT");
    expect(env).not.toHaveProperty("NODE_OPTIONS");
    expect(env).not.toHaveProperty("ESTATE_BUILD_DIR");
    expect(JSON.stringify(env)).not.toMatch(
      /PRIVATE_PARENT_|PRIVATE_PAYMENT_|PRIVATE_MLS_|private\.example\.test|\\\\private\\\\/,
    );
    expect(parent).toEqual(original);
  });

  it("keeps every database identity on the same synthetic loopback database with separate roles", () => {
    const keys = [
      "DATABASE_URL",
      "MIGRATION_DATABASE_URL",
      "WORKER_DATABASE_URL",
      "CONTROL_DATABASE_URL",
      "STAFF_ISSUER_DATABASE_URL",
    ];
    const parent = Object.fromEntries(
      keys.map((key) => [key, "postgresql://postgres:PRIVATE_REMOTE_PASSWORD@remote.example.test/customer"]),
    );
    const env = bootstrapEnvironment(parent, root, { instanceId });
    const databases = keys.map((key) => new URL(env[key]));
    for (const database of databases) {
      expect(["postgresql:", "postgres:"]).toContain(database.protocol);
      expect(database.hostname).toBe("127.0.0.1");
      expect(database.port).toBe("55432");
      expect(database.pathname).toBe("/estate");
      expect(database.password).not.toBe("");
      expect(database.search).toBe("");
      expect(database.hash).toBe("");
    }
    expect(new Set(databases.map((database) => database.username)).size).toBe(keys.length);
    expect(databases[0].username).not.toBe("postgres");
    expect(new URL(env.REDIS_URL).hostname).toBe("127.0.0.1");
    expect(JSON.stringify(env)).not.toContain("PRIVATE_REMOTE_PASSWORD");
  });

  it("retains required Windows process environment and puts the portable runtime first on PATH", () => {
    const nodeDirectory = path.join(root, ".local", "bootstrap", "Node with spaces & !");
    const env = bootstrapEnvironment(systemEnvironment, root, { instanceId, nodeDirectory });
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE"])
      expect(Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1]).toBe(
        systemEnvironment[key],
      );
    const executablePath = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1];
    expect(executablePath.split(path.delimiter)[0]).toBe(nodeDirectory);
    expect(executablePath).toContain(systemEnvironment.PATH);
    expect(Object.keys(env).filter((key) => key.toLowerCase() === "path")).toHaveLength(1);
  });
});

describe("workspace and supervisor ownership", () => {
  it("distinguishes two extracted folders while preserving stable Windows path identity", () => {
    const first = workspaceId("C:\\Projects\\Agent8lite");
    expect(first).toMatch(/^agent8lite-[a-f0-9]{16}$/);
    expect(workspaceId("c:\\projects\\agent8lite")).toBe(first);
    expect(workspaceId("C:\\Projects\\Agent8lite copy")).not.toBe(first);
    expect(workspaceId("C:\\Projects\\Agent8lite")).toBe(first);
  });

  const processStartedAt = "2026-10-12T03:00:00.000Z";
  const nodeExecutable = path.join(root, ".local", "bootstrap", "node", "node.exe");
  const current = { root, processId: 43127, processStartedAt, nodeExecutable };
  const owned = { ...current, ready: true, instanceId };

  it("reuses only the current ready owned supervisor", () => {
    expect(canReuseState(owned, current)).toBe(true);
    expect(canReuseState({ ...owned, processStartedAt: "2026-10-12T03:00:01.999Z" }, current)).toBe(true);
  });

  it.each([
    ["a reused PID", { processStartedAt: "2026-10-11T03:00:00.000Z" }],
    ["a different process", { processId: 43128 }],
    ["a different extraction", { root: path.join(root, "another-extraction") }],
    ["a different runtime", { nodeExecutable: "C:\\Unrelated\\node.exe" }],
    ["an incomplete startup", { ready: false }],
    ["a truthy ready value", { ready: "true" }],
    ["a missing start time", { processStartedAt: undefined }],
    ["an invalid start time", { processStartedAt: "invalid" }],
    ["a missing PID", { processId: undefined }],
    ["a string PID", { processId: "43127" }],
    ["a missing marker", { instanceId: undefined }],
    ["a noncanonical marker", { instanceId: instanceId.toUpperCase() }],
    ["a short marker", { instanceId: instanceId.slice(1) }],
    ["a marker with suffix", { instanceId: `${instanceId}\n` }],
  ])("rejects persisted state with %s", (_label, changed) => {
    expect(canReuseState({ ...owned, ...changed }, current)).toBe(false);
  });

  it.each([null, undefined, {}, [], "ready", 42])("rejects malformed persisted state %s", (state) => {
    expect(canReuseState(state, current)).toBe(false);
  });
});

describe("instance-bound synthetic API readiness", () => {
  it("accepts the matching healthy synthetic instance", async () => {
    expect(await apiReady(response(), instanceId)).toBe(true);
  });

  it.each([undefined, "", anotherInstanceId, instanceId.toUpperCase()])(
    "rejects unrelated or noncanonical response marker %s",
    async (marker) => {
      const candidate = response(health, marker);
      if (marker === undefined) candidate.headers.delete("X-Verification-Instance");
      expect(await apiReady(candidate, instanceId)).toBe(false);
    },
  );

  it.each([
    { ...health, status: "starting" },
    { ...health, identityMode: "unconfigured" },
    { ...health, mlsMode: "live" },
    { ...health, deliveryMode: "email" },
    { status: "ready" },
    null,
    [],
    "ready",
  ])("rejects HTTP success without the required safe health body %s", async (body) => {
    expect(await apiReady(response(body), instanceId)).toBe(false);
  });

  it("rejects failed HTTP and malformed JSON without inferring readiness", async () => {
    expect(await apiReady(response(health, instanceId, 503), instanceId)).toBe(false);
    const invalid = new Response("not JSON", { headers: { "X-Verification-Instance": instanceId } });
    expect(await apiReady(invalid, instanceId)).toBe(false);
  });

  it("requires the exact marker returned by the header interface", async () => {
    const candidate = { ok: true, headers: { get: () => `${instanceId} suffix` }, json: async () => health };
    expect(await apiReady(candidate, instanceId)).toBe(false);
  });
});

describe("application port conflicts", () => {
  it("checks both fixed application ports before permitting setup", async () => {
    const checkPort = vi.fn(async () => false);
    await assertAvailablePorts(checkPort);
    expect(checkPort.mock.calls.map(([port]) => port).sort()).toEqual([3000, 3001]);
  });

  it.each([3000, 3001])("fails closed when port %s belongs to an existing listener", async (occupied) => {
    const checkPort = vi.fn(async (port) => port === occupied);
    await expect(assertAvailablePorts(checkPort)).rejects.toThrow("bootstrap_port_in_use");
    expect(checkPort).toHaveBeenCalledWith(occupied);
  });

  it("does not treat an unavailable port probe as permission to launch", async () => {
    await expect(
      assertAvailablePorts(async () => {
        throw new Error("port_probe_failed");
      }),
    ).rejects.toThrow();
  });
});

function supervisionFixture({ marker = instanceId, nextReady = true, exitAfterReady = false } = {}) {
  const children = [];
  let elapsed = 0;
  let emitted = false;
  const spawnChild = vi.fn(() => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => {
      child.exitCode = 0;
      return true;
    });
    children.push(child);
    return child;
  });
  const writeState = vi.fn(async () => {
    if (exitAfterReady)
      queueMicrotask(() => {
        children[0].exitCode = 0;
        children[0].emit("exit", 0);
      });
  });
  const fetchResponse = vi.fn(async (url) =>
    url.endsWith("/health") ? response(health, marker) : new Response("owned web", { status: 200 }),
  );
  const options = {
    root,
    environment: bootstrapEnvironment(systemEnvironment, root, { instanceId }),
    spawnChild,
    fetchResponse,
    writeState,
    checkPort: vi.fn(async () => false),
    output: vi.fn(),
    startupMs: 1500,
    now: () => elapsed,
    delay: async (ms) => {
      elapsed += ms;
      if (!emitted && children[1]) {
        emitted = true;
        children[1].stdout.write(nextReady ? "\u001b[32m\u2713 Ready in 500ms\u001b[0m\n" : "Starting...\n");
      }
    },
  };
  return { options, children, spawnChild, writeState, fetchResponse };
}

describe("owned application supervision", () => {
  it("performs no launch or readiness writes when a fixed port is already occupied", async () => {
    const fixture = supervisionFixture();
    fixture.options.checkPort = vi.fn(async () => true);
    await expect(supervise(fixture.options)).rejects.toThrow("bootstrap_port_in_use");
    expect(fixture.spawnChild).not.toHaveBeenCalled();
    expect(fixture.fetchResponse).not.toHaveBeenCalled();
    expect(fixture.writeState).not.toHaveBeenCalled();
  });

  it.each([
    ["an unrelated API", { marker: anotherInstanceId }],
    ["an incomplete owned web process", { nextReady: false }],
  ])("times out safely for %s and kills only its own fake children", async (_label, setup) => {
    const fixture = supervisionFixture(setup);
    const unrelated = { kill: vi.fn() };
    const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    await expect(supervise(fixture.options)).rejects.toThrow("bootstrap_startup_timeout");
    expect(fixture.writeState).not.toHaveBeenCalled();
    expect(fixture.children).toHaveLength(2);
    for (const child of fixture.children) expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(unrelated.kill).not.toHaveBeenCalled();
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
    expect(fixture.fetchResponse.mock.calls.every(([url]) => url.endsWith("/health"))).toBe(true);
  });

  it("acknowledges readiness only after both owned processes are ready and stops on child exit", async () => {
    const fixture = supervisionFixture({ exitAfterReady: true });
    expect(await supervise(fixture.options)).toBe(1);
    expect(fixture.writeState).toHaveBeenCalledExactlyOnceWith({ ready: true });
    expect(fixture.fetchResponse.mock.calls.some(([url]) => url === "http://localhost:3000")).toBe(true);
    expect(fixture.children[1].kill).toHaveBeenCalledWith("SIGTERM");
    for (const [_command, args, options] of fixture.spawnChild.mock.calls) {
      expect(options.cwd).toBe(root);
      expect(options.windowsHide).toBe(true);
      expect(options).not.toHaveProperty("shell");
      expect(args).not.toContain("--watch");
      expect(options.env.API_HOST).toBe("127.0.0.1");
    }
  });
});

describe("bootstrap library import", () => {
  it("has no setup, network, process-launch, or file-mutation side effects", async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    const directory = await fs.mkdtemp(path.join(tempRoot, "estate-bootstrap-import-"));
    const runtimeUrl = new URL("./runtime.mjs", import.meta.url).href;
    const toolUrl = new URL("./tool.mjs", import.meta.url).href;
    const code = `
      import cp from 'node:child_process';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const denied = () => { throw new Error('bootstrap_import_side_effect'); };
      for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[key] = denied;
      for (const key of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync']) fs[key] = denied;
      for (const key of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'cp']) fs.promises[key] = denied;
      globalThis.fetch = denied;
      syncBuiltinESMExports();
      await import(${JSON.stringify(runtimeUrl)});
      await import(${JSON.stringify(toolUrl)});
      process.stdout.write('import-pure');
    `;
    try {
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], {
        cwd: directory,
        env: bootstrapEnvironment(process.env, root, { instanceId }),
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("import-pure");
      expect(result.stderr).toBe("");
      expect(await fs.readdir(directory)).toEqual([]);
    } finally {
      if (path.dirname(directory) !== tempRoot) throw new Error("unsafe_test_cleanup");
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe("owned tool command handshake validation", () => {
  const command = {
    executable: "C:\\Portable Node\\node.exe",
    directory: "C:\\Extracted project with spaces",
    arguments: ["--version"],
  };
  it("accepts native absolute paths and an explicit argument array without a shell", () => {
    expect(validToolCommand(command)).toBeTruthy();
    expect(
      validToolCommand({ ...command, arguments: ["", "a & b", 'quote"value', "C:\\trailing\\"] }),
    ).toBeTruthy();
    expect(validToolCommand({ ...command, interactive: true })).toBeTruthy();
  });

  it.each([
    null,
    undefined,
    false,
    42,
    "command",
    {},
    { ...command, executable: "node.exe" },
    { ...command, directory: "relative-directory" },
    { ...command, executable: "C:\\node\0.exe" },
    { ...command, directory: "C:\\directory\0" },
    { ...command, arguments: "--version" },
    { ...command, arguments: [1] },
    { ...command, arguments: [null] },
    { ...command, arguments: ["bad\0argument"] },
    { ...command, arguments: Array(101).fill("argument") },
    { ...command, interactive: "true" },
  ])("rejects malformed or implicit-shell command input %s", (candidate) => {
    expect(validToolCommand(candidate)).toBeFalsy();
  });
});

const powerShell = path.join(
  process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
function powerShellLibrary(code, payload = null, beforeImport = "") {
  const script = path.join(root, "scripts", "bootstrap", "windows.ps1").replaceAll("'", "''");
  const prefix = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false; ${beforeImport}; . '${script}' -LibraryOnly; `;
  const result = spawnSync(
    powerShell,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", prefix + code],
    {
      cwd: root,
      env: {
        ...bootstrapEnvironment(process.env, root, { instanceId }),
        BOOTSTRAP_TEST_NODE: process.execPath,
        BOOTSTRAP_TEST_INPUT: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ""));
}

describe.skipIf(process.platform !== "win32")("Windows setup library helpers", () => {
  it("loads library helpers without invoking installers, services, network or file changes", () => {
    const functions = [
      "Start-Process",
      "Stop-Process",
      "Invoke-WebRequest",
      "Invoke-RestMethod",
      "New-Item",
      "Set-Content",
      "Add-Content",
      "Remove-Item",
      "winget",
      "docker",
    ]
      .map((name) => `function ${name} { throw 'bootstrap_library_side_effect' }`)
      .join("; ");
    expect(
      powerShellLibrary(`[Console]::Write(('import-pure' | ConvertTo-Json -Compress));`, null, functions),
    ).toBe("import-pure");
  });

  it("round-trips native arguments with spaces, shell symbols, quotes and trailing backslashes", () => {
    const values = [
      "",
      "plain",
      "C:\\Project with spaces\\",
      'C:\\Quotes\\"quoted"',
      'backslash\\\\before"quote',
      "a & b | c < d > e",
      "(parentheses) !bang! %PATH%",
      "apostrophe's value",
      "$env:PRIVATE `backtick`",
      "--flag-like-input",
      "บ้าน",
    ];
    const actual = powerShellLibrary(
      `
      $values = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BOOTSTRAP_TEST_INPUT)) | ConvertFrom-Json;
      $arguments = @('-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--') + @($values);
      $info = New-Object Diagnostics.ProcessStartInfo;
      $info.FileName = $env:BOOTSTRAP_TEST_NODE;
      $info.Arguments = (($arguments | ForEach-Object { ConvertTo-WindowsArgument ([string]$_) }) -join ' ');
      $info.UseShellExecute = $false;
      $info.CreateNoWindow = $true;
      $info.RedirectStandardOutput = $true;
      $info.RedirectStandardError = $true;
      $info.StandardOutputEncoding = New-Object Text.UTF8Encoding $false;
      $info.StandardErrorEncoding = New-Object Text.UTF8Encoding $false;
      $child = [Diagnostics.Process]::Start($info);
      $out = $child.StandardOutput.ReadToEnd();
      $err = $child.StandardError.ReadToEnd();
      $child.WaitForExit();
      if ($child.ExitCode -ne 0) { throw $err };
      [Console]::Write($out);
    `,
      values,
    );
    expect(actual).toEqual(values);
  });

  it("accepts only a unique exact archive checksum entry", () => {
    const filename = "node-v24.19.0-win-x64.zip";
    const hash = "0123456789abcdef".repeat(4);
    const cases = [
      [`${hash}  ${filename}\r\n${"f".repeat(64)}  unrelated.zip\r\n`, true],
      [`${hash.toUpperCase()}  ${filename}\n`, true],
      [`${hash}  ${filename}.tar\n`, false],
      [`${hash}  other.zip\n`, false],
      [`${hash.slice(1)}  ${filename}\n`, false],
      [`${"z".repeat(64)}  ${filename}\n`, false],
      [`${hash}  ${filename}\n${hash}  ${filename}\n`, false],
      [`${hash}  ${filename}\n${"f".repeat(64)}  ${filename}\n`, false],
    ];
    const actual = powerShellLibrary(
      `
      $inputValue = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BOOTSTRAP_TEST_INPUT)) | ConvertFrom-Json;
      $results = @();
      foreach ($case in $inputValue.cases) {
        try { $hash = Get-NodeArchiveHash ([string]$case[0]) ([string]$inputValue.filename); $results += @{valid=$true; hash=$hash} }
        catch { $results += @{valid=$false} }
      }
      [Console]::Write((ConvertTo-Json -InputObject $results -Compress));
    `,
      { filename, cases },
    );
    expect(actual.map((entry) => entry.valid)).toEqual(cases.map((entry) => entry[1]));
    expect(actual.filter((entry) => entry.valid).map((entry) => entry.hash.toLowerCase())).toEqual([
      hash,
      hash,
    ]);
  });

  it("distinguishes successful installation, required restart and failed installation", () => {
    const codes = [0, 3010, 1641, 1, 1602, -2147023673];
    const actual = powerShellLibrary(
      `
      $codes = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BOOTSTRAP_TEST_INPUT)) | ConvertFrom-Json;
      $results = @($codes | ForEach-Object { Get-InstallerOutcome ([int]$_) });
      [Console]::Write((ConvertTo-Json -InputObject $results -Compress));
    `,
      codes,
    );
    expect(actual).toEqual(["complete", "restart", "restart", "failed", "failed", "failed"]);
  });

  it("derives the same source-owned project identity without creating bootstrap state", async () => {
    const directory = path.join(root, ".local", "bootstrap");
    const before = await fs.stat(directory).catch(() => null);
    const plan = powerShellLibrary(
      `
      $root = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BOOTSTRAP_TEST_INPUT)) | ConvertFrom-Json;
      [Console]::Write((Get-BootstrapPlan ([string]$root) | ConvertTo-Json -Compress));
    `,
      root,
    );
    expect(plan.Root.toLowerCase()).toBe(root.toLowerCase());
    expect(plan.Project).toBe(workspaceId(root));
    expect(plan.Directory.toLowerCase()).toBe(directory.toLowerCase());
    expect(plan.NodeVersion).toBe((await fs.readFile(path.join(root, ".node-version"), "utf8")).trim());
    expect(plan.PnpmVersion).toBe(
      JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).packageManager.split("@")[1],
    );
    expect(plan.NodeArchiveHash).toMatch(/^[a-f0-9]{64}$/);
    if (!before) expect(await fs.stat(directory).catch(() => null)).toBeNull();
  });

  it("uses a safe synthetic child environment even when the PowerShell parent is poisoned", () => {
    const env = powerShellLibrary(
      `
      $root = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BOOTSTRAP_TEST_INPUT)) | ConvertFrom-Json;
      $env:PORT = '443'; $env:NODE_OPTIONS = '--import private.mjs';
      $env:APP_ENV = 'production'; $env:NODE_ENV = 'production'; $env:HOSTED_DEMO_ENABLED = 'true';
      $env:DATABASE_URL = 'postgresql://postgres:PRIVATE_REMOTE_SECRET@remote.example.test/customer';
      $env:DOCKER_HOST = 'tcp://remote.example.test:2375'; $env:DOCKER_CONTEXT = 'production';
      $env:MLS_PROVIDER = 'live'; $env:DELIVERY_PROVIDER = 'live'; $env:STRIPE_SECRET_KEY = 'PRIVATE_PAYMENT_SECRET';
      $plan = Get-BootstrapPlan ([string]$root);
      $result = New-SyntheticEnvironment $plan 'C:\\Portable Node with spaces';
      [Console]::Write((ConvertTo-Json -InputObject $result -Compress));
    `,
      root,
    );
    expect(hostedLaunchRequired(env)).toBe(false);
    expect(env.APP_ENV).toBe("development");
    expect(env.DEV_AUTH_ENABLED).toBe("true");
    expect(env.MLS_PROVIDER).toBe("mock");
    expect(env.DELIVERY_PROVIDER).toBe("no-delivery");
    expect(new URL(env.DATABASE_URL).hostname).toBe("127.0.0.1");
    for (const key of ["PORT", "NODE_OPTIONS", "DOCKER_HOST", "DOCKER_CONTEXT", "STRIPE_SECRET_KEY"])
      expect(env).not.toHaveProperty(key);
    expect(JSON.stringify(env)).not.toMatch(
      /PRIVATE_REMOTE_SECRET|PRIVATE_PAYMENT_SECRET|remote\.example\.test/,
    );
    expect(
      Object.entries(env)
        .find(([key]) => key.toLowerCase() === "path")?.[1]
        .split(";")[0],
    ).toBe("C:\\Portable Node with spaces");
  });

  it("rejects path traversal before any bootstrap write", () => {
    const result = powerShellLibrary(
      `
      $root = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BOOTSTRAP_TEST_INPUT)) | ConvertFrom-Json;
      try { [void](Assert-WorkspacePath ([string]$root) (Join-Path $root '../outside-bootstrap')); $denied = $false }
      catch { $denied = $true };
      [Console]::Write((ConvertTo-Json -InputObject @{denied=$denied} -Compress));
    `,
      root,
    );
    expect(result.denied).toBe(true);
  });

  it("opens an existing app only for a typed owned state and current healthy instance", async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    const directory = await fs.mkdtemp(path.join(tempRoot, "estate-bootstrap-reuse-"));
    const started = "2026-10-12T03:00:00.000Z";
    const inputs = [
      { label: "matching owned process", expected: true },
      { label: "string ready value", state: { ready: "true" }, expected: false },
      { label: "string PID", state: { processId: "43127" }, expected: false },
      { label: "uppercase instance", state: { instanceId: instanceId.toUpperCase() }, expected: false },
      { label: "reused PID", state: { processStartedAt: "2026-10-11T03:00:00.000Z" }, expected: false },
      { label: "unhealthy current API", health: { ...health, status: "starting" }, expected: false },
      { label: "unrelated API", marker: anotherInstanceId, expected: false },
      { label: "live delivery", health: { ...health, deliveryMode: "live" }, expected: false },
      { label: "unrelated runtime", processPath: "C:\\Unrelated\\node.exe", expected: false },
    ];
    try {
      const cases = [];
      for (const [index, input] of inputs.entries()) {
        const stateDirectory = path.join(directory, String(index));
        await fs.mkdir(stateDirectory);
        const executable = path.join(stateDirectory, "tools", "node-v24.19.0-win-x64", "node.exe");
        await fs.writeFile(
          path.join(stateDirectory, "running.json"),
          JSON.stringify({
            root,
            ready: true,
            processId: 43127,
            processStartedAt: started,
            nodeExecutable: executable,
            instanceId,
            ...input.state,
          }),
        );
        cases.push({
          directory: stateDirectory,
          root,
          started,
          processPath: input.processPath || executable,
          marker: input.marker || instanceId,
          health: input.health || health,
        });
      }
      const actual = powerShellLibrary(
        `
        $inputValue = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BOOTSTRAP_TEST_INPUT)) | ConvertFrom-Json;
        function Get-Process { param($Id) return [pscustomobject]@{Path=$script:current.processPath; StartTime=[DateTime]::Parse($script:current.started)} }
        function Invoke-WebRequest { param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
          if ($Uri -like '*/health') { return [pscustomobject]@{StatusCode=200; Headers=@{'X-Verification-Instance'=$script:current.marker}; Content=($script:current.health | ConvertTo-Json -Compress)} }
          return [pscustomobject]@{StatusCode=200}
        }
        function Start-Process { $script:browserCalls++ }
        $results = @();
        foreach ($case in $inputValue) {
          $script:current=$case; $script:browserCalls=0;
          $plan=[pscustomobject]@{Root=$case.root; Directory=$case.directory; NodeVersion='24.19.0'};
          $opened=Try-OpenRunningApp $plan;
          $results += @{opened=$opened; browserCalls=$script:browserCalls};
        }
        [Console]::Write((ConvertTo-Json -InputObject $results -Compress));
      `,
        cases,
      );
      for (const [index, input] of inputs.entries()) {
        expect(actual[index].opened, input.label).toBe(input.expected);
        expect(actual[index].browserCalls, input.label).toBe(input.expected ? 1 : 0);
      }
    } finally {
      if (path.dirname(directory) !== tempRoot) throw new Error("unsafe_test_cleanup");
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts occupied database ports only from running containers in this Compose project", () => {
    const project = workspaceId(root);
    const container = (labels = project, running = true, host = "127.0.0.1", redis = true) => ({
      Config: { Labels: { "com.docker.compose.project": labels } },
      State: { Running: running },
      NetworkSettings: {
        Ports: {
          "5432/tcp": [{ HostIp: host, HostPort: "55432" }],
          "6379/tcp": redis ? [{ HostIp: host, HostPort: "56379" }] : null,
        },
      },
    });
    const cases = [
      { containers: [container("other-project"), container()], expected: true },
      { containers: [container("other-project"), container("other-project")], expected: false },
      { containers: [container(project, false), container(project, false)], expected: false },
      {
        containers: [container(project, true, "0.0.0.0"), container(project, true, "0.0.0.0")],
        expected: false,
      },
      {
        containers: [
          container(project, true, "127.0.0.1", false),
          container(project, true, "127.0.0.1", false),
        ],
        expected: false,
      },
    ];
    const actual = powerShellLibrary(
      `
      $inputValue = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BOOTSTRAP_TEST_INPUT)) | ConvertFrom-Json;
      function Get-Listeners { return @(55432, 56379) }
      function Invoke-BootstrapTool {
        param($Executable, [string[]]$Arguments, $Environment, $Directory, $Label, [switch]$Capture)
        if ($Arguments -contains 'up') { throw 'unexpected_container_mutation' }
        if ($Arguments -contains 'ps') { return [pscustomobject]@{ExitCode=0; Text="aaaaaaaaaaaa\nbbbbbbbbbbbb"} }
        $index = if ($Arguments[-1] -eq 'aaaaaaaaaaaa') { 0 } else { 1 };
        return [pscustomobject]@{ExitCode=0; Text=(ConvertTo-Json -InputObject @($script:current.containers[$index]) -Depth 10 -Compress)};
      }
      $plan=[pscustomobject]@{Root=$inputValue.root; Project=$inputValue.project};
      $docker=[pscustomobject]@{Cli='mock-docker'; Context='desktop-linux'};
      $results=@();
      foreach ($case in $inputValue.cases) {
        $script:current=$case;
        try { Assert-DatabasePortOwnership $plan $docker @{}; $results += $true }
        catch { $results += $false }
      }
      [Console]::Write((ConvertTo-Json -InputObject $results -Compress));
    `,
      { root, project, cases },
    );
    expect(actual).toEqual(cases.map((entry) => entry.expected));
  });

  it("extracts cached verified Node ZIP entries beyond MAX_PATH with native tar and no network", async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    const directory = await fs.mkdtemp(path.join(tempRoot, "estate-bootstrap-long-path-"));
    const bootstrapDirectory = path.join(directory, ".local", "bootstrap");
    const archive = path.join(bootstrapDirectory, "downloads", "node-v24.19.0-win-x64.zip");
    const nodeBytes = "fixture executable bytes; never execute";
    const nestedEntry = `node-v24.19.0-win-x64/node_modules/npm/node_modules/${Array(6).fill("nested-package-0123456789abcdef").join("/")}/fixture.txt`;
    const nestedBytes = "long path extraction fixture";
    await fs.mkdir(path.dirname(archive), { recursive: true });
    try {
      const result = powerShellLibrary(
        `
        $inputValue = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BOOTSTRAP_TEST_INPUT)) | ConvertFrom-Json;
        function Invoke-WebRequest { throw 'unexpected_network_request' }
        Add-Type -AssemblyName System.IO.Compression;
        Add-Type -AssemblyName System.IO.Compression.FileSystem;
        $zip = [IO.Compression.ZipFile]::Open([string]$inputValue.archive, [IO.Compression.ZipArchiveMode]::Create);
        try {
          foreach ($file in @(@{name='node-v24.19.0-win-x64/node.exe'; content=$inputValue.nodeBytes}, @{name=$inputValue.nestedEntry; content=$inputValue.nestedBytes})) {
            $entry = $zip.CreateEntry([string]$file.name);
            $stream = $entry.Open();
            try { $bytes=[Text.Encoding]::UTF8.GetBytes([string]$file.content); $stream.Write($bytes, 0, $bytes.Length) }
            finally { $stream.Dispose() }
          }
        } finally { $zip.Dispose() }
        $plan=[pscustomobject]@{Root=$inputValue.root; Directory=$inputValue.directory; NodeVersion='24.19.0'; NodeArchiveHash=(Get-FileHash -LiteralPath $inputValue.archive -Algorithm SHA256).Hash.ToLowerInvariant()};
        $environment=New-SyntheticEnvironment $plan;
        $script:originalTool=(Get-Command Invoke-BootstrapTool).ScriptBlock;
        $script:extractions=0; $script:versionChecks=0;
        function Invoke-BootstrapTool {
          param($Executable, [string[]]$Arguments, $Environment, $Directory, $Label, [switch]$Capture)
          if ($Label -eq 'Node verification') {
            if ($Arguments.Count -ne 1 -or $Arguments[0] -ne '--version') { throw 'fixture_executable_must_not_run' }
            $script:versionChecks++; return [pscustomobject]@{ExitCode=0; Text='v24.19.0'}
          }
          if ([IO.Path]::GetFileName($Executable) -ne 'tar.exe') { throw 'unexpected_native_tool' }
          $script:extractions++;
          return & $script:originalTool $Executable $Arguments $Environment $Directory $Label -Capture:$Capture;
        }
        $node=Ensure-Node $plan $environment;
        [Console]::Write((ConvertTo-Json -InputObject @{node=$node; extractions=$script:extractions; versionChecks=$script:versionChecks} -Compress));
      `,
        { root: directory, directory: bootstrapDirectory, archive, nodeBytes, nestedEntry, nestedBytes },
      );
      expect(result.extractions).toBe(1);
      expect(result.versionChecks).toBe(1);
      expect(await fs.readFile(result.node, "utf8")).toBe(nodeBytes);
      const extracted = path.join(bootstrapDirectory, "tools", ...nestedEntry.split("/"));
      expect(extracted.length).toBeGreaterThan(260);
      expect(await fs.readFile(extracted, "utf8")).toBe(nestedBytes);
    } finally {
      if (path.dirname(directory) !== tempRoot) throw new Error("unsafe_test_cleanup");
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("kills an owned tool and its descendant on timeout while preserving an unrelated test process", async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    const directory = await fs.mkdtemp(path.join(tempRoot, "estate-bootstrap-job-"));
    const record = path.join(directory, "owned-processes.json");
    const script = `
      const {spawn} = require('node:child_process');
      const fs = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore', windowsHide:true});
      fs.writeFileSync(process.argv[1], JSON.stringify({parent:process.pid, descendant:child.pid}));
      setInterval(()=>{},1000);
    `;
    try {
      const result = powerShellLibrary(
        `
        $inputValue = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BOOTSTRAP_TEST_INPUT)) | ConvertFrom-Json;
        $plan = Get-BootstrapPlan ([string]$inputValue.root);
        $environment = New-SyntheticEnvironment $plan ([IO.Path]::GetDirectoryName($env:BOOTSTRAP_TEST_NODE));
        $environment['AGENT8LITE_BOOTSTRAP_NODE'] = $env:BOOTSTRAP_TEST_NODE;
        $otherInfo = New-Object Diagnostics.ProcessStartInfo;
        $otherInfo.FileName = $env:BOOTSTRAP_TEST_NODE;
        $otherInfo.Arguments = '-e ' + (ConvertTo-WindowsArgument 'setInterval(()=>{},1000)');
        $otherInfo.UseShellExecute = $false;
        $otherInfo.CreateNoWindow = $true;
        $unrelated = [Diagnostics.Process]::Start($otherInfo);
        try {
          $timedOut = $false;
          try {
            [void](Invoke-BootstrapTool $env:BOOTSTRAP_TEST_NODE @('-e', [string]$inputValue.script, [string]$inputValue.record) $environment $plan.Root 'Owned timeout test' -Capture -TimeoutSeconds 1);
          } catch { $timedOut = $_.Exception.Message -like '*timed out*' }
          if (-not (Test-Path -LiteralPath $inputValue.record)) { throw 'owned_child_did_not_record_identity' }
          $record = Get-Content -LiteralPath $inputValue.record -Raw | ConvertFrom-Json;
          $deadline = [DateTime]::UtcNow.AddSeconds(2);
          do {
            $alive = @(Get-Process -Id @($record.parent, $record.descendant) -ErrorAction SilentlyContinue);
            if ($alive.Count -eq 0) { break }
            Start-Sleep -Milliseconds 20;
          } while ([DateTime]::UtcNow -lt $deadline);
          $unrelated.Refresh();
          [Console]::Write((ConvertTo-Json -InputObject @{timedOut=$timedOut; ownedAlive=$alive.Count; unrelatedAlive=(-not $unrelated.HasExited)} -Compress));
        } finally {
          if (-not $unrelated.HasExited) { $unrelated.Kill(); [void]$unrelated.WaitForExit(2000) }
          $unrelated.Dispose();
        }
      `,
        { root, script, record },
      );
      expect(result).toEqual({ timedOut: true, ownedAlive: 0, unrelatedAlive: true });
    } finally {
      if (path.dirname(directory) !== tempRoot) throw new Error("unsafe_test_cleanup");
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

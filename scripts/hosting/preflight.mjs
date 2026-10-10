import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOST = Object.freeze({
  provider: "XWeb Pros",
  ip: "68.178.204.192",
  region: "United States (West)",
  ownerReportedPlatform: "AlmaLinux 10 (cPanel)",
});
export const PINS = Object.freeze({ node: "24.19.0", pnpm: "11.25.0" });
const MAX_OUTPUT = 65536;
const VERSION = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/;
const BOOL = /^[01]$/;
const FIELDS = Object.freeze({
  kernel: /^[A-Za-z_][A-Za-z0-9_]{0,23}$/,
  arch: /^[A-Za-z_][A-Za-z0-9_]{0,23}$/,
  os_id: /^[a-z][a-z0-9_]{0,31}$/,
  os_version: /^[0-9]{1,3}(\.[0-9]{1,3}){0,2}$/,
  cpanel_version: /^[0-9]{1,3}(\.[0-9]{1,5}){1,3}$/,
  node_version: VERSION,
  pnpm_present: BOOL,
  pnpm_version: VERSION,
  psql_client_version: /^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?$/,
  redis_binary_version: VERSION,
  cpu_count: /^[0-9]{1,4}$/,
  memory_kib: /^[0-9]{1,12}$/,
  disk_free_kib: /^[0-9]{1,12}$/,
  account_class: /^(root|unprivileged)$/,
  systemd_present: BOOL,
  supervisor_present: BOOL,
  passenger_present: BOOL,
  nginx_present: BOOL,
  httpd_present: BOOL,
  database_roles_verified: /^0$/,
  postgis_verified: /^0$/,
  worker_supervision_verified: /^0$/,
  private_storage_verified: /^0$/,
  https_origin_verified: /^0$/,
  restore_verified: /^0$/,
});
const BOOLEAN_FIELDS = new Set(Object.keys(FIELDS).filter((key) => key.endsWith("_present")));
const NUMERIC_FIELDS = new Set(["cpu_count", "memory_kib", "disk_free_kib"]);
const MESSAGES = Object.freeze({
  INVALID_TARGET: "Use a configured SSH alias containing only letters, digits, underscores or hyphens.",
  INVALID_ARGUMENTS: "Use --ssh-target ALIAS, optionally with --dry-run; no passwords or keys are accepted.",
  INVALID_RESPONSE: "Host inspection returned incomplete or invalid inventory; raw output was discarded.",
  SSH_UNAVAILABLE: "OpenSSH is unavailable; no host inspection occurred.",
  HOST_KEY_UNVERIFIED:
    "The host key is not trusted or has changed; normal SSH trust verification is required.",
  AUTHENTICATION_FAILED: "SSH authentication failed; configure the authorized account/key locally.",
  CONNECTION_FAILED: "SSH inspection failed; verify the configured alias and server access.",
  OUTPUT_LIMIT: "SSH output exceeded the inventory limit; raw output was discarded.",
  TIMEOUT: "Host inspection timed out; its SSH process was stopped.",
});

export class PreflightError extends Error {
  constructor(code) {
    super(MESSAGES[code]);
    this.name = "PreflightError";
    this.code = code;
  }
}

function validNonce(nonce) {
  if (typeof nonce !== "string" || !/^[a-f0-9]{32}$/.test(nonce)) {
    throw new PreflightError("INVALID_RESPONSE");
  }
}

export function sshArguments(sshTarget) {
  if (typeof sshTarget !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(sshTarget)) {
    throw new PreflightError("INVALID_TARGET");
  }
  return [
    "-T",
    "-o",
    `HostName=${HOST.ip}`,
    "-o",
    "BatchMode=yes",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "GSSAPIAuthentication=no",
    "-o",
    "HostbasedAuthentication=no",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "VerifyHostKeyDNS=no",
    "-o",
    "AddKeysToAgent=no",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ConnectionAttempts=1",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "RequestTTY=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    "-o",
    "LogLevel=ERROR",
    sshTarget,
    "/usr/bin/env",
    "-u",
    "BASH_ENV",
    "-u",
    "ENV",
    "/bin/bash",
    "--noprofile",
    "--norc",
    "-s",
  ];
}

export async function probeScript(nonce) {
  validNonce(nonce);
  const source = (await fs.readFile(new URL("./host-probe.sh", import.meta.url), "utf8"))
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n");
  if (source.split("__NONCE__").length !== 2) throw new PreflightError("INVALID_RESPONSE");
  return source.replace("__NONCE__", nonce);
}

export function parseInventory(stdout, nonce) {
  validNonce(nonce);
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT) {
    throw new PreflightError("INVALID_RESPONSE");
  }
  const prefix = `AEHOST1:${nonce}:`;
  const facts = Object.create(null);
  let started = false;
  let ended = false;
  for (const line of stdout.split(/\r?\n/)) {
    // SSH banners are ignored and never copied into a report.
    if (!line.startsWith(prefix)) continue;
    const value = line.slice(prefix.length);
    if (value === "BEGIN" && !started && !ended) {
      started = true;
      continue;
    }
    if (value === "END" && started && !ended) {
      ended = true;
      continue;
    }
    const separator = value.indexOf(":");
    const key = value.slice(0, separator);
    const raw = value.slice(separator + 1);
    if (
      !started ||
      ended ||
      separator < 1 ||
      !Object.hasOwn(FIELDS, key) ||
      Object.hasOwn(facts, key) ||
      !(raw === "-" || FIELDS[key].test(raw))
    ) {
      throw new PreflightError("INVALID_RESPONSE");
    }
    if (key.endsWith("_verified") && raw !== "0") throw new PreflightError("INVALID_RESPONSE");
    if (BOOLEAN_FIELDS.has(key) && raw === "-") throw new PreflightError("INVALID_RESPONSE");
    facts[key] =
      raw === "-"
        ? null
        : BOOLEAN_FIELDS.has(key)
          ? raw === "1"
          : NUMERIC_FIELDS.has(key)
            ? Number(raw)
            : key.endsWith("_verified")
              ? false
              : raw;
  }
  if (!started || !ended || Object.keys(facts).length !== Object.keys(FIELDS).length) {
    throw new PreflightError("INVALID_RESPONSE");
  }
  if (
    (facts.cpu_count !== null && facts.cpu_count < 1) ||
    (facts.memory_kib !== null && facts.memory_kib < 1) ||
    (facts.pnpm_present === false && facts.pnpm_version !== null)
  ) {
    throw new PreflightError("INVALID_RESPONSE");
  }
  return Object.freeze(facts);
}

function exactCheck(id, label, actual, expected) {
  return {
    id,
    label,
    status: actual === null ? "unverified" : actual === expected ? "observed-match" : "mismatch",
    actual,
    expected,
  };
}

export function inventoryReport(facts, sshTarget, inspectedAt = new Date().toISOString()) {
  const cpanelMajor = facts.cpanel_version === null ? null : Number(facts.cpanel_version.split(".")[0]);
  const checks = [
    exactCheck("linux", "Linux kernel", facts.kernel, "Linux"),
    exactCheck("architecture", "cPanel x86_64 architecture", facts.arch, "x86_64"),
    exactCheck("distribution", "Owner-selected distribution", facts.os_id, "almalinux"),
    exactCheck(
      "os-major",
      "Owner-selected OS major",
      facts.os_version === null ? null : facts.os_version.split(".")[0],
      "10",
    ),
    {
      id: "cpanel",
      label: "cPanel release for AlmaLinux 10",
      actual: facts.cpanel_version,
      minimumMajor: 132,
      status: cpanelMajor === null ? "unverified" : cpanelMajor >= 132 ? "observed-match" : "mismatch",
      source: "https://docs.cpanel.net/installation-guide/system-requirements-almalinux/",
    },
    exactCheck("node", "Pinned Node in inspected SSH account PATH", facts.node_version, PINS.node),
    exactCheck("pnpm", "Installed pnpm package metadata", facts.pnpm_version, PINS.pnpm),
  ];
  const remaining = [
    {
      id: "capacity",
      detail:
        "Approve application capacity after representative load measurement; inventory is not a sizing decision.",
    },
    {
      id: "runtime-account",
      detail:
        "Verify the exact runtime under the application service account; the inspected SSH account may differ.",
    },
    {
      id: "database",
      detail:
        "Verify private PostgreSQL17.10/PostGIS3.6.2, migrations and separate non-owner runtime/worker/control/issuer roles. A client binary is not database acceptance.",
    },
    {
      id: "redis",
      detail:
        "Verify private Redis7.4.6 connectivity, restart and data-loss recovery. A binary version is not queue acceptance.",
    },
    {
      id: "workers",
      detail: "Configure and prove durable supervision/restart of separate web, API and worker processes.",
    },
    {
      id: "identity",
      detail:
        "Complete production identity and provider authorization; synthetic loopback sessions cannot serve a public preview.",
    },
    {
      id: "https",
      detail: "Approve staging/application domains, DNS/TLS and private API/cache/proxy behavior.",
    },
    {
      id: "storage",
      detail:
        "Approve private objects/secrets outside the public document root and verify retention/restore.",
    },
    {
      id: "acceptance",
      detail:
        "Complete physical iPhone/Android PWA, security/load/recovery, live-MLS rights and M8 release gates.",
    },
  ];
  return {
    schemaVersion: 1,
    outcome: "inspection-complete",
    deploymentReady: false,
    inspectedAt,
    target: { ...HOST, sshAlias: sshTarget },
    facts,
    checks,
    remaining: remaining.map((item) => ({ ...item, status: "unverified" })),
    limitations: [
      "Inventory covers the inspected account's PATH and readable system files only; absence is not proof a private external service does not exist.",
      "Host-provided observations do not certify capacity, network isolation, production identity, licensed MLS rights or release acceptance.",
      "No service, package, DNS, database, credential or deployment change is performed.",
    ],
  };
}

function connectionError(stderr) {
  if (/host key verification failed|remote host identification has changed/i.test(stderr))
    return "HOST_KEY_UNVERIFIED";
  if (/permission denied|authentication failed|no supported authentication methods/i.test(stderr))
    return "AUTHENTICATION_FAILED";
  return "CONNECTION_FAILED";
}

async function executeProbe(args, script, spawnProcess, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess("ssh", args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(new PreflightError(error?.code === "ENOENT" ? "SSH_UNAVAILABLE" : "CONNECTION_FAILED"));
      return;
    }
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    let forcedStop;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(result);
    };
    const stop = (code) => {
      if (settled) return;
      forcedStop = setTimeout(() => child.kill("SIGKILL"), 1000);
      forcedStop.unref();
      finish(new PreflightError(code));
      child.kill("SIGTERM");
    };
    const deadline = setTimeout(() => stop("TIMEOUT"), timeoutMs);
    const collect = (chunk, errorStream) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT) {
        stop("OUTPUT_LIMIT");
        return;
      }
      if (errorStream) stderr += chunk.toString("utf8");
      else stdout += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk) => collect(chunk, false));
    child.stderr.on("data", (chunk) => collect(chunk, true));
    child.stdout.on("error", () => stop("CONNECTION_FAILED"));
    child.stderr.on("error", () => stop("CONNECTION_FAILED"));
    child.on("error", (error) =>
      finish(new PreflightError(error.code === "ENOENT" ? "SSH_UNAVAILABLE" : "CONNECTION_FAILED")),
    );
    child.on("close", (code) => {
      clearTimeout(forcedStop);
      if (code !== 0) finish(new PreflightError(connectionError(stderr)));
      else finish(null, stdout);
    });
    child.stdin.on("error", () => stop("CONNECTION_FAILED"));
    child.stdin.end(script);
  });
}

export async function inspectHost({ sshTarget, timeoutMs = 30000, spawnProcess = spawn } = {}) {
  const args = sshArguments(sshTarget);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new PreflightError("INVALID_ARGUMENTS");
  const nonce = randomBytes(16).toString("hex");
  const script = await probeScript(nonce);
  const stdout = await executeProbe(args, script, spawnProcess, timeoutMs);
  return inventoryReport(parseInventory(stdout, nonce), sshTarget);
}

export function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  let sshTarget;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ssh-target" && sshTarget === undefined && argv[i + 1]) sshTarget = argv[++i];
    else if (argv[i] === "--dry-run" && !dryRun) dryRun = true;
    else throw new PreflightError("INVALID_ARGUMENTS");
  }
  sshArguments(sshTarget);
  return { sshTarget, dryRun };
}

export async function main(argv) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      console.log(
        "Usage: node scripts/hosting/preflight.mjs --ssh-target ALIAS [--dry-run]\nRead-only inventory of XWeb Pros 68.178.204.192 through an existing local OpenSSH alias.\nStrict host-key checking and noninteractive key authentication are required. No passwords or keys are accepted.\n--dry-run prints the fixed command/probe without connecting. Successful inspection is not deployment approval.",
      );
      return 0;
    }
    if (options.dryRun) {
      console.log(
        JSON.stringify(
          {
            outcome: "dry-run",
            deploymentReady: false,
            target: HOST,
            executable: "ssh",
            arguments: sshArguments(options.sshTarget),
            probe: await probeScript("0".repeat(32)),
          },
          null,
          2,
        ),
      );
      return 0;
    }
    const report = await inspectHost(options);
    console.log(JSON.stringify(report, null, 2));
    return report.checks.some((item) => item.status === "mismatch") ? 2 : 0;
  } catch (error) {
    const safe = error instanceof PreflightError ? error : new PreflightError("CONNECTION_FAILED");
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          outcome: "inspection-failed",
          deploymentReady: false,
          target: HOST,
          error: { code: safe.code, message: safe.message },
        },
        null,
        2,
      ),
    );
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}

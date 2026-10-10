import { createHmac, randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateLocalObjectStore } from "../../packages/storage/private-local";
import type { UploadGrantBinding } from "../../packages/storage/port";

const testRoot = path.resolve(process.cwd(), ".local", "private-storage-tests");
const directories = new Set<string>();
const secret = "private-object-test-signing-secret-32-bytes";
const instant = new Date("2026-10-10T00:00:00.000Z");
const tenant = randomUUID();
const filesystemFault = vi.hoisted(() => ({ operation: null as "write" | "sync" | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const file = await original.open(...args);
      const fault = filesystemFault.operation;
      filesystemFault.operation = null;
      if (fault === "write")
        file.writeFile = async () => {
          throw new Error("Synthetic write failure");
        };
      if (fault === "sync")
        file.sync = async () => {
          throw new Error("Synthetic sync failure");
        };
      return file;
    },
  };
});

function fixture() {
  const directory = path.resolve(testRoot, randomUUID());
  directories.add(directory);
  let clock = instant;
  const store = new PrivateLocalObjectStore({
    mode: "test",
    baseDirectory: directory,
    signingSecret: secret,
    clock: () => clock,
  });
  const binding: UploadGrantBinding = {
    tenantId: tenant,
    memberId: randomUUID(),
    assetId: randomUUID(),
    objectKey: `${tenant}/assets/${randomUUID()}.bin`,
    mimeType: "application/octet-stream",
    bytes: 4,
    expiresAt: new Date(instant.getTime() + 60_000).toISOString(),
  };
  return {
    store,
    binding,
    directory,
    setClock: (next: Date) => {
      clock = next;
    },
  };
}

afterEach(async () => {
  filesystemFault.operation = null;
  vi.unstubAllGlobals();
  for (const directory of directories) {
    const resolved = path.resolve(directory);
    // Check the final absolute deletion target; never remove the shared fixture parent.
    expect(resolved).toBe(directory);
    expect(resolved.startsWith(`${testRoot}${path.sep}`)).toBe(true);
    expect(path.dirname(resolved)).toBe(testRoot);
    await rm(resolved, { recursive: true, force: true });
  }
  directories.clear();
});

describe("M1 — synthetic private object storage and scoped upload grants", () => {
  it("requires explicit development/test mode, a private local child directory and strong signing key", () => {
    expect(() => new PrivateLocalObjectStore({ mode: "production" as "test" })).toThrow(
      "local_storage_disabled",
    );
    for (const baseDirectory of [process.cwd(), path.resolve(process.cwd(), ".local")]) {
      expect(() => new PrivateLocalObjectStore({ mode: "test", baseDirectory })).toThrow(
        "storage_directory_invalid",
      );
    }
    expect(
      () =>
        new PrivateLocalObjectStore({
          mode: "test",
          baseDirectory: path.resolve(process.cwd(), ".local-outside", "objects"),
        }),
    ).toThrow("storage_directory_invalid");
    expect(() => new PrivateLocalObjectStore({ mode: "test", signingSecret: "weak" })).toThrow(
      "storage_signing_key_weak",
    );
  });

  it("binds a signed grant to tenant, member, asset, object key, MIME type, byte count and expiry", () => {
    const { store, binding } = fixture();
    const { signature } = store.issueUploadGrant(binding);
    expect(() => store.verifyUploadGrant(signature, binding)).not.toThrow();
    const otherTenant = randomUUID();
    for (const changed of [
      { ...binding, tenantId: otherTenant, objectKey: `${otherTenant}/assets/file.bin` },
      { ...binding, memberId: randomUUID() },
      { ...binding, assetId: randomUUID() },
      { ...binding, objectKey: `${tenant}/assets/different.bin` },
      { ...binding, mimeType: "image/png" },
      { ...binding, bytes: binding.bytes + 1 },
      { ...binding, expiresAt: new Date(instant.getTime() + 61_000).toISOString() },
    ])
      expect(() => store.verifyUploadGrant(signature, changed)).toThrow("upload_grant_invalid");
    const otherKey = new PrivateLocalObjectStore({
      mode: "test",
      baseDirectory: path.resolve(testRoot, randomUUID()),
      signingSecret: "different-private-storage-key-32-bytes",
      clock: () => instant,
    });
    expect(() => otherKey.verifyUploadGrant(signature, binding)).toThrow("upload_grant_invalid");
  });

  it("rejects altered signatures, malformed claims and unsupported signed grant versions", () => {
    const { store, binding } = fixture();
    const { signature } = store.issueUploadGrant(binding);
    const [payload, signed] = signature.split(".");
    const changed = `${payload}.${signed[0] === "A" ? "B" : "A"}${signed.slice(1)}`;
    for (const value of [changed, "", "invalid.invalid", "x".repeat(1025)])
      expect(() => store.verifyUploadGrant(value, binding)).toThrow("upload_grant_invalid");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    for (const value of [
      "invalid-json",
      JSON.stringify({ ...claims, v: 2 }),
      JSON.stringify({ ...claims, expires: claims.expires + 1 }),
      "null",
    ]) {
      const encoded = Buffer.from(value).toString("base64url");
      const token = `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
      expect(() => store.verifyUploadGrant(token, binding)).toThrow("upload_grant_invalid");
    }
  });

  it("expires grants exactly at the boundary, bounds lifetime and validates upload metadata and clock", () => {
    const { store, binding, setClock } = fixture();
    const signature = store.issueUploadGrant(binding).signature;
    setClock(new Date(instant.getTime() + 60_000));
    expect(() => store.verifyUploadGrant(signature, binding)).toThrow("upload_grant_expired");
    setClock(instant);
    expect(() =>
      store.issueUploadGrant({
        ...binding,
        expiresAt: new Date(instant.getTime() + 15 * 60_000 + 1).toISOString(),
      }),
    ).toThrow("upload_grant_lifetime_invalid");
    for (const value of [0, -1, 1.5, 20 * 1024 * 1024 + 1])
      expect(() => store.issueUploadGrant({ ...binding, bytes: value })).toThrow("upload_binding_invalid");
    for (const changed of [
      { memberId: "invented" },
      { assetId: "invented" },
      { mimeType: "image/png;malicious=1" },
      { expiresAt: "invalid" },
    ])
      expect(() => store.issueUploadGrant({ ...binding, ...changed })).toThrow();
    setClock(new Date("invalid"));
    expect(() => store.issueUploadGrant(binding)).toThrow("storage_clock_invalid");
  });

  it("rejects traversal, absolute paths, backslashes, ambiguous names and Windows device names", async () => {
    const { store, binding } = fixture();
    for (const key of [
      `${tenant}/../escaped`,
      `${tenant}/./escaped`,
      `${tenant}//empty`,
      `${tenant}/..\\escaped`,
      `${tenant}/%2e%2e/escaped`,
      `${tenant}/nul`,
      `${tenant}/CON.txt`,
      `${tenant}/aux.bin`,
      `${tenant}/com1`,
      `${tenant}/lpt9.txt`,
      `${tenant}/trailing.`,
      `${tenant}/space name`,
      `${tenant}/${"a".repeat(129)}`,
      `${tenant}/a/b/c/d/e/f`,
      "C:\\outside\\file.bin",
      "/outside/file.bin",
    ]) {
      expect(() => store.issueUploadGrant({ ...binding, objectKey: key })).toThrow();
      await expect(store.putOnce(tenant, key, Buffer.from("data"))).rejects.toThrow();
      await expect(store.read(tenant, key)).rejects.toThrow();
    }
  });

  it("publishes concurrent identical puts once with complete private bytes and no temporary remnants", async () => {
    const { store, binding, directory } = fixture();
    const bytes = Buffer.alloc(64 * 1024, 0x5a);
    const network = vi.fn(() => {
      throw new Error("Synthetic private storage must not use external networking");
    });
    vi.stubGlobal("fetch", network);
    await Promise.all(Array.from({ length: 8 }, () => store.putOnce(tenant, binding.objectKey, bytes)));
    expect(await store.read(tenant, binding.objectKey)).toEqual(bytes);
    expect(await readdir(path.join(directory, tenant, "assets"))).toEqual([path.basename(binding.objectKey)]);
    await expect(store.putOnce(tenant, binding.objectKey, Buffer.from("different data"))).rejects.toThrow(
      "storage_object_conflict",
    );
    expect(await store.read(tenant, binding.objectKey)).toEqual(bytes);
    expect(network).not.toHaveBeenCalled();
  });

  it("concurrent changed-byte writers choose one immutable complete object and reject the conflicting command", async () => {
    const { store, binding } = fixture();
    const options = [Buffer.alloc(128 * 1024, 0x11), Buffer.alloc(128 * 1024, 0x22)];
    const results = await Promise.allSettled(
      options.map((bytes) => store.putOnce(tenant, binding.objectKey, bytes)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "storage_object_conflict" });
    const winner = results.findIndex((result) => result.status === "fulfilled");
    expect(await store.read(tenant, binding.objectKey)).toEqual(options[winner]);
  });

  it("scopes private reads and result objects by tenant and bounds written bytes", async () => {
    const { store, binding } = fixture();
    await store.putPrivateResult(tenant, binding.objectKey, Buffer.from("data"));
    expect(await store.read(tenant, binding.objectKey)).toEqual(Buffer.from("data"));
    await expect(store.read(randomUUID(), binding.objectKey)).rejects.toThrow("storage_scope_denied");
    await expect(
      store.putPrivateResult(randomUUID(), binding.objectKey, Buffer.from("data")),
    ).rejects.toThrow("storage_scope_denied");
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(20 * 1024 * 1024 + 1)])
      await expect(store.putOnce(tenant, `${tenant}/size.bin`, bytes)).rejects.toThrow(
        "storage_size_invalid",
      );
    await expect(store.read(tenant, `${tenant}/missing.bin`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["write", "sync"] as const)(
    "a %s failure removes unpublished private bytes and permits an explicit retry",
    async (operation) => {
      const { store, binding, directory } = fixture();
      const bytes = Buffer.from("Synthetic private result never exposed before durable publication");
      filesystemFault.operation = operation;
      await expect(store.putOnce(tenant, binding.objectKey, bytes)).rejects.toThrow(
        `Synthetic ${operation} failure`,
      );
      await expect(store.read(tenant, binding.objectKey)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(path.join(directory, tenant, "assets"))).toEqual([]);
      await store.putOnce(tenant, binding.objectKey, bytes);
      expect(await store.read(tenant, binding.objectKey)).toEqual(bytes);
    },
  );
});

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, link, unlink } from "node:fs/promises";
import path from "node:path";
import { StorageError, type PrivateObjectStore, type UploadGrantBinding } from "./port";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxBytes = 20 * 1024 * 1024;

/** Synthetic private storage. Every read still requires the API's current membership/scope checks. */
export class PrivateLocalObjectStore implements PrivateObjectStore {
  private readonly root: string;
  private readonly secret: Buffer;
  constructor(
    private readonly options: {
      mode: "development" | "test";
      baseDirectory?: string;
      signingSecret?: string;
      clock?: () => Date;
    },
  ) {
    if (!["development", "test"].includes(options.mode)) throw new StorageError("local_storage_disabled");
    const local = path.resolve(process.cwd(), ".local");
    this.root = path.resolve(options.baseDirectory ?? path.join(local, "private-objects"));
    if (!this.root.startsWith(`${local}${path.sep}`)) throw new StorageError("storage_directory_invalid");
    if (options.signingSecret && Buffer.byteLength(options.signingSecret) < 32)
      throw new StorageError("storage_signing_key_weak");
    this.secret = options.signingSecret ? Buffer.from(options.signingSecret) : randomBytes(32);
  }
  private now() {
    const value = (this.options.clock?.() ?? new Date()).getTime();
    if (!Number.isFinite(value)) throw new StorageError("storage_clock_invalid");
    return value;
  }
  private objectPath(tenantId: string, objectKey: string) {
    if (!uuid.test(tenantId) || typeof objectKey !== "string" || !objectKey.startsWith(`${tenantId}/`))
      throw new StorageError("storage_scope_denied");
    const segments = objectKey.split("/");
    if (
      segments.length < 2 ||
      segments.length > 6 ||
      segments.some(
        (segment) =>
          !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(segment) ||
          segment === "." ||
          segment === ".." ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment) ||
          segment.endsWith("."),
      )
    )
      throw new StorageError("storage_key_invalid");
    const target = path.resolve(this.root, ...segments);
    if (!target.startsWith(`${this.root}${path.sep}`)) throw new StorageError("storage_key_invalid");
    return target;
  }
  private bindingHash(binding: UploadGrantBinding) {
    this.objectPath(binding.tenantId, binding.objectKey);
    if (
      !uuid.test(binding.memberId) ||
      !uuid.test(binding.assetId) ||
      !Number.isInteger(binding.bytes) ||
      binding.bytes < 1 ||
      binding.bytes > maxBytes ||
      typeof binding.mimeType !== "string" ||
      !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(binding.mimeType)
    )
      throw new StorageError("upload_binding_invalid");
    const expires = new Date(binding.expiresAt).getTime();
    if (!Number.isFinite(expires) || expires <= this.now()) throw new StorageError("upload_grant_expired");
    return createHash("sha256")
      .update(
        JSON.stringify([
          binding.tenantId,
          binding.memberId,
          binding.assetId,
          binding.objectKey,
          binding.mimeType,
          binding.bytes,
          new Date(expires).toISOString(),
        ]),
      )
      .digest("hex");
  }
  issueUploadGrant(binding: UploadGrantBinding) {
    const hash = this.bindingHash(binding);
    const expires = new Date(binding.expiresAt).getTime();
    if (expires > this.now() + 15 * 60_000) throw new StorageError("upload_grant_lifetime_invalid");
    const payload = Buffer.from(JSON.stringify({ v: 1, hash, expires })).toString("base64url");
    const signature = createHmac("sha256", this.secret).update(payload).digest("base64url");
    return { signature: `${payload}.${signature}` };
  }
  verifyUploadGrant(signature: string, binding: UploadGrantBinding) {
    if (
      typeof signature !== "string" ||
      signature.length > 1024 ||
      !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]{43}$/.test(signature)
    )
      throw new StorageError("upload_grant_invalid");
    const [payload, signed] = signature.split(".");
    const expected = createHmac("sha256", this.secret).update(payload).digest();
    const received = Buffer.from(signed, "base64url");
    if (received.length !== expected.length || !timingSafeEqual(received, expected))
      throw new StorageError("upload_grant_invalid");
    let claims;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw new StorageError("upload_grant_invalid");
    }
    if (
      !claims ||
      claims.v !== 1 ||
      claims.hash !== this.bindingHash(binding) ||
      claims.expires !== new Date(binding.expiresAt).getTime() ||
      claims.expires <= this.now()
    )
      throw new StorageError("upload_grant_invalid");
  }
  async putOnce(tenantId: string, objectKey: string, data: Buffer) {
    if (!Buffer.isBuffer(data) || data.length < 1 || data.length > maxBytes)
      throw new StorageError("storage_size_invalid");
    const target = this.objectPath(tenantId, objectKey);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomBytes(12).toString("hex")}.pending`;
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(data);
        await file.sync();
      } finally {
        await file.close();
      }
      // Hard-linking a fully flushed temporary inode publishes an immutable object atomically.
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readFile(target);
        if (existing.length !== data.length || !timingSafeEqual(existing, data))
          throw new StorageError("storage_object_conflict");
      }
    } finally {
      await unlink(temporary);
    }
  }
  async read(tenantId: string, objectKey: string) {
    return readFile(this.objectPath(tenantId, objectKey));
  }
  async putPrivateResult(tenantId: string, objectKey: string, data: Buffer) {
    await this.putOnce(tenantId, objectKey, data);
  }
}

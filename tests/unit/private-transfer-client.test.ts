import { afterEach, describe, expect, it, vi } from "vitest";
import { csvHeaders, privateTransferPath, uploadHeaders } from "../../apps/web/lib/private-transfer";
import type { components } from "../../packages/contracts/generated/api";

const origin = "http://localhost:3000";
const expected = "/api/dev/storage/uploads/synthetic-asset";
const now = new Date("2026-10-10T00:00:00Z");
const grant = (): components["schemas"]["UploadGrant"] => ({
  assetId: "10000000-0000-4000-8000-000000000001",
  url: `${origin}${expected}`,
  method: "PUT",
  expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  requiredHeaders: { "Content-Type": "text/csv", "X-Upload-Grant": "synthetic-signature" },
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("M2 — private browser transfer preparation without browser execution", () => {
  it("normalizes only exact BFF paths on the current origin or same-port loopback aliases", () => {
    for (const value of [
      expected,
      `${origin}${expected}`,
      `http://127.0.0.1:3000${expected}`,
      `http://[::1]:3000${expected}`,
    ])
      expect(privateTransferPath(value, expected, origin)).toBe(expected);
    for (const value of [
      `https://example.invalid${expected}`,
      `http://localhost.example.invalid:3000${expected}`,
      `http://127.0.0.1:3001${expected}`,
      `https://localhost:3000${expected}`,
      `http://user:password@localhost:3000${expected}`,
      `${origin}${expected}?token=private`,
      `${origin}${expected}#fragment`,
      `${origin}/api/dev/storage/uploads/other-asset`,
      `${origin}/api/dev/storage/uploads/%2Fsynthetic-asset`,
      "javascript:alert(1)",
      "data:text/html,private",
    ])
      expect(() => privateTransferPath(value, expected, origin)).toThrow();
  });

  it("sends only allowlisted grant headers plus current CSRF, rejecting expired/incomplete grants", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const prepared: string[][] = [];
    uploadHeaders(grant(), "current-csrf").forEach((value, name) => prepared.push([name, value]));
    expect(prepared).toEqual([
      ["content-type", "text/csv"],
      ["x-csrf-token", "current-csrf"],
      ["x-upload-grant", "synthetic-signature"],
    ]);
    for (const changed of [
      { method: "POST" },
      { expiresAt: now.toISOString() },
      { expiresAt: "unresolved" },
      { requiredHeaders: { "Content-Type": "text/html", "X-Upload-Grant": "synthetic" } },
      { requiredHeaders: { "Content-Type": "text/csv" } },
      {
        requiredHeaders: {
          "Content-Type": "text/csv",
          "X-Upload-Grant": "synthetic",
          Authorization: "forbidden",
        },
      },
      { requiredHeaders: { "Content-Type": "text/csv", "X-Upload-Grant": 123 } },
    ])
      expect(() =>
        uploadHeaders({ ...grant(), ...changed } as components["schemas"]["UploadGrant"], "current-csrf"),
      ).toThrow();
    expect(() => uploadHeaders(grant(), "")).toThrow();
  });

  it("reads a bounded UTF-8 header for mapping and leaves entire-file validation to the server", async () => {
    const file = new File(
      ['\uFEFF"Name, full", Email ,"Remark ""quoted"""\r\n', "x".repeat(1024 * 1024)],
      "synthetic.csv",
      { type: "text/csv" },
    );
    const slice = vi.spyOn(file, "slice");
    expect(await csvHeaders(file)).toEqual(["Name, full", "Email", 'Remark "quoted"']);
    expect(slice).toHaveBeenCalledOnce();
    expect(slice).toHaveBeenCalledWith(0, 256 * 1024);
    for (const invalid of [
      new File(["Name\nData"], "unsafe.html"),
      new File([], "empty.csv"),
      new File([new Uint8Array([0xc3, 0x28])], "invalid.csv"),
      new File(["Name, Name\nData,Data"], "duplicate.csv"),
      new File(["Name,\nData,Data"], "missing.csv"),
      new File(['"Unfinished\nData'], "unfinished.csv"),
      new File(["Name"], "no-data.csv"),
    ])
      await expect(csvHeaders(invalid)).rejects.toThrow();
  });
});

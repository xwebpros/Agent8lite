import type { Schema } from "./api";

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Normalize approved local transfer URLs to the current BFF origin before sending private bytes. */
export function privateTransferPath(value: string, expectedPath: string, currentOrigin: string): string {
  const current = new URL(currentOrigin);
  const target = new URL(value, current);
  const alias =
    loopback.has(current.hostname) &&
    loopback.has(target.hostname) &&
    target.protocol === current.protocol &&
    target.port === current.port;
  if (
    (target.origin !== current.origin && !alias) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    target.pathname !== expectedPath
  )
    throw new Error(
      "The service returned an unapproved private transfer URL. No file was sent or downloaded.",
    );
  return expectedPath;
}

export function uploadHeaders(grant: Schema<"UploadGrant">, csrf: string): Headers {
  const expiry = new Date(grant.expiresAt).getTime();
  if (grant.method !== "PUT" || !Number.isFinite(expiry) || expiry <= Date.now())
    throw new Error("This private upload grant has expired. Choose the file again to request a new grant.");
  const headers = new Headers();
  for (const [name, value] of Object.entries(grant.requiredHeaders)) {
    if (!["content-type", "x-upload-grant"].includes(name.toLowerCase()) || typeof value !== "string")
      throw new Error("This upload grant requires unsupported headers. The file has not been sent.");
    headers.set(name, value);
  }
  if (headers.get("content-type") !== "text/csv" || !headers.get("x-upload-grant") || !csrf)
    throw new Error("The upload grant or current session is incomplete. The file has not been sent.");
  headers.set("X-CSRF-Token", csrf);
  return headers;
}

/** Read only the bounded header locally for mapping. The server validates the entire CSV. */
export async function csvHeaders(file: File): Promise<string[]> {
  if (!file.name.toLowerCase().endsWith(".csv") || !file.size || file.size > 20 * 1024 * 1024)
    throw new Error("Choose a nonempty .csv file of at most 20 MiB, saved as UTF-8 text.");
  const bytes = await file.slice(0, 256 * 1024).arrayBuffer();
  const text = new TextDecoder("utf-8", { fatal: true })
    .decode(bytes, { stream: true })
    .replace(/^\uFEFF/, "");
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closed = false;
  const finishCell = () => {
    row.push(cell.trim());
    cell = "";
    closed = false;
    if (row.length > 30) throw new Error("CSV supports at most 30 columns.");
  };
  const finishHeader = () => {
    finishCell();
    if (row.every((header) => !header)) {
      row = [];
      return null;
    }
    if (row.some((header) => !header) || new Set(row).size !== row.length)
      throw new Error("CSV headers must be nonempty and unique.");
    return row;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += char;
    } else if (char === ",") finishCell();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      const headers = finishHeader();
      if (headers) return headers;
    } else if (char === '"' && !cell && !closed) quoted = true;
    else if (closed || char === '"') throw new Error("The CSV header has invalid quoting.");
    else cell += char;
    if (cell.length > 4096) throw new Error("CSV header cells must contain at most 4,096 characters.");
  }
  throw new Error("A CSV requires a header followed by at least one data row.");
}

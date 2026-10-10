import { AccessError } from "../../../packages/db/tenant-transaction";

/** Bounded RFC 4180-style CSV: UTF-8 only; no binary, executable documents or unbounded cells. */
export function parseCsv(bytes: Buffer): string[][] {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 20 * 1024 * 1024)
    throw new AccessError(422, "csv_size_invalid", "A nonempty CSV of at most 20 MiB is required.");
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    throw new AccessError(422, "csv_encoding_invalid", "CSV must use valid UTF-8 text.");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(source))
    throw new AccessError(422, "csv_content_invalid", "CSV contains unsupported control characters.");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closed = false;
  const finishCell = () => {
    row.push(cell);
    cell = "";
    closed = false;
    if (row.length > 30)
      throw new AccessError(422, "csv_columns_exceeded", "CSV supports at most 30 columns.");
  };
  const finishRow = () => {
    finishCell();
    if (row.some((value) => value.trim())) rows.push(row);
    row = [];
    if (rows.length > 1001)
      throw new AccessError(422, "csv_rows_exceeded", "A local import supports at most 1,000 data rows.");
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += char;
    } else if (char === ",") finishCell();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index++;
      finishRow();
    } else if (char === '"' && !cell && !closed) quoted = true;
    else if (closed || char === '"')
      throw new AccessError(422, "csv_syntax_invalid", "CSV quoting is invalid.");
    else cell += char;
    if (cell.length > 4096)
      throw new AccessError(422, "csv_cell_exceeded", "CSV cells must contain at most 4,096 characters.");
  }
  if (quoted) throw new AccessError(422, "csv_syntax_invalid", "CSV has an unfinished quoted field.");
  if (cell || row.length || closed) finishRow();
  if (rows.length < 2)
    throw new AccessError(422, "csv_rows_required", "CSV requires a header and at least one data row.");
  const headers = rows[0].map((value) => value.trim());
  if (headers.some((value) => !value) || new Set(headers).size !== headers.length)
    throw new AccessError(422, "csv_headers_invalid", "CSV headers must be nonempty and unique.");
  rows[0] = headers;
  return rows;
}

export function csvCell(value: unknown): string {
  let text = value === undefined || value === null ? "" : String(value);
  // Neutralize spreadsheet formulas even when hidden behind whitespace or control characters.
  if (/^[\s\x00-\x1f]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function formatCsv(rows: unknown[][]): Buffer {
  return Buffer.from(`${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`, "utf8");
}

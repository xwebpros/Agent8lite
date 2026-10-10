import { describe, expect, it } from "vitest";
import { csvCell, formatCsv, parseCsv } from "../../apps/api/src/csv";

describe("M2 — bounded contact CSV and safe spreadsheet exports", () => {
  it("parses UTF-8/BOM, CRLF, escaped quotes and multiline fields without losing data", () => {
    const input = Buffer.from(
      '\uFEFF Name ,Email,Remark\r\n"Synthetic, Agent",agent@example.test,"A ""quoted"" remark\r\nsecond line"\r\n\r\n',
    );
    expect(parseCsv(input)).toEqual([
      ["Name", "Email", "Remark"],
      ["Synthetic, Agent", "agent@example.test", 'A "quoted" remark\r\nsecond line'],
    ]);
    expect(parseCsv(Buffer.from("Name,Email\nSynthetic Person,synthetic@example.test"))).toEqual([
      ["Name", "Email"],
      ["Synthetic Person", "synthetic@example.test"],
    ]);
  });

  it("rejects binary, invalid UTF-8, forbidden controls and malformed quoting", () => {
    for (const bytes of [
      Buffer.from([0xc3, 0x28]),
      Buffer.from("Name\nSynthetic\x00payload"),
      Buffer.from("Name\nSynthetic\x1fpayload"),
      Buffer.from('Name\n"Unfinished'),
      Buffer.from('Name\nUnexpected"quote'),
      Buffer.from('Name\n"Closed"trailing'),
    ])
      expect(() => parseCsv(bytes)).toThrow();
  });

  it("requires nonempty unique headers and at least one data row", () => {
    for (const value of ["Name", "Name\n\n", "Name, Name \nA,B", "Name,\nA,B", ",Email\nA,B"])
      expect(() => parseCsv(Buffer.from(value))).toThrow();
  });

  it("bounds upload size, columns, data rows and cell length", () => {
    for (const input of [
      Buffer.alloc(0),
      Buffer.alloc(20 * 1024 * 1024 + 1),
      Buffer.from(
        `${Array.from({ length: 31 }, (_, index) => `Header${index}`).join(",")}\n${Array(31).fill("Value").join(",")}`,
      ),
      Buffer.from(`Name\n${Array(1001).fill("Synthetic").join("\n")}`),
      Buffer.from(`Name\n${"x".repeat(4097)}`),
    ])
      expect(() => parseCsv(input)).toThrow();
    expect(parseCsv(Buffer.from(`Name\n${Array(1000).fill("Synthetic").join("\n")}`))).toHaveLength(1001);
    expect(parseCsv(Buffer.from(`Name\n${"x".repeat(4096)}`))[1][0]).toHaveLength(4096);
  });

  it("neutralizes formula prefixes including leading spaces and control characters", () => {
    const formulas = [
      '=HYPERLINK("https://example.invalid")',
      "+SUM(1,2)",
      "-1+2",
      "@SUM(A1:A2)",
      " \t=1+1",
      "\r\n@SUM(1)",
      "\u00a0=1+1",
    ];
    for (const value of formulas) {
      const encoded = csvCell(value);
      expect(encoded.startsWith("\"'")).toBe(true);
      expect(encoded.endsWith('"')).toBe(true);
    }
    expect(csvCell(4900)).toBe('"4900"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell("Ordinary synthetic name")).toBe('"Ordinary synthetic name"');
  });

  it("exports UTF-8 quoted CRLF rows and preserves literal quotes, commas and line breaks safely", () => {
    const output = formatCsv([
      ["Name", "Remark"],
      ["=1+1", 'Literal "quote", comma\nand newline'],
      ["Synthetic José", null],
    ]);
    expect(output.toString("utf8")).toContain('"\'=1+1"');
    expect(output.toString("utf8").endsWith("\r\n")).toBe(true);
    expect(parseCsv(output)).toEqual([
      ["Name", "Remark"],
      ["'=1+1", 'Literal "quote", comma\nand newline'],
      ["Synthetic José", ""],
    ]);
  });
});

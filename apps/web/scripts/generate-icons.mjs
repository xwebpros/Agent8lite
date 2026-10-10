// Original geometric Estate house mark. PNG encoder uses only Node built-ins.
import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
const directory = fileURLToPath(new URL("../public/icons/", import.meta.url));
await mkdir(directory, { recursive: true });
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, checksum]);
}
function distance(x, y, a, b, c, d) {
  const t = Math.max(0, Math.min(1, ((x - a) * (c - a) + (y - b) * (d - b)) / ((c - a) ** 2 + (d - b) ** 2)));
  return Math.hypot(x - a - t * (c - a), y - b - t * (d - b));
}
function png(size) {
  const bytes = Buffer.alloc((size * 4 + 1) * size);
  const segments = [
    [0.25, 0.46, 0.5, 0.26],
    [0.5, 0.26, 0.75, 0.46],
    [0.32, 0.44, 0.32, 0.73],
    [0.32, 0.73, 0.68, 0.73],
    [0.68, 0.73, 0.68, 0.44],
    [0.46, 0.73, 0.46, 0.57],
    [0.46, 0.57, 0.56, 0.57],
    [0.56, 0.57, 0.56, 0.73],
  ];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let white = 0;
      for (const dy of [0.25, 0.75])
        for (const dx of [0.25, 0.75]) {
          const px = (x + dx) / size;
          const py = (y + dy) / size;
          if (segments.some((segment) => distance(px, py, ...segment) < 0.021)) white++;
        }
      const t = white / 4;
      const index = y * (size * 4 + 1) + 1 + x * 4;
      bytes[index] = 21 * (1 - t) + 245 * t;
      bytes[index + 1] = 38 * (1 - t) + 250 * t;
      bytes[index + 2] = 63 * (1 - t) + 255 * t;
      bytes[index + 3] = 255;
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(bytes)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
for (const [name, size] of [
  ["app-192.png", 192],
  ["app-512.png", 512],
  ["app-maskable-512.png", 512],
  ["apple-touch-icon.png", 180],
])
  await writeFile(`${directory}${name}`, png(size));

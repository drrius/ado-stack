import { mkdir } from "node:fs/promises";
import { join } from "node:path";
// Generates the app icon set deterministically, with no image tooling:
// PNGs are encoded by hand (zlib via node:zlib), then wrapped into the
// PNG-capable ICO and ICNS container formats. Rerun with `bun run icons`.
import { deflateSync } from "node:zlib";

const OUT = join(import.meta.dir, "../src-tauri/icons");

type Rgba = [number, number, number, number];

const BG: Rgba = [27, 31, 42, 255];
const BARS: Array<{ color: Rgba; x: number; y: number; w: number }> = [
  { color: [96, 165, 250, 255], x: 0.18, y: 0.2, w: 0.64 }, // blue: trunk-most PR
  { color: [167, 139, 250, 255], x: 0.28, y: 0.42, w: 0.54 }, // purple
  { color: [52, 211, 153, 255], x: 0.38, y: 0.64, w: 0.44 }, // green: top of stack
];

function drawIcon(size: number): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  const radius = size * 0.22;
  const put = (x: number, y: number, [r, g, b, a]: Rgba) => {
    const i = (y * size + x) * 4;
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = a;
  };
  const insideRounded = (
    x: number,
    y: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    rad: number,
  ): boolean => {
    if (x < x0 || x >= x1 || y < y0 || y >= y1) {
      return false;
    }
    const cx = Math.max(x0 + rad, Math.min(x + 0.5, x1 - rad));
    const cy = Math.max(y0 + rad, Math.min(y + 0.5, y1 - rad));
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    return (
      dx * dx + dy * dy <= rad * rad ||
      (x + 0.5 >= x0 + rad && x + 0.5 <= x1 - rad) ||
      (y + 0.5 >= y0 + rad && y + 0.5 <= y1 - rad)
    );
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (insideRounded(x, y, 0, 0, size, size, radius)) {
        put(x, y, BG);
      }
    }
  }
  const barHeight = Math.max(2, Math.round(size * 0.14));
  const barRadius = barHeight / 2;
  for (const bar of BARS) {
    const x0 = Math.round(bar.x * size);
    const y0 = Math.round(bar.y * size);
    const x1 = Math.round((bar.x + bar.w) * size);
    const y1 = y0 + barHeight;
    for (let y = Math.max(0, y0); y < Math.min(size, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(size, x1); x++) {
        if (insideRounded(x, y, x0, y0, x1, y1, barRadius)) {
          put(x, y, bar.color);
        }
      }
    }
  }
  return pixels;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePng(pixels: Uint8Array, size: number): Uint8Array {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, size);
  ihdrView.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));
  const parts = [
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function png(size: number): Uint8Array {
  return encodePng(drawIcon(size), size);
}

// Modern ICO: PNG-compressed entries (supported since Windows Vista).
function encodeIco(entries: Array<{ size: number; data: Uint8Array }>): Uint8Array {
  const header = new Uint8Array(6 + entries.length * 16);
  const view = new DataView(header.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, entries.length, true);
  let offset = header.length;
  entries.forEach((entry, index) => {
    const base = 6 + index * 16;
    header[base] = entry.size >= 256 ? 0 : entry.size;
    header[base + 1] = entry.size >= 256 ? 0 : entry.size;
    view.setUint16(base + 4, 1, true);
    view.setUint16(base + 6, 32, true);
    view.setUint32(base + 8, entry.data.length, true);
    view.setUint32(base + 12, offset, true);
    offset += entry.data.length;
  });
  const out = new Uint8Array(offset);
  out.set(header, 0);
  let cursor = header.length;
  for (const entry of entries) {
    out.set(entry.data, cursor);
    cursor += entry.data.length;
  }
  return out;
}

// Modern ICNS: PNG payloads in typed boxes.
function encodeIcns(entries: Array<{ type: string; data: Uint8Array }>): Uint8Array {
  const total = 8 + entries.reduce((sum, entry) => sum + 8 + entry.data.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode("icns"), 0);
  view.setUint32(4, total);
  let offset = 8;
  for (const entry of entries) {
    out.set(new TextEncoder().encode(entry.type), offset);
    view.setUint32(offset + 4, 8 + entry.data.length);
    out.set(entry.data, offset + 8);
    offset += 8 + entry.data.length;
  }
  return out;
}

await mkdir(OUT, { recursive: true });
const png32 = png(32);
const png128 = png(128);
const png256 = png(256);
const png512 = png(512);
await Bun.write(join(OUT, "32x32.png"), png32);
await Bun.write(join(OUT, "128x128.png"), png128);
await Bun.write(join(OUT, "128x128@2x.png"), png256);
await Bun.write(join(OUT, "icon.png"), png512);
await Bun.write(
  join(OUT, "icon.ico"),
  encodeIco([
    { size: 32, data: png32 },
    { size: 128, data: png128 },
    { size: 256, data: png256 },
  ]),
);
await Bun.write(
  join(OUT, "icon.icns"),
  encodeIcns([
    { type: "ic07", data: png128 },
    { type: "ic08", data: png256 },
    { type: "ic09", data: png512 },
  ]),
);
console.log(`Wrote icons to ${OUT}`);

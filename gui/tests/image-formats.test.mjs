import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeBmp24,
  encodeIco,
  readBmpHeader,
  readIcoEntries,
  readPngSize,
} from "../scripts/lib/image-formats.mjs";

// A 2x2 RGBA image, top-down: red, green / blue, white.
const rgba = Uint8Array.from([
  255, 0, 0, 255,   0, 255, 0, 255,
  0, 0, 255, 255,   255, 255, 255, 255,
]);

test("encodeBmp24 writes a bottom-up 24-bit BMP with rows padded to four bytes", () => {
  const bmp = encodeBmp24({ width: 2, height: 2, rgba });
  assert.equal(bmp.toString("ascii", 0, 2), "BM");
  const header = readBmpHeader(bmp);
  assert.deepEqual(header, { width: 2, height: 2, bitsPerPixel: 24, compression: 0 });
  // 2 px * 3 bytes = 6, padded to 8 per row; two rows after the 54-byte headers.
  assert.equal(bmp.length, 54 + 8 * 2);
  // Bottom row first, BGR order: blue then white.
  const bottom = bmp.subarray(54, 54 + 6);
  assert.deepEqual([...bottom], [255, 0, 0, 255, 255, 255]);
  const top = bmp.subarray(54 + 8, 54 + 8 + 6);
  assert.deepEqual([...top], [0, 0, 255, 0, 255, 0]);
});

test("encodeBmp24 rejects a pixel buffer of the wrong length", () => {
  assert.throws(() => encodeBmp24({ width: 2, height: 2, rgba: new Uint8Array(3) }), /expected 16 bytes/);
});

test("encodeIco writes a directory whose offsets point at each PNG blob", () => {
  const png16 = Buffer.from("PNG16-bytes-here");
  const png256 = Buffer.from("PNG256");
  const ico = encodeIco([{ size: 16, png: png16 }, { size: 256, png: png256 }]);
  const entries = readIcoEntries(ico);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { width: 16, height: 16, bytes: png16.length, offset: 6 + 16 * 2 });
  // 256 is stored as 0 in the one-byte width/height fields.
  assert.deepEqual(entries[1], { width: 256, height: 256, bytes: png256.length, offset: 6 + 16 * 2 + png16.length });
  assert.equal(ico.subarray(entries[1].offset).toString(), "PNG256");
});

test("readPngSize reads width and height from IHDR", () => {
  const png = Buffer.alloc(33);
  png.write("\x89PNG\r\n\x1a\n", 0, "binary");
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(660, 16);
  png.writeUInt32BE(400, 20);
  assert.deepEqual(readPngSize(png), { width: 660, height: 400 });
  assert.throws(() => readPngSize(Buffer.from("not a png")), /not a PNG/);
});

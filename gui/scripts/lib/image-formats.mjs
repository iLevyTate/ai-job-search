/**
 * Minimal encoders for the two formats electron-builder cannot take as PNG.
 *
 * NSIS wants 24-bit uncompressed BMPs for the wizard sidebar and header; a
 * 32-bit BMP shows as a blank panel with no error. Windows wants a multi-entry
 * ICO for the installer and uninstaller icons; entries are PNG-compressed,
 * which NSIS 3 and Windows Vista+ both accept. No dependencies: the whole
 * point is that the art build needs nothing CI does not already have.
 */

const BMP_FILE_HEADER = 14;
const BMP_INFO_HEADER = 40;

export function encodeBmp24({ width, height, rgba }) {
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`encodeBmp24: expected ${expected} bytes of RGBA, got ${rgba.length}`);
  }
  const stride = (width * 3 + 3) & ~3;
  const pixelBytes = stride * height;
  const out = Buffer.alloc(BMP_FILE_HEADER + BMP_INFO_HEADER + pixelBytes);
  out.write("BM", 0, "ascii");
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(0, 6);
  out.writeUInt32LE(BMP_FILE_HEADER + BMP_INFO_HEADER, 10);
  out.writeUInt32LE(BMP_INFO_HEADER, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22); // positive height: rows are stored bottom-up
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(0, 30); // BI_RGB
  out.writeUInt32LE(pixelBytes, 34);
  out.writeInt32LE(2835, 38); // 72 dpi
  out.writeInt32LE(2835, 42);
  out.writeUInt32LE(0, 46);
  out.writeUInt32LE(0, 50);
  let offset = BMP_FILE_HEADER + BMP_INFO_HEADER;
  for (let y = height - 1; y >= 0; y -= 1) {
    const rowStart = offset;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      out[offset] = rgba[i + 2];
      out[offset + 1] = rgba[i + 1];
      out[offset + 2] = rgba[i];
      offset += 3;
    }
    offset = rowStart + stride; // padding bytes stay zero
  }
  return out;
}

export function readBmpHeader(buf) {
  if (buf.toString("ascii", 0, 2) !== "BM") throw new Error("not a BMP");
  return {
    width: buf.readInt32LE(18),
    height: buf.readInt32LE(22),
    bitsPerPixel: buf.readUInt16LE(28),
    compression: buf.readUInt32LE(30),
  };
}

const ICO_DIR = 6;
const ICO_ENTRY = 16;

export function encodeIco(entries) {
  const dirBytes = ICO_DIR + ICO_ENTRY * entries.length;
  const total = entries.reduce((n, e) => n + e.png.length, dirBytes);
  const out = Buffer.alloc(total);
  out.writeUInt16LE(0, 0);
  out.writeUInt16LE(1, 2); // type: icon
  out.writeUInt16LE(entries.length, 4);
  let offset = dirBytes;
  entries.forEach((entry, index) => {
    const at = ICO_DIR + ICO_ENTRY * index;
    out.writeUInt8(entry.size >= 256 ? 0 : entry.size, at);
    out.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1);
    out.writeUInt8(0, at + 2);
    out.writeUInt8(0, at + 3);
    out.writeUInt16LE(1, at + 4);
    out.writeUInt16LE(32, at + 6);
    out.writeUInt32LE(entry.png.length, at + 8);
    out.writeUInt32LE(offset, at + 12);
    entry.png.copy(out, offset);
    offset += entry.png.length;
  });
  return out;
}

export function readIcoEntries(buf) {
  if (buf.readUInt16LE(2) !== 1) throw new Error("not an ICO");
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const at = ICO_DIR + ICO_ENTRY * i;
    const w = buf.readUInt8(at);
    const h = buf.readUInt8(at + 1);
    entries.push({
      width: w === 0 ? 256 : w,
      height: h === 0 ? 256 : h,
      bytes: buf.readUInt32LE(at + 8),
      offset: buf.readUInt32LE(at + 12),
    });
  }
  return entries;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function readPngSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

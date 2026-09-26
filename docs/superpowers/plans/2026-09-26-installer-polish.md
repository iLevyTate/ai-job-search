# Installer Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Windows installer, the macOS DMG, and the Linux desktop entry the Desk's own look, generated from committed SVG sources by one script, with a test that guards the committed assets by shape.

**Architecture:** SVG sources under `gui/build/src/` are rendered by `gui/scripts/build-installer-art.mjs` using Playwright's bundled Chromium: each SVG is drawn into a canvas (with the Desk's Fraunces font embedded as a data URI so it resolves inside the image), raw pixels come back through `getImageData`, and two small pure-Node encoders in `gui/scripts/lib/image-formats.mjs` write the 24-bit BMPs NSIS needs and the multi-entry ICOs Windows needs; PNGs come from `canvas.toDataURL`. Outputs land in `gui/build/` under electron-builder's default resource names and are committed, the same way `public/dist/desk.js` is; CI and the release workflow use the committed files and never regenerate (Chromium text rasterization is not byte-identical across operating systems, so a byte-level drift check would fail on principle). `gui/tests/installer-art.test.mjs` asserts every referenced asset exists at its exact dimensions and bit depth. The NSIS welcome page text is set through electron-builder's `customHeader` macro in the existing `build/installer.nsh`.

**Tech Stack:** electron-builder 26.15 (NSIS via MUI2, dmg, AppImage), Playwright 1.62 (already a devDependency, used by `scripts/record-tour.mjs`), Node 22 `node:test`, no new dependencies.

**Working directory for every command:** the root of the public checkout (the clone whose `origin` is `iLevyTate/ai-job-search`), on branch `installer-polish`, which already holds the spec commit. Run `gui` commands from `gui/`. This is the public repo: the split guard blocks personal identifiers on write and on push, including absolute paths that contain an account name; nothing in this plan needs one, so use relative paths throughout.

---

## File structure

| Path | Responsibility |
|---|---|
| `gui/scripts/lib/image-formats.mjs` (new) | Pure functions: `encodeBmp24`, `encodeIco`, and the three readers the tests use (`readBmpHeader`, `readPngSize`, `readIcoEntries`). No I/O. |
| `gui/build/src/mark.svg` (new, replaces `gui/build/icon.svg`) | The app mark. Source for `icon.png`, `icons/`, `installerIcon.ico`. |
| `gui/build/src/uninstall-mark.svg` (new) | The mark in cream on amber. Source for `uninstallerIcon.ico`. |
| `gui/build/src/sidebar.svg` (new) | 164 x 314 welcome/finish sidebar. |
| `gui/build/src/header.svg` (new) | 150 x 57 header strip. |
| `gui/build/src/background.svg` (new) | 660 x 400 DMG background. |
| `gui/scripts/build-installer-art.mjs` (new) | Renders every target from the SVGs, writes `gui/build/*` outputs, copies `LICENSE` to `gui/build/license.txt`. |
| `gui/build/{icon.png, icons/*.png, installerSidebar.bmp, installerHeader.bmp, installerIcon.ico, uninstallerIcon.ico, background.png, background@2x.png, license.txt}` (generated, committed) | What electron-builder consumes. Default resource names, so electron-builder finds them with or without the explicit keys. |
| `gui/electron-builder.yml` (modify) | `copyright`, `nsis.*` art keys, `dmg` layout, `linux.icon` + `linux.desktop.entry`. |
| `gui/package.json` (modify) | `author`, `build:installer-art` script. |
| `gui/build/installer.nsh` (modify) | `customHeader` macro setting the welcome page title and text. |
| `gui/tests/image-formats.test.mjs` (new) | Encoder/reader unit tests. |
| `gui/tests/installer-art.test.mjs` (new) | Committed assets exist at exact size/depth; yml references them; `license.txt` equals `LICENSE`. |
| `gui/tests/package-config.test.mjs` (modify) | `author` and `copyright` assertions. |
| `docs/superpowers/specs/2026-09-26-installer-polish-design.md` (modify) | Three corrections the implementation forced. |
| `CHANGELOG.md` (modify) | `[Unreleased]` entry. |

---

### Task 1: BMP and ICO encoders with readers

**Files:**
- Create: `gui/scripts/lib/image-formats.mjs`
- Test: `gui/tests/image-formats.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// gui/tests/image-formats.test.mjs
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd gui && node --test tests/image-formats.test.mjs`
Expected: FAIL, `Cannot find module '.../scripts/lib/image-formats.mjs'`

- [ ] **Step 3: Write the module**

```js
// gui/scripts/lib/image-formats.mjs
/**
 * Minimal encoders for the two formats electron-builder cannot take as PNG.
 *
 * NSIS wants 24-bit uncompressed BMPs for the wizard sidebar and header; a
 * 32-bit BMP shows as a blank panel with no error. Windows wants a multi-entry
 * ICO for the installer and uninstaller icons; entries are PNG-compressed,
 * which NSIS 3 and Windows Vista+ both accept. No dependencies: the whole
 * point is that the art script needs nothing CI does not already have.
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd gui && node --test tests/image-formats.test.mjs`
Expected: `# pass 4`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add gui/scripts/lib/image-formats.mjs gui/tests/image-formats.test.mjs
git commit -m "Add dependency-free BMP and ICO encoders for installer art

NSIS takes 24-bit BMPs for the wizard sidebar and header and shows a blank
panel, not an error, if handed a 32-bit one. Windows takes a multi-entry
ICO with PNG-compressed entries for the installer icons. Both are small
enough to write directly, and doing so keeps the art build free of any
tool CI does not already have. Readers for the tests come with them."
```

---

### Task 2: SVG sources

**Files:**
- Create: `gui/build/src/mark.svg`, `gui/build/src/uninstall-mark.svg`, `gui/build/src/sidebar.svg`, `gui/build/src/header.svg`, `gui/build/src/background.svg`
- Delete: `gui/build/icon.svg`
- Test: `gui/tests/installer-art.test.mjs` (first test only; the rest come in Task 3)

The palette is the app's: ink `#1c1814`, cream `#f4ead6`, amber `#d08a3a`, line `#201b16`. Text uses `Fraunces` (display) and `Bricolage Grotesque` (sans); the render script embeds both from `gui/public/vendor/fonts/` so they resolve inside the image.

- [ ] **Step 1: Write the failing test**

```js
// gui/tests/installer-art.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const build = (name) => new URL(`../build/${name}`, import.meta.url);

test("every SVG source declares the size its target needs", async () => {
  const expected = {
    "src/mark.svg": [256, 256],
    "src/uninstall-mark.svg": [256, 256],
    "src/sidebar.svg": [164, 314],
    "src/header.svg": [150, 57],
    "src/background.svg": [660, 400],
  };
  for (const [name, [w, h]] of Object.entries(expected)) {
    const svg = await readFile(build(name), "utf8");
    assert.match(svg, new RegExp(`viewBox="0 0 ${w} ${h}"`), `${name} viewBox`);
    assert.match(svg, new RegExp(`width="${w}"`), `${name} width`);
    assert.match(svg, new RegExp(`height="${h}"`), `${name} height`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd gui && node --test tests/installer-art.test.mjs`
Expected: FAIL, `ENOENT ... build/src/mark.svg`

- [ ] **Step 3: Create the SVG sources and remove the old icon.svg**

`gui/build/src/mark.svg` (the existing icon, unchanged):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" rx="48" fill="#1c1814"/>
  <rect x="36" y="52" width="184" height="132" rx="16" fill="#f4ead6"/>
  <rect x="52" y="68" width="88" height="12" rx="6" fill="#d08a3a"/>
  <rect x="52" y="92" width="152" height="8" rx="4" fill="#201b16" opacity="0.35"/>
  <rect x="52" y="112" width="128" height="8" rx="4" fill="#201b16" opacity="0.28"/>
  <rect x="52" y="132" width="140" height="8" rx="4" fill="#201b16" opacity="0.22"/>
  <circle cx="196" cy="196" r="28" fill="#d08a3a"/>
</svg>
```

`gui/build/src/uninstall-mark.svg` (amber field so it is never confused with the app in Add/Remove):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" rx="48" fill="#d08a3a"/>
  <rect x="36" y="52" width="184" height="132" rx="16" fill="#f4ead6"/>
  <rect x="52" y="68" width="88" height="12" rx="6" fill="#1c1814"/>
  <rect x="52" y="92" width="152" height="8" rx="4" fill="#201b16" opacity="0.35"/>
  <rect x="52" y="112" width="128" height="8" rx="4" fill="#201b16" opacity="0.28"/>
  <rect x="52" y="132" width="140" height="8" rx="4" fill="#201b16" opacity="0.22"/>
  <circle cx="196" cy="196" r="28" fill="#1c1814"/>
</svg>
```

`gui/build/src/sidebar.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="164" height="314" viewBox="0 0 164 314">
  <rect width="164" height="314" fill="#1c1814"/>
  <g transform="translate(34 40) scale(0.375)">
    <rect width="256" height="256" rx="48" fill="#2a2420"/>
    <rect x="36" y="52" width="184" height="132" rx="16" fill="#f4ead6"/>
    <rect x="52" y="68" width="88" height="12" rx="6" fill="#d08a3a"/>
    <rect x="52" y="92" width="152" height="8" rx="4" fill="#201b16" opacity="0.35"/>
    <rect x="52" y="112" width="128" height="8" rx="4" fill="#201b16" opacity="0.28"/>
    <rect x="52" y="132" width="140" height="8" rx="4" fill="#201b16" opacity="0.22"/>
    <circle cx="196" cy="196" r="28" fill="#d08a3a"/>
  </g>
  <text x="82" y="176" text-anchor="middle" font-family="Fraunces" font-weight="360" font-size="22" fill="#f4ead6">Job Search</text>
  <text x="82" y="202" text-anchor="middle" font-family="Fraunces" font-weight="360" font-size="22" fill="#f4ead6">Desk</text>
  <rect x="66" y="222" width="32" height="2" fill="#d08a3a"/>
  <text x="82" y="252" text-anchor="middle" font-family="Bricolage Grotesque" font-size="10" fill="#f4ead6" opacity="0.7">The hunt stays</text>
  <text x="82" y="266" text-anchor="middle" font-family="Bricolage Grotesque" font-size="10" fill="#f4ead6" opacity="0.7">on this computer.</text>
</svg>
```

`gui/build/src/header.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="150" height="57" viewBox="0 0 150 57">
  <rect width="150" height="57" fill="#1c1814"/>
  <g transform="translate(10 10) scale(0.1445)">
    <rect width="256" height="256" rx="48" fill="#2a2420"/>
    <rect x="36" y="52" width="184" height="132" rx="16" fill="#f4ead6"/>
    <rect x="52" y="68" width="88" height="12" rx="6" fill="#d08a3a"/>
    <rect x="52" y="92" width="152" height="8" rx="4" fill="#201b16" opacity="0.35"/>
    <rect x="52" y="112" width="128" height="8" rx="4" fill="#201b16" opacity="0.28"/>
    <circle cx="196" cy="196" r="28" fill="#d08a3a"/>
  </g>
  <text x="56" y="34" font-family="Fraunces" font-weight="360" font-size="15" fill="#f4ead6">Job Search Desk</text>
</svg>
```

`gui/build/src/background.svg` (the app icon lands at x=170, the Applications alias at x=490, both centred on y=210 with icon size 128; the copy sits below the arrow):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="660" height="400" viewBox="0 0 660 400">
  <rect width="660" height="400" fill="#1c1814"/>
  <text x="330" y="78" text-anchor="middle" font-family="Fraunces" font-weight="360" font-size="30" fill="#f4ead6">Job Search Desk</text>
  <rect x="314" y="92" width="32" height="2" fill="#d08a3a"/>
  <line x1="262" y1="210" x2="392" y2="210" stroke="#d08a3a" stroke-width="3" stroke-linecap="round"/>
  <polyline points="378,198 392,210 378,222" fill="none" stroke="#d08a3a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="330" y="318" text-anchor="middle" font-family="Bricolage Grotesque" font-size="14" fill="#f4ead6" opacity="0.85">Drag to Applications.</text>
  <text x="330" y="340" text-anchor="middle" font-family="Bricolage Grotesque" font-size="13" fill="#f4ead6" opacity="0.6">Unsigned build: right-click, then Open, the first time.</text>
</svg>
```

Then: `git rm gui/build/icon.svg` (the mark now lives at `src/mark.svg`; nothing referenced `icon.svg`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd gui && node --test tests/installer-art.test.mjs`
Expected: `# pass 1`

- [ ] **Step 5: Commit**

```bash
git add gui/build/src gui/tests/installer-art.test.mjs
git rm -q gui/build/icon.svg
git commit -m "Add the installer art as SVG sources in the Desk's own palette

The mark, an uninstaller variant on amber, the NSIS sidebar and header,
and the DMG background, each declared at the exact size its target
needs. Text is set in Fraunces and Bricolage Grotesque, the faces the
Desk already ships, so the installer looks like the app it installs."
```

---

### Task 3: The render script and the shape test

**Files:**
- Create: `gui/scripts/build-installer-art.mjs`
- Modify: `gui/package.json` (scripts)
- Modify: `gui/tests/installer-art.test.mjs` (add the asset tests)
- Generated + committed: `gui/build/icon.png`, `gui/build/icons/*.png`, `gui/build/installerSidebar.bmp`, `gui/build/installerHeader.bmp`, `gui/build/installerIcon.ico`, `gui/build/uninstallerIcon.ico`, `gui/build/background.png`, `gui/build/background@2x.png`, `gui/build/license.txt`

- [ ] **Step 1: Write the failing asset tests**

Append to `gui/tests/installer-art.test.mjs`:

```js
import { readBmpHeader, readIcoEntries, readPngSize } from "../scripts/lib/image-formats.mjs";

test("the NSIS bitmaps are the exact size MUI2 expects and 24-bit", async () => {
  for (const [name, w, h] of [["installerSidebar.bmp", 164, 314], ["installerHeader.bmp", 150, 57]]) {
    const header = readBmpHeader(await readFile(build(name)));
    assert.deepEqual(header, { width: w, height: h, bitsPerPixel: 24, compression: 0 }, name);
  }
});

test("the installer and uninstaller icons carry every size Windows asks for", async () => {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  for (const name of ["installerIcon.ico", "uninstallerIcon.ico"]) {
    const buf = await readFile(build(name));
    const entries = readIcoEntries(buf);
    assert.deepEqual(entries.map((e) => e.width), sizes, name);
    for (const e of entries) {
      assert.deepEqual(readPngSize(buf.subarray(e.offset, e.offset + e.bytes)), { width: e.width, height: e.height }, `${name} ${e.width}`);
    }
  }
});

test("the DMG background exists at 1x and 2x", async () => {
  assert.deepEqual(readPngSize(await readFile(build("background.png"))), { width: 660, height: 400 });
  assert.deepEqual(readPngSize(await readFile(build("background@2x.png"))), { width: 1320, height: 800 });
});

test("the app icon set covers the standard sizes and icon.png is 512", async () => {
  assert.deepEqual(readPngSize(await readFile(build("icon.png"))), { width: 512, height: 512 });
  for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
    assert.deepEqual(readPngSize(await readFile(build(`icons/${size}x${size}.png`))), { width: size, height: size });
  }
});

test("the license shown by the installer is the repository LICENSE", async () => {
  const shown = await readFile(build("license.txt"), "utf8");
  const source = await readFile(new URL("../../LICENSE", import.meta.url), "utf8");
  assert.equal(shown, source);
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `cd gui && node --test tests/installer-art.test.mjs`
Expected: `# pass 1`, `# fail 5` (each with `ENOENT`)

- [ ] **Step 3: Write the render script**

```js
// gui/scripts/build-installer-art.mjs
/**
 * Render every installer asset from the SVG sources in build/src.
 *
 * Each SVG is drawn into a canvas inside Playwright's bundled Chromium. The
 * Desk's own fonts are embedded into the SVG as data URIs first, because an
 * SVG drawn as an image cannot reach the page's fonts. Raw pixels come back
 * through getImageData for the BMPs; PNGs come from toDataURL.
 *
 * Outputs are committed. CI does not run this: Chromium's text rasterizer is
 * not byte-identical across operating systems, so a rebuild on Linux would
 * differ from one on Windows in ways that do not matter. Run it after editing
 * an SVG, look at the results, and commit them with the SVG.
 *
 *   npm run build:installer-art
 */
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { encodeBmp24, encodeIco } from "./lib/image-formats.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUI = join(HERE, "..");
const BUILD = join(GUI, "build");
const SRC = join(BUILD, "src");
const FONTS = join(GUI, "public", "vendor", "fonts");

const FONT_FILES = {
  Fraunces: "fraunces_v38_6NU58FyLNQOQZAnv9ZwNjucMHVn85Ni7emAe9lKqZTnbB-gzTK0K1ChjeveQ.woff2",
  "Bricolage Grotesque": "bricolagegrotesque_v9_3y9K6as8bTXq_nANBjzKo3IeZx8z6up5BeSl9D4dj_x9PpZBMlGIInE.woff2",
};

// One output per line: [source svg, output file, width, height, format, scale]
const TARGETS = [
  ["sidebar.svg", "installerSidebar.bmp", 164, 314, "bmp", 1],
  ["header.svg", "installerHeader.bmp", 150, 57, "bmp", 1],
  ["background.svg", "background.png", 660, 400, "png", 1],
  ["background.svg", "background@2x.png", 660, 400, "png", 2],
  ["mark.svg", "icon.png", 512, 512, "png", 1],
];
const ICON_SET = [16, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function fontStyle() {
  const faces = Object.entries(FONT_FILES).map(([family, file]) => {
    const b64 = readFileSync(join(FONTS, file)).toString("base64");
    return `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
  });
  return `<style>${faces.join("")}</style>`;
}

function svgWithFonts(name, style) {
  const svg = readFileSync(join(SRC, name), "utf8");
  return svg.replace(/(<svg[^>]*>)/, `$1${style}`);
}

async function render(page, svg, width, height, scale) {
  return page.evaluate(async ({ svg, width, height, scale }) => {
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const png = canvas.toDataURL("image/png").split(",")[1];
    return { rgba: Array.from(data), png };
  }, { svg, width, height, scale });
}

async function main() {
  const style = fontStyle();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent("<!doctype html><title>installer art</title>");
  mkdirSync(join(BUILD, "icons"), { recursive: true });

  for (const [src, out, width, height, format, scale] of TARGETS) {
    const svg = svgWithFonts(src, style);
    const result = await render(page, svg, width, height, scale);
    const file = join(BUILD, out);
    if (format === "bmp") {
      writeFileSync(file, encodeBmp24({ width, height, rgba: Uint8Array.from(result.rgba) }));
    } else {
      writeFileSync(file, Buffer.from(result.png, "base64"));
    }
    console.log(`${out}  ${width * scale}x${height * scale}`);
  }

  const mark = svgWithFonts("mark.svg", style);
  for (const size of ICON_SET) {
    const { png } = await render(page, mark, size, size, 1);
    writeFileSync(join(BUILD, "icons", `${size}x${size}.png`), Buffer.from(png, "base64"));
  }
  console.log(`icons/  ${ICON_SET.join(", ")}`);

  for (const [src, out] of [["mark.svg", "installerIcon.ico"], ["uninstall-mark.svg", "uninstallerIcon.ico"]]) {
    const svg = svgWithFonts(src, style);
    const entries = [];
    for (const size of ICO_SIZES) {
      const { png } = await render(page, svg, size, size, 1);
      entries.push({ size, png: Buffer.from(png, "base64") });
    }
    writeFileSync(join(BUILD, out), encodeIco(entries));
    console.log(`${out}  ${ICO_SIZES.join(", ")}`);
  }

  copyFileSync(join(GUI, "..", "LICENSE"), join(BUILD, "license.txt"));
  console.log("license.txt  copied from LICENSE");

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Add the script to `gui/package.json` `scripts`, after `"record"`:

```json
    "build:installer-art": "node scripts/build-installer-art.mjs",
```

- [ ] **Step 4: Run the script**

Run: `cd gui && npm run build:installer-art`
Expected output:

```
installerSidebar.bmp  164x314
installerHeader.bmp  150x57
background.png  660x400
background@2x.png  1320x800
icon.png  512x512
icons/  16, 32, 48, 64, 128, 256, 512, 1024
installerIcon.ico  16, 24, 32, 48, 64, 128, 256
uninstallerIcon.ico  16, 24, 32, 48, 64, 128, 256
license.txt  copied from LICENSE
```

If Playwright reports no browser, run `cd gui && npx playwright install chromium` once and retry.

- [ ] **Step 5: Look at the results**

Open `gui/build/background.png`, `gui/build/background@2x.png`, and `gui/build/icons/256x256.png` with the Read tool. Check: ink background, cream Fraunces wordmark, amber arrow between the two icon positions, the two lines of copy legible, nothing clipped. The BMPs cannot be opened by the Read tool; their correctness is the shape test plus the Windows build in Task 6.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd gui && node --test tests/installer-art.test.mjs tests/image-formats.test.mjs`
Expected: `# pass 10`, `# fail 0`

- [ ] **Step 7: Commit the script and the generated assets together**

```bash
git add gui/scripts/build-installer-art.mjs gui/package.json gui/tests/installer-art.test.mjs gui/build
git commit -m "Render the installer art from its SVG sources and commit the results

One script draws each SVG into a canvas in Playwright's Chromium, with the
Desk's fonts embedded so they resolve inside the image, and writes the NSIS
bitmaps, the installer icons, the DMG background at 1x and 2x, the Linux
icon set, and a 512 icon.png. The outputs are committed under
electron-builder's default resource names; CI consumes them and does not
regenerate, since Chromium's text rasterizer is not byte-identical across
operating systems. A test guards each file by size and bit depth."
```

---

### Task 4: Wire electron-builder and the package metadata

**Files:**
- Modify: `gui/electron-builder.yml`
- Modify: `gui/package.json` (`author`)
- Modify: `gui/tests/package-config.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `gui/tests/package-config.test.mjs`:

```js
test("the installer metadata names the project, not a placeholder", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  assert.equal(pkg.author, "Job Search Desk contributors");
  const yml = await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
  assert.match(yml, /^copyright: \(c\) 2026 Job Search Desk contributors\. MIT License\.$/m);
});

test("electron-builder references every generated installer asset", async () => {
  const yml = await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
  for (const line of [
    "installerIcon: installerIcon.ico",
    "uninstallerIcon: uninstallerIcon.ico",
    "installerHeader: installerHeader.bmp",
    "installerSidebar: installerSidebar.bmp",
    "uninstallerSidebar: installerSidebar.bmp",
    "background: background.png",
    "icon: icons",
    "Comment: Job search desk that keeps the hunt in a folder on this computer",
    "Keywords: job;search;cv;resume;application;",
  ]) {
    assert.ok(yml.includes(line), `missing: ${line}`);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd gui && node --test tests/package-config.test.mjs`
Expected: 2 new failures, the first on `pkg.author` (`'AI Job Search' !== 'Job Search Desk contributors'`)

- [ ] **Step 3: Edit the config**

In `gui/package.json`, change `"author": "AI Job Search"` to `"author": "Job Search Desk contributors"`.

In `gui/electron-builder.yml`:

Change line 3 `copyright: AI Job Search` to:

```yaml
copyright: (c) 2026 Job Search Desk contributors. MIT License.
```

Replace the `nsis:` block with:

```yaml
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: false
  shortcutName: Job Search Desk
  createDesktopShortcut: always
  createStartMenuShortcut: true
  runAfterFinish: true
  deleteAppDataOnUninstall: false
  uninstallDisplayName: Job Search Desk ${version}
  include: build/installer.nsh
  # Art rendered by scripts/build-installer-art.mjs from build/src/*.svg.
  # These are electron-builder's default resource names, so the files are
  # found either way; naming them keeps the wiring visible.
  installerIcon: installerIcon.ico
  uninstallerIcon: uninstallerIcon.ico
  installerHeader: installerHeader.bmp
  installerSidebar: installerSidebar.bmp
  uninstallerSidebar: installerSidebar.bmp
```

(The license page needs no key: electron-builder finds `build/license.txt` by name.)

Replace the `mac:` block's tail and add `dmg:` after it:

```yaml
mac:
  category: public.app-category.productivity
  icon: build/icon.png
  identity: null
  target:
    - dmg
    - zip
  artifactName: JobSearchDesk-${version}-mac-${arch}.${ext}
dmg:
  title: Job Search Desk
  background: background.png
  iconSize: 128
  window:
    width: 660
    height: 400
  contents:
    - x: 170
      y: 210
      type: file
    - x: 490
      y: 210
      type: link
      path: /Applications
```

Replace the `linux:` block with:

```yaml
linux:
  category: Office
  icon: icons
  desktop:
    entry:
      Comment: Job search desk that keeps the hunt in a folder on this computer
      Keywords: job;search;cv;resume;application;
  target:
    - AppImage
  artifactName: JobSearchDesk-${version}-linux-${arch}.${ext}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd gui && node --test tests/package-config.test.mjs`
Expected: all pass (the two new tests plus the existing ones)

- [ ] **Step 5: Confirm the YAML still parses**

Run: `cd gui && node -e "const y=require('yaml');y.parse(require('fs').readFileSync('electron-builder.yml','utf8'));console.log('yaml ok')"`
Expected: `yaml ok`

- [ ] **Step 6: Commit**

```bash
git add gui/electron-builder.yml gui/package.json gui/tests/package-config.test.mjs
git commit -m "Point electron-builder at the installer art and name the publisher

The NSIS wizard gets its sidebar, header, and distinct installer and
uninstaller icons; the DMG gets the background, a window sized to it,
and the app and Applications positions the background's arrow points
between; the AppImage gets an icon set and a desktop entry that says
what the app is. Publisher and copyright name the project instead of a
placeholder. Product name, app id, and artifact names are unchanged so
upgrades and the updater keep matching."
```

---

### Task 5: Welcome page copy in the NSIS wizard

**Files:**
- Modify: `gui/build/installer.nsh` (add a `customHeader` macro at the top, after the `!include`)

electron-builder inserts `customHeader` at `installer.nsi:45`, before any `MUI_PAGE_*` macro, and its own templates define neither `MUI_WELCOMEPAGE_TITLE` nor `MUI_WELCOMEPAGE_TEXT`, so defining them here is safe. The uninstaller also includes this file; the defines are harmless there because the uninstaller has no welcome page.

- [ ] **Step 1: Audit the copy before it goes in**

Write the paragraph to a scratch file and run the repository's prose audit (the script ships in this repo at `.claude/skills/strip-ai-tells/scripts/audit_prose.py`):

```bash
printf '%s\n' "Job Search Desk keeps a job search in a folder on this computer: postings found, applications drafted, and what happened to each one. Setup adds Start Menu and Desktop shortcuts and installs for your account only, with no administrator rights. Your job-search folder stays wherever you put it and is never uploaded." > /tmp/welcome.txt
python .claude/skills/strip-ai-tells/scripts/audit_prose.py /tmp/welcome.txt
```

Expected: `0 to fix`. A rule-of-three LOOK on "postings found, applications drafted, and what happened to each one" is acceptable; those are the three things the tracker records.

- [ ] **Step 2: Add the macro**

Insert after `!include "LogicLib.nsh"` at the top of `gui/build/installer.nsh`:

```nsis
; Welcome page copy. electron-builder inserts customHeader before the MUI
; page macros and defines neither of these itself. $\r$\n is a line break.
!macro customHeader
  !define MUI_WELCOMEPAGE_TITLE "Job Search Desk"
  !define MUI_WELCOMEPAGE_TEXT "Job Search Desk keeps a job search in a folder on this computer: postings found, applications drafted, and what happened to each one.$\r$\n$\r$\nSetup adds Start Menu and Desktop shortcuts and installs for your account only, with no administrator rights.$\r$\n$\r$\nYour job-search folder stays wherever you put it and is never uploaded."
!macroend
```

- [ ] **Step 3: Add a test that the copy is present and the upgrade dialog is untouched**

Append to `gui/tests/installer-art.test.mjs`:

```js
test("installer.nsh sets the welcome copy and keeps the upgrade dialog", async () => {
  const nsh = await readFile(build("installer.nsh"), "utf8");
  assert.match(nsh, /!macro customHeader/);
  assert.match(nsh, /MUI_WELCOMEPAGE_TEXT ".*never uploaded\."/);
  assert.match(nsh, /!macro customInit/);
  assert.match(nsh, /Yes = replace it with this version/);
});
```

Run: `cd gui && node --test tests/installer-art.test.mjs`
Expected: `# pass 7`

- [ ] **Step 4: Commit**

```bash
git add gui/build/installer.nsh gui/tests/installer-art.test.mjs
git commit -m "Say what the installer does on its welcome page

One paragraph: what the Desk is, that setup adds shortcuts and installs
for the current account without administrator rights, and that the
job-search folder stays where the person puts it. The upgrade dialog in
customInit is unchanged."
```

---

### Task 6: Build the Windows installer locally and prove the wiring

**Files:** none modified. Output goes to `gui/release/` (must be ignored; the first step checks).

- [ ] **Step 1: Confirm release/ is ignored**

Run: `git check-ignore -v gui/release`
Expected: a `.gitignore` line. If nothing prints, stop and add `gui/release/` to `.gitignore` before building.

- [ ] **Step 2: Build the NSIS installer with debug logging**

Run (from `gui/`; the log goes to the system temp directory, outside the repo):

```bash
cd gui && npm run build:renderer && DEBUG=electron-builder npx electron-builder --win nsis --publish never > "$TEMP/installer-build.log" 2>&1; echo "exit=$?"; ls -la release/*.exe
```

Expected: `exit=0` and `release/JobSearchDesk-1.3.5-win-x64.exe` listed. If the build fails on `node-pty`, run `npm run rebuild:native` first and retry.

- [ ] **Step 3: Prove the defines electron-builder passed to makensis**

Run:

```bash
grep -oE "MUI_(WELCOMEFINISHPAGE_BITMAP|UNWELCOMEFINISHPAGE_BITMAP|HEADERIMAGE_BITMAP|ICON|UNICON)=[^ ]*" "$TEMP/installer-build.log" | sed -E 's#=.*[\\/]build[\\/]#=build/#' | sort -u
```

Expected (paths shortened by the `sed` so no machine path appears in the output):

```
MUI_HEADERIMAGE_BITMAP=build/installerHeader.bmp
MUI_ICON=build/installerIcon.ico
MUI_UNICON=build/uninstallerIcon.ico
MUI_UNWELCOMEFINISHPAGE_BITMAP=build/installerSidebar.bmp
MUI_WELCOMEFINISHPAGE_BITMAP=build/installerSidebar.bmp
```

If the defines are not in the log, find the generated script under the temp directory (`ls "$TEMP"/electron-builder-*/*.nsi`) and grep it for `MUI_WELCOMEPAGE_TEXT` and `MUI_HEADERIMAGE_BITMAP`.

Also confirm the license page was picked up:

```bash
grep -c "MUI_PAGE_LICENSE" "$TEMP/installer-build.log"; grep -o "license.txt" "$TEMP/installer-build.log" | head -1
```

Expected: a count of at least 1 and `license.txt`.

- [ ] **Step 4: Run the packaged validation**

Run: `cd gui && npm run dist:dir && npm run test:packaged`
Expected: both exit 0.

- [ ] **Step 5: Do not run the installer.** Remove the log: `rm "$TEMP/installer-build.log"`.

---

### Task 7: Correct the spec, record the change, run the whole suite

**Files:**
- Modify: `docs/superpowers/specs/2026-09-26-installer-polish-design.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Amend the spec's pipeline section**

In the spec, replace the paragraph starting `then converts the NSIS targets to 24-bit BMP with a small Python helper using Pillow` and the four bullets under "Pipeline" with:

```markdown
        |  renders each SVG into a canvas in Playwright's Chromium (already a
        |  devDependency; used by record-tour.mjs) with the Desk's fonts embedded,
        |  and writes the BMPs and ICOs with two small encoders in
        |  scripts/lib/image-formats.mjs. No new dependencies.
```

and

```markdown
- `npm run build:installer-art` runs it after an SVG changes. Outputs are **committed** under electron-builder's default resource names, the same way `public/dist/desk.js` is.
- CI and the release workflow use the committed files and do not regenerate them: Chromium's text rasterizer is not byte-identical across operating systems, so a byte-level drift check would fail on principle. The guard is `gui/tests/installer-art.test.mjs`, which checks every file by size and bit depth.
- The SVGs are the source of truth. Changing a colour or the mark means editing an SVG, rerunning the script, looking at the result, and committing both.
- The sidebar carries no version string, so the assets do not change on every release.
```

Also change `dmg-background.png` / `dmg-background@2x.png` in the tree to `background.png` / `background@2x.png` (electron-builder's default names), and in the Windows section change "version" in "Mark at top, wordmark, version, ink background" to "Mark at top, wordmark, tagline, ink background".

- [ ] **Step 2: Add the changelog entry**

Under `## [Unreleased]` in `CHANGELOG.md`, add a `### Changed` section (or extend one if present):

```markdown
### Changed
- The installers look like the app. The Windows wizard has a sidebar, header, welcome copy, and the MIT license page, with distinct installer and uninstaller icons; the macOS disk image has a background that shows the drag to Applications and says the build is unsigned; the Linux AppImage has a full icon set and a desktop entry that describes the app. Every asset is rendered from SVG sources in `gui/build/src/` by `npm run build:installer-art` and guarded by a test. Publisher and copyright name the project.
```

- [ ] **Step 3: Run the full gui suite and the prose audit on the changelog**

Run: `cd gui && npm test`
Expected: unit and renderer suites both `# fail 0`; unit count is the previous 227 plus 11 new.

Run: `python .claude/skills/strip-ai-tells/scripts/audit_prose.py CHANGELOG.md | tail -3`
Expected: `0 to fix`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-26-installer-polish-design.md CHANGELOG.md
git commit -m "Record the installer polish and correct the spec to what was built

The pipeline is pure Node rather than a Python helper, CI consumes the
committed assets instead of regenerating them, the DMG files use
electron-builder's default names, and the sidebar carries a tagline
rather than a version so the assets are stable across releases."
```

---

### Task 8: Sweep, push, pull request

- [ ] **Step 1: Tree-wide identifier sweep of HEAD with a positive control**

```bash
MSYS_NO_PATHCONV=1 python - <<'PY'
import sys; from pathlib import Path
sys.path.insert(0,"tools"); import split_check
pats = split_check.load_patterns(split_check.pattern_path()); repo = Path(".").resolve()
print("HEAD hits:", len(split_check.tree_hits(repo, "HEAD", pats)))
print("control 00af8c9:", len(split_check.tree_hits(repo, "00af8c9", pats)))
PY
```

Expected: `HEAD hits: 0` and a non-zero control. Binary assets (BMP, ICO, PNG) are skipped by `git grep -I`; the SVG sources and every text file are scanned.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin installer-polish
gh pr create --repo iLevyTate/ai-job-search --base master --head installer-polish \
  --title "Give the installers the Desk's own look" \
  --body "Spec: docs/superpowers/specs/2026-09-26-installer-polish-design.md. Plan: docs/superpowers/plans/2026-09-26-installer-polish.md.

Windows: sidebar, header, welcome copy, MIT license page, distinct installer/uninstaller icons. macOS: DMG background showing the drag to Applications, with the unsigned-build note. Linux: icon set and a descriptive desktop entry. Publisher and copyright name the project.

Every asset is rendered from SVG sources in gui/build/src by npm run build:installer-art (Playwright's Chromium plus two dependency-free encoders) and committed under electron-builder's default resource names; a test guards each by size and bit depth. CI consumes the committed files.

Verified: gui suite green; local Windows NSIS build succeeded and the makensis defines name the sidebar, header, both icons, and the license page; dist:dir and test:packaged pass; identifier sweep 0 hits with live control. The DMG is verified by the release workflow's macOS job; nothing ships until the next desk-v tag."
```

- [ ] **Step 3: Merge when the 34 checks are green** (the ruleset requires them), then `git checkout master && git merge --ff-only origin/master`.

---

## Self-review notes

- **Spec coverage:** identity (Task 2), Windows sidebar/header/icons/welcome/license/finish (Tasks 2-5; finish page unchanged by design), DMG background/window/contents/copy (Tasks 2, 4), Linux entry and icon set (Tasks 3, 4), metadata (Task 4), pipeline and commit-the-outputs (Task 3), unit test (Tasks 1, 3, 5), local Windows build read-back (Task 6, via makensis defines since 7-Zip is not installed), DMG verified by CI (Task 8 PR body), nothing ships until a tag (Task 8). Out-of-scope items untouched.
- **Spec corrections carried in Task 7:** Python helper replaced by Node encoders; no byte drift check; default asset names; no version on the sidebar.
- **Names used consistently:** `encodeBmp24`, `encodeIco`, `readBmpHeader`, `readIcoEntries`, `readPngSize`; script `build:installer-art`; files under `gui/build/` as listed in the file table.
- **No absolute paths anywhere in the plan.** The build log in Task 6 goes to `$TEMP` and its output is shortened before it is read, so nothing machine-specific can be pasted into a commit or PR.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readBmpHeader, readIcoEntries, readPngSize } from "../scripts/lib/image-formats.mjs";

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

test("the Desk pages and assets/logo carry the same mark the icons are rendered from", async () => {
  const source = await readFile(build("src/mark.svg"), "utf8");
  for (const copy of ["../public/mark.svg", "../../assets/logo/mark.svg"]) {
    assert.equal(await readFile(new URL(copy, import.meta.url), "utf8"), source, copy);
  }
  for (const page of ["index.html", "first-run.html", "starting.html"]) {
    const html = await readFile(new URL(`../public/${page}`, import.meta.url), "utf8");
    assert.match(html, /<img class="mark" src="\/?mark\.svg" alt=""/, page);
    assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/?favicon\.svg">/, page);
  }
});

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

test("installer.nsh sets the welcome copy and keeps the upgrade dialog", async () => {
  const nsh = await readFile(build("installer.nsh"), "utf8");
  assert.match(nsh, /!macro customHeader/);
  assert.match(nsh, /MUI_WELCOMEPAGE_TEXT ".*never uploaded\."/);
  assert.match(nsh, /!macro customInit/);
  assert.match(nsh, /Yes = replace it with this version/);
});

test("the license shown by the installer is the repository LICENSE", async () => {
  const shown = await readFile(build("license.txt"), "utf8");
  const source = await readFile(new URL("../../LICENSE", import.meta.url), "utf8");
  assert.equal(shown, source);
});

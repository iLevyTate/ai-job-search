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

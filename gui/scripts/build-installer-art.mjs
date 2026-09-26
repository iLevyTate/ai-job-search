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
  Fraunces: "fraunces_v38_6NU78FyLNQOQZAnv9bYEvDiIdE9Ea92uemAk_WBq8U_9v0c2Wa0KxC9TeA.woff2",
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

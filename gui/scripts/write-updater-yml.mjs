/**
 * electron-builder --publish never packages the installer but skips
 * latest.yml / latest-mac.yml / latest-linux.yml. electron-updater reads
 * those from the GitHub Release, so write them from the built artifacts.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALLER = /\.(exe|zip|dmg|AppImage)$/;

export function pickUpdaterArtifact(names) {
  const installers = names.filter((name) => INSTALLER.test(name) && !name.includes("portable"));
  const win = installers.find((name) => name.endsWith(".exe"));
  if (win) return { fileName: win, ymlName: "latest.yml" };
  const macZip = installers.find((name) => name.endsWith(".zip"));
  if (macZip) return { fileName: macZip, ymlName: "latest-mac.yml" };
  const linux = installers.find((name) => name.endsWith(".AppImage"));
  if (linux) return { fileName: linux, ymlName: "latest-linux.yml" };
  return null;
}

export function renderUpdaterYml({ version, fileName, sha512, size, releaseDate }) {
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${fileName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${fileName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    "",
  ].join("\n");
}

export function writeUpdaterYml(releaseDir, { version, now = new Date() } = {}) {
  const picked = pickUpdaterArtifact(readdirSync(releaseDir));
  if (!picked) {
    throw new Error(`No installer in ${releaseDir} to write an updater channel file from.`);
  }
  const artifactPath = join(releaseDir, picked.fileName);
  const sha512 = createHash("sha512").update(readFileSync(artifactPath)).digest("base64");
  const body = renderUpdaterYml({
    version,
    fileName: picked.fileName,
    sha512,
    size: statSync(artifactPath).size,
    releaseDate: now.toISOString(),
  });
  const ymlPath = join(releaseDir, picked.ymlName);
  writeFileSync(ymlPath, body);
  return { ymlPath, fileName: picked.fileName, ymlName: picked.ymlName };
}

function isMain(url) {
  const entry = process.argv[1] && process.argv[1].replace(/\\/g, "/");
  return entry && fileURLToPath(url).replace(/\\/g, "/").endsWith(basename(entry));
}

if (isMain(import.meta.url)) {
  const releaseDir = process.argv[2] || join(fileURLToPath(new URL("..", import.meta.url)), "release");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const written = writeUpdaterYml(releaseDir, { version: pkg.version });
  process.stdout.write(`Wrote ${written.ymlName} for ${written.fileName}\n`);
}

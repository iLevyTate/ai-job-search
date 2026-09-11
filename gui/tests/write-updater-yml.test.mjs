import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pickUpdaterArtifact, renderUpdaterYml, writeUpdaterYml } from "../scripts/write-updater-yml.mjs";

test("pickUpdaterArtifact prefers the NSIS installer over the portable exe", () => {
  const picked = pickUpdaterArtifact([
    "JobSearchDesk-1.3.2-win-x64-portable.exe",
    "JobSearchDesk-1.3.2-win-x64.exe",
    "JobSearchDesk-1.3.2-win-x64.exe.blockmap",
  ]);
  assert.deepEqual(picked, { fileName: "JobSearchDesk-1.3.2-win-x64.exe", ymlName: "latest.yml" });
});

test("pickUpdaterArtifact uses the mac zip and the Linux AppImage", () => {
  assert.deepEqual(pickUpdaterArtifact(["JobSearchDesk-1.3.2-mac-arm64.dmg", "JobSearchDesk-1.3.2-mac-arm64.zip"]), {
    fileName: "JobSearchDesk-1.3.2-mac-arm64.zip",
    ymlName: "latest-mac.yml",
  });
  assert.deepEqual(pickUpdaterArtifact(["JobSearchDesk-1.3.2-linux-x86_64.AppImage"]), {
    fileName: "JobSearchDesk-1.3.2-linux-x86_64.AppImage",
    ymlName: "latest-linux.yml",
  });
  assert.equal(pickUpdaterArtifact(["linux-unpacked"]), null);
});

test("writeUpdaterYml writes electron-updater fields next to the installer", () => {
  const dir = mkdtempSync(join(tmpdir(), "desk-latest-"));
  try {
    writeFileSync(join(dir, "JobSearchDesk-1.3.2-win-x64.exe"), "installer-bytes");
    const written = writeUpdaterYml(dir, {
      version: "1.3.2",
      now: new Date("2026-09-11T18:00:00.000Z"),
    });
    assert.equal(written.ymlName, "latest.yml");
    const body = readFileSync(join(dir, "latest.yml"), "utf8");
    assert.match(body, /^version: 1\.3\.2$/m);
    assert.match(body, /url: JobSearchDesk-1\.3\.2-win-x64\.exe/);
    assert.match(body, /releaseDate: '2026-09-11T18:00:00.000Z'/);
    const expected = renderUpdaterYml({
      version: "1.3.2",
      fileName: "JobSearchDesk-1.3.2-win-x64.exe",
      sha512: body.match(/sha512: (\S+)/)[1],
      size: "installer-bytes".length,
      releaseDate: "2026-09-11T18:00:00.000Z",
    });
    assert.equal(body, expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

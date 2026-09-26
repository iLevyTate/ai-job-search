# Installer polish for Job Search Desk

**Date:** 2026-09-26
**Status:** implemented on branch `installer-polish` (plan: `docs/superpowers/plans/2026-09-26-installer-polish.md`)
**Scope:** the Windows NSIS installer, the macOS DMG, the Linux AppImage desktop entry, and the metadata every OS shows for the app. Generic branding only ("Job Search Desk"). No company name, no signing, no change to what the installer does.

## Why

The installer is a bare electron-builder default: one flat icon, an empty wizard sidebar and header on Windows, a blank DMG window on macOS, and "AI Job Search" as publisher and copyright. It installs correctly and looks like nobody designed it. People decide whether to trust an unsigned download partly on whether it looks finished. This makes it look like the app it installs.

## Visual identity

Taken from the app, not invented for the installer:

| Token | Value | Use |
|---|---|---|
| ink | `#1c1814` | backgrounds |
| cream | `#f4ead6` | type, the card in the mark |
| amber | `#d08a3a` | the single accent, the uninstaller's field |
| line | `#201b16` at 22-35% | the three text lines in the mark |

The mark is the existing icon: a cream card with an amber title bar, three faded lines, and an amber dot, on an ink rounded square. Installer art is that mark plus a cream wordmark ("Job Search Desk") and a tagline, on ink. No gradients, no stock imagery. Type is the Desk's own: Fraunces (upright) for the wordmark and Bricolage Grotesque for the small copy, embedded from `gui/public/vendor/fonts/` at render time so the result is the same on every machine.

## What changes, per platform

### Windows (NSIS, `oneClick: false`)

- **Sidebar** on the welcome and finish pages: 164 x 314, 24-bit BMP. Mark at top, wordmark, tagline, ink background.
- **Header** on the inner pages: 150 x 57, 24-bit BMP. Small mark, wordmark on two lines (one line clips at that width).
- **Installer icon** and **uninstaller icon**: separate multi-resolution `.ico` files (16 through 256). The uninstaller is the mark in cream on an amber square so it is never mistaken for the app in Add/Remove Programs.
- **Welcome page** copy, one paragraph: what this is, that it adds Start Menu and Desktop shortcuts, that it installs for the current user without administrator rights, and that the job-search folder stays wherever the person puts it.
- **License page** shows the repository's MIT `LICENSE`.
- **Finish page** keeps "Run Job Search Desk".
- The upgrade dialog in `build/installer.nsh` (replace / keep a copy / cancel) stays exactly as it is.

### macOS (DMG)

- **Background** 660 x 400 at 1x plus a 1320 x 800 retina variant. The mark, an arrow from the app position to the Applications position, and one line of copy: "Drag to Applications. Unsigned build: right-click, then Open, the first time." That sentence is the instruction people need and today it lives only in the README.
- **Window** sized to the background; **icon size** 128; app icon at (170, 210), Applications alias at (490, 210); title "Job Search Desk".
- The `.zip` target is unchanged; it is what the updater downloads.

### Linux (AppImage)

- Desktop entry gets `Comment=Job search desk that keeps the hunt in a folder on this computer` and `Keywords=job;search;cv;resume;application;`.
- An icon set at 16, 32, 48, 64, 128, 256, 512, 1024 under `build/icons/` replaces the single 512 PNG so launchers pick the right size.

### Metadata (all platforms)

- `copyright`: `(c) 2026 Job Search Desk contributors. MIT License.`
- `package.json` `author`: `Job Search Desk contributors` (Windows shows this as Publisher).
- `productName`, `appId`, artifact names, and shortcut names are unchanged, so upgrades and the updater keep matching.

## Pipeline: generated from source, committed, checked

```
gui/build/src/               SVG sources (mark, uninstall-mark, sidebar, header, background)
        |
gui/scripts/build-installer-art.mjs
        |  renders each SVG into a canvas in Playwright's Chromium (already a
        |  devDependency; used by record-tour.mjs) with the Desk's fonts embedded,
        |  and writes the BMPs and ICOs with two small encoders in
        |  scripts/lib/image-formats.mjs. No new dependencies.
        v
gui/build/installerSidebar.bmp      164 x 314   24-bit
gui/build/installerHeader.bmp       150 x 57    24-bit
gui/build/installerIcon.ico         16, 24, 32, 48, 64, 128, 256 (PNG entries)
gui/build/uninstallerIcon.ico       same sizes
gui/build/background.png            660 x 400
gui/build/background@2x.png         1320 x 800  (electron-builder finds the retina variant only by
                                                 this exact suffix next to the 1x file)
gui/build/license.txt                copied from LICENSE; found by name for the license page
gui/build/icons/NNxNN.png           16..1024
```

- `npm run build:installer-art` runs it after an SVG changes. Outputs are **committed** under electron-builder's default resource names, the same way `public/dist/desk.js` is.
- CI and the release workflow use the committed files and do not regenerate them: Chromium's text rasterizer is not byte-identical across operating systems, so a byte-level drift check would fail on principle. The guard is `gui/tests/installer-art.test.mjs`, which checks every file by size and bit depth.
- The SVGs are the source of truth. Changing a colour or the mark means editing an SVG, rerunning the script, looking at the result, and committing both.
- The sidebar carries no version string, so the assets do not change on every release.

## Copy

Welcome page:

> Job Search Desk keeps a job search in a folder on this computer: postings found, applications drafted, and what happened to each one. Setup adds Start Menu and Desktop shortcuts and installs for your account only, with no administrator rights. Your job-search folder stays wherever you put it and is never uploaded.

DMG:

> Drag to Applications. Unsigned build: right-click, then Open, the first time.

Both pass the repository's prose audit (`strip-ai-tells`) before they are committed.

## Testing and verification

- **Unit test** (`gui/tests/installer-art.test.mjs`): every asset `electron-builder.yml` references exists, at exactly the required pixel dimensions, and each BMP is 24-bit. NSIS shows a blank sidebar rather than an error when handed a 32-bit BMP, so the depth check is the one that matters.
- **Local Windows build**: `npx electron-builder --win nsis` to `release/` with `DEBUG=electron-builder`, skipping the native rebuild (`--config.npmRebuild=false`; this machine has no C++ toolchain, and the release workflow does the real rebuild on GitHub runners). The debug log's makensis defines name the sidebar for both welcome and finish, the header, and both icons. makensis runs with `-WX`, so the `customHeader` macro compiled without warnings. The license page is proven by code path: `getResource(undefined, "license.txt", ...)` finds the file in `build/` and `nsisLicense.js` inserts the page on a non-null result; electron-builder pipes the generated script to makensis and keeps no copy, so there is nothing to read back. The installer is not run on the developer's machine.
- **DMG** can only be built on macOS: verified by the release workflow's macOS job. The background PNGs are opened and looked at before commit.
- **Config validity**: `npm run dist:dir` and `npm run test:packaged` still pass, so nothing about packaging or the updater changed.
- Nothing ships from this change alone. It lands on `master` and rides the next `desk-v*` tag.

## Out of scope

- Code signing (Apple Developer ID, Windows OV/EV). The DMG copy states the consequence honestly instead.
- Replacing the MUI2 wizard with custom NSIS pages.
- Per-machine installs, install-directory choice, or any change to the upgrade dialog.
- An Intel macOS build.
- Any company name or personal branding. The split guard blocks it in this repository by design, and this design does not need it.

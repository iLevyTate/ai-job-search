# Job Search Desk logo

A sealed application letter. The brass wax seal carries a Fraunces D, for Desk.

| File | Use |
| --- | --- |
| `mark.svg` | The app mark on its own tile. Use it where the name already appears in text next to it. |
| `lockup-dark.svg` | Mark and wordmark for dark backgrounds (cream text, brass kicker). The README shows it to GitHub's dark theme. |
| `lockup-light.svg` | Mark and wordmark for light backgrounds (ink text, deep brass kicker). The README's default. |

The mark exists in three places that must stay byte-identical, and `gui/tests/installer-art.test.mjs` checks it: `gui/build/src/mark.svg` (the source every app and installer icon is rendered from), `gui/public/mark.svg` (the Desk's sidebar, sign-in card, and first-run and starting screens), and `mark.svg` here.

All text is outlined, so the files render the same with or without the fonts installed. The wordmark is Fraunces at optical size 144, weight 440, tracked -0.02em; the kicker is IBM Plex Mono 500 tracked 0.28em; the seal's D is Fraunces at optical size 144, weight 600. Both typefaces are under the SIL Open Font License and ship with the Desk in `gui/public/vendor/fonts/`.

How it is drawn:

- The tile has continuous corners (radius 58 of 256, 60% smoothing, the curve Apple uses on app icons), a top-to-bottom gradient from `#261f19` to `#0e0b09`, a faint brass light in the top-left corner, and a rim that is lit at the top and fades down the sides. The rim is what keeps the tile's edge on the Desk's dark cards, so the page needs no border around it.
- The letter is paper `#f9f2e4` shading to `#efe4cd`, with a flap from `#ebdec4` to `#e0cfb0`, lifted off the tile by a soft blurred shadow.
- The seal is a brass disc (`#ecb66f` through `#d08a3a` to `#a4601c`, lit from the top left) with a milled edge of 32 teeth, an engraved ring, and a D struck into it in `#45260a` with a thin highlight under it.

Below about 32px the D and the ring stop reading, and the mark becomes an envelope with a brass dot. `gui/public/favicon.svg` draws exactly that, flat and without the shadow, for the browser tab.

If you change the mark, edit `gui/build/src/mark.svg`, copy it to `gui/public/` and here, and run `npm run build:installer-art` in `gui/` to re-render the icons.

Don't put the mark on a light tile or recolor the seal: the dark tile and the brass seal are what make it recognizable at 16px. The one sanctioned variant is `gui/build/src/uninstall-mark.svg`, which swaps to a brass tile and a dark seal with a brass D so the uninstaller never looks like the app.

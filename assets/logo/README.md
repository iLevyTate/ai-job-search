# Job Search Desk logo

A sealed application letter. The brass wax seal carries a Fraunces D, for Desk.

| File | Use |
| --- | --- |
| `mark.svg` | The app mark on its own tile. Use it where the name already appears in text next to it. |
| `lockup-dark.svg` | Mark and wordmark for dark backgrounds (cream text, brass kicker). The README shows it to GitHub's dark theme. |
| `lockup-light.svg` | Mark and wordmark for light backgrounds (ink text, deep brass kicker). The README's default. |

The mark exists in three places that must stay byte-identical, and `gui/tests/installer-art.test.mjs` checks it: `gui/build/src/mark.svg` (the source every app and installer icon is rendered from), `gui/public/mark.svg` (the Desk's sidebar, sign-in card, and first-run and starting screens), and `mark.svg` here.

All text is outlined, so the files render the same with or without the fonts installed. The wordmark is Fraunces at optical size 72, weight 520; the kicker is IBM Plex Mono 500 tracked at 0.2em; the seal's D is Fraunces at optical size 72, weight 620. Both typefaces are under the SIL Open Font License and ship with the Desk in `gui/public/vendor/fonts/`.

Colors come from `gui/public/desk.css`:

| Role | Hex |
| --- | --- |
| Tile | `#1c1814`, warming to `#2e251c` in the top-left corner |
| Paper | `#f4ead6` |
| Flap | `#e6d7ba` |
| Brass seal | `#d08a3a` |
| Seal ring | `#a9651f` |

Below about 24px the D and the ring stop reading, and the mark becomes an envelope with a brass dot. `gui/public/favicon.svg` draws exactly that, without the shadow, for the browser tab.

If you change the mark, edit `gui/build/src/mark.svg`, copy it to `gui/public/` and here, and run `npm run build:installer-art` in `gui/` to re-render the icons.

Don't put the mark on a light tile or recolor the seal: the dark tile and the brass seal are what make it recognizable at 16px. The one sanctioned variant is `gui/build/src/uninstall-mark.svg`, which swaps to a brass tile and an ink seal so the uninstaller never looks like the app.

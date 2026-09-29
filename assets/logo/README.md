# Job Search Desk logo

A sealed application letter. The brass wax seal carries a Fraunces D, the same D the Desk shows in its sidebar.

| File | Use |
| --- | --- |
| `mark.svg` | The app mark on its own tile. Same drawing as `gui/build/src/mark.svg`, which the installer art is rendered from. |
| `lockup-dark.svg` | Mark and wordmark for dark backgrounds (cream text, brass kicker). |
| `lockup-light.svg` | Mark and wordmark for light backgrounds (ink text, deep brass kicker). |

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

If you change the mark, edit `gui/build/src/mark.svg`, copy it here, and run `npm run build:installer-art` in `gui/` to re-render the icons.

# Job Search Desk logo

A D that is also a sealed letter. The D's flat back and round bowl are the envelope, the flap is a line cut out of it, and the brass seal sits where the flap meets. Everything is flat color: no gradients, no shadows.

| File | Use |
| --- | --- |
| `lockup-dark.svg` | The primary logo on dark backgrounds: glyph, wordmark, and kicker. The README shows it to GitHub's dark theme. |
| `lockup-light.svg` | The primary logo on light backgrounds. The README's default. |
| `glyph-dark.svg` | The letter alone, paper on transparent, for dark backgrounds. The Desk's sidebar, sign-in card, and first-run and starting screens use it. |
| `glyph-light.svg` | The letter alone, ink on transparent, for light backgrounds. |
| `mark.svg` | The app icon: the letter on its dark tile. |

Some of these live in more than one place, and `gui/tests/installer-art.test.mjs` checks that the copies stay byte-identical:

- `mark.svg` is the same file as `gui/build/src/mark.svg` (the source every app and installer icon is rendered from) and `gui/public/favicon.svg`.
- `glyph-dark.svg` is the same file as `gui/public/mark.svg`.

## Construction

On a 256 grid:

- The tile has continuous corners (radius 58, 60% smoothing, the curve Apple uses on app icons), flat `#1c1814`.
- The D is 124 tall: a 70-unit straight run from a flat back with 15-unit corners, closed by a half circle of radius 62. It sits 2 units left of center, because the bowl carries more visual weight than the back.
- The flap is an 11-unit line with round caps, cut out of the D rather than drawn on it, so it is the background showing through. Its left arm runs into the top-left corner; its right arm is the mirror line, stopped by the bowl.
- The seal is a circle of radius 17 at the flap's apex.

| Role | App icon | Uninstaller |
| --- | --- | --- |
| Tile | `#1c1814` ink | `#d08a3a` brass |
| Letter | `#f4ead6` paper | `#1c1814` ink |
| Seal | `#d08a3a` brass | `#f4ead6` paper |

The colors are the Desk's own, from `gui/public/desk.css`. The uninstaller swaps them so it is never mistaken for the app in Add/Remove.

## Wordmark

Bricolage Grotesque 700 at optical size 96, tracked -0.025em, with the kicker in IBM Plex Mono 500 tracked 0.28em. Both are outlined, so the files render the same with or without the fonts installed. Both typefaces are under the SIL Open Font License and ship with the Desk in `gui/public/vendor/fonts/`. The installer sidebar, header, and macOS disk-image title use the same face as live text.

## Rules

Keep the seal brass on the ink tile and the paper glyph; that dot is what identifies the mark at 16px. Don't add gradients, shadows, or outlines back. Don't set the glyph on a mid-tone where neither the paper nor the ink version has contrast; use the app icon there.

If you change the mark, edit `gui/build/src/mark.svg`, copy it to `gui/public/favicon.svg` and here, and run `npm run build:installer-art` in `gui/` to re-render the icons. Change the glyphs to match.

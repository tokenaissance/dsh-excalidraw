# Renderer fidelity against Excalidraw

Reviewed against a real in-app scene, not a synthetic one (`app-scene.json`, 58
elements of which 57 are drawn; the 47-element CJK scene below is
`design-scene.json`):

<https://app.excalidraw.com/s/9Zq6XgRe98z/67ydgmAZ4xK> — 58 elements
(15 rectangles, 29 texts, 7 arrows, 6 dashed guide lines, 1 deleted text), the
"cause & fix" recovery diagram. It is now `test/fixtures/app-scene.json`, drawn by
hand in the Excalidraw app (not by the MCP diagram tool), so it carries the shapes
and styles people actually use.

Method: our `renderScene()` → SVG → `rsvg-convert` at the reference export's width
(934×1079), compared with the PNG Excalidraw itself exports for that scene. Both
are composited on white before measuring.

## Numbers

| metric | Excalidraw | ours |
| --- | --- | --- |
| ink coverage (<245 gray) | 10.44 % | 10.62 % |
| ink bounding box | (12, 12)–(921, 1066) | (14, 14)–(919, 1063) |
| rectangle border coverage (midpoint samples, 15 boxes) | 0.783 | 0.800 |
| bound text: median horizontal offset | — | 0.0 px |
| bound text: median vertical offset | — | 0.5 px |
| bound text: median width ratio | 1.00 | 1.00 |
| line/arrow path coverage (1 px tolerance) | 1.00 | 1.00 (9 of 14 sampled; the rest are dashed-phase) |
| coarse structural correlation (Gaussian blur 3, 8 px grid) | 1.0 | 0.873 |
| mean absolute difference (blurred) | 0 | 2.02 / 255 |
| elements drawn | 58 | 57 (`isDeleted: 1` skipped) |

Ink coverage, bounding box, rectangle geometry, and **text placement** agree to
about a pixel. That is the part the renderer controls.

## With the bundled fonts (v2)

The plugin now ships Comic Shanns (MIT), Virgil (OFL) and Lilita One (OFL) and
registers them with `@font-face` (CONTRACT §6). Measured again, same scene, same
reference PNG:

| path | ink | ink bbox | coarse corr | MAD | IoU (1 px) | label IoU (mean / median) |
| --- | --- | --- | --- | --- | --- | --- |
| reference (Excalidraw) | 10.44 % | (12,12)–(921,1066) | 1.0 | 0 | 1.0 | 1.0 |
| ours, CSS fallback (before) | 10.62 % | (14,14)–(919,1063) | 0.873 | 2.02 | 0.492 | 0.619 / 0.513 |
| ours, fonts loaded (`rsvg-convert`) | 10.34 % | (14,14)–(919,1063) | 0.920 | 1.58 | 0.543 | 0.664 / 0.834 |
| ours, fonts loaded (**Chromium**, the product path) | 10.67 % | (14,14)–(919,1064) | **0.939** | **1.67** | **0.551** | 0.655 / 0.660 |

- Bound-text ink centre offset against the reference: **median 0.0 px horizontally,
  0.0 px vertically** (worst case in the scene: one two-line label at 3.5 px,
  caused by re-wrapping, see below).
- Glyph advances now come from Excalidraw's own faces: `FUSE / kernel` renders
  77 px wide against Excalidraw's 79 px (the fallback gave 84 px).

The measurement used the fonts Excalidraw itself renders with: `woff2` →
`ttf` (fontTools) installed for `rsvg-convert`, and the same `woff2` files served
by the plugin's font route for the Chromium pass (`file://` page with data-URL
`@font-face`).

## Second scene: wide + CJK

The same method on the architecture scene
(<https://app.excalidraw.com/s/9Zq6XgRe98z/6gbUPPB8Q7X>, 47 elements, a 3700-unit
wide diagram whose text is Chinese, i.e. glyphs `Comic Shanns` does not carry and
the browser must fall back for):

| metric | Excalidraw | ours (Chromium + fonts) |
| --- | --- | --- |
| ink | 9.76 % | 9.46 % |
| ink bbox | (8,8)–(1391,233) | (17,9)–(1382,232) |
| row profile correlation | 1.0 | 0.902 |
| coarse structural correlation | 1.0 | 0.870 |
| mean absolute difference (blurred) | 0 | 1.81 / 255 |
| IoU (1 px tolerance) | 1.0 | 0.574 |

So the Latin/CJK fallback chain behaves the way Excalidraw's own canvas does: the
CJK runs fall through `Comic Shanns → monospace → system CJK` on both sides, and
the shape/structure agreement stays in the same range as the Latin scene.

## Textures and images (round 13)

`fillStyle: hachure | cross-hatch` now draws real hatch strokes: an
axis-aligned `<pattern>` per colour/density whose **pattern transform** rotates the
tile, so the strokes stay inside it (rotating the line inside an 8 px tile clips it
away — a regression the tests now pin). Measured on a 120×80 rectangle with
`strokeWidth: 2` (8 px tile, 2 px stroke, white background composited):

| fill | ink inside the shape | expected |
| --- | --- | --- |
| `hachure` | **34.5 %** | 20–40 % |
| `cross-hatch` | **51.6 %** | 44–55 % |

There is no Excalidraw export of that synthetic scene, so this is a
**density/geometry sanity check**, not a pixel comparison. `image` elements whose
`fileId` resolves to a `data:image/…;base64,` URL are drawn as `<image>` sized to
the element box (`preserveAspectRatio="none"`); anything else stays the
placeholder. Verified structurally (12 assertions: href/size/four-colour pixel
placement, `javascript:` and missing-fileId fallback, `xmllint` well-formed).

Known boundary: the "fonts loaded (Chromium)" row above needs a machine with the
Excalidraw fonts installed; on a font-less machine the measured path is the CSS
fallback row.

## What differs, and why

1. **Rasteriser.** Excalidraw draws on a canvas with its own anti-aliasing; the
   plugin emits SVG. Even with identical fonts and identical geometry the pixels
   differ at edges, which is what keeps the 1 px-tolerance IoU near 0.55.
2. **Container-text re-wrapping.** Excalidraw re-wraps text bound to a container
   using live font metrics when it renders, while the stored `text` field is only
   the *last* wrap it cached. Our renderer honours the stored newlines, so a label
   can break at a different word (worst case in this scene: 56 px of line width
   and 3.5 px of vertical centre). The stored wrap is what older Excalidraw
   versions drew, so the scene stays faithful, just not identical to a live
   re-wrap. Measured wrapping with a canvas `measureText` shim is the next
   improvement if it matters.
3. **Dash phase.** Dashed guides start at a different point in the pattern, so
   per-run dash/gap lengths differ even though the pattern's period and coverage
   match.


## Reproduce

```sh
node scripts/render-scene.mjs test/fixtures/app-scene.json /tmp/app.svg
rsvg-convert -w 934 /tmp/app.svg -o /tmp/app.png
# then compare /tmp/app.png with Excalidraw's export of the scene above
```

`test/renderer.test.mjs` pins the parts that must not drift: every live element is
drawn, the frame keeps the reference export's aspect (0.866), the frame covers the
reference content, and the output is deterministic.

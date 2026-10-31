# Renderer notes (`src/renderer.mjs`)

Pure ESM, zero dependencies, no DOM. `src/renderer.mjs` turns an Excalidraw
scene's `elements` array into one standalone `<svg>` string. The contract is
[`CONTRACT.md`](CONTRACT.md) §6; this file records how the implementation reads
the parts that are open to interpretation, and what is deliberately not done.

## API

```js
renderScene(elements, { padding = 24, background = false })
  // -> { svg, width, height, bounds, rendered, skipped }

sceneBounds(elements)
  // -> { minX, minY, maxX, maxY } | null

escapeXml(value)                              // exported for tests / callers
arrowHeadPath(points, atStart, type, strokeWidth, strokeColor) -> string
SUPPORTED_TYPES                               // frozen string[]
```

`rendered` and `skipped` are additive fields beyond the contract's four: the
CLI summary and the tests need them. `skipped` entries are
`{ id, type, reason }`.

## Determinism

- No `Math.random`, no clock, no environment or locale lookups.
- Numbers are formatted to at most three decimals with a stable formatter; no
  `-0`, no scientific notation for ordinary scene coordinates.
- Output order is array order (already Excalidraw's z-order); elements are never
  sorted. Two renders of the same input are byte-identical.
- Text and attribute values are XML-escaped (`& < > "`). Colours are accepted
  only as plain CSS colour strings: anything containing `<>"'&`, newlines or
  `url(` falls back to the default (this also blocks external resource loads).

## Geometry and viewport

- `sceneBounds` is the union of the axis-aligned geometry of every renderable
  element. Rotated elements (`angle`, radians) contribute the axis-aligned box
  of their rotated corners. Lines/arrows use the absolute `points`
  (`x + px`, `y + py`), not the stored `width`/`height`.
- Deleted, unknown and non-finite elements are ignored for bounds.
- Stroke width and arrow-head overhang are not added to bounds; the default
  padding of 24 units absorbs them.
- The SVG's `viewBox` is `bounds` expanded by `padding`; `width`/`height` are
  the padded size. An empty scene returns `bounds: null` and a `48 × 48` SVG
  (`padding` 0 falls back to `1 × 1` so the viewport is never degenerate).
- Negative `width`/`height` are normalised by moving the origin and taking the
  absolute value. Boxes whose far corner overflows to `Infinity` are rejected.
- `background: true` adds one white `<rect>` covering the whole viewBox; the
  scene's `appState.viewBackgroundColor` is not consulted (the client owns
  theming).

## Elements

| type | output |
| --- | --- |
| `rectangle` | `<rect>`; `roundness` (`type` 1/2/3) → `rx`/`ry = min(32, min(w,h) * 0.25)` |
| `ellipse` | `<ellipse>` from the element box |
| `diamond` | `<polygon>` through the four box midpoints |
| `line` / `arrow` | `<polyline>` from `points`; heads appended by `arrowHeadPath` |
| `text` | `<text>` with one `<tspan>` per line (see below) |
| `frame` | rounded border rect plus the frame `name` above its top-left corner |
| `image` | grey dashed placeholder rect; nothing is fetched or embedded |

Every element is wrapped in `<g data-el="<type>" data-id="<id>">` so tests and
the client can identify it without parsing geometry. `groupIds` are ignored:
Excalidraw already writes array order as z-order.

### Paint

- `strokeColor`, `backgroundColor` (`transparent` → SVG `none`), `strokeWidth`
  (clamped to 1–100), `opacity` (`100` → no attribute, otherwise `opacity` in
  0–1), `strokeStyle`:
  - `dashed` → `stroke-dasharray="4·sw 2·sw"`
  - `dotted` → `stroke-dasharray="0.1·sw 2·sw"` plus round linecap
- `fillStyle` is honoured by tint, not texture: `hachure` uses `fill-opacity`
  0.35, `cross-hatch` 0.25, `zigzag` 0.3. `roughness` is ignored; output is
  always clean, as the contract says.

### Arrowheads

`startArrowhead` / `endArrowhead` support `arrow`, `triangle`,
`triangle_outline`, `bar`, `dot`/`circle`, and null. Size is
`max(12, min(30, strokeWidth * 6))`. Unknown head names are ignored rather than
guessed. Heads are computed from the last non-duplicate segment, in absolute
coordinates.

### Text

- Font families map to web-safe stacks: 1 Virgil, 2 Helvetica, 3 Cascadia
  (mono), 4 Liberation Sans, 5 Excalifont, 6 Nunito, 7 Lilita One (display),
  8 Comic Shanns (mono). Unknown numbers fall back to the Excalifont stack. The
  Excalidraw fonts are not loaded; the fallbacks are what actually render.
- Lines come from `text.split('\n')`, advanced by `fontSize * lineHeight`
  (`lineHeight` default 1.25). Each line is a `<tspan>` with absolute `x`/`y`
  and `dominant-baseline="central"`.
- Standalone text uses `textAlign` for the anchor (left/center/right) and
  `verticalAlign` for the block position inside its own box.
- Bound text (`containerId` → shape) is horizontally centred in the container
  (literal CONTRACT §6 wording; `textAlign` is not used for bound text) and
  honours `verticalAlign` (top/middle/bottom, 5-unit padding for top/bottom).
- Bound arrow/line labels are positioned at the polyline midpoint measured by
  arc length, with a small white `<rect data-role="label-chip">` behind them.
- Empty text (`text === ''`) is skipped and counted.
- Bound text whose container is missing, deleted or not supported is rendered
  as standalone text at its own stored coordinates (documented fallback).

## Skipped elements

`renderScene` never throws for bad input; it counts skips by reason:

`deleted`, `unknown-type`, `bad-geometry` (missing/non-finite x/y/width/height),
`bad-points` (line/arrow without two finite points), `empty-text`,
`invalid-element` (not an object), `render-error` (defensive catch).

The CLI prints the aggregate as `skipped=[reason:count,...]` and writes up to 20
per-element details to stderr.

## Known limitations / out of scope

- No hachure/zigzag/sketch textures, no roughness fidelity.
- No elbow re-routing: stored `points` are drawn as-is.
- No bindings/focus/gap recalculation; the scene's stored geometry is trusted.
- No text wrapping or font-metric layout; Excalidraw's stored width/height and
  line breaks are used.
- No image bytes, no `<image>` embedding, no MCP/network access.
- Frames are drawn as simple containers, not as slides; no frame backgrounds
  from `appState`, no clipping of frame children.
- Element types outside §6 (`freedraw`, `embed`, `iframe`, `magicframe`, …) are
  skipped and counted; they are not silently dropped.

## Running the tests

`node --test test/` is the command CONTRACT §7 specifies. On some current Node
builds (v24.21 in the sandbox included) a directory argument is resolved as a
module instead of being discovered, so `test/package.json` points `main` at
`scripts/run-tests.mjs`, which imports every `test/*.test.mjs`. The runner lives
outside `test/`, so plain `node --test` discovery does not register the tests a
second time. `node --test` and `node --test 'test/**/*.test.mjs'` work as usual.

## CLI

```sh
node scripts/render-scene.mjs <scene.json|-> <out.svg> [--background] [--padding N]
# elements=47 rendered=47 skipped=[] bounds=80,80,3700.5,670.667 bytes=14465
```

Accepts a full scene document or a bare elements array; `-` reads JSON from
stdin. Writes only `<out.svg>`; no PNG/SVG artefacts are committed.

## Verification (this branch)

- `node --test test/`: 19 renderer tests, all passing.
- `design-scene.json`: 47 elements, 47 rendered, 0 skipped, 13,882-byte SVG,
  bounds `(80, 80) – (3700.5, 670.667)` (aspect ≈ 6.13:1 padded).
- Visual cross-check with `rsvg-convert` against the official Excalidraw
  screenshot of the same scene: non-white pixel share 5.004% vs 5.113%; ink
  bounding-box aspect 6.213 vs 6.159; ink-density Pearson correlation 0.798
  after fitting both to the same grid. Different fonts/hand-drawn strokes mean
  pixel equality is not expected.

## Textures and images

`fillStyle: hachure | cross-hatch | zigzag` now renders as an SVG `<pattern>` of
strokes (deduplicated per colour+density, one `<defs>` block; the rotation is a
`patternTransform` on the tile — rotating the line inside the tile clips it, which
is exactly the bug round 13 found). Measured ink: hachure 34.5 %, cross-hatch
51.6 % on an 8 px tile with a 2 px stroke, and an `image`
element whose `fileId` has a `data:image/…;base64,` URL in the scene's `files`
renders as `<image preserveAspectRatio="none">`; anything else (remote URL, bad
scheme, missing file) stays the placeholder. Roughness (wobble) is still not
simulated.

## Fidelity against Excalidraw

See [`FIDELITY.md`](FIDELITY.md) — measured against a hand-drawn app scene.

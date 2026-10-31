# Shipped Excalidraw web fonts

The plugin bundles the fonts the Excalidraw app draws hand-drawn text with, so a
scene looks the same in the Design tab as it does in Excalidraw. Nothing is
fetched from a CDN: the host half serves these files from the package
(`GET /excalidraw/fonts/<file>`, CONTRACT §6) and the client registers them with
`@font-face` rules.

| family | Excalidraw `fontFamily` | file(s) | license |
| --- | --- | --- | --- |
| `Comic Shanns` | 8 (code / "Comic Shanns") | 4 unicode subsets | MIT — see `LICENSE-comic-shanns.txt` |
| `Virgil` | 1 (hand-drawn) | `Virgil-Regular.woff2` | SIL OFL 1.1 — see `LICENSE-virgil.txt` |
| `Lilita One` | 7 (bold display) | 2 unicode subsets | SIL OFL 1.1 — see `LICENSE-lilita-one.txt` |

`Excalifont` (family 5, Excalidraw's default) is **not** bundled: the font itself
carries "Copyright (c) 2024 by Excalidraw. All rights reserved." and neither the
package nor the repository ships a licence grant for it. Scenes that use it fall
back to the CSS stack. Add it here only with an explicit licence grant from
Excalidraw.

Font families the plugin does not bundle (2 Helvetica, 3 Cascadia Code,
4 Liberation Sans, 6 Nunito) also fall back to the browser's stack.

## User-supplied fonts

`config.extraFontsDir` can point at a directory with font files plus `fonts.json`:

```json
{ "fonts": [{ "family": "Excalifont", "file": "Excalifont-Regular.woff2" }] }
```

The host serves those files under `/excalidraw/fonts-extra/` and the client adds
the matching `@font-face` rules, which is how you can bring `Excalifont` (family 5)
without the plugin redistributing it.

## Exports

An exported SVG (and the PNG the tab rasterises) embeds only the subsets the scene
draws with, and its `<metadata>` names each embedded family with its licence and
copyright line. The licence texts ship here (`LICENSE-*.txt`) and are not copied
into every export: MIT requires the notice with the font, and OFL's conditions
attach to the font software, not to a diagram that uses it.

## Format

Binary files travel as base64 text (`<file>.<n>.b64`, concatenated in order)
because the plugin repository is text-only. `MANIFEST.json` records the family,
unicode range, byte size and sha256 of every font; `lib/fonts.js` verifies the
digest before serving. After editing the manifest run `node scripts/gen-fonts-data.mjs` **and** `node
scripts/build-client.mjs`: the client bundle inlines that generated module, and
the test suite fails if the two drift.

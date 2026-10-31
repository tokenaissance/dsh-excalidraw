# Third-party notices

The plugin is MIT licensed (see [LICENSE](LICENSE)). The following third-party
material keeps its own terms.

## Bundled fonts

The plugin ships the Excalidraw web fonts it can redistribute. Each one keeps its own
licence, reproduced in `fonts/`:

| Font | Licence | Text |
| --- | --- | --- |
| Comic Shanns | MIT | [fonts/LICENSE-comic-shanns.txt](fonts/LICENSE-comic-shanns.txt) |
| Virgil | SIL Open Font License 1.1 | [fonts/LICENSE-virgil.txt](fonts/LICENSE-virgil.txt) |
| Lilita One | SIL Open Font License 1.1 | [fonts/LICENSE-lilita-one.txt](fonts/LICENSE-lilita-one.txt) |

Excalifont, Excalidraw's own default face, is **not** bundled: it carries no licence
grant. Scenes that use it render with the shipped Virgil fallback, which is what
Excalidraw's own font stack does.

## Excalidraw

The Excalidraw name and its scene format belong to the
[Excalidraw](https://github.com/excalidraw/excalidraw) project. This plugin reads and
renders the `.excalidraw` format; the renderer in `src/renderer.mjs` is original code and
does not depend on `@excalidraw/*` at runtime.

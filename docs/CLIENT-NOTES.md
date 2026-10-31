# Client half — implementation notes

`client.js` is **generated**: `npm run build` inlines `src/renderer.mjs` and
`src/client.mjs` into the single `window.__ModuleLoader__.load({ id, factory })`
module. Edit the sources, never the artifact.

## Mount points

Two surfaces: DSH's native `conversation.view` slot (always registered when the
`slots` service is present, so a stock DSH shows a **Design** view) and, when
dsh-better-sidebar is installed, the sidebar surfaces below.

| What | API | Effect |
| --- | --- | --- |
| `Design` sidebar tab | `registerTab({ id: 'excalidraw', single: true, order: 42, … })` | the viewer for refreshed scenes |
| `.excalidraw` files | `registerFileViewer({ exts: ['excalidraw'], fetchStrategy: 'fsRead', priority: 10 })` | clicking a scene file shows the diagram, not JSON |
| tree glyph | `registerFileIcon({ exts: ['excalidraw'] })` | diagram icon in the explorer |
| auto-open | `openTab({ type: 'excalidraw' }, { sessionId })` | fires when the host's `focus` pointer changes |

The sidebar block sits inside `ctx.inject(['betterSidebar'], …)`; a host without
dsh-better-sidebar keeps the native conversation view and its watcher instead
(auto-open activates the view rather than a tab). Nothing steals other viewers.

## Data flow

- `GET /excalidraw/api/scenes?sessionId=` → the scene list (`slug`, `name`,
  `updatedAt`).
- `GET /excalidraw/api/scene?sessionId=&slug=` → the scene document; the ETag is
  kept and replayed as `if-none-match`, so an unchanged scene costs one 304.
- `GET /excalidraw/api/rev?sessionId=` → `{ revision, focus? }`, polled while the
  tab is visible (500–10 000 ms, default 1500). A higher revision refetches.
- `POST /excalidraw/api/refresh` → the host pulls from Excalidraw+ and returns the
  same shape as the `excalidraw_refresh` tool.

The focus watcher (every 6 s, visible tabs only) reads `/rev` **without** a
session, so the host can resolve its most recent workspace; the `focus.sessionId`
in the response decides which session's sidebar gets the tab.

## Rendering

`renderScene(elements)` returns the whole SVG string; the tab only positions it
(`translate/scale`), so zoom/pan never re-renders the scene. A `ResizeObserver`
keeps the fit scale fresh; double-click refits.

The shipped fonts are registered with `@font-face` by `injectFontFaces(ctx)` (CONTRACT §6): Comic Shanns, Virgil and Lilita One are served by the host `/excalidraw/fonts/` route with a `?v=<sha8>` suffix so `immutable` caching cannot pin stale glyphs. Family 5 (Excalifont) is not shipped, so it falls through to the shipped Virgil. Exports (SVG and the PNG path) embed the fonts the scene draws with, plus a `<metadata>` notice, because a document's `@font-face` rules do not apply inside an `<img>`; both formats go through one `exportArtifacts()` helper so the PNG path cannot rasterise the bare SVG.
with bundled fonts is the documented follow-up if fidelity matters.

## What the Node tests cover, and what they do not

Covered: bundle shape (one loader call, no module syntax), registration counts and
disposal, tab descriptor fields, viewer sniffing, pure helpers (`parseScene`,
`formatClock`, `createApi` URL/etag/error mapping), and a render smoke of the tab
component through a React stub.

Not covered: real React rendering, the sidebar chrome, and visual fidelity — those
are verified in the browser against a scratch profile.

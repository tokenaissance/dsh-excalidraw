# dsh-excalidraw — wire contract

Everything below is normative. `xcal-host` implements §2–§4, `xcal-client`
implements §5–§6. Change this file only with both halves in agreement.

## 1. Config (cordis row `config`)

| key | type | default | meaning |
| --- | --- | --- | --- |
| `mcpUrl` | string | `https://api.excalidraw.com/api/v1/mcp` | Excalidraw+ MCP endpoint (streamable HTTP) |
| `mcpToken` | string | `''` | bearer token; when empty, resolved from `EXCALIDRAW_MCP_TOKEN`, then from the profile's own `mcp-excalidraw` row in `$DSH_PROFILE_DIR/cordis.patch.yml` |
| `scenesDir` | string | `.dsh/excalidraw` | scene directory, relative to the session workspace |
| `pollIntervalMs` | number | `1500` | client revision poll interval (clamped 500–10000) |
| `autoOpen` | boolean | `true` | host asks the sidebar to open/focus the tab after a refresh |
| `extraFontsDir` | string | `''` | directory of user-supplied fonts (`fonts.json` + the files); served under `/excalidraw/fonts-extra/` and registered by the client. This is the legal way to bring Excalifont or any other face |
| `maxSceneBytes` | number | `4194304` | refuse to serve/write scenes larger than this |

Config must be a `Config` schema on the plugin (`export const Config`) so a bad
row fails loudly at activation instead of at first refresh.

## 2. Scene store

Root: `<cwd>/<scenesDir>/`, created on demand.

```
<cwd>/.dsh/excalidraw/
  index.json                        # { revision, scenes: [...], focus?: {sessionId, at} }
  architecture.excalidraw           # a real Excalidraw scene document (JSON bytes)
  architecture.meta.json            # { slug, name, sceneId, source, tool, updatedAt }
```

The `.excalidraw` extension is what lets the sidebar file viewer (registered for
`exts: ['excalidraw']`) claim the file. A legacy `architecture.excalidraw.json`
is still read, listed and served and is **never** rewritten or migrated; when
both names exist for one slug the `.excalidraw` file wins and the slug is listed
once. `index.json`'s `entry.file` records the actual name and `entry.fingerprint`
(`{ mtimeMs, size }`) records the bytes it describes.

- `slug`: `^[a-z0-9][a-z0-9-]{0,63}$`, derived from the scene name (lowercase,
  non-alphanumerics → `-`, collapse runs, trim `-`), default `architecture`.
- Scene document: the object returned by `get_scene_content` (`{ type, version,
  source, elements, appState, files, … }`) stored as JSON — the same object and
  field order, but not the wire bytes (whitespace is re-rendered).
- `index.json` is the only revision source for reads. `revision` is a
  monotonically increasing integer (`Date.now()` is acceptable, but it must never
  go backwards; on a backwards write, use `max(prev+1, now)`).
- Writes are atomic: `writeFile` to `<file>.tmp` then `rename`.
- A `fs.watch` on the directory refreshes `index.json` when the scene files change
  outside the plugin (agent `fs.write`, editor, git). Change detection uses the
  stored fingerprint, so an edit that keeps the element count still bumps the
  revision. Watcher failures degrade to a low-frequency poll (`refreshFromDisk`
  every 5 s), never crash the plugin. A missing or corrupt `index.json` is
  rebuilt by scanning the directory.
- Index read-modify-write runs under a cross-process lock (`index.lock`, stale
  after 6 s) and every write uses a unique temporary name, so two hosts writing
  one workspace neither lose entries nor collide on a revision.
- A stored `revision` that is not a safe integer is treated as corrupt and
  rebuilt from the clock on the next write rather than clamped into a freeze.
- Scene reads must reject any path that escapes the scene root
  (`path.resolve` + prefix check, then `lstat`).
- **Auto-open handshake.** When `autoOpen` is on and a refresh succeeds, the host
  also writes `focus: { sessionId, at }` into `index.json` (`sessionId` = the
  calling agent's session, `at` = the new revision). The client half watches
  `focus` through `/excalidraw/api/rev` and calls
  `ctx.betterSidebar.openTab({...}, { sessionId })` for that session when it sees
  a focus it has not handled yet. No websocket: the pointer is just durable state.

## 3. HTTP API (host half)

Mounted under the plugin's route prefix `/excalidraw/api` (seven exact routes, plus
the `/excalidraw/fonts/` and `/excalidraw/fonts-extra/` prefixes). All responses are JSON
with `cache-control: no-store`; all handlers are `try/catch`-ed and return a JSON
error body (never an HTML stack trace).

`session` is optional everywhere. When a request carries no session, the host must
resolve the most recent session's cwd, or refuse with 400 `{"error":"no-session"}`
if it cannot. Never default to `process.cwd()`.

| method + path | query / body | 200 response |
| --- | --- | --- |
| `GET /excalidraw/api/health` | — | `{ ok, revision, scenes, mcp: { configured, url }, store }` |
| `GET /excalidraw/api/scenes` | `session?` (`sessionId?` alias) | `{ revision, items: [{ slug, name, sceneId, elements, updatedAt }] }` |
| `GET /excalidraw/api/scene` | `session?` (`sessionId?`), `slug` (default `architecture`) | the scene document verbatim, `etag: "<revision>-<slug>"`; `304` when `if-none-match` matches |
| `GET /excalidraw/api/focus` | — | `{ focus: { sessionId, at } \| null }`: the newest auto-open pointer across **every workspace this host has mounted**, so a refresh in another workspace still opens the tab. `cache-control: no-store` |
| `GET /excalidraw/api/rev` | `session?` (`sessionId?`) | `{ revision, focus?, pollMs }`; `304` when `if-none-match` matches; must stay < 1 ms hot. Its ETag is `"rev-<revision>"` before a focus exists and `"rev-<revision>-<focus.at>"` after, so a focus write invalidates a cached poll. **Only what `/rev` itself issues matches** — `"rev-<revision>"` (no focus) or `"rev-<revision>-<focus.at>"`. The `rev-` namespace keeps a scene ETag (`"<revision>-<slug>"`) from ever aliasing it, numeric slug or not. `pollMs` is the host's `pollIntervalMs` (clamped 500–10000) and is the interval the client polls with |
| `POST /excalidraw/api/refresh` | `{ session?, sceneId?, slug?, name? }` | same as the tool result (§4); failures are `{ ok: false, error, message }` with the status from the table below |

Error bodies: `{ "error": "<code>", "message": "<human text>" }` with codes
`no-session`, `no-scene`, `bad-request`, `mcp-unconfigured`, `mcp-error`,
`scene-too-large`, `internal`, `forbidden`, and `aborted` (a cancelled refresh, status 400). An `internal` failure answers
`internal error` and keeps its detail (which may contain an absolute path) in the
log only; a `no-scene` message never names the store root. Status: 400 for the first three,
502 for MCP failures, 413 for size, 500 for internal, **403 `forbidden`** when
`ctx.connection.requestRejection` refuses the request (browser-trust fence), and
**405 `bad-request`** for a wrong method on an existing path.

Both spellings of the session parameter are accepted everywhere — `session`
(this table) and `sessionId` (the client half's spelling) — in the query string
and in the refresh body, `sessionId` first.

## 4. Tool (host half)

```jsonc
// name: excalidraw_refresh
{
  "sceneId": "6gbUPPB8Q7X",   // optional; when absent the last/default scene is re-pulled
  "name": "Architecture",      // optional; becomes the slug + display name
  "slug": "architecture"       // optional; explicit slug wins
}
```

Result (`structuredContent` + a one-line text summary for the transcript):

```jsonc
{ "ok": true, "slug": "architecture", "file": ".dsh/excalidraw/architecture.excalidraw",
  "sceneId": "6gbUPPB8Q7X", "elements": 47, "revision": 1793203000000, "opened": true }
```

A cancelled call (`exec.signal` aborted) rejects with `AbortError` and writes
nothing — no scene, no index entry, no focus pointer — even if the MCP response
had already arrived.

Behaviour: resolve token → MCP `initialize` + `notifications/initialized` →
`tools/call get_scene_content { sceneId }` → validate (`elements` is an array) →
write scene + meta atomically → bump revision → (if `autoOpen`) ask the sidebar to
open the tab → return. A second tool `excalidraw_open` (`{ slug? }`) only opens the
tab. Failures return `{ ok: false, error, message }`, never throw.

```jsonc
// name: excalidraw_export
{ "slug": "architecture",   // optional; newest stored scene by default
  "format": "svg" }         // optional; only "svg" — anything else is bad-request
```

Result: `{ ok, slug, file, format: "svg", bytes, elements }`, where `file` is
`<scenesDir>/<slug>.svg`, written atomically. The export renders through the same
pure renderer as the client (`src/renderer.mjs`) and is bounded by
`maxSceneBytes`. PNG is not a host format: the Excalidraw tab rasterises the same SVG
on a canvas.

## 5. Client module (`client.js`)

The client half mounts the same scene view on **two surfaces**:

1. **DSH's native slot** — when the client context serves `slots`,
   `ctx.get('slots').inject('conversation.view', () => ctx.get('slots').register({
   name: 'conversation.view', id: 'excalidraw', order: 42, label, inject: (sessionId)
   => ({ sessionId }) }, NativeDesignView))` puts an **Excalidraw** view beside Chat and
   Trajectory. This is what makes the plugin work on a stock DSH.
2. **dsh-better-sidebar** — when that plugin is present, `registerTab` adds the
   **Excalidraw** sidebar tab (with the file viewer and file icon).

Both surfaces share `useScene`, `SceneCanvas`, the export pipeline and the focus
watcher; neither is required for the host half. The native registration is
best-effort: a profile without `slots` simply keeps the better-sidebar path, and
a browser-only retry covers a slot service that arrives after this plugin.

`dsh.client.immediately` is `true`: the tab must be in better-sidebar's registry
before the sidebar mounts, so the client module cannot wait for an on-demand load.
The bundle is ~102 KB (it inlines the renderer and the seven-entry font table); the
module itself never fetches a font until a scene uses one.

Module dependencies (`dsh.client.inject`): **only `@deepseek-ai/dsh-client-locale`**
(the plugin registers its copy through `ctx.locale`). `dsh-better-sidebar` is
consumed as a *service* (`ctx.inject(['betterSidebar'])`), not as a module, and the
plugin uses no slot registry — an unused module dependency here would block
activation in any profile that does not install it (review round 10).

Built artifact; source is `src/client.mjs` (+ `src/renderer.mjs`) and
`scripts/build-client.mjs` produces the loader wrapper:

```js
window.__ModuleLoader__.load({
  id: 'dsh-excalidraw',
  factory(require) { /* … */ return { inject: [...], apply(ctx) { … } }; },
});
```

- `id` must equal the package name.
- No side effects outside `apply`. Everything registered inside `apply` returns a
  disposer (cordis `ctx.effect`), so HMR and disable work.
- Primary mount: `ctx.betterSidebar.registerTab({ id: 'excalidraw', title, icon,
  description, order, single: true, component })`.
  `component` receives `{ scope }`; `scope.sessionId` and `scope.cwd` are used for
  every request. Tab title/description come from the client locale service when
  available, else the literals above.
- **Three more things the same service gives us for free** (all in this release,
  all optional when the service is absent):
  1. `registerFileViewer` for real `.excalidraw` files — `{ id:
     'excalidraw:file', exts: ['excalidraw'], priority: 10, fetchStrategy:
     'fsRead', detect: (path, head) => /\.excalidraw\.json$/i.test(path) },`
     parsing the `content` the host already read and rendering it with the same
     renderer. Clicking a scene file in the file tree then shows the diagram, not
     JSON. Never claim plain `.json` files otherwise.
  2. `registerFileIcon` for `exts: ['excalidraw']` (+ `names: []` unused) using the
     package icon, so the tree/crumbs show the diagram glyph.
  3. no plugin-local settings: `autoOpen` and `pollIntervalMs` are **host** config
     (§1), delivered through the focus handshake and `/rev`'s `pollMs`.
- Without `betterSidebar` only the sidebar surface is absent: `ctx.inject` never
  fires, so the file viewer, the file icon and the tab stay unregistered — the
  native `conversation.view` above still works, and the native focus watcher is
  installed instead of the tab one. Do not steal other viewers.
- Auto-open is a better-sidebar feature: its watcher calls `openTab`. DSH has no
  public API to switch a slot view — `uiConversation.binding().activate()` only
  knows registered target builders (chat, trajectory, …), and a plugin view id is
  not one — so on a stock DSH the Excalidraw tab is opened by clicking it. Exactly
  one watcher runs per profile, and the host still records the focus pointer.
- The `.excalidraw` file viewer relies on better-sidebar handing over the file
  content; better-sidebar refuses to read files above its own 5 MiB editable
  limit, so a scene that large opens with a load error even though the Excalidraw tab
  can still render it from the store.
- The scene surface is preview-only: drag/wheel pans, ⌘/Ctrl+wheel and pinch
  zoom at the cursor, click selects the topmost element, Shift+click toggles,
  Shift+drag marquees, ⌘/Ctrl+A selects all, and `Esc` clears. Selection is
  local UI state; the plugin never writes an edited scene back.
- A session restored from disk is not "live": the resolver first asks the
  working-directory service, then its header, then the persisted workspace table
  (`$DSH_HOME/storages/workspace.json`, sessionIds → path). Only when none of
  those knows the session does the view report `no-session`.
- Polling: only while mounted and `document.visibilityState === 'visible'`;
  `GET /excalidraw/api/rev` with the current `etag`; on change, refetch the scene.
  Stop the timer on dispose.
- The tab must survive a session switch: refetch on `scope.sessionId` change.
- **A failure is visible.** When a load or refresh fails while a scene is shown,
  the tab keeps that scene but marks itself: red status dot and the error text in
  the footer. A silent failure (green dot, old "Updated") is a bug.
- **The Refresh button sends only `{ sessionId, slug }`**: the host resolves the
  scene id that slug currently holds, so a stale id in an old tab can never pull a
  different scene over a newer one. An explicit `sceneId` (agent path) either
  re-points that same slug (intent) or is refused when it belongs to another
  stored slug (`bad-request`).
- **A dead scene never wedges the tab.** When the pinned scene disappears the tab
  unpins, shows the empty state, and offers a **Follow** button that returns to
  the newest scene.
- **Polling carries the `/rev` ETag** (`if-none-match`), reloads on ANY revision
  change (including a rollback after an external `index.json` rewrite), and each
  load takes a ticket so a late response cannot overwrite a newer manual pick.
- The scene is drawn on a paper surface (`background: true`), so dark themes do
  not wash out Excalidraw's dark ink.
- All requests go through one helper `api(path, params)` that adds
  `credentials: 'same-origin'`, the session id, a 10 s `AbortController` timeout,
  and turns non-2xx into an error state rendered as text (never a thrown render).
- Every URL resolves against `document.baseURI` with leading slashes stripped
  (never a root-absolute path): a reverse-proxied subpath and Electron's
  `dsh-app://app/` both require it. `ctx.betterSidebar.hostRouteUrl` is used when
  the service offers it, and its result may be a string or a `URL`.
- Switching `scope.sessionId` resets the loaded scene, the scene list, the
  revision and the cached ETag before refetching: an ETag belongs to one
  workspace's store and must never be replayed against another.
- With no explicit slug the tab shows the **newest** stored scene
  (`updatedAt`, else the last entry), so it follows the latest refresh.

## 6. Fonts (`GET /excalidraw/fonts/<file>`)

The plugin ships the Excalidraw web fonts it can legally redistribute and serves
them itself, so rendering a scene makes **no third-party request**:

| family | `fontFamily` | files | licence |
| --- | --- | --- | --- |
| `Comic Shanns` | 8 | 4 unicode subsets | MIT (`fonts/LICENSE-comic-shanns.txt`) |
| `Virgil` | 1 | 1 file | SIL OFL 1.1 (`fonts/LICENSE-virgil.txt`) |
| `Lilita One` | 7 | 2 unicode subsets | SIL OFL 1.1 (`fonts/LICENSE-lilita-one.txt`) |

`Excalifont` (family 5, Excalidraw's default) is **not** bundled: the font carries
"All rights reserved" and no licence grant ships with it. Families 2, 3, 4, 6 and
the Emoji font also fall back to the browser stack. `fonts/README.md` records this.

Rules:
- the route is a **prefix** (`/excalidraw/fonts/`), refuses untrusted callers with
  `403` like every other route, accepts only `GET`/`HEAD` (`405` otherwise), and
  serves **only** names in `fonts/MANIFEST.json` (`404` otherwise) — the path can
  never reach another package file;
- the response is `font/woff2` with `cache-control: public, max-age=31536000,
  immutable` and `x-content-type-options: nosniff`;
- binaries travel as base64 chunks (`<file>.<n>.b64`); `lib/fonts.js` concatenates,
  decodes and verifies the manifest's `sha256` before serving (`500` on mismatch);
- the client registers them with `@font-face` rules built from
  `src/fonts-data.mjs` (generated from the manifest), each with its unicode range
  and `font-display: swap`, so an unavailable font degrades to the CSS stack. The
  rules are injected once (an element carrying `data-dsh-excalidraw="fonts"`), and
  their URLs carry `?v=<sha256 prefix>` so the route's `immutable` cache cannot pin
  stale glyphs after an upgrade;
- **exports are self-contained**: both the tab's SVG/PNG buttons and the host's
  `excalidraw_export` tool embed the bytes of the families the scene draws with as
  `@font-face` data URLs inside the written SVG (the tab also streams the same
  self-contained SVG into its `<img>` for PNG, because a document's `@font-face`
  rules do not apply inside an image). "Draws with" includes text elements, named
  frames (drawn in the family-5 stack) and text whose `fontFamily` is missing,
  `null`, `0` or unknown (the renderer falls back to family 5, so the embedder
  must too). Families 2/3/4/6 render with *system* stacks, so nothing is
  embedded for them. Subsets are selected by the characters actually present; unused
  families and subsets are never embedded, and a scene without drawn text gets no
  `<style>`. The CSS travels in a **CDATA** section (a raw `<` is invalid XML
  text) and the file carries a `<metadata>` notice naming exactly the embedded
  families with their licences. The notice carries the family, the licence name
  and the copyright line; the licence texts themselves ship in the package
  (`fonts/LICENSE-*`), which is what MIT requires (the copyright + permission
  notice must accompany the font) and what OFL requires of the font software. A
  short pointer (not a 4 KB licence) is embedded in every export on purpose: the
  exported diagram is output, not a redistribution of the font.
- **User-supplied fonts**: `config.extraFontsDir` may point at a directory holding
  font files plus `fonts.json` (`{ "fonts": [{ "family": "Excalifont", "file":
  "Excalifont-Regular.woff2" }] }`). The host serves them under
  `/excalidraw/fonts-extra/<file>` (manifest names only, browser-fenced) and lists
  them at `GET /excalidraw/api/fonts`; the client appends the matching
  `@font-face` rules after the bundled ones. This lets a user bring Excalifont
  without the plugin redistributing it.
- an `index.json` larger than 8 MiB is treated as corrupt and rebuilt from the
  scene files; an index commit is refused when the lock file no longer carries
  the writer's token (fencing), and a cancelled write restores the previous
  scene bytes (a new slug's files are removed instead).
- the export byte budget is `maxSceneBytes` **plus** a bounded
  `FONT_EMBED_ALLOWANCE` (256 KiB) for that deterministic font sheet, so a scene
  that fits is not refused merely because its fonts are embedded.

## 7. Renderer (`src/renderer.mjs`)

Pure, DOM-free, deterministic:

```js
export function renderScene(elements, options) -> { svg: string, width, height, bounds }
export function sceneBounds(elements) -> { minX, minY, maxX, maxY } | null
```

- Options: `{ padding = 24, background = false }`.
- Returns two extra diagnostics besides the four documented fields: `rendered`
  (element count) and `skipped` (`[{ id, type, reason }]`); both are additive and
  used by `scripts/render-scene.mjs`.
- Skips `isDeleted === true`, unknown types, and elements with non-finite
  geometry. Never emits `NaN`, `undefined`, or `null` inside the SVG.
- Supports: `rectangle`, `ellipse`, `diamond`, `line`, `arrow`, `text`, `frame`,
  `image` (drawn from a `data:image/…;base64,` URL in the scene's `files`, else a
  placeholder rect with the image's x/y/w/h — never a network fetch).
- Honours: `x, y, width, height, angle, strokeColor, backgroundColor,
  fillStyle, strokeWidth, strokeStyle (solid|dashed|dotted), opacity, roundness`.
  `roughness` is ignored; rendering is always clean.
- Text: standalone `text` elements use `textAnchor` from `textAlign`; bound text
  (`containerId`) is centred in its container honouring `verticalAlign`. Escape
  `& < > "`.
- Arrows/lines: build the polyline from `points` (`x + px`, `y + py`), honour
  `startArrowhead`/`endArrowhead` (`arrow`, `triangle`, `bar`, `dot`, `null`).
- Bound arrow labels render at the polyline midpoint with a small white chip.
- Order: array order (Excalidraw already stores z-order) — do not sort by `id`.
- Deterministic output: identical elements must produce byte-identical SVG.

### Renderer details that are normative

- Fills with `fillStyle: hachure` / `cross-hatch` / `zigzag` are drawn with SVG
  `<pattern>` hatch strokes (one pattern per colour+density, deduplicated, emitted
  in a single `<defs>`), not a solid tint.
- An `image` element whose `fileId` resolves to a `data:image/…;base64,` URL in the
  scene's `files` is drawn as `<image>` stretched to its box; any other value
  (remote URL, `javascript:`, an unknown file id) renders the placeholder.
- The renderer receives the scene's `files` map from both halves, so an export and
  the tab draw the same images.

## 8. Testing

- `node --test test/` must pass with **no dependencies** (Node 22 built-ins only).
- `test/renderer.test.mjs`: fixture `test/fixtures/design-scene.json` (47 real
  elements, the design of this plugin) → SVG asserts: every element accounted
  for, viewBox covers bounds, no `NaN`, title text present, `<svg` well-formed,
  determinism across two runs.
- `test/store.test.mjs`: slug derivation, atomic write, revision monotonicity,
  path escape refusal.
- `test/mcp.test.mjs`: the JSON-RPC client against a local `node:http` fake MCP
  server (initialize → tools/call → result), plus SSE and plain-JSON responses and
  an error frame.
- `test/client.test.mjs`: load `client.js` in Node with a stub
  `globalThis.window.__ModuleLoader__` and a stub `require('react')`; assert the
  factory returns `{ inject, apply }`, that `apply` registers exactly one tab on a
  stub `ctx`, and that disposing calls the stubbed disposers.

# dsh-excalidraw — host half notes

Implementation record for the Node/cordis half (`index.js` + `lib/`). The
normative wire surface is `docs/CONTRACT.md`; this file says what the code
actually does, where it differs, and what the client half and the integrator
need to know. `docs/CONTRACT.md`, `docs/DESIGN.md`, `client.js`,
`src/client.mjs`, `src/renderer.mjs`, `scripts/build-client.mjs` and
`cordis.patch.yml` are owned by the other halves and were not touched.

## Layout

| file | role |
| --- | --- |
| `index.js` | glue only: `name`, `inject`, `Config`, `apply`; every registration goes through `ctx.effect` |
| `lib/config.js` | defaults + clamps (`resolveConfig`) and the schema factory (`createConfigSchema(z)`) — imports nothing from DSH |
| `lib/token.js` | token precedence (row → `EXCALIDRAW_MCP_TOKEN` → profile `serverName: excalidraw` row), line-oriented YAML reader, no YAML dependency |
| `lib/store.js` | scene store: slug, unique-temp atomic writes under a cross-process index lock, monotonic revision, content fingerprints, focus pointer, `fs.watch` with poll fallback, directory rebuild, path fence, size cap |
| `lib/session.js` | request/tool → `{ sessionId, cwd }`, `scenesDir` resolution, scene-file reference |
| `lib/mcp.js` | streamable-HTTP JSON-RPC client (`initialize` → `notifications/initialized` → `tools/call`), event-based SSE + plain JSON (a missing `content-type` tries JSON then SSE), `mcp-session-id`, deadline and caller cancellation, `mcp-error` mapping |
| `lib/routes.js` | the five `/excalidraw/api` handlers, ETag/304, `cache-control: no-store`, JSON error envelope |
| `lib/tools.js` | `excalidraw_refresh` / `excalidraw_open` definitions and the shared refresh operation |
| `test/*.test.mjs` | `node:test` suite, zero dependencies, no network |
| `test/stubs/` | `node:module` resolve hooks replacing `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools` for the glue test |
| `scripts/run-tests.mjs` + `test/package.json` | makes the literal `node --test test/` work on Node builds that resolve a directory argument as a module (see “Environment” below) |

Config (CONTRACT §1) is unchanged: all six keys already exist in
`cordis.patch.yml`. `mcpToken` is optional — the profile row and the environment
are used when it is empty. No new config key is required.

## Wire surface

`session` is optional everywhere and accepted under **both** spellings,
`sessionId` (what the client sends) and `session` (CONTRACT §3); `sessionId`
wins when both are present. All bodies are bare JSON (no `{ok, value}`
envelope), all responses carry `cache-control: no-store`.

### `GET /excalidraw/api/health`

- query: `sessionId?` / `session?`
- 200: `{ ok: true, revision, scenes, mcp: { configured, url }, store }`
  - `scenes` is a count; `mcp.configured` says a token was resolvable, never the token;
  - `store` is the scene directory relative to the session cwd (`.dsh/excalidraw`), or the configured value / an absolute root when no session is resolvable;
  - with no resolvable session: `revision: 0, scenes: 0, store: <scenesDir>` and still 200.

### `GET /excalidraw/api/scenes`

- query: `sessionId?` / `session?`
- 200: `{ revision, items: [{ slug, name, sceneId, elements, updatedAt }] }`
- entries whose file vanished are omitted; `updatedAt` is epoch milliseconds.

### `GET /excalidraw/api/scene`

- query: `sessionId?` / `session?`, `slug` (default `architecture`)
- 200: the stored scene document **verbatim**, `content-type: application/json; charset=utf-8`, `etag: "<revision>-<slug>"`
  - a file written by an older version (`<slug>.excalidraw.json`) is served and indexed under that name; a scene written now is `<slug>.excalidraw` (still JSON bytes)
  - if the file changed outside the plugin since the last scan, the read adopts it (bumps the revision) before answering, so the ETag cannot mask new bytes
- 304: when `if-none-match` contains that ETag (a `W/` prefix is ignored); the 304 repeats `etag` and `cache-control`
- 400 `no-scene` for an unknown slug, 400 `bad-request` for a slug that is not `^[a-z0-9][a-z0-9-]{0,63}$` (a path-like slug is normalized or refused, never opened), 413 `scene-too-large`.

### `GET /excalidraw/api/rev`

- query: `sessionId?` / `session?`
- 200: `{ revision, focus?: { sessionId, at } }`, `etag: "rev-<revision>"` before a focus pointer exists, else `etag: "<revision>-<focus.at>"`
- 304: when `if-none-match` matches that ETag exactly — the bare `"rev-<revision>"` while no focus is recorded, or `"<revision>-<focus.at>"` after. A scene ETag `"<revision>-<slug>"` is *not* a `/rev` validator (a numeric slug is ambiguous with a focus value). An older value is stale (200), so a cached poll cannot swallow an auto-open.
- 400 `no-session` when no session can be resolved.

### `POST /excalidraw/api/refresh`

- body: `{ sessionId? | session?, sceneId?, slug?, name? }` (the query parameters are accepted too)
- 200: exactly the `excalidraw_refresh` result, `{ ok: true, slug, file, sceneId?, elements, revision, opened }`
- failure: `{ error, message }` with `400` `no-session`/`no-scene`/`bad-request`/`mcp-unconfigured`, `413` `scene-too-large`, `502` `mcp-error`, `500` `internal`.

Wrong method → `405 { error: "bad-request" }`; a request rejected by
`ctx.connection.requestRejection` → `403 { error: "forbidden" }` (neither status
is in CONTRACT §3's table, which only lists the seven error codes).

## Tools

`excalidraw_refresh` — parameters `{ sceneId?: string, name?: string, slug?: string }`.
Result (canonical JSON; `sceneId` is omitted when the server did not name the
scene):

```json
{ "ok": true, "slug": "architecture", "file": ".dsh/excalidraw/architecture.excalidraw",
  "sceneId": "6gbUPPB8Q7X", "elements": 47, "revision": 1793203000000, "opened": true }
```

Failure: `{ ok: false, error, message }` with the same code set as the route.
The calling session comes from `exec.agent.session.id`; the model never passes it.

`excalidraw_open` — parameters `{ slug?: string }`. Records the focus pointer for
the calling session and bumps the revision so every explicit open is observable:

```json
{ "ok": true, "slug": "architecture",
  "file": ".dsh/excalidraw/architecture.excalidraw", "revision": 1793203000001, "opened": true }
```

Both tools call `exec.signal.throwIfAborted()` before any I/O, pass the signal
into the MCP `fetch`, re-check it before `writeScene`/`markFocus`, and reject
with `AbortError` when cancelled (cancellation is not a `{ ok: false }`
result). Otherwise they return one canonical value and project it to text in
`output.render`.

## Implementation notes

- **Token.** `config.mcpToken` → `EXCALIDRAW_MCP_TOKEN` → the `Authorization:
  Bearer …` header of the profile's `serverName: excalidraw` insert row in
  `$DSH_PROFILE_DIR/cordis.patch.yml` (read-only, folded multi-line scalars
  supported, other servers' rows never picked up). Every failure path returns
  `{ token: '', source: 'none' }`; the token never appears in a log line, a
  response body, or an error message (MCP error text is redacted).
- **Store.** `<cwd>/<scenesDir>/` with `<slug>.excalidraw` (JSON bytes; the
  legacy `<slug>.excalidraw.json` is still read, never rewritten or migrated),
  `<slug>.meta.json` (`{ slug, name, sceneId, source, tool, updatedAt }`) and
  `index.json` (`{ revision, scenes, focus? }`). Every index entry also carries
  `file` (the actual document name) and `fingerprint: { mtimeMs, size }`.
  Writes are a unique `<file>.<pid>.<n>.tmp` + `rename` under a per-store
  mutex; a failed rename removes its temporary. `revision = max(prev + 1,
  now())`, so a clock that moves backwards cannot rewind it. Reads are fenced
  twice (slug grammar, then `resolve` + prefix) and served only from a regular
  file (`lstat`, so a symlink is refused). `maxSceneBytes` is enforced on write
  and on read.
- **Cross-process lock.** Every `index.json` read-modify-write (write, bump,
  focus, scan, read-adoption) holds `<root>/index.lock` created with
  `open(..., 'wx')`. A busy lock is retried every 10 ms; a lock older than 2 s
  belongs to a dead writer and is taken over; after 10 s the operation answers
  `internal`. Two hosts on one workspace therefore never lose an entry, never
  share a revision and never collide on a temporary file (P1-2).
- **Content fingerprints.** The watcher, the poll and a scene read compare the
  file's `mtimeMs` + `size` with the index entry, so a rewrite that keeps the
  element count (the normal "move a box" edit) still bumps the revision and
  moves the ETag. An index written before fingerprints existed is backfilled
  once without a bump. The element count alone is no longer the change test
  (P1-1).
- **Revision recovery.** A stored revision that is not a safe integer (a
  tampered `1e308`) is not trusted: the next write rebuilds it from the clock.
  Clamping to `Number.MAX_SAFE_INTEGER - 1` would freeze again one write later
  and the client's `next <= current.revision` rule would ignore the rebuilt
  value, so the unusable value is reset rather than clamped (P2-4).
- **Watcher.** `fs.watch` on the store root (non-persistent, debounced) calls
  `refreshFromDisk()`, which reconciles scene files with the index and bumps
  only on a real change — our own writes therefore cannot cause a feedback bump.
  A watcher that cannot start (or fails later) logs and starts the poll path
  CONTRACT §2 promises: `refreshFromDisk()` every 5 s, `unref()`-ed and cleared
  by `close()`. `listScenes()` also scans the directory once when the index has
  no scenes, so a missing or corrupt `index.json` is rebuilt instead of hiding
  every scene forever (P2-5).
- **Focus (auto-open).** On a successful refresh with `autoOpen`, the store
  writes `focus: { sessionId, at: <new revision> }`; the client watches it
  through `/rev`. `/rev` returns the focus pointer unfiltered — the client
  compares `focus.sessionId` with its own session — and its ETag includes
  `focus.at`, so a poll cached before the pointer was recorded is answered 200
  with the pointer instead of 304 (P2-7). `excalidraw_open` always writes the
  pointer (it is an explicit request) and bumps the revision first.
- **Cache.** `/rev` and `/scenes` read a cached index validated by a single
  `stat` (size + mtime), so an external rewrite (agent `fs.write`, editor,
  checkout) is picked up on the next poll. Stores are cached per scene root
  (bounded at 32, LRU) and closed on dispose.
- **No session.** An explicit but unusable session id → `400 no-session`. With
  no id: the last session this plugin successfully resolved, else the only
  session in `ctx.sessions.list`, else `400 no-session`. Never
  `process.cwd()`. The host session API exposes no recency field, so “most
  recent” is this plugin's observation order.
- **Errors.** Every route handler is wrapped; failures become the contract's
  `{ error, message }`; an `internal` failure logs the detail and answers a
  generic message, so no stack trace and no unexpected path reaches the browser.

## Verified

- `node --test test/` — 196 tests, 0 failures (Node 24.21.0 in a LayerFS
  Workspace, and Node 22.23.2 on the host). `node --test test/*.test.mjs` and
  bare `node --test` also pass. The mcp tests use local `node:http` fake servers;
  no test touches the network or a real profile.
- Live read-only smoke (outside the suite, not committed): `lib/token.js` +
  `lib/mcp.js` against `https://api.excalidraw.com/api/v1/mcp` with the profile
  token — `initialize`, 39 tools listed, `tools/call get_scene_content
  { sceneId: "6gbUPPB8Q7X" }` extracted as a 47-element scene document.

## Environment note

On Node 22.19+/24, `node --test <dir>` treats the argument as a single module
instead of searching the directory, so the literal CONTRACT §7 command failed
with `Cannot find module .../test`. `test/package.json` points `main` at
`scripts/run-tests.mjs` (same shim as `xcal-render`), which imports every
`test/*.test.mjs`; the file sits outside `test/`, so bare `node --test`
discovery does not run the suite twice. Measured: 196 tests, 0 failures.

## Contract deltas (host round 2)

Wire-visible behaviour that changes the text of `docs/CONTRACT.md` (§3/§4) and
must be folded into it when both halves agree:

1. **Scene file extension.** New scene documents are `<slug>.excalidraw` (the
   bytes are still the Excalidraw JSON document); `<slug>.excalidraw.json` is
   still read, listed and served, and is never rewritten or migrated. When both
   names exist for one slug the `.excalidraw` file wins and the slug is listed
   once. `index.json`'s `entry.file` records the actual name. This is what
   makes the sidebar file viewer (`exts: ['excalidraw']`) claim the file.
2. **`GET /rev` ETag carries the focus pointer.** `"rev-<revision>"` while no focus
   is recorded, `"<revision>-<focus.at>"` afterwards. `if-none-match` still
   accepts the bare revision (when no focus exists) and any scene ETag
   `"<revision>-<slug>"`; an older `"<revision>-<at>"` is stale.
3. **A read may bump the revision.** `/scene` (and `/rev` after a scan) adopt a
   scene file whose content fingerprint changed since the index was written, so
   the revision can advance without a write by the plugin.
4. **Revision recovery.** A stored `revision` that is not a safe integer is
   rebuilt from the clock on the next write instead of being clamped forever.
5. **Cancellation.** A cancelled `excalidraw_refresh` / `excalidraw_open` call
   rejects with `AbortError`; CONTRACT §4's "failures return `{ ok: false }`"
   covers business failures only.
6. **Internal failures.** `POST /refresh` answers `{ ok: false, error:
   "internal", message: "internal error" }`; the raw detail (which may contain
   an absolute path) only reaches the log, matching the other routes.
7. **`no-scene` messages** no longer carry the store root.

Internal only (no contract text changes): the cross-process `index.lock`, the
unique temporary names, the directory rebuild and the 5 s poll fallback, the
`ctx.sessions.list()` shape support, and the SSE event parsing.

## Deviations from CONTRACT

1. **Scene bytes.** The document is stored as `JSON.stringify(document)` — the
   same object in canonical JSON, field order preserved, wire whitespace not.
2. **`mcp-error` / `mcp-unconfigured` statuses.** `mcp-error` → 502 as
   specified; `mcp-unconfigured` (no token anywhere) → **400**, because it is a
   local configuration problem rather than an upstream failure. CONTRACT §3
   lists it as a code but only names 502 for “MCP failures”.
3. **`403 forbidden` and `405`.** CONTRACT §3's error-code set has no
   “forbidden”/“method” code; the browser gate answers 403 `forbidden` and a
   wrong method answers 405 `bad-request`.
4. **`/rev` ETag leniency.** It accepts either `"rev-<revision>"` or
   `"<revision>-<slug>"`, so one stored ETag drives both `/rev` and `/scene`.
5. **Focus is global.** `/rev` returns the pointer regardless of the requesting
   session; the client must compare `focus.sessionId`.
6. **`excalidraw_open` bumps the revision.** Otherwise two opens at the same
   revision are indistinguishable to a client that deduplicates by `at`.
7. **No-session resolution** is observation-order based (see above), because
   the host session API has no recency field.
8. **`updatedAt`** in `index.json` and the meta sidecar is epoch milliseconds
   (CONTRACT does not pin the representation).
9. **Index entries carry an extra `file` field** (derived from the slug); the
   scene store writes the documents atomically but never edits them.
10. **`scenesDir` may be absolute**; it is resolved against the session cwd
    otherwise (CONTRACT says “relative to the session workspace”).
11. **`session` vs `sessionId`.** Both spellings are accepted everywhere; the
    client half sends `sessionId`.

## Not verified here

- Mounting inside a real DSH process: the glue test replaces
  `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools` with local stubs and
  drives `apply` on a fake cordis context. The sugar used is exactly
  dsh-better-sidebar's (`parameters` / `output.schema` / `output.render` /
  `execute`, `ctx.tools.register`, `ctx.webServer.register({ kind: 'exact' })`),
  but the first real mount is the integrator's to confirm.
- The browser round trip that consumes the focus pointer (`openTab`), which is
  the client half's behaviour.
- A live host with several sessions: the no-session fallback then refuses with
  `400 no-session`, as CONTRACT allows.

## Contract deltas (review round 4)

1. **`/rev` validators are exactly what /rev issues**: `"rev-<revision>"` while no
   focus exists, `"<revision>-<focus.at>"` afterwards. A scene ETag
   (`"<revision>-<slug>"`) is no longer accepted there — a numeric slug is
   indistinguishable from a focus value (round-3 finding).
2. **A cancelled write is not a completion**: `excalidraw_refresh`/`_open` and
   every store mutation take the abort signal; a call cancelled while waiting
   for the index lock rejects with `AbortError`, and `POST /refresh` answers
   `400 { ok: false, error: "aborted", message: "the refresh was cancelled" }`.
3. **The index lock names its owner**: a unique token in the lock file, an mtime
   heartbeat while held, and a second `index.lock.steal` mutex that serializes
   stale takeovers. Only the owner (token match) releases; a path holding a
   symlink or a directory is cleared instead of wedging the store.
4. **A read never pairs bytes with a fingerprint they did not produce**: reads
   stat → read → stat and only adopt a fingerprint when both stats agree; a file
   that will not hold still advances the revision without a fingerprint. A file
   that vanished mid-read is `no-scene`, never a 200 with an empty body.
5. **Fingerprints carry a content hash** (`sha1`) wherever the bytes are at
   hand, so a same-size rewrite with a restored mtime still bumps the revision.
   A corrupt `index.json` is rebuilt from the directory, and reading one scene
   through it keeps every other scene listed.

## Contract deltas (review round 5)

1. **A third tool, `excalidraw_export`**: it renders one stored scene through the
   same pure renderer the client uses and writes `<scenesDir>/<slug>.svg`
   (atomic, fenced, `maxSceneBytes`-bounded). Only `svg` is exported on the host;
   `format: "png"` is refused with `bad-request` because rasterising needs a
   browser (the tab's PNG button draws the same SVG on a canvas).
2. `lib/tools.js` imports `src/renderer.mjs` relatively, and the package's
   `files` list ships that file so a installed copy can render exports.

## Changes (review round 6)

- The client reads the two `settings.pluginToggles` values directly from
  `store.getPrefs()` instead of memoising a call to it: `getPrefs()` returns a
  fresh object per call, so it must never sit in a dependency array.
- Exported `.svg` assets are deliberately invisible to the scene store: the
  watcher, the directory scan and the corrupt-index rebuild only recognise
  `.excalidraw` / `.excalidraw.json`, and a test pins that.

## Changes (review round 11)

- **Lock wait is bounded on every path**: `withIndexLock` routes every retry
  (including "could not clear a pathological node" and "stale lock could not be
  unlinked") through one `retry()` that checks the deadline and sleeps, so a
  non-empty `index.lock/` directory or an immutable lock file fails with
  `internal` after `lockWaitMs` instead of spinning the event loop forever.
  `lockWaitMs` is injectable for tests.
- `POST /excalidraw/api/refresh` passes an `AbortSignal` tied to the request's
  close/abort, so the documented `400 aborted` is reachable and a disconnected
  client stops the write.
- Renderer clamps line/arrow points as well as boxes (a `1e306` point no longer
  turns the SVG into `Infinity`), and a malformed `fonts/MANIFEST.json` entry is
  dropped instead of 500ing the export / 404ing every font.
- **The client half never reads an undeclared service property.** `resolveHostUrl`
  asks `ctx.get('betterSidebar')`: a bare `ctx.betterSidebar` throws in cordis 4
  when the plugin did not inject it, and the font registration runs during `apply`
  before `ctx.inject(['betterSidebar'])` fires. A strict-ctx test pins this.
- The MCP token parser scopes `Authorization` to the row that owns
  `serverName: excalidraw` (a single `- insert:` can hold several server rows).
- A scene write now happens **inside** the index lock, so an abort while waiting
  for it leaves no scene or meta behind; the index keeps each entry's `sha1`
  (same-size rewrites with a restored mtime still bump), and deleting every scene
  externally prunes the index and bumps instead of advertising ghosts.
- Registering a route that is already mounted (a double-mounted bundle) logs a
  warning instead of failing the web boot.

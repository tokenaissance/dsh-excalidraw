# dsh-excalidraw — design

Drawn in Excalidraw before a line of code:
<https://app.excalidraw.com/s/9Zq6XgRe98z/6gbUPPB8Q7X> (architecture) and
<https://app.excalidraw.com/s/9Zq6XgRe98z/Aw55m5vJxYJ> (sidebar wireframe).

## The problem

The Excalidraw+ MCP server can already draw code architecture into a scene
(`create_diagram`, `edit_scene_content`, …). What is missing is the other half of
the loop: once the scene exists, there is nowhere in DSH to **see** it. A scene
lives in the Excalidraw+ cloud; DSH's UI knows nothing about it.

## The result we want

> “Refresh the architecture into Excalidraw” → the sidebar shows the diagram,
> immediately, without leaving the conversation.

Concretely, after a refresh the `Design` tab in the sidebar renders the newest
scene. It keeps itself current: any later refresh re-renders it in place.

## Architecture

Three halves, one contract (see `CONTRACT.md` for the exact shapes):

1. **Host half** (`index.js` + `lib/`, a cordis plugin, Node side)
   - `excalidraw_refresh` tool: pulls a scene from the Excalidraw+ MCP server and
     writes it to `<cwd>/.dsh/excalidraw/<slug>.excalidraw.json`, then bumps a
     revision counter.
   - HTTP routes under `/excalidraw/api/`: list scenes, read one scene, cheap
     revision poll, manual refresh.
   - A `chokidar`-free `fs.watch` on the scene directory, so a scene written by
     *anything* (agent, editor, git checkout) also bumps the revision.
2. **Client half** (`client.js`, loaded through `window.__ModuleLoader__.load`)
   - Registers the `Design` tab through `ctx.betterSidebar.registerTab` when
     dsh-better-sidebar is installed (it is, in this profile), and falls back to a
     plain file viewer registration otherwise.
   - Polls `/excalidraw/api/rev` while visible, refetches on change, renders.
3. **Renderer** (`src/renderer.mjs`, shared, pure)
   - Turns Excalidraw scene JSON into a single `<svg>` string: the subset the
     diagram tools actually emit — `rectangle`, `ellipse`, `diamond`, `line`,
     `arrow`, `text`, `frame`, plus bound text and group containers.
   - No `@excalidraw/*` dependency: the viewer is read-only, and a ~400-line
     deterministic renderer is far lighter than the 1.5 MB editor bundle.

## Why these choices

| Choice | Reason |
| --- | --- |
| Render, don't embed the Excalidraw editor | v1 is a *viewer*: correctness, small bundle, no font/asset plumbing. An editor tab is a follow-up. |
| Poll the revision endpoint, not SSE | One 200-byte request per 1.5 s while the tab is visible; no socket lifecycle to get wrong inside someone else's sidebar plugin. |
| Store the scene as a file | Debuggable, diffable, works offline, survives restarts, and lets the renderer be tested from Node without the browser. |
| Scene file under `<cwd>/.dsh/excalidraw/` | Per-workspace, invisible to the file tree's normal work, easy to gitignore. |
| `ctx.betterSidebar` as the primary mount | It is the profile's actual sidebar implementation and its service is explicitly open to third-party plugins. |

## Status

Shipped and reviewed eleven times (three independent reviewers in the last round);
see the three NOTES files and `FIDELITY.md` for the records.

## v1 scope

In: scene store + revision, MCP pull, HTTP API, three tools,
sidebar tab, SVG renderer, fit/zoom, scene switcher, live refresh, error states,
i18n (en/zh), `.excalidraw` file viewer, bundled Excalidraw fonts, on-demand
SVG/PNG export with self-contained files.

Out (documented as known limits): editing in the tab, annotations,
frames-as-slides, roughness/hachure fidelity (solid tint), image elements
(placeholder), Excalifont itself (licence; Virgil is the fallback).

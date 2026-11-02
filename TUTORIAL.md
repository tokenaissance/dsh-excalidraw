# Tutorial: from an agent's diagram to a live sidebar view

1. **Install the plugin** into a profile (this bundle is a normal DSH bundle):

   ```sh
   dsh plugin --profile desktop add <path-to-this-directory>
   ```

   Restart DSH. The plugin registers its host routes and its client half.

2. **No Excalidraw+ account? Import a local scene instead.** Ask the agent to
   `excalidraw_import` a `.excalidraw`/`.json` file from the workspace, or to hand
   it an inline Excalidraw JSON document:

   > "把 docs/flow.excalidraw 导入到 Excalidraw 视图"

   That stores the scene under `.dsh/excalidraw/` and the **Excalidraw** view
   renders it — no token involved. Skip the next step.

3. **Or give it a token (for Excalidraw+ refresh).** The plugin resolves Excalidraw+ MCP credentials in this
   order — the plugin row's `mcpToken` wins, then `EXCALIDRAW_MCP_TOKEN`, then the
   `Authorization` header your profile keeps for the `excalidraw` MCP server:

   ```sh
   export EXCALIDRAW_MCP_TOKEN=…            # easiest for a shell session
   ```

   or set `mcpToken` in the plugin's row (`cordis.patch.yml`), or keep the
   `Authorization: Bearer …` header your profile already has for the
   `excalidraw` MCP server.

4. **Ask your agent to pull a scene.** In a session whose workspace is where you
   want the files:

   > "把这张图刷新到 Excalidraw：https://app.excalidraw.com/s/…/<sceneId>"

   The agent calls `excalidraw_refresh`; the scene lands in
   `<workspace>/.dsh/excalidraw/<slug>.excalidraw` and the **Excalidraw** view opens.

5. **Look at it.** Two ways, depending on what your profile has:

   - a profile with **dsh-better-sidebar**: the **Excalidraw 图 / Excalidraw** tab in the
     right sidebar;
   - a **stock DSH**: an **Excalidraw** view beside Chat and Trajectory (registered
     through DSH's own `conversation.view` slot).

   Both surfaces show the same live scene; the tab/panel follows a new scene
   automatically unless you pin one in its picker.

5. **Export.** The toolbar's **SVG**/**PNG** buttons write a self-contained file
   (the fonts the scene draws with are embedded, plus a licence notice). From an
   agent, `excalidraw_export` writes `<slug>.svg` next to the scene.

6. **Tune it** (all optional, in the plugin's row config):

   | key | default | meaning |
   | --- | --- | --- |
   | `scenesDir` | `.dsh/excalidraw` | where scenes are stored, relative to the session workspace |
   | `autoOpen` | `true` | open/focus the view after a refresh |
   | `pollIntervalMs` | `1500` | how often the view polls `/rev` (500–10000) |
   | `maxSceneBytes` | `4194304` | refuse larger scene documents |
   | `extraFontsDir` | `''` | directory of user-supplied fonts (see `fonts/README.md`) — the legal way to add Excalifont |

7. **Bring Excalidraw's default font (optional).** Excalifont cannot be
   redistributed, but you can supply it yourself: drop the file plus a
   `fonts.json` into a directory and point `extraFontsDir` at it; the view and
   the exports then use it.

If something looks wrong, `GET /excalidraw/api/health` is the first check: it
reports whether a token is configured and which directory the scene store uses.

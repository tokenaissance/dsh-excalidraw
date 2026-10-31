# Notes for agents working on this plugin

- The repository holds one DSH bundle: host half in `index.js` + `lib/`, client
  half in `src/client.mjs` (+ `src/renderer.mjs`, `src/fonts-data.mjs`) bundled
  into `client.js` by `scripts/build-client.mjs`.
- **Never edit `client.js` by hand.** Edit the sources, then
  `node scripts/build-client.mjs`; the build fails if module syntax survives.
- `src/fonts-data.mjs` is generated from `fonts/MANIFEST.json` by
  `node scripts/gen-fonts-data.mjs`; run `--check` in tests. Font binaries are
  base64 chunks (`fonts/*.b64`), decoded by `lib/fonts.js` with a sha256 check.
- The contract is `docs/CONTRACT.md`; fidelity measurements are in
  `docs/FIDELITY.md`; per-half implementation notes are the three `*-NOTES.md`.
- Tests: `npm test` (`gen-fonts-data --check` + `node --test test/`); it does not
  rebuild, so a stale `client.js` fails. Use `npm run build` after editing sources.
  The suite is zero-dependency and must not touch the network, `~/.dsh`, or the
  user's font directory.
- Host routes all sit behind `ctx.connection.requestRejection`; the font routes
  accept only manifest names. Client code must reach services through
  `ctx.get(...)` (a bare `ctx.service` read throws in cordis).
- The client half has two surfaces: the better-sidebar tab (when that plugin is
  present) and DSH's native `conversation.view` slot. Both share `useScene` and
  `SceneCanvas`; do not fork that state machine.
- Keep the renderer pure and deterministic: it is used by the tab, the file
  viewer, the host export tool, and the fidelity comparison.

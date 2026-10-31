/**
 * dsh-excalidraw — host half.
 *
 * A cordis plugin that turns an Excalidraw+ MCP scene into a per-workspace
 * scene store plus the wire surface the Design sidebar tab reads:
 *
 *  - `excalidraw_refresh` / `excalidraw_open` model tools (CONTRACT §4);
 *  - `GET  /excalidraw/api/health`
 *  - `GET  /excalidraw/api/scenes`
 *  - `GET  /excalidraw/api/scene`   (ETag + 304)
 *  - `GET  /excalidraw/api/rev`     (ETag + 304, focus pointer)
 *  - `POST /excalidraw/api/refresh`
 *
 * Everything lives in `lib/`; this file only resolves the config, builds the
 * pieces, and registers them through `ctx.effect` so HMR and disable unregister
 * cleanly.
 *
 * The browser half is `./client.js`, built from `src/client.mjs` +
 * `src/renderer.mjs` by `scripts/build-client.mjs`; the two halves share
 * `docs/CONTRACT.md` and nothing else.
 */

import zImport from '@deepseek-ai/schemastery'

/** DSH's schemastery default export is callable; tolerate a namespace wrapper. */
const z = typeof zImport === 'function' ? zImport : zImport?.default ?? zImport
import { createConfigSchema, resolveConfig } from './lib/config.js'
import { resolveToken } from './lib/token.js'
import { createStore } from './lib/store.js'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createSessionResolver, sceneRootOf } from './lib/session.js'
import { createMcpClient } from './lib/mcp.js'
import { createTools } from './lib/tools.js'
import { findFont, listExtraFonts, readExtraFont, readFont } from './lib/fonts.js'
import { FONT_EXTRA_PATH, FONT_ROUTE_PATH, ROUTE_PATHS, createExtraFontHandler, createFontHandler, createRoutes } from './lib/routes.js'

/** Plugin identity for cordis rows. */
export const name = 'dsh-excalidraw'

/** Services required before mounting: routes, sessions, browser gate, tools. */
export const inject = ['webServer', 'sessions', 'connection', 'tools']

/**
 * The cordis row schema. DSH's own schemastery is required (not the public
 * package): only DSH's build gives the Loader the field shapes it commits, and
 * a bad row must fail at activation rather than at the first refresh
 * (CONTRACT §1).
 */
export const Config = createConfigSchema(z)

/** Bound of the per-workspace store cache (closed LRU-style on overflow). */
const MAX_STORES = 32

/**
 * Mount the host half.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] - the row's config, already validated by the Loader.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const logger = ctx.logger

  // One store per workspace scene directory, created on first use and closed
  // on teardown (or when the cache overflows).
  const stores = new Map()
  const storeFor = (cwd) => {
    const root = sceneRootOf(cwd, resolved.scenesDir)
    const cached = stores.get(root)
    if (cached !== undefined) {
      // Touch: re-insert so eviction is least-recently-used.
      stores.delete(root)
      stores.set(root, cached)
      return cached
    }
    if (stores.size >= MAX_STORES) {
      const oldest = stores.keys().next()
      if (oldest.done !== true) {
        try {
          stores.get(oldest.value)?.close?.()
        } catch {
          // Already closed.
        }
        stores.delete(oldest.value)
      }
    }
    const store = createStore({ root, maxSceneBytes: resolved.maxSceneBytes, logger })
    stores.set(root, store)
    store.start().catch((error) => {
      logger?.warn?.(`dsh-excalidraw: the scene directory watch could not start: ${error instanceof Error ? error.message : String(error)}`)
    })
    return store
  }

  const resolveMcpToken = () => resolveToken({ configToken: resolved.mcpToken })
  /**
   * Best-effort cwd of a session that is no longer live: DSH persists the
   * workspace table (sessionIds -> path) under `$DSH_HOME/storages`. Read-only,
   * cached briefly, and never fatal — a miss just means "no cwd".
   */
  let persistedCache = { at: 0, byId: new Map() }
  async function persistedCwd(sessionId) {
    const now = Date.now()
    if (now - persistedCache.at > 5000) {
      const byId = new Map()
      try {
        const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
        const file = join(home, 'storages', 'workspace.json')
        const table = JSON.parse(await readFile(file, 'utf8'))
        const workspaces = table?.tables?.workspaces ?? {}
        for (const workspace of Object.values(workspaces)) {
          const path = workspace?.path
          if (typeof path !== 'string' || path === '') continue
          for (const id of Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []) {
            if (typeof id === 'string' && id !== '') byId.set(id, path)
          }
        }
      } catch {
        /* no persisted workspace table: nothing to fall back to */
      }
      persistedCache = { at: now, byId }
    }
    return persistedCache.byId.get(sessionId)
  }

  const sessionResolver = createSessionResolver({
    getSession: (sessionId) => ctx.sessions.get(sessionId),
    getWorkingDirectory: () => ctx.get('workingDirectory'),
    // The real host exposes `sessions.list()` returning `Session[]`; an older
    // snapshot shape exposed `{ byId }`. Both are supported (P2-2).
    listSessions: () => {
      const list = ctx.sessions?.list
      if (typeof list === 'function') return list.call(ctx.sessions)
      return list?.getSnapshot?.()
    },
  })

  const tools = createTools({
    config: resolved,
    resolveSession: sessionResolver.resolve,
    resolveToken: resolveMcpToken,
    storeFor,
    mcpFactory: createMcpClient,
    logger,
  })
  /** URL without credentials or query, for logs and health. */
  const redactUrl = (value) => {
    try {
      const parsed = new URL(String(value))
      parsed.username = ''
      parsed.password = ''
      parsed.search = ''
      parsed.hash = ''
      return parsed.toString()
    } catch {
      return ''
    }
  }
  const routes = createRoutes({
    config: resolved,
    connection: ctx.connection,
    resolveSession: sessionResolver.resolve,
    resolveToken: resolveMcpToken,
    refresh: tools.refresh,
    storeFor,
    // Every mounted workspace's focus pointer, so auto-open is not limited to
    // whichever workspace this host resolved last.
    listExtraFonts,
    listFocuses: async () => {
      const found = []
      for (const store of stores.values()) {
        try {
          const snapshot = await store.snapshot()
          if (snapshot?.focus !== undefined && snapshot.focus !== null) found.push(snapshot.focus)
        } catch {
          // A store that cannot answer simply contributes nothing.
        }
      }
      return found
    },
    logger,
  })

  // ── HTTP API (CONTRACT §3) ─────────────────────────────────────────────
  // Shipped Excalidraw web fonts are served from the package itself (no CDN,
  // no third-party requests at render time); the client adds the @font-face
  // rules that point here.
  /**
   * Register one route, tolerating an already-mounted path: an aggregating
   * bundle that mounts this plugin twice must log a warning, not fail the web
   * boot (a duplicate prefix throws inside the web server).
   */
  const registerRoute = (route, label) => ctx.effect(
    () => {
      try {
        return ctx.webServer.register(route)
      } catch (error) {
        logger?.warn?.(`dsh-excalidraw: ${label} is already mounted (${error?.message ?? error}); keeping the existing one`)
        return () => {}
      }
    },
    `dsh-excalidraw: ${label}`,
  )

  const fontHandler = createFontHandler({ findFont, readFont, connection: ctx.connection, logger })
  registerRoute({ kind: 'prefix', path: FONT_ROUTE_PATH, handler: fontHandler }, 'font route')
  // User-supplied fonts (config.extraFontsDir): the legal way to bring a face the
  // plugin cannot redistribute, e.g. Excalifont.
  if (resolved.extraFontsDir !== '') {
    const extraHandler = createExtraFontHandler({
      dir: resolved.extraFontsDir,
      listExtraFonts,
      readExtraFont,
      connection: ctx.connection,
      logger,
    })
    registerRoute({ kind: 'prefix', path: FONT_EXTRA_PATH, handler: extraHandler }, 'extra font route')
  }

  const routeHandlers = {
    [ROUTE_PATHS.health]: routes.health,
    [ROUTE_PATHS.focus]: routes.focus,
    [ROUTE_PATHS.fonts]: routes.fonts,
    [ROUTE_PATHS.scenes]: routes.scenes,
    [ROUTE_PATHS.scene]: routes.scene,
    [ROUTE_PATHS.rev]: routes.rev,
    [ROUTE_PATHS.refresh]: routes.refresh,
  }
  for (const [path, handler] of Object.entries(routeHandlers)) {
    registerRoute({ kind: 'exact', path, handler }, `route ${path}`)
  }

  // ── Model tools (CONTRACT §4) ──────────────────────────────────────────
  for (const definition of tools.definitions) {
    ctx.effect(
      () => ctx.tools.register(definition),
      `dsh-excalidraw: tool ${definition.name}`,
    )
  }

  // ── Teardown ───────────────────────────────────────────────────────────
  ctx.effect(
    () => () => {
      for (const store of stores.values()) {
        try {
          store.close()
        } catch {
          // Nothing left to release.
        }
      }
      stores.clear()
    },
    'dsh-excalidraw: scene stores',
  )

  logger?.info?.(
    'dsh-excalidraw: host half mounted (scenes %s, MCP endpoint %s)',
    resolved.scenesDir,
    redactUrl(resolved.mcpUrl),
  )
}


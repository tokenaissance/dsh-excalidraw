/**
 * The two model-facing tools (CONTRACT §4) and the refresh operation the HTTP
 * `/refresh` route shares with `excalidraw_refresh`.
 *
 * Conventions followed here (the plugin-development guide's C1/C4/C6/C10, as
 * dsh-better-sidebar's tools do):
 *  - parameters are validated before `execute`;
 *  - `execute` returns ONE canonical JSON value, `render` is a separate pure
 *    text projection;
 *  - the abort signal reaches the MCP fetch and is re-checked before every
 *    write; a cancelled call rejects with `AbortError` instead of a result;
 *  - the canonical value carries no UI/transport vocabulary.
 *
 * A tool never throws: failures come back as `{ ok: false, error, message }`.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderScene } from '../src/renderer.mjs'
import { fontStackOf } from '../src/renderer.mjs'
import { exportFonts, fontNotice, injectIntoRoot, listExtraFonts, readExtraFont, withStyle } from './fonts.js'

/**
 * Deterministic overhead an embedded font sheet may add to an exported SVG.
 * Two copies of the largest family (Virgil, 56 KB) plus base64 inflation fit
 * comfortably; it is a bound, not a target.
 */
const FONT_EMBED_ALLOWANCE = 256 * 1024
import { createMcpClient, extractToolPayload } from './mcp.js'
import { DEFAULT_SLUG, normalizeSlug, slugify } from './store.js'
import { sceneFileRef } from './session.js'

/** Every error code the tools may report (CONTRACT §3's closed set). */
const ERROR_CODES = new Set([
  'no-session',
  'no-scene',
  'bad-request',
  'mcp-unconfigured',
  'mcp-error',
  'scene-too-large',
  'internal',
])

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function isAbort(error) {
  return error !== null && typeof error === 'object' && (error.name === 'AbortError' || error.code === 'ABORT_ERR')
}

function errorCodeOf(error) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined
  return typeof code === 'string' && ERROR_CODES.has(code) ? code : 'internal'
}

function textOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function redact(message, token) {
  const text = String(message)
  return token === '' ? text : text.split(token).join('<redacted>')
}

/** One normalized failure value (the canonical shape of both tools). */
function failure(code, message) {
  return { ok: false, error: code, message }
}

const ELEMENT_PROP = { type: 'number', description: 'Number of Excalidraw elements in the stored scene.' }
const REFRESH_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: 'Whether the scene was pulled and stored.' },
    slug: { type: 'string', description: 'Slug of the stored scene (its file name under the scene directory).' },
    file: { type: 'string', description: 'Scene document path, relative to the session working directory when it lives inside it.' },
    sceneId: { type: 'string', description: 'Excalidraw+ scene id the document was pulled from.' },
    elements: ELEMENT_PROP,
    revision: { type: 'number', description: 'Store revision the client polls for.' },
    opened: { type: 'boolean', description: 'Whether the host requested that the Design sidebar tab open.' },
    error: { type: 'string', description: 'Machine-readable failure code when ok is false.' },
    message: { type: 'string', description: 'Human-readable failure detail when ok is false.' },
  },
}
const IMPORT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: 'Whether the scene was imported and stored.' },
    slug: { type: 'string', description: 'Slug of the stored scene (its file name under the scene directory).' },
    file: { type: 'string', description: 'Scene document path, relative to the session working directory when it lives inside it.' },
    elements: ELEMENT_PROP,
    revision: { type: 'number', description: 'Store revision the client polls for.' },
    opened: { type: 'boolean', description: 'Whether the host requested that the Excalidraw view open.' },
    error: { type: 'string', description: 'Machine-readable failure code when ok is false.' },
    message: { type: 'string', description: 'Human-readable failure detail when ok is false.' },
  },
}

const OPEN_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: 'Whether the open was requested.' },
    slug: { type: 'string', description: 'Slug of the scene the tab was asked to show.' },
    file: { type: 'string', description: 'Scene document path of that slug.' },
    revision: { type: 'number', description: 'Store revision carrying the focus pointer.' },
    opened: { type: 'boolean', description: 'Whether the host requested that the Design sidebar tab open.' },
    error: { type: 'string', description: 'Machine-readable failure code when ok is false.' },
    message: { type: 'string', description: 'Human-readable failure detail when ok is false.' },
  },
}

const EXPORT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: 'Whether the scene was exported.' },
    slug: { type: 'string', description: 'Slug of the exported scene.' },
    file: { type: 'string', description: 'Path of the written file, relative to the workspace.' },
    format: { type: 'string', description: 'The written format (svg in this release).' },
    bytes: { type: 'number', description: 'Size of the written file in bytes.' },
    elements: { type: 'number', description: 'How many scene elements the export drew.' },
    error: { type: 'string', description: 'Machine-readable failure code when ok is false.' },
    message: { type: 'string', description: 'Human-readable failure detail when ok is false.' },
  },
}

/** Pure text projection of one tool value (the canonical value is structured). */
/**
 * The self-contained export: the fonts the scene draws with, plus a notice that
 * names exactly the families that were embedded.
 */
function withExcalidrawFonts(svg, { css, families }) {
  const styled = withStyle(svg, css)
  const notice = fontNotice(families)
  if (notice === '') return styled
  return injectIntoRoot(styled, `<metadata>${notice.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</metadata>`)
}

/**
 * Resolve an imported scene path inside the session workspace.
 *
 * The tool reads a user file, so it stays inside the workspace the session owns
 * (absolute paths are accepted only when they resolve there) and only for the
 * Excalidraw document extensions. Returns the absolute path.
 */
function resolveScenePath(cwd, value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return { error: 'bad-request', message: 'the path is empty' }
  const target = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)
  const root = resolve(cwd)
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    return { error: 'bad-request', message: 'the scene file must live inside this session\'s workspace' }
  }
  if (!/\.(excalidraw|json)$/i.test(target)) {
    return { error: 'bad-request', message: 'the scene file must end in .excalidraw or .json' }
  }
  return { path: target }
}

/** Parse one imported document (object or JSON text); `elements` is required. */
function parseSceneDocument(raw) {
  if (raw === null || raw === undefined) return { error: 'bad-request', message: 'the scene document is empty' }
  let document = raw
  if (typeof raw === 'string') {
    try {
      document = JSON.parse(raw)
    } catch {
      return { error: 'bad-request', message: 'the scene document is not valid JSON' }
    }
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return { error: 'bad-request', message: 'the scene document must be a JSON object' }
  }
  if (!Array.isArray(document.elements)) {
    return { error: 'bad-request', message: 'the scene document must carry an elements array' }
  }
  return { document }
}

/** The newest stored scene by `updatedAt` (an index rebuild can reorder entries). */
function newestScene(scenes) {
  let newest = scenes[0]
  for (const entry of scenes) {
    if (Number(entry?.updatedAt ?? 0) > Number(newest?.updatedAt ?? 0)) newest = entry
  }
  return newest
}

function textRender(pick) {
  return (_args, value) => [{ type: 'text', text: pick(value ?? {}) }]
}

/**
 * Build the refresh/open operations shared by the tools and the HTTP routes.
 *
 * @param {object} deps
 * @param {ReturnType<import('./config.js').resolveConfig>} deps.config
 * @param {(sessionId?: string) => Promise<{sessionId: string, cwd: string}>} deps.resolveSession
 * @param {() => Promise<{token: string, source: string}>} deps.resolveToken
 * @param {(cwd: string) => object} deps.storeFor
 * @param {typeof createMcpClient} [deps.mcpFactory]
 * @param {{warn?: Function}} [deps.logger]
 * @returns {{ refresh: Function, open: Function }}
 */
export function createSceneService(deps) {
  const { config, resolveSession, resolveToken, storeFor, mcpFactory = createMcpClient, logger } = deps

  /**
   * Pull one scene from the configured MCP server into the caller's store.
   *
   * @param {{ sessionId?: unknown, sceneId?: unknown, slug?: unknown, name?: unknown }} input
   * @returns {Promise<object>} the canonical tool result.
   */
  async function refresh(input = {}) {
    const signal = input.signal
    let token = ''
    try {
      signal?.throwIfAborted?.()
      const target = await resolveSession(input.sessionId)
      const store = storeFor(target.cwd)
      const resolvedToken = await resolveToken()
      token = resolvedToken.token
      if (token === '') {
        return failure(
          'mcp-unconfigured',
          'no Excalidraw+ MCP token is configured: set the dsh-excalidraw row\'s mcpToken, export EXCALIDRAW_MCP_TOKEN, or add an Authorization: Bearer header to the profile\'s mcp-excalidraw row',
        )
      }

      const listed = await store.listScenes().catch(() => ({ revision: 0, scenes: [] }))
      const requestedSceneId = textOf(input.sceneId)
      const requestedSlug = textOf(input.slug)
      const bySlug = requestedSlug === null
        ? undefined
        : listed.scenes.find((candidate) => candidate.slug === normalizeSlug(requestedSlug, DEFAULT_SLUG))
      // The scene id must belong to the scene that will be written: reusing the
      // last entry's id while writing another slug overwrote that file with a
      // different scene (review round 5, P0).
      const existing = requestedSceneId !== null
        ? listed.scenes.find((candidate) => candidate.sceneId === requestedSceneId)
        : (bySlug ?? newestScene(listed.scenes))
      const owner = listed.scenes.find((candidate) => candidate.sceneId === requestedSceneId)
      if (requestedSceneId !== null && owner !== undefined && bySlug !== undefined && owner.slug !== bySlug.slug) {
        // The id belongs to another stored scene: refuse rather than write that
        // scene into this slug (the round-5 data-loss shape). Re-pointing the
        // SAME slug to a new scene id is allowed — that is an agent's intent.
        return failure(
          'bad-request',
          `scene id "${requestedSceneId}" belongs to "${owner.slug}", not to "${bySlug.slug}"`,
        )
      }
      const sceneId = requestedSceneId ?? existing?.sceneId ?? null

      if (sceneId === null) {
        return failure(
          'no-scene',
          'no Excalidraw scene id is known for this workspace yet: pass sceneId (the id in the scene URL) once, or have the agent call excalidraw_refresh with a sceneId before using the sidebar Refresh button',
        )
      }

      let payload
      let client
      try {
        client = await mcpFactory({ url: config.mcpUrl, token, signal })
        const result = await client.callTool('get_scene_content', { sceneId })
        payload = extractToolPayload(result)
      } finally {
        try {
          await client?.close?.()
        } catch {
          // Closing is best-effort; the request already settled.
        }
      }
      if (payload === undefined || payload === null) {
        return failure('mcp-error', 'the MCP server returned no scene document (get_scene_content)')
      }
      if (!Array.isArray(payload.elements)) {
        return failure('mcp-error', 'the MCP server returned a scene without an elements array')
      }

      const name = textOf(input.name) ?? existing?.name ?? 'Architecture'
      const slug = requestedSlug !== null
        ? normalizeSlug(requestedSlug, DEFAULT_SLUG)
        : (existing?.slug ?? slugify(name))
      // A cancellation between the fetch and the write must not touch disk.
      signal?.throwIfAborted?.()
      const written = await store.writeScene({
        slug,
        name,
        sceneId,
        document: payload,
        source: 'excalidraw-mcp',
        tool: 'get_scene_content',
      }, { signal })
      let opened = false
      if (config.autoOpen) {
        // The focus pointer is the auto-open handshake (CONTRACT §2). Failing
        // to record it must not discard a pull that already succeeded.
        try {
          signal?.throwIfAborted?.()
          await store.markFocus({ sessionId: target.sessionId, at: written.revision }, { signal })
          opened = true
        } catch (error) {
          if (isAbort(error)) throw error
          logger?.warn?.(`dsh-excalidraw: could not record the auto-open focus pointer: ${redact(messageOf(error), token)}`)
        }
      }
      const value = {
        ok: true,
        slug: written.slug,
        file: sceneFileRef(target.cwd, config.scenesDir, written.file),
        elements: written.elements,
        revision: written.revision,
        opened,
      }
      // The declared output schema types `sceneId` as a string: omit it rather
      // than send `null` when the server did not name the scene.
      if (written.sceneId !== null && written.sceneId !== undefined) value.sceneId = written.sceneId
      return value
    } catch (error) {
      // A cancelled call is not a tool failure: report it as the abort it is.
      if (isAbort(error)) throw error
      const code = errorCodeOf(error)
      const message = redact(messageOf(error), token)
      if (code === 'internal') logger?.warn?.(`dsh-excalidraw: excalidraw_refresh failed: ${message}`)
      return failure(code, message)
    }
  }

  /**
   * Import a scene that already exists locally, with no Excalidraw+ account and
   * no MCP token: either a `.excalidraw` / `.json` file inside the workspace, or
   * an Excalidraw document the agent built itself. The stored scene behaves
   * exactly like a refreshed one (index entry, revision, focus pointer).
   *
   * @param {{ sessionId?: unknown, path?: unknown, scene?: unknown, slug?: unknown, name?: unknown }} input
   * @returns {Promise<object>} the canonical tool result.
   */
  async function importScene(input = {}) {
    const signal = input.signal
    try {
      signal?.throwIfAborted?.()
      const target = await resolveSession(input.sessionId)
      const store = storeFor(target.cwd)
      const requestedPath = textOf(input.path)
      const hasScene = input.scene !== undefined && input.scene !== null
      if ((requestedPath === null) === (!hasScene)) {
        return failure('bad-request', 'pass exactly one of `path` (a local .excalidraw/.json file inside the workspace) or `scene` (an Excalidraw JSON document)')
      }

      let document
      let localName = null
      if (requestedPath !== null) {
        const resolvedPath = resolveScenePath(target.cwd, requestedPath)
        if (resolvedPath.error !== undefined) return failure(resolvedPath.error, resolvedPath.message)
        const info = await stat(resolvedPath.path).catch(() => null)
        if (info === null || !info.isFile()) {
          return failure('bad-request', `no scene file at "${requestedPath}"`)
        }
        if (info.size > config.maxSceneBytes) {
          return failure('scene-too-large', `the scene file is ${info.size} bytes, above the ${config.maxSceneBytes}-byte limit`)
        }
        const text = await readFile(resolvedPath.path, 'utf8').catch(() => null)
        if (text === null) return failure('bad-request', `the scene file "${requestedPath}" could not be read`)
        const parsed = parseSceneDocument(text)
        if (parsed.error !== undefined) return failure(parsed.error, parsed.message)
        document = parsed.document
        const base = basename(resolvedPath.path)
        localName = base.replace(/\.(excalidraw|json)$/i, '').replace(/\.excalidraw$/i, '') || null
      } else {
        const parsed = parseSceneDocument(input.scene)
        if (parsed.error !== undefined) return failure(parsed.error, parsed.message)
        document = parsed.document
      }

      const name = textOf(input.name) ?? localName ?? 'Architecture'
      const slug = textOf(input.slug) !== null
        ? normalizeSlug(textOf(input.slug), DEFAULT_SLUG)
        : slugify(name)
      signal?.throwIfAborted?.()
      const written = await store.writeScene({
        slug,
        name,
        sceneId: typeof document.sceneId === 'string' && document.sceneId !== '' ? document.sceneId : null,
        document,
        source: 'local-import',
        tool: 'excalidraw_import',
      }, { signal })
      let opened = false
      if (config.autoOpen) {
        try {
          signal?.throwIfAborted?.()
          await store.markFocus({ sessionId: target.sessionId, at: written.revision }, { signal })
          opened = true
        } catch (error) {
          if (isAbort(error)) throw error
          logger?.warn?.(`dsh-excalidraw: could not record the auto-open focus pointer: ${messageOf(error)}`)
        }
      }
      const value = {
        ok: true,
        slug: written.slug,
        file: sceneFileRef(target.cwd, config.scenesDir, written.file),
        elements: written.elements,
        revision: written.revision,
        opened,
      }
      return value
    } catch (error) {
      if (isAbort(error)) throw error
      const code = errorCodeOf(error)
      const message = messageOf(error)
      if (code === 'internal') logger?.warn?.(`dsh-excalidraw: excalidraw_import failed: ${message}`)
      return failure(code, message)
    }
  }

  /**
   * Ask the Design sidebar tab to open/focus one stored scene. The host half
   * only records the durable focus pointer (CONTRACT §2); the client half
   * performs the actual `openTab`.
   *
   * @param {{ sessionId?: unknown, slug?: unknown }} input
   * @returns {Promise<object>} the canonical tool result.
   */
  async function open(input = {}) {
    const signal = input.signal
    try {
      signal?.throwIfAborted?.()
      const target = await resolveSession(input.sessionId)
      const store = storeFor(target.cwd)
      const listed = await store.listScenes()
      if (listed.scenes.length === 0) {
        return failure('no-scene', 'no scene is stored for this workspace yet; pull one with excalidraw_refresh first')
      }
      const requestedSlug = textOf(input.slug)
      const entry = requestedSlug === null
        ? newestScene(listed.scenes)
        : listed.scenes.find((candidate) => candidate.slug === normalizeSlug(requestedSlug, DEFAULT_SLUG))
      if (entry === undefined) return failure('no-scene', `no scene "${requestedSlug}" is stored for this workspace`)
      // A fresh revision makes every open observable to a client that
      // deduplicates focus pointers by `at`.
      const revision = await store.bump(undefined, { signal })
      signal?.throwIfAborted?.()
      await store.markFocus({ sessionId: target.sessionId, at: revision }, { signal })
      return {
        ok: true,
        slug: entry.slug,
        file: sceneFileRef(target.cwd, config.scenesDir, entry.file),
        revision,
        opened: true,
      }
    } catch (error) {
      if (isAbort(error)) throw error
      const message = messageOf(error)
      if (errorCodeOf(error) === 'internal') logger?.warn?.(`dsh-excalidraw: excalidraw_open failed: ${message}`)
      return failure(errorCodeOf(error), message)
    }
  }

  /**
   * Render one stored scene to SVG and write it next to the scene documents.
   * PNG stays a browser action (the tab's PNG button rasterises the SVG with the
   * browser's own codecs); the host ships no rasteriser.
   *
   * @param {{ sessionId?: unknown, slug?: unknown, format?: unknown, signal?: AbortSignal }} input
   * @returns {Promise<object>} the canonical tool result.
   */
  async function exportScene(input = {}) {
    const signal = input.signal
    try {
      signal?.throwIfAborted?.()
      const format = textOf(input.format) ?? 'svg'
      if (format !== 'svg') {
        return failure('bad-request', `unsupported export format "${format}": only svg is exported on the host, PNG comes from the Design tab`)
      }
      const target = await resolveSession(input.sessionId)
      const store = storeFor(target.cwd)
      const listed = await store.listScenes()
      if (listed.scenes.length === 0) {
        return failure('no-scene', 'no scene is stored for this workspace yet; pull one with excalidraw_refresh first')
      }
      const requestedSlug = textOf(input.slug)
      const entry = requestedSlug === null
        ? newestScene(listed.scenes)
        : listed.scenes.find((candidate) => candidate.slug === normalizeSlug(requestedSlug, DEFAULT_SLUG))
      if (entry === undefined) return failure('no-scene', `no scene "${requestedSlug}" is stored for this workspace`)

      const stored = await store.readScene(entry.slug)
      let document
      try {
        document = JSON.parse(stored.text)
      } catch {
        return failure('bad-request', `the stored scene "${entry.slug}" is not valid JSON`)
      }
      const elements = Array.isArray(document) ? document : document?.elements
      if (!Array.isArray(elements)) {
        return failure('bad-request', `the stored scene "${entry.slug}" has no elements array`)
      }
      signal?.throwIfAborted?.()
      const rendered = renderScene(elements, { padding: 24, background: false, files: document.files })
      if (typeof rendered.svg !== 'string' || rendered.svg === '') {
        return failure('internal', 'the renderer produced no SVG for this scene')
      }
      // The written file is a document of its own: embed the fonts the scene
      // uses, or a committed SVG opens with fallback glyphs (round 10).
      // User-supplied fonts join the export when the scene's stacks name them.
      let extraFonts = []
      if (config.extraFontsDir !== '') {
        try {
          const names = new Set()
          for (const element of elements) {
            if (element?.isDeleted === true) continue
            if (element?.type !== 'text' && element?.type !== 'frame') continue
            for (const name of fontStackOf(element.fontFamily ?? 5).split(',')) {
              const clean = name.trim().replace(/^['"]|['"]$/g, '')
              if (clean !== '') names.add(clean)
            }
          }
          const listed = await listExtraFonts(config.extraFontsDir)
          for (const font of listed.fonts) {
            // Reading every file in a user font directory per export was wasteful
            // and touched unrelated files (round 18).
            if (!names.has(font.family)) continue
            extraFonts.push({ ...font, bytes: await readExtraFont(config.extraFontsDir, font.file) })
          }
        } catch {
          extraFonts = []
        }
      }
      const exported = withExcalidrawFonts(rendered.svg, await exportFonts(elements, { extraFonts }))
      const written = await store.writeExport(entry.slug, exported, { allowance: FONT_EMBED_ALLOWANCE })
      return {
        ok: true,
        slug: entry.slug,
        file: sceneFileRef(target.cwd, config.scenesDir, written.file),
        format: 'svg',
        bytes: written.bytes,
        elements: rendered.rendered,
      }
    } catch (error) {
      if (isAbort(error)) throw error
      const message = messageOf(error)
      if (errorCodeOf(error) === 'internal') logger?.warn?.(`dsh-excalidraw: excalidraw_export failed: ${message}`)
      return failure(errorCodeOf(error), message)
    }
  }

  return { refresh, open, importScene, exportScene }
}

/**
 * Build the tool definitions registered on `ctx.tools`.
 *
 * @param {object} deps - see {@link createSceneService}.
 * @returns {{ refresh: Function, open: Function, definitions: object[] }}
 */
export function createTools(deps) {
  const service = createSceneService(deps)

  const refresh = defineTool({
    name: 'excalidraw_refresh',
    description:
      'Pull an Excalidraw+ scene from the configured Excalidraw MCP server into this conversation\'s workspace and show it in the '
      + 'Design sidebar tab. The scene document is stored under the workspace scene directory (`.dsh/excalidraw` by default) and the '
      + 'tab re-renders itself. Use this when the user asks to "refresh" or "show" an Excalidraw diagram. '
      + 'With no arguments the most recently stored scene (or the MCP server\'s default scene) is re-pulled; pass `sceneId` to pull a '
      + 'specific Excalidraw+ scene, and `name`/`slug` to control the stored file name. '
      + 'Returns the stored slug, file path, element count and store revision.',
    parameters: {
      sceneId: {
        type: 'string',
        description: 'Optional Excalidraw+ scene id. Omitted: re-pull the last stored scene, or the MCP server default.',
      },
      name: {
        type: 'string',
        description: 'Optional display name for the scene; it becomes the slug (lowercase, dashes) unless `slug` is given.',
      },
      slug: {
        type: 'string',
        description: 'Optional explicit slug (lowercase letters, digits and dashes; max 64). Wins over `name`.',
      },
    },
    output: {
      schema: REFRESH_OUTPUT,
      render: textRender((value) => {
        if (value.ok === true) {
          return `Refreshed the Excalidraw scene "${value.slug}": ${value.elements} elements in ${value.file} (revision ${value.revision})${value.opened === true ? '; the Design tab was asked to open' : ''}.`
        }
        return `Could not refresh the Excalidraw scene (${value.error ?? 'internal'}): ${value.message ?? 'unknown error'}`
      }),
    },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      return service.refresh({
        sessionId: exec?.agent?.session?.id,
        sceneId: args?.sceneId,
        slug: args?.slug,
        name: args?.name,
        signal: exec?.signal,
      })
    },
  })

  const open = defineTool({
    name: 'excalidraw_open',
    description:
      'Open (or focus) the Design sidebar tab showing an already-stored Excalidraw scene in this conversation\'s sidebar. '
      + 'This does not fetch anything from Excalidraw+: use `excalidraw_refresh` to pull a scene. With no arguments the most '
      + 'recently stored scene is shown.',
    parameters: {
      slug: {
        type: 'string',
        description: 'Optional slug of the stored scene to show (for example "architecture"). Defaults to the newest scene.',
      },
    },
    output: {
      schema: OPEN_OUTPUT,
      render: textRender((value) =>
        value.ok === true
          ? `Asked the Design tab to show the Excalidraw scene "${value.slug}" (revision ${value.revision}).`
          : `Could not open the Excalidraw scene (${value.error ?? 'internal'}): ${value.message ?? 'unknown error'}`,
      ),
    },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      return service.open({ sessionId: exec?.agent?.session?.id, slug: args?.slug, signal: exec?.signal })
    },
  })

  const importTool = defineTool({
    name: 'excalidraw_import',
    description:
      'Import an Excalidraw scene that already exists locally and show it in the Excalidraw view. This needs no Excalidraw+ '
      + 'account and no MCP token: pass `path` (a `.excalidraw` or `.json` file inside this conversation\'s workspace) or `scene` '
      + '(an Excalidraw JSON document you built, e.g. `{ "type": "excalidraw", "elements": [...] }`). The document is stored under '
      + 'the workspace scene directory (`.dsh/excalidraw` by default) and the view re-renders itself. Use this when the user has a '
      + 'local scene file or wants a diagram without pulling one from Excalidraw+; use `excalidraw_refresh` to pull from Excalidraw+. '
      + 'With `path`, the file must resolve inside the workspace.',
    parameters: {
      path: {
        type: 'string',
        description: 'Optional path of a local `.excalidraw` / `.json` file, relative to the workspace (or absolute inside it).',
      },
      scene: {
        type: 'object',
        description: 'Optional Excalidraw JSON document (an object with an `elements` array), for a scene you build inline.',
      },
      name: {
        type: 'string',
        description: 'Optional display name for the stored scene; it becomes the slug unless `slug` is given.',
      },
      slug: {
        type: 'string',
        description: 'Optional explicit slug (lowercase letters, digits and dashes; max 64). Wins over `name`.',
      },
    },
    output: {
      schema: IMPORT_OUTPUT,
      render: textRender((value) => {
        if (value.ok === true) {
          return `Imported the Excalidraw scene "${value.slug}": ${value.elements} elements in ${value.file} (revision ${value.revision})${value.opened === true ? '; the Excalidraw view was asked to open' : ''}.`
        }
        return `Could not import the Excalidraw scene (${value.error ?? 'internal'}): ${value.message ?? 'unknown error'}`
      }),
    },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      return service.importScene({
        sessionId: exec?.agent?.session?.id,
        path: args?.path,
        scene: args?.scene,
        slug: args?.slug,
        name: args?.name,
        signal: exec?.signal,
      })
    },
  })

  const exportTool = defineTool({
    name: 'excalidraw_export',
    description:
      'Render one stored Excalidraw scene to SVG and write it next to the scene documents in the workspace '
      + '(`<scenesDir>/<slug>.svg`). Use it when the user asks for a file they can open, embed or commit; the '
      + 'Design tab\'s PNG button rasterises the same SVG in the browser. With no arguments the newest stored scene is exported.',
    parameters: {
      slug: { type: 'string', description: 'Optional slug of the stored scene to export; defaults to the newest one.' },
      format: { type: 'string', description: 'Export format. Only "svg" is supported on the host; omit it for the default.' },
    },
    output: {
      schema: EXPORT_OUTPUT,
      render: textRender((value) => {
        if (value.ok === true) {
          return `Exported the Excalidraw scene "${value.slug}" as ${value.format}: ${value.bytes} bytes in ${value.file} (${value.elements} elements).`
        }
        return `Could not export the Excalidraw scene (${value.error ?? 'internal'}): ${value.message ?? 'unknown error'}`
      }),
    },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      return service.exportScene({
        sessionId: exec?.agent?.session?.id,
        slug: args?.slug,
        format: args?.format,
        signal: exec?.signal,
      })
    },
  })

  return { ...service, definitions: [refresh, importTool, open, exportTool] }
}


/**
 * The host HTTP API (CONTRACT §3): five exact routes mounted under
 * `/excalidraw/api`.
 *
 * Every response is JSON with `cache-control: no-store` (scene bodies are the
 * stored bytes with a JSON content type), every handler is try/catch-ed, and a
 * failure is always the contract's `{ error, message }` envelope — never an
 * HTML stack trace and never a file path we were not asked for.
 */

import { DEFAULT_SLUG, normalizeSlug, revisionEtag } from './store.js'
import { SessionError } from './session.js'

/** The five registered paths (the client half keys off these). */
export const ROUTE_PATHS = Object.freeze({
  health: '/excalidraw/api/health',
  scenes: '/excalidraw/api/scenes',
  scene: '/excalidraw/api/scene',
  rev: '/excalidraw/api/rev',
  refresh: '/excalidraw/api/refresh',
  focus: '/excalidraw/api/focus',
  fonts: '/excalidraw/api/fonts',
})

/** The prefix the shipped font files are served under (CONTRACT §6). */
export const FONT_ROUTE_PREFIX = '/excalidraw/fonts/'
/** The same prefix in the form `webServer.register({ kind: 'prefix' })` wants. */
export const FONT_ROUTE_PATH = '/excalidraw/fonts'
/** User-supplied fonts (config.extraFontsDir), served under their own prefix. */
export const FONT_EXTRA_PREFIX = '/excalidraw/fonts-extra/'
export const FONT_EXTRA_PATH = '/excalidraw/fonts-extra'

/**
 * Serve one shipped web font (CONTRACT §6). Only exact manifest names are
 * accepted, so the path can never reach another file in the package.
 *
 * @param {{ findFont: Function, readFont: Function, connection?: object, logger?: object }} deps
 */
export function createFontHandler({ findFont, readFont, connection, logger }) {
  const trusted = (request) => {
    try {
      return connection?.requestRejection?.(request) === undefined
    } catch {
      return false
    }
  }
  return async function fontHandler(request, response) {
    if (!trusted(request)) {
      writeJson(response, 403, { error: 'forbidden', message: 'untrusted caller' }, { 'cache-control': 'no-store' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    let name
    try {
      name = decodeURIComponent(url.pathname.slice(FONT_ROUTE_PREFIX.length))
    } catch {
      // A malformed escape (`%zz`) is not a font name: answer 404, never throw.
      writeJson(response, 404, { error: 'no-font', message: 'no such font' })
      return
    }
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      // Also stops NUL bytes, slashes and control characters before any fs call.
      writeJson(response, 404, { error: 'no-font', message: 'no such font' })
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      writeJson(response, 405, { error: 'bad-request', message: 'method not allowed: use GET' })
      return
    }
    const font = await Promise.resolve(findFont(name)).catch(() => undefined)
    if (font === undefined) {
      writeJson(response, 404, { error: 'no-font', message: 'no such font' })
      return
    }
    let bytes
    try {
      bytes = await readFont(name)
    } catch (error) {
      logger?.warn?.(`dsh-excalidraw: could not serve font "${name}": ${error?.message ?? error}`)
      writeJson(response, 500, { error: 'internal', message: 'internal error' })
      return
    }
    response.writeHead(200, {
      'content-type': 'font/woff2',
      'content-length': String(bytes.length),
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    })
    if (request.method === 'HEAD') response.end()
    else response.end(bytes)
  }
}


/** CONTRACT §3: code → HTTP status. */
const ERROR_STATUS = Object.freeze({
  'no-session': 400,
  'no-scene': 400,
  'bad-request': 400,
  'mcp-unconfigured': 400,
  'mcp-error': 502,
  'scene-too-large': 413,
  internal: 500,
  forbidden: 403,
})

/** Body bound of one JSON request. */
const MAX_BODY_BYTES = 1 << 20

/** A request-level refusal (as opposed to a store/MCP one). */
export class ApiError extends Error {
  /**
   * @param {'bad-request' | 'internal' | 'forbidden'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

function messageOf(error) {
  // Errors and plain `{ message }` records (the refresh operation returns the
  // latter) both carry a usable detail.
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

/**
 * Map any thrown value to `{ status, code, message }` (CONTRACT §3). An
 * internal failure's raw message is logged, not returned.
 */
export function errorResponse(error) {
  const rawCode = error !== null && typeof error === 'object' ? error.code : undefined
  const code = typeof rawCode === 'string' && ERROR_STATUS[rawCode] !== undefined ? rawCode : 'internal'
  return {
    status: ERROR_STATUS[code],
    code,
    message: code === 'internal' ? 'internal error' : messageOf(error),
  }
}

function writeJson(response, status, body, headers = {}) {
  if (response.headersSent === true) {
    response.destroy?.()
    return
  }
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(JSON.stringify(body))
}

function writeNotModified(response, headers = {}) {
  if (response.headersSent === true) {
    response.destroy?.()
    return
  }
  response.writeHead(304, { 'cache-control': 'no-store', ...headers })
  response.end()
}

function writeFailure(response, error, logger) {
  const { status, code, message } = errorResponse(error)
  if (code === 'internal' && error instanceof Error) {
    logger?.warn?.(`dsh-excalidraw: /excalidraw/api request failed: ${message}`)
  }
  writeJson(response, status, { error: code, message })
}

function urlOf(request) {
  try {
    return new URL(request.url ?? '/', 'http://dsh.internal')
  } catch {
    return new URL('/', 'http://dsh.internal')
  }
}

function queryValue(url, key) {
  const value = url.searchParams.get(key)
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The conversation id of one request. The contract spells the parameter
 * `session`; the client half sends `sessionId`. Both are accepted, with
 * `sessionId` first so a client that sends both wins on its own spelling.
 */
function querySession(url) {
  return queryValue(url, 'sessionId') ?? queryValue(url, 'session')
}

/** First non-empty string argument (body field, then query parameter). */
function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** The parsed `if-none-match` tokens, weak markers stripped. */
function ifNoneMatch(request) {
  const raw = request.headers?.['if-none-match']
  const value = Array.isArray(raw) ? raw.join(',') : typeof raw === 'string' ? raw : ''
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => entry.replace(/^W\//, ''))
}

/**
 * `/rev` accepts its own validator shapes and, for compatibility, a scene ETag
 * (`"<revision>-<slug>"`), because the client stores one ETag and the contract
 * lets it poll `/rev` with it.
 *
 * The focus pointer is part of the validator now (P2-7): once a pointer is
 * recorded, the bare `"<revision>"` and an older `"<revision>-<at>"` are stale
 * (the client has not seen the pointer yet), while a scene slug suffix still
 * matches.
 */
function matchesRevision(tokens, revision, focusAt) {
  const current = Number.isFinite(focusAt) ? String(Math.trunc(focusAt)) : undefined
  return tokens.some((token) => {
    // Only the namespaced validator this route issued matches: without a focus
    // pointer `"rev-<revision>"`, with one `"rev-<revision>-<focus.at>"`. A scene
    // ETag (`"<revision>-<slug>"`) never does, numeric slug or not.
    if (current === undefined) return token === `"rev-${revision}"`
    return token === `"rev-${revision}-${current}"`
  })
}

async function readJsonBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new ApiError('bad-request', 'request body is too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ApiError('bad-request', 'request body is not valid JSON')
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

/**
 * Build the five route handlers.
 *
 * @param {object} deps
 * @param {ReturnType<import('./config.js').resolveConfig>} deps.config
 * @param {{ requestRejection?: (req: unknown) => number | undefined }} deps.connection - `ctx.connection`.
 * @param {(sessionId?: string) => Promise<{sessionId: string, cwd: string}>} deps.resolveSession
 * @param {() => Promise<{token: string, source: string}>} deps.resolveToken
 * @param {(input: object) => Promise<object>} deps.refresh - the tool's shared refresh operation.
 * @param {(cwd: string) => object} deps.storeFor
 * @param {{warn?: Function, debug?: Function}} [deps.logger]
 * @returns {{ health: Function, scenes: Function, scene: Function, rev: Function, refresh: Function }}
 */
/**
 * Serve one user-supplied font. The manifest is re-read per request (the user may
 * add a font without restarting), and only manifest names are accepted.
 */
export function createExtraFontHandler({ dir, listExtraFonts, readExtraFont, connection, logger }) {
  const trusted = (request) => {
    try {
      return connection?.requestRejection?.(request) === undefined
    } catch {
      return false
    }
  }
  return async function extraFontHandler(request, response) {
    if (!trusted(request)) {
      writeJson(response, 403, { error: 'forbidden', message: 'untrusted caller' }, { 'cache-control': 'no-store' })
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      writeJson(response, 405, { error: 'bad-request', message: 'method not allowed: use GET' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    let name
    try {
      name = decodeURIComponent(url.pathname.slice(FONT_EXTRA_PREFIX.length))
    } catch {
      writeJson(response, 404, { error: 'no-font', message: 'no such font' })
      return
    }
    try {
      // The manifest is the whitelist: names with spaces or non-ASCII characters
      // are legitimate, a traversal is not (round 16).
      const listed = await listExtraFonts(dir)
      if (!(listed.fonts ?? []).some((font) => font.file === name)) {
        writeJson(response, 404, { error: 'no-font', message: 'no such font' })
        return
      }
      const bytes = await readExtraFont(dir, name)
      response.writeHead(200, {
        'content-type': 'font/woff2',
        'content-length': String(bytes.length),
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      })
      if (request.method === 'HEAD') response.end()
      else response.end(bytes)
    } catch (error) {
      logger?.warn?.(`dsh-excalidraw: could not serve extra font "${name}": ${error?.message ?? error}`)
      writeJson(response, 404, { error: 'no-font', message: 'no such font' })
    }
  }
}

export function createRoutes(deps) {
  const { config, connection, resolveSession, resolveToken, refresh, storeFor, listFocuses, listExtraFonts, logger } = deps

  const fenced = (request) => {
    try {
      return connection?.requestRejection?.(request) === undefined
    } catch {
      return false
    }
  }

  const guarded = (handler) => async (request, response) => {
    try {
      await handler(request, response)
    } catch (error) {
      writeFailure(response, error, logger)
    }
  }

  function requireMethod(request, response, method) {
    if (String(request.method ?? 'GET').toUpperCase() === method) return true
    writeJson(response, 405, { error: 'bad-request', message: `method not allowed: use ${method}` })
    return false
  }

  function requireTrusted(request, response) {
    if (fenced(request)) return true
    writeJson(response, 403, { error: 'forbidden', message: 'this request did not pass the host browser gate' })
    return false
  }

  async function tokenState() {
    try {
      const { token } = await resolveToken()
      return { configured: typeof token === 'string' && token !== '' }
    } catch {
      return { configured: false }
    }
  }

  function storeLabel(cwd) {
    // `.dsh/excalidraw` when the store lives inside the workspace, otherwise
    // the configured value / absolute root.
    try {
      const root = storeFor(cwd).root
      const relative = cwd.endsWith('/') ? root.slice(cwd.length) : root.startsWith(`${cwd}/`) ? root.slice(cwd.length + 1) : undefined
      return relative !== undefined && relative !== '' ? relative : root
    } catch {
      return config.scenesDir
    }
  }

  const health = guarded(async (request, response) => {
    if (!requireTrusted(request, response)) return
    if (!requireMethod(request, response, 'GET')) return
    let revision = 0
    let scenes = 0
    let store = config.scenesDir
    try {
      const target = await resolveSession(querySession(urlOf(request)))
      const listed = await storeFor(target.cwd).listScenes()
      revision = listed.revision
      scenes = listed.scenes.length
      store = storeLabel(target.cwd)
    } catch (error) {
      if (!(error instanceof SessionError)) throw error
      // No conversation to scope to: health is still answerable, it just has
      // no per-workspace store to report yet.
    }
    const { configured } = await tokenState()
    // Never echo credentials or a query string from the configured endpoint.
    const safeUrl = (() => {
      try {
        const parsed = new URL(config.mcpUrl)
        parsed.username = ''
        parsed.password = ''
        parsed.search = ''
        parsed.hash = ''
        return parsed.toString()
      } catch {
        return ''
      }
    })()
    writeJson(response, 200, {
      ok: true,
      revision,
      scenes,
      mcp: { configured, url: safeUrl },
      store,
    })
  })

  const scenes = guarded(async (request, response) => {
    if (!requireTrusted(request, response)) return
    if (!requireMethod(request, response, 'GET')) return
    const target = await resolveSession(querySession(urlOf(request)))
    const listed = await storeFor(target.cwd).listScenes()
    writeJson(response, 200, {
      revision: listed.revision,
      items: listed.scenes.map((entry) => ({
        slug: entry.slug,
        name: entry.name,
        sceneId: entry.sceneId,
        elements: entry.elements,
        updatedAt: entry.updatedAt,
      })),
    })
  })

  const scene = guarded(async (request, response) => {
    if (!requireTrusted(request, response)) return
    if (!requireMethod(request, response, 'GET')) return
    const url = urlOf(request)
    const target = await resolveSession(querySession(url))
    const slug = normalizeSlug(queryValue(url, 'slug'), DEFAULT_SLUG)
    const stored = await storeFor(target.cwd).readScene(slug)
    const validators = ifNoneMatch(request)
    if (validators.includes('*') || validators.includes(stored.etag)) {
      writeNotModified(response, { etag: stored.etag })
      return
    }
    if (response.headersSent === true) {
      response.destroy?.()
      return
    }
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      etag: stored.etag,
    })
    response.end(stored.bytes)
  })

  const rev = guarded(async (request, response) => {
    if (!requireTrusted(request, response)) return
    if (!requireMethod(request, response, 'GET')) return
    const target = await resolveSession(querySession(urlOf(request)))
    const snapshot = await storeFor(target.cwd).snapshot()
    const focusAt = snapshot.focus?.at
    const etag = revisionEtag(snapshot.revision, focusAt)
    const validators = ifNoneMatch(request)
    if (validators.includes('*') || matchesRevision(validators, snapshot.revision, focusAt)) {
      writeNotModified(response, { etag })
      return
    }
    // The configured client poll interval rides the poll response, so the
    // CONTRACT §1 setting has a real consumer instead of being decorative.
    const pollMs = Math.min(10000, Math.max(500, Math.trunc(Number(config.pollIntervalMs) || 1500)))
    const body = snapshot.focus === undefined
      ? { revision: snapshot.revision, pollMs }
      : { revision: snapshot.revision, focus: snapshot.focus, pollMs }
    writeJson(response, 200, body, { etag })
  })

  const isAbort = (error) => error !== null && typeof error === 'object'
    && (error.name === 'AbortError' || error.code === 'ABORT_ERR')

  // The newest auto-open pointer across every workspace this host has mounted, so
  // the client watcher is not blind to refreshes in another workspace.
  // The fonts the user supplied (config.extraFontsDir), so the client can add
  // @font-face rules for them. Bundled fonts travel in the client bundle.
  const fontsRoute = guarded(async (request, response) => {
    if (!requireTrusted(request, response)) return
    if (!requireMethod(request, response, 'GET')) return
    let extra = []
    try {
      const listed = typeof listExtraFonts === 'function' ? await listExtraFonts(config.extraFontsDir) : { fonts: [] }
      extra = (listed.fonts ?? []).map((font) => ({
        family: font.family,
        file: font.file,
        url: `${FONT_EXTRA_PREFIX}${encodeURIComponent(font.file)}`,
        weight: font.weight,
        style: font.style,
        ...(font.unicodeRange ? { unicodeRange: font.unicodeRange } : {}),
      }))
    } catch (error) {
      writeFailure(response, error, logger)
      return
    }
    writeJson(response, 200, { extra }, { 'cache-control': 'no-store' })
  })

  const focusRoute = guarded(async (request, response) => {
    if (!requireTrusted(request, response)) return
    if (!requireMethod(request, response, 'GET')) return
    let newest = null
    try {
      const entries = typeof listFocuses === 'function' ? await listFocuses() : []
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue
        if (typeof entry.sessionId !== 'string' || !Number.isFinite(entry.at)) continue
        if (newest === null || entry.at > newest.at) newest = { sessionId: entry.sessionId, at: entry.at }
      }
    } catch (error) {
      writeFailure(response, error, logger)
      return
    }
    writeJson(response, 200, { focus: newest }, { 'cache-control': 'no-store' })
  })

  const refreshRoute = guarded(async (request, response) => {
    if (!requireTrusted(request, response)) return
    if (!requireMethod(request, response, 'POST')) return
    const url = urlOf(request)
    const body = await readJsonBody(request)
    // A client that goes away must not leave a write behind: the tool result
    // contract (`400 aborted`) is reachable from this route too.
    const controller = new AbortController()
    const abort = () => {
      if (response.writableEnded !== true && controller.signal.aborted !== true) controller.abort()
    }
    // Over real HTTP `request` 'close' fires once the body has been read, so the
    // connection-level signal is the response's own close (review round 14).
    response.on?.('close', abort)
    request.on?.('aborted', abort)
    request.on?.('close', abort)
    let result
    try {
      result = await refresh({
        sessionId: firstText(body.sessionId, body.session, querySession(url)),
        sceneId: body.sceneId,
        slug: body.slug,
        name: body.name,
        signal: controller.signal,
      })
    } catch (error) {
      if (!isAbort(error)) throw error
      writeJson(response, 400, { ok: false, error: 'aborted', message: 'the refresh was cancelled' })
      return
    } finally {
      request.off?.('close', abort)
      request.off?.('aborted', abort)
      response.off?.('close', abort)
    }
    if (result.ok === true) {
      writeJson(response, 200, result)
      return
    }
    const { status, code, message } = errorResponse({ code: result.error, message: result.message })
    // The refresh body is the tool result on success, so its failure keeps the
    // same discriminant (`ok: false`) on top of CONTRACT §3's error envelope.
    // An `internal` failure answers the generic message; the raw detail (which
    // can carry an absolute path) only reaches the log (P2-1).
    if (code === 'internal') logger?.warn?.(`dsh-excalidraw: /excalidraw/api/refresh failed: ${result.message}`)
    writeJson(response, status, { ok: false, error: code, message })
  })

  return { health, scenes, scene, rev, focus: focusRoute, fonts: fontsRoute, refresh: refreshRoute }
}


/**
 * A dependency-free MCP "streamable HTTP" JSON-RPC client, just large enough
 * for the one call this plugin makes: `initialize` →
 * `notifications/initialized` → `tools/call get_scene_content`.
 *
 * Behaviours that matter on the wire:
 *  - plain JSON responses AND `text/event-stream` responses (the harness reads
 *    only the `data:` frames of the latter);
 *  - the `mcp-session-id` response header is remembered and echoed on later
 *    requests;
 *  - one `AbortController` deadline per request, surfacing as `mcp-error`;
 *  - every failure becomes a {@link McpError} with `code: 'mcp-error'`, and no
 *    message ever contains the token.
 *
 * The endpoint URL never comes from a request or from the model: callers pass
 * the configured row value.
 */

/** A failed MCP interaction, mapped by the routes to HTTP 502 `mcp-error`. */
export class McpError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, timeout?: boolean, rpcCode?: number }} [details]
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'McpError'
    this.code = 'mcp-error'
    this.status = details.status
    this.timeout = details.timeout === true
    this.rpcCode = details.rpcCode
  }
}

/** JSON-RPC protocol version this client announces. */
export const PROTOCOL_VERSION = '2025-06-18'

/** Refuse an upstream body beyond this; scene payloads are far smaller. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function isAbort(error) {
  return error !== null && typeof error === 'object' && (error.name === 'AbortError' || error.code === 'ABORT_ERR')
}

/** Parse one SSE event's `data:` value into a JSON-RPC message (keepalives ignored). */
function parseSsePayload(payload) {
  const body = String(payload).trim()
  if (body === '' || body === '[DONE]') return undefined
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

/**
 * Parse the lines of one SSE event into a JSON-RPC message. Per the SSE
 * specification every `data:` line of an event is a fragment of one value,
 * joined with `\n`; one optional leading space after the colon is dropped.
 *
 * @param {string[]} lines - the event's lines, without the blank separator.
 * @returns {unknown | undefined}
 */
export function parseSseEvent(lines) {
  const data = []
  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    const rest = line.slice(5)
    data.push(rest.startsWith(' ') ? rest.slice(1) : rest)
  }
  if (data.length === 0) return undefined
  return parseSsePayload(data.join('\n'))
}

/**
 * Parse a complete response body into JSON-RPC messages, accepting either a
 * single object or a batch array.
 *
 * @param {string} text
 * @param {string} method - for the error message.
 * @returns {unknown[]}
 */
export function parseJsonMessages(text, method = 'request') {
  const trimmed = text.trim()
  if (trimmed === '') return []
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new McpError(`${method}: the MCP server returned a body that is not JSON`)
  }
  if (Array.isArray(parsed)) return parsed
  return [parsed]
}

/**
 * Parse a complete SSE body into JSON-RPC messages. Events are separated by a
 * blank line (CRLF and LF alike), and one event's `data:` lines are joined
 * before parsing (P2-6).
 * @param {string} text
 * @returns {unknown[]}
 */
export function parseSseMessages(text) {
  const messages = []
  let event = []
  const flush = () => {
    const message = parseSseEvent(event)
    event = []
    if (message !== undefined) messages.push(message)
  }
  for (const line of String(text).split(/\r?\n/)) {
    if (line === '') flush()
    else event.push(line)
  }
  flush()
  return messages
}

function pickAnswer(messages, id, method, quiet = false) {
  for (const message of messages) {
    if (message !== null && typeof message === 'object' && message.id === id) return message
  }
  for (const message of messages) {
    if (message !== null && typeof message === 'object' && (message.result !== undefined || message.error !== undefined)) return message
  }
  if (quiet) return undefined
  throw new McpError(`${method}: no JSON-RPC response in the MCP reply`)
}

/**
 * Pull an Excalidraw scene document out of a `tools/call` result.
 *
 * The Excalidraw+ server has returned the document both as
 * `structuredContent` and, historically, as a JSON text content block, and
 * either may nest it under `scene`; all of those are accepted. Anything that
 * does not look like a scene (an object with an `elements` array) is rejected
 * rather than written to disk.
 *
 * @param {unknown} result - the JSON-RPC `result`.
 * @returns {{ type: string, version: number, elements: unknown[] } | object | undefined}
 */
export function extractToolPayload(result) {
  if (result === null || typeof result !== 'object') return undefined
  const candidates = []
  const structured = result.structuredContent
  if (structured !== null && typeof structured === 'object') candidates.push(structured)
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block === null || typeof block !== 'object') continue
      if (block.type !== 'text' || typeof block.text !== 'string') continue
      try {
        candidates.push(JSON.parse(block.text))
      } catch {
        // A prose block is allowed; only JSON can carry the scene.
      }
    }
  }
  for (const candidate of candidates) {
    const scene = candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate) && 'scene' in candidate ? candidate.scene : candidate
    if (scene === null || scene === undefined) continue
    if (Array.isArray(scene)) {
      if (scene.length > 0 && scene.every((element) => element !== null && typeof element === 'object')) {
        return { type: 'excalidraw', version: 2, source: 'excalidraw-mcp', elements: scene }
      }
      continue
    }
    if (typeof scene === 'object' && Array.isArray(scene.elements)) return scene
  }
  return undefined
}

/**
 * Create and hand-shake one MCP client.
 *
 * @param {object} options
 * @param {string} options.url - configured endpoint (http/https only).
 * @param {string} [options.token] - bearer token; omitted when empty.
 * @param {typeof fetch} [options.fetch] - injectable fetch (tests).
 * @param {AbortSignal} [options.signal] - caller cancellation; an aborted call
 *   rejects with an `AbortError`, never with a timeout or `mcp-error` (P2-3).
 * @param {number} [options.timeoutMs] - per-request deadline.
 * @param {string} [options.protocolVersion]
 * @param {{name: string, version: string}} [options.clientInfo]
 * @returns {Promise<{ url: string, sessionId: string | null, initializeResult: unknown, send: Function, listTools: Function, callTool: Function, close: Function }>}
 */
export async function createMcpClient(options = {}) {
  const {
    url,
    token = '',
    fetch: fetchImpl = globalThis.fetch,
    signal: externalSignal,
    timeoutMs = 15000,
    protocolVersion = PROTOCOL_VERSION,
    clientInfo = { name: 'dsh-excalidraw', version: '0.1.0' },
  } = options

  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new McpError('the configured MCP endpoint is not an http(s) URL')
  }
  if (typeof fetchImpl !== 'function') throw new McpError('this runtime has no fetch implementation')

  let sessionId = null
  let initialized = false
  let nextId = 1

  const redact = (text) => (token === '' ? String(text) : String(text).split(token).join('<redacted>'))

  function cancelled() {
    return externalSignal?.aborted === true
  }

  /** The caller's cancellation, as an `AbortError` (never a transport error). */
  function abortError() {
    const reason = externalSignal?.reason
    if (reason !== null && typeof reason === 'object' && reason.name === 'AbortError') return reason
    if (reason instanceof Error) return reason
    const error = new Error('the operation was aborted')
    error.name = 'AbortError'
    error.code = 'ABORT_ERR'
    return error
  }

  function timeoutError(method) {
    return new McpError(`${method}: the MCP server did not answer within ${timeoutMs} ms`, { timeout: true })
  }

  async function bodyText(response, method) {
    try {
      // A hostile or broken upstream must not be able to balloon the process:
      // 32 MB of error body used to cost ~200 MB RSS (review round 14).
      const declared = Number(response.headers?.get?.('content-length'))
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        await discardBody(response)
        throw new McpError(`${method}: the MCP response is larger than ${MAX_RESPONSE_BYTES} bytes`, { status: 502 })
      }
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new McpError(`${method}: the MCP response is larger than ${MAX_RESPONSE_BYTES} bytes`, { status: 502 })
      }
      return text
    } catch (error) {
      if (cancelled()) throw abortError()
      if (isAbort(error)) throw timeoutError(method)
      // Keep a McpError we raised ourselves (for example the size cap): re-wrapping
      // it hides the status and nests the message (round 18).
      if (error instanceof McpError) throw error
      throw new McpError(`${method}: reading the MCP response failed: ${redact(messageOf(error))}`)
    }
  }

  async function discardBody(response) {
    try {
      await response.body?.cancel?.()
    } catch {
      // The body was already consumed or is unsupported; nothing to release.
    }
  }

  /**
   * Read one answer from a streaming body. Events are cut at a blank line and
   * their `data:` lines joined before parsing (P2-6); when the body turns out
   * to be plain JSON (no `text/event-stream` content type, so we cannot know
   * in advance) the whole text is parsed as JSON at the end.
   */
  async function readStreamAnswer(response, id, method) {
    let consumed = 0
    const body = response.body
    if (body === null || body === undefined || typeof body.getReader !== 'function') {
      return answerFromText(await bodyText(response, method), id, method)
    }
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let raw = ''
    let event = []
    const messages = []
    const flush = () => {
      const message = parseSseEvent(event)
      event = []
      if (message === undefined) return undefined
      messages.push(message)
      return pickAnswer(messages, id, method, true)
    }
    const consume = (line) => (line === '' ? flush() : (event.push(line), undefined))
    const stop = async () => {
      try {
        await reader.cancel()
      } catch {
        // The server already ended the stream.
      }
    }
    try {
      for (;;) {
        let chunk
        try {
          chunk = await reader.read()
        } catch (error) {
          if (cancelled()) throw abortError()
          if (isAbort(error)) throw timeoutError(method)
          throw new McpError(`${method}: reading the MCP event stream failed: ${redact(messageOf(error))}`)
        }
        if (chunk.done === true) break
        consumed += chunk.value?.byteLength ?? 0
        if (consumed > MAX_RESPONSE_BYTES) {
          await stop()
          throw new McpError(`${method}: the MCP response is larger than ${MAX_RESPONSE_BYTES} bytes`, { status: 502 })
        }
        const text = decoder.decode(chunk.value, { stream: true })
        raw += text
        buffer += text
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, '')
          buffer = buffer.slice(newline + 1)
          const answer = consume(line)
          if (answer !== undefined) {
            await stop()
            return answer
          }
          newline = buffer.indexOf('\n')
        }
      }
      const tail = decoder.decode()
      raw += tail
      buffer += tail
      const rest = consume(buffer.replace(/\r$/, ''))
      if (rest !== undefined) return rest
      // The final (unterminated) line ends the last event too.
      const last = consume('')
      if (last !== undefined) return last
      if (messages.length === 0) {
        // No SSE event frame: the body may be plain JSON.
        try {
          return pickAnswer(parseJsonMessages(raw, method), id, method)
        } catch {
          // Fall through to the SSE/no-answer error below.
        }
      }
      return pickAnswer(messages, id, method)
    } finally {
      try {
        reader.releaseLock?.()
      } catch {
        // Already released by cancel().
      }
    }
  }

  /** Answer from a fully read body: JSON first, then SSE (P2-6). */
  function answerFromText(text, id, method) {
    let messages
    try {
      messages = parseJsonMessages(text, method)
    } catch {
      messages = parseSseMessages(text)
    }
    if (messages.length === 0) messages = parseSseMessages(text)
    return pickAnswer(messages, id, method)
  }

  async function send(method, params, requestOptions = {}) {
    const { notify = false } = requestOptions
    const request = { jsonrpc: '2.0', method, params }
    if (!notify) request.id = nextId
    nextId += 1

    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    }
    if (token !== '') headers.authorization = `Bearer ${token}`
    if (sessionId !== null) headers['mcp-session-id'] = sessionId
    if (initialized) headers['mcp-protocol-version'] = protocolVersion

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    // A caller cancellation must reach the in-flight fetch (P2-3): abort the
    // per-request deadline controller with it, and keep the two reasons apart.
    const onCancel = externalSignal === undefined ? undefined : () => controller.abort(externalSignal.reason)
    externalSignal?.addEventListener?.('abort', onCancel, { once: true })
    try {
      if (cancelled()) throw abortError()
      let response
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(request),
          signal: controller.signal,
        })
      } catch (error) {
        if (cancelled()) throw abortError()
        if (isAbort(error)) throw timeoutError(method)
        throw new McpError(`${method}: the MCP request failed: ${redact(messageOf(error))}`)
      }
      if (cancelled()) throw abortError()

      const responseSession = response.headers?.get?.('mcp-session-id')
      if (typeof responseSession === 'string' && responseSession !== '') sessionId = responseSession

      if (response.status === 401 || response.status === 403) {
        // Never echo the body of an authentication failure: it can carry the
        // credential back, and it tells the user nothing actionable.
        await discardBody(response)
        throw new McpError(`${method}: the MCP server rejected the credential (HTTP ${response.status}); check the Excalidraw+ MCP token`, {
          status: response.status,
        })
      }
      if (response.ok !== true) {
        const snippet = redact(await bodyText(response, method)).slice(0, 200)
        throw new McpError(`${method}: HTTP ${response.status}${snippet === '' ? '' : `: ${snippet}`}`, {
          status: response.status,
        })
      }
      if (notify) {
        await discardBody(response)
        return undefined
      }

      const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase()
      let answer
      if (contentType.includes('text/event-stream')) {
        answer = await readStreamAnswer(response, request.id, method)
      } else if (contentType.includes('application/json') || contentType.includes('+json')) {
        answer = pickAnswer(parseJsonMessages(await bodyText(response, method), method), request.id, method)
      } else {
        // Missing or unexpected content type (a proxy, a bare SSE server): the
        // body must not be rejected for its label alone (P2-6). A streaming
        // read keeps a keep-alive event stream from hanging.
        answer = await readStreamAnswer(response, request.id, method)
      }

      if (answer !== null && typeof answer === 'object' && answer.error !== undefined) {
        const error = answer.error
        const detail = error !== null && typeof error === 'object' ? (typeof error.message === 'string' ? error.message : 'JSON-RPC error') : String(error)
        const code = error !== null && typeof error === 'object' && Number.isFinite(error.code) ? error.code : undefined
        throw new McpError(`${method}: ${redact(detail)}${code === undefined ? '' : ` (code ${code})`}`, { rpcCode: code })
      }
      return answer.result
    } finally {
      clearTimeout(timer)
      if (onCancel !== undefined) externalSignal?.removeEventListener?.('abort', onCancel)
    }
  }

  async function listTools() {
    return send('tools/list', {})
  }

  async function callTool(name, args = {}) {
    const result = await send('tools/call', { name, arguments: args })
    if (result !== null && typeof result === 'object' && result.isError === true) {
      const text = Array.isArray(result.content)
        ? result.content
            .filter((block) => block !== null && typeof block === 'object' && typeof block.text === 'string')
            .map((block) => block.text)
            .join(' ')
        : ''
      throw new McpError(`${name}: the tool reported an error${text === '' ? '' : `: ${redact(text).slice(0, 300)}`}`)
    }
    return result
  }

  const initializeResult = await send('initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo,
  })
  await send('notifications/initialized', {}, { notify: true })
  initialized = true

  return {
    url,
    get sessionId() {
      return sessionId
    },
    initializeResult,
    send,
    listTools,
    callTool,
    async close() {
      // Every request is its own fetch; there is no transport to tear down.
    },
  }
}


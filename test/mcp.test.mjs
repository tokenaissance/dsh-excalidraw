/**
 * The streamable-HTTP JSON-RPC client against local fake MCP servers
 * (CONTRACT §4/§7): plain JSON, SSE, JSON-RPC errors, 401, timeout, session
 * header, auth header, and the `get_scene_content` payload shapes.
 *
 * No test ever reaches the network: every endpoint is a `node:http` server on
 * 127.0.0.1.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  McpError,
  extractToolPayload,
  parseJsonMessages,
  parseSseMessages,
  createMcpClient,
} from '../lib/mcp.js'

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function replyJson(response, id, result, headers = {}) {
  response.writeHead(200, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
}

function replySse(response, id, result, headers = {}) {
  response.writeHead(200, { 'content-type': 'text/event-stream', ...headers })
  response.write(': keepalive\n\n')
  response.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":50}}\n\n')
  response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`)
  response.end()
}

/** Start a fake MCP server; every request body is parsed and handed over. */
async function startServer(t, handler) {
  const server = createServer((request, response) => {
    readBody(request)
      .then((text) => handler(JSON.parse(text), request, response))
      .catch(() => {
        try {
          response.destroy()
        } catch {
          // Already gone.
        }
      })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(() => resolve()))
  })
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}/mcp`, server }
}

const INITIALIZE_RESULT = {
  protocolVersion: '2025-06-18',
  capabilities: { tools: {} },
  serverInfo: { name: 'fake-excalidraw', version: '1.0.0' },
}

function handleCommon(message, request, response, calls, { tool, sessionId = 'session-from-server', sse = false } = {}) {
  calls.push({ message, headers: request.headers })
  if (message.method === 'initialize') {
    if (sse) replySse(response, message.id, INITIALIZE_RESULT, { 'mcp-session-id': sessionId })
    else replyJson(response, message.id, INITIALIZE_RESULT, { 'mcp-session-id': sessionId })
    return true
  }
  if (message.method === 'notifications/initialized') {
    response.writeHead(202)
    response.end()
    return true
  }
  if (message.method === 'tools/call') {
    const result = tool ?? { structuredContent: { type: 'excalidraw', elements: [{ id: 'a' }, { id: 'b' }] } }
    if (sse) replySse(response, message.id, result)
    else replyJson(response, message.id, result)
    return true
  }
  return false
}

test('plain JSON: initialize → initialized → tools/call, with auth and session headers', async (t) => {
  const calls = []
  const server = await startServer(t, (message, request, response) => {
    handleCommon(message, request, response, calls)
  })
  const token = 'sk-test-plain'
  const client = await createMcpClient({ url: server.url, token })

  assert.equal(client.sessionId, 'session-from-server')
  assert.equal(client.initializeResult.serverInfo.name, 'fake-excalidraw')
  assert.equal(calls.length, 2, 'initialize + notifications/initialized')
  assert.equal(calls[0].headers.authorization, `Bearer ${token}`)
  assert.equal(calls[0].headers.accept.includes('text/event-stream'), true)
  assert.equal(calls[0].headers['content-type'], 'application/json')
  assert.equal(calls[1].headers['mcp-session-id'], 'session-from-server')
  assert.equal(calls[1].message.id, undefined, 'the initialized notification carries no id')

  const result = await client.callTool('get_scene_content', { sceneId: 'scene-1' })
  assert.deepEqual(calls[2].message.params, { name: 'get_scene_content', arguments: { sceneId: 'scene-1' } })
  assert.equal(calls[2].headers['mcp-session-id'], 'session-from-server')
  assert.equal(calls[2].headers['mcp-protocol-version'], '2025-06-18')
  const scene = extractToolPayload(result)
  assert.deepEqual(scene.elements.map((element) => element.id), ['a', 'b'])
  await client.close()
})

test('SSE: initialize and tools/call over text/event-stream', async (t) => {
  const calls = []
  const server = await startServer(t, (message, request, response) => {
    handleCommon(message, request, response, calls, { sse: true })
  })
  const client = await createMcpClient({ url: server.url })
  assert.equal(typeof calls[0].headers.authorization, 'undefined', 'no Authorization header without a token')
  assert.equal(client.sessionId, 'session-from-server')
  const result = await client.callTool('get_scene_content', { sceneId: 'x' })
  assert.equal(extractToolPayload(result).elements.length, 2)
})

test('SSE: a response split across chunks is reassembled', async (t) => {
  const server = await startServer(t, (message, request, response) => {
    if (message.method === 'initialize') {
      replyJson(response, message.id, INITIALIZE_RESULT)
      return
    }
    if (message.method === 'notifications/initialized') {
      response.writeHead(202)
      response.end()
      return
    }
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { structuredContent: { elements: [{ id: 'split' }] } },
    })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n')
    // Split the data frame mid-JSON, then finish it.
    response.write(`data: ${payload.slice(0, 20)}`)
    setTimeout(() => {
      response.write(`${payload.slice(20)}\n\n`)
      response.end()
    }, 10)
  })
  const client = await createMcpClient({ url: server.url, timeoutMs: 2000 })
  const result = await client.callTool('get_scene_content', {})
  assert.equal(extractToolPayload(result).elements[0].id, 'split')
})

test('a JSON-RPC error during initialize becomes mcp-error', async (t) => {
  const server = await startServer(t, (message, request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'internal error' } }))
  })
  const error = await createMcpClient({ url: server.url }).catch((caught) => caught)
  assert.ok(error instanceof McpError)
  assert.equal(error.rpcCode, -32603)
  assert.match(error.message, /internal error/)
})

test('a non-2xx answer becomes mcp-error with its status and a redacted snippet', async (t) => {
  const token = 'sk-test-http-500'
  const server = await startServer(t, (message, request, response) => {
    response.writeHead(500, { 'content-type': 'text/plain' })
    response.end(`upstream exploded (token was ${token})`)
  })
  const error = await createMcpClient({ url: server.url, token }).catch((caught) => caught)
  assert.ok(error instanceof McpError)
  assert.equal(error.status, 500)
  assert.match(error.message, /HTTP 500/)
  assert.equal(error.message.includes(token), false)
})

test('tools/call JSON-RPC error: mcp-error with rpcCode and the server message', async (t) => {
  const server = await startServer(t, (message, request, response) => {
    if (message.method === 'initialize') {
      replyJson(response, message.id, INITIALIZE_RESULT)
      return
    }
    if (message.method === 'notifications/initialized') {
      response.writeHead(202)
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'scene not found' } }))
  })
  const client = await createMcpClient({ url: server.url })
  const error = await client.callTool('get_scene_content', { sceneId: 'nope' }).catch((caught) => caught)
  assert.ok(error instanceof McpError)
  assert.equal(error.code, 'mcp-error')
  assert.equal(error.rpcCode, -32000)
  assert.match(error.message, /scene not found/)
})

test('401 is mcp-error and never echoes the credential', async (t) => {
  const token = 'sk-test-should-not-leak'
  const server = await startServer(t, (message, request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'unauthorized', echo: `Bearer ${token}` }))
  })
  const error = await createMcpClient({ url: server.url, token }).catch((caught) => caught)
  assert.ok(error instanceof McpError)
  assert.equal(error.status, 401)
  assert.equal(error.message.includes(token), false, 'the token must not appear in the error')
  assert.match(error.message, /HTTP 401/)
})

test('a hanging server surfaces as a timeout mcp-error', async (t) => {
  const server = await startServer(t, () => {
    // Deliberately never answers.
  })
  const startedAt = Date.now()
  const error = await createMcpClient({ url: server.url, timeoutMs: 100 }).catch((caught) => caught)
  assert.ok(error instanceof McpError)
  assert.equal(error.timeout, true)
  assert.match(error.message, /did not answer within 100 ms/)
  assert.ok(Date.now() - startedAt >= 90, 'the deadline is actually applied')
})

test('the endpoint must be an http(s) URL', async () => {
  for (const url of [undefined, '', 'file:///tmp/mcp', 'api.excalidraw.com', 42]) {
    const error = await createMcpClient({ url }).catch((caught) => caught)
    assert.ok(error instanceof McpError, `url ${String(url)} should be refused`)
  }
})

test('isError tool results become mcp-error instead of a scene', async (t) => {
  const server = await startServer(t, (message, request, response) => {
    if (message.method === 'initialize') {
      replyJson(response, message.id, INITIALIZE_RESULT)
      return
    }
    if (message.method === 'notifications/initialized') {
      response.writeHead(202)
      response.end()
      return
    }
    replyJson(response, message.id, { isError: true, content: [{ type: 'text', text: 'permission denied' }] })
  })
  const client = await createMcpClient({ url: server.url })
  const error = await client.callTool('get_scene_content', {}).catch((caught) => caught)
  assert.ok(error instanceof McpError)
  assert.match(error.message, /permission denied/)
})

test('SSE: one event whose JSON is split over several data lines is understood (P2-6)', async (t) => {
  const server = await startServer(t, (message, request, response) => {
    if (message.method === 'initialize') {
      replyJson(response, message.id, INITIALIZE_RESULT)
      return
    }
    if (message.method === 'notifications/initialized') {
      response.writeHead(202)
      response.end()
      return
    }
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { structuredContent: { elements: [{ id: 'multi-line' }] } },
    })
    // Split at a token boundary (after the first comma): the SSE rule joins
    // the fragments with a newline, which JSON accepts between tokens.
    const cut = payload.indexOf(',') + 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${payload.slice(0, cut)}\n`)
    response.write(`data: ${payload.slice(cut)}\n\n`)
    response.end()
  })
  const client = await createMcpClient({ url: server.url, timeoutMs: 2000 })
  const result = await client.callTool('get_scene_content', {})
  assert.equal(extractToolPayload(result).elements[0].id, 'multi-line')
})

test('SSE: CRLF line endings are accepted (P2-6)', async (t) => {
  const server = await startServer(t, (message, request, response) => {
    if (message.method === 'initialize') {
      replyJson(response, message.id, INITIALIZE_RESULT)
      return
    }
    if (message.method === 'notifications/initialized') {
      response.writeHead(202)
      response.end()
      return
    }
    const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { elements: [{ id: 'crlf' }] } } })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`event: message\r\ndata: ${payload}\r\n\r\n`)
  })
  const client = await createMcpClient({ url: server.url, timeoutMs: 2000 })
  const result = await client.callTool('get_scene_content', {})
  assert.equal(extractToolPayload(result).elements[0].id, 'crlf')
})

test('a JSON body without a content-type is still understood (P2-6)', async (t) => {
  const server = await startServer(t, (message, request, response) => {
    response.writeHead(200)
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: message.method === 'initialize' ? INITIALIZE_RESULT : { structuredContent: { elements: [{ id: 'no-type-json' }] } },
    }))
  })
  const client = await createMcpClient({ url: server.url, timeoutMs: 2000 })
  assert.equal(client.initializeResult.serverInfo.name, 'fake-excalidraw')
  const result = await client.callTool('get_scene_content', {})
  assert.equal(extractToolPayload(result).elements[0].id, 'no-type-json')
})

test('an SSE body without a content-type is still understood (P2-6)', async (t) => {
  const server = await startServer(t, (message, request, response) => {
    if (message.method === 'notifications/initialized') {
      response.writeHead(202)
      response.end()
      return
    }
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: message.method === 'initialize' ? INITIALIZE_RESULT : { structuredContent: { elements: [{ id: 'no-type-sse' }] } },
    })
    // No content-type at all, SSE framing.
    response.writeHead(200)
    response.end(`data: ${payload}\n\n`)
  })
  const client = await createMcpClient({ url: server.url, timeoutMs: 2000 })
  assert.equal(client.initializeResult.serverInfo.name, 'fake-excalidraw')
  const result = await client.callTool('get_scene_content', {})
  assert.equal(extractToolPayload(result).elements[0].id, 'no-type-sse')
})

test('SSE: the answer is returned from a stream that stays open (P2-6)', async (t) => {
  const server = await startServer(t, (message, request, response) => {
    if (message.method === 'initialize') {
      replyJson(response, message.id, INITIALIZE_RESULT)
      return
    }
    if (message.method === 'notifications/initialized') {
      response.writeHead(202)
      response.end()
      return
    }
    const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { elements: [{ id: 'open-stream' }] } } })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${payload}\n\n`)
    // Deliberately never end: the client must cancel once it has its answer.
  })
  const client = await createMcpClient({ url: server.url, timeoutMs: 3000 })
  const result = await client.callTool('get_scene_content', {})
  assert.equal(extractToolPayload(result).elements[0].id, 'open-stream')
})

test('a batch JSON array reply is understood', async (t) => {
  const server = await startServer(t, (message, request, response) => {
    if (message.method === 'initialize') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify([{ jsonrpc: '2.0', id: message.id, result: INITIALIZE_RESULT }]))
      return
    }
    response.writeHead(202)
    response.end()
  })
  const client = await createMcpClient({ url: server.url })
  assert.equal(client.initializeResult.protocolVersion, '2025-06-18')
})

test('parseJsonMessages handles bodies and rejects garbage', () => {
  assert.deepEqual(parseJsonMessages(''), [])
  assert.deepEqual(parseJsonMessages('   '), [])
  assert.deepEqual(parseJsonMessages('{"id":1}'), [{ id: 1 }])
  assert.deepEqual(parseJsonMessages('[{"id":1},{"id":2}]'), [{ id: 1 }, { id: 2 }])
  assert.throws(() => parseJsonMessages('<html>502</html>', 'initialize'), (error) => error.code === 'mcp-error')
})

test('parseSseMessages reads data lines, ignores keepalives and comments', () => {
  // One event per blank-line-separated block (the SSE rule): `[DONE]` and an
  // unparseable event are skipped, a valid one is kept.
  const body = [
    ': keepalive',
    '',
    'event: message',
    'data: {"jsonrpc":"2.0","id":1,"result":{}}',
    '',
    'data: [DONE]',
    '',
    'data: not-json',
    '',
    'data:{"jsonrpc":"2.0","id":2,"result":{}}',
  ].join('\n')
  const messages = parseSseMessages(body)
  assert.deepEqual(messages.map((message) => message.id), [1, 2])
})

test('parseSseMessages joins one event\'s data lines and handles CRLF (P2-6)', () => {
  const body = [
    ': keepalive',
    '',
    'event: message',
    'data: {"jsonrpc":"2.0",',
    'data: "id":7,"result":{}}',
    '',
    'data: {"jsonrpc":"2.0","id":8,"result":{}}',
  ].join('\r\n')
  assert.deepEqual(parseSseMessages(body).map((message) => message.id), [7, 8])

  // A single-line event without a trailing blank line still parses.
  assert.deepEqual(parseSseMessages('data: {"id":9}').map((message) => message.id), [9])
})

test('extractToolPayload accepts every documented scene envelope', () => {
  const elements = [{ id: 'a' }]
  assert.deepEqual(extractToolPayload({ structuredContent: { elements } }).elements, elements)
  assert.deepEqual(extractToolPayload({ structuredContent: { scene: { elements } } }).elements, elements)
  assert.deepEqual(
    extractToolPayload({ content: [{ type: 'text', text: JSON.stringify({ elements }) }] }).elements,
    elements,
  )
  assert.deepEqual(
    extractToolPayload({ content: [{ type: 'text', text: 'Not JSON at all' }], structuredContent: { elements } }).elements,
    elements,
  )
  const bare = extractToolPayload({ structuredContent: elements })
  assert.equal(bare.type, 'excalidraw')
  assert.deepEqual(bare.elements, elements)

  const rejected = [undefined, null, 'text', 42, {}, { structuredContent: {} }, { structuredContent: { elements: 'no' } }]
  for (const value of rejected) {
    assert.equal(extractToolPayload(value), undefined, `${JSON.stringify(value)} should not yield a scene`)
  }
})


test('the MCP request is wired to the caller signal (round 14)', async () => {
  const { createMcpClient } = await import('../lib/mcp.js')
  let seenSignal = null
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    seenSignal = init?.signal ?? null
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })
  try {
    const controller = new AbortController()
    // createMcpClient initializes immediately, so the caller cancellation must
    // reach the in-flight initialize fetch.
    const pending = createMcpClient({
      url: 'https://example.invalid/mcp',
      token: 't',
      fetch: globalThis.fetch,
      signal: controller.signal,
      timeoutMs: 5000,
    }).catch((error) => error)
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    const error = await pending
    assert.equal(error.name, 'AbortError', `expected a cancellation, got ${error?.name}: ${error?.message}`)
    assert.ok(seenSignal !== null, 'fetch received an AbortSignal')
    assert.equal(seenSignal.aborted, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an oversized streamed or chunked response is refused (round 16)', async () => {
  const { createMcpClient } = await import('../lib/mcp.js')
  const big = 'x'.repeat(9 * 1024 * 1024)
  const sse = 'data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}\n\n' + `data: ${big}\n\n`
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (name === 'content-type' ? 'text/event-stream' : null) },
    body: {
      getReader: () => {
        let sent = false
        return {
          read: async () => {
            if (sent) return { done: true, value: undefined }
            sent = true
            return { done: false, value: new TextEncoder().encode(sse) }
          },
          cancel: async () => {},
        }
      },
    },
  })
  try {
    const error = await createMcpClient({ url: 'https://x.invalid/mcp', token: 't', fetch: globalThis.fetch, timeoutMs: 5000 }).catch((caught) => caught)
    assert.equal(error.name, 'McpError')
    assert.match(error.message, /larger than/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a declared oversized body is refused before it is read (round 18)', async () => {
  const { createMcpClient } = await import('../lib/mcp.js')
  const originalFetch = globalThis.fetch
  let read = false
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (name) => {
        if (name === 'content-type') return 'application/json'
        if (name === 'content-length') return String(9 * 1024 * 1024)
        return null
      },
    },
    text: async () => { read = true; return '{}' },
  })
  try {
    const error = await createMcpClient({ url: 'https://x.invalid/mcp', token: 't', fetch: globalThis.fetch, timeoutMs: 5000 }).catch((caught) => caught)
    assert.equal(error.name, 'McpError')
    assert.match(error.message, /larger than/)
    assert.equal(error.status, 502, 'the cap keeps its own status')
    assert.equal(read, false, 'the body was never read')
  } finally {
    globalThis.fetch = originalFetch
  }
})

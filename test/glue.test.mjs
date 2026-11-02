/**
 * The glue: `index.js` is imported with the DSH packages stubbed, mounted on a
 * fake cordis context, and driven through its real routes and tools.
 *
 * This is the wiring contract for the client half and the integrator: five
 * exact routes, two tools, everything disposable through `ctx.effect`.
 */
import { register } from 'node:module'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

register('./stubs/loader.mjs', import.meta.url)

const plugin = await import('../index.js')
const { ROUTE_PATHS } = await import('../lib/routes.js')
const { createStore, SCENE_SUFFIX } = await import('../lib/store.js')

// The fixture token must come from the config only in these tests: make the
// ambient environment unable to point at a real profile or token.
delete process.env.EXCALIDRAW_MCP_TOKEN
delete process.env.DSH_PROFILE_DIR

const DOCUMENT = {
  type: 'excalidraw',
  version: 2,
  source: 'https://excalidraw.com',
  elements: [{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }],
  appState: { viewBackgroundColor: '#ffffff' },
  files: {},
}

function fakeRequest({ url = '/', method = 'GET', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  return {
    url,
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    ended: false,
    destroyed: false,
    writeHead(status, headers) {
      if (this.headersSent) throw new Error('headers already sent')
      this.statusCode = status
      this.headers = { ...headers }
      this.headersSent = true
      return this
    },
    end(data) {
      if (data !== undefined) this.body += Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
      this.ended = true
    },
    destroy() {
      this.destroyed = true
    },
  }
}

async function mount(t, options = {}) {
  const cwd = options.cwd ?? (await mkdtemp(join(tmpdir(), 'dsh-excalidraw-glue-')))
  if (options.cwd === undefined) t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))
  const state = {
    cwd,
    routes: [],
    tools: [],
    effects: [],
    disposers: [],
    logs: [],
  }
  const ctx = {
    effect(fn, label) {
      const disposer = fn()
      state.effects.push(label)
      if (typeof disposer === 'function') state.disposers.push(disposer)
      return disposer
    },
    webServer: {
      register(route) {
        state.routes.push(route)
        return () => {
          state.routes = state.routes.filter((candidate) => candidate !== route)
        }
      },
    },
    tools: {
      register(definition) {
        state.tools.push(definition)
        return () => {
          state.tools = state.tools.filter((candidate) => candidate !== definition)
        }
      },
    },
    connection: {
      requestRejection: () => (options.reject === true ? 403 : undefined),
    },
    sessions: {
      // The real DSH shape: `get(id)` returns a Session whose `header` carries
      // the id and cwd, and `list()` is a function returning `Session[]` (P2-2).
      get: (id) => (id === 'session-1' ? { header: { id: 'session-1', cwd }, id: 'session-1', snapshotEvents: () => [], seq: 1 } : undefined),
      list: options.listSessions === false
        ? undefined
        : () => [{ header: { id: 'session-1', cwd }, id: 'session-1', displayTitle: 'Test' }],
    },
    get(name) {
      if (name === 'workingDirectory') return { get: () => cwd }
      return undefined
    },
    logger: {
      info(...args) {
        state.logs.push(['info', args])
      },
      warn(...args) {
        state.logs.push(['warn', args])
      },
      debug(...args) {
        state.logs.push(['debug', args])
      },
    },
  }
  plugin.apply(ctx, options.config)
  return { ctx, state, cwd }
}

function routeOf(state, path) {
  const route = state.routes.find((candidate) => candidate.path === path)
  assert.ok(route !== undefined, `route ${path} should be registered`)
  return route
}

function toolOf(state, name) {
  const definition = state.tools.find((candidate) => candidate.name === name)
  assert.ok(definition !== undefined, `tool ${name} should be registered`)
  return definition
}

async function call(state, path, requestOptions = {}) {
  const response = fakeResponse()
  await routeOf(state, path).handler(fakeRequest({ url: path, ...requestOptions }), response)
  return response
}

function json(response) {
  return JSON.parse(response.body)
}

test('the plugin exports its cordis identity, Config schema and apply', () => {
  assert.equal(plugin.name, 'dsh-excalidraw')
  assert.deepEqual(plugin.inject, ['webServer', 'sessions', 'connection', 'tools'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'object')
  assert.deepEqual(Object.keys(plugin.Config.shape).sort(), [
    'autoOpen',
    'extraFontsDir',
    'maxSceneBytes',
    'mcpToken',
    'mcpUrl',
    'pollIntervalMs',
    'scenesDir',
  ])
})

test('apply registers seven exact routes, the font prefix and four tools', async (t) => {
  const { state } = await mount(t)
  assert.equal(state.routes.length, 8)
  const fontRoute = state.routes.find((route) => route.kind === 'prefix')
  assert.equal(fontRoute?.path, '/excalidraw/fonts')
  assert.equal(typeof fontRoute?.handler, 'function')
  assert.deepEqual(
    state.routes.filter((route) => route.kind === 'exact').map((route) => route.path).sort(),
    Object.values(ROUTE_PATHS).sort(),
  )
  assert.equal(new Set(state.routes.map((route) => route.path)).size, 8)
  for (const route of state.routes.filter((entry) => entry.kind === 'exact')) {
    assert.equal(route.kind, 'exact')
    assert.equal(typeof route.handler, 'function')
  }
  assert.deepEqual(state.tools.map((definition) => definition.name).sort(), ['excalidraw_export', 'excalidraw_import', 'excalidraw_open', 'excalidraw_refresh'])
  for (const definition of state.tools) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 40)
    assert.equal(typeof definition.parameters, 'object')
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.output.schema, 'object')
  }
  // The refresh tool's parameters are exactly the CONTRACT §4 input.
  assert.deepEqual(Object.keys(toolOf(state, 'excalidraw_refresh').parameters).sort(), ['name', 'sceneId', 'slug'])
  assert.deepEqual(Object.keys(toolOf(state, 'excalidraw_open').parameters), ['slug'])
  assert.deepEqual(Object.keys(toolOf(state, 'excalidraw_import').parameters).sort(), ['name', 'path', 'scene', 'slug'])
  assert.deepEqual(Object.keys(toolOf(state, 'excalidraw_export').parameters).sort(), ['format', 'slug'])
})

test('disposing every effect empties the registries', async (t) => {
  const { state } = await mount(t)
  assert.equal(state.routes.length, 8)
  assert.equal(state.tools.length, 4)
  for (const disposer of state.disposers.reverse()) disposer()
  assert.deepEqual(state.routes, [])
  assert.deepEqual(state.tools, [])
})

test('health answers without a scene store and flags an unconfigured MCP', async (t) => {
  const { state } = await mount(t)
  const response = await call(state, ROUTE_PATHS.health)
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.deepEqual(json(response), {
    ok: true,
    revision: 0,
    scenes: 0,
    mcp: { configured: false, url: 'https://api.excalidraw.com/api/v1/mcp' },
    store: '.dsh/excalidraw',
  })
})

test('health reports a configured token without ever echoing it', async (t) => {
  const { state } = await mount(t, { config: { mcpToken: 'sk-from-config' } })
  const response = await call(state, ROUTE_PATHS.health)
  const body = json(response)
  assert.equal(body.mcp.configured, true)
  assert.equal(response.body.includes('sk-from-config'), false)
  assert.deepEqual(Object.keys(body.mcp).sort(), ['configured', 'url'])
})

test('the browser gate refuses untrusted requests', async (t) => {
  const { state } = await mount(t, { reject: true })
  for (const path of Object.values(ROUTE_PATHS)) {
    const response = await call(state, path)
    assert.equal(response.statusCode, 403, path)
    assert.equal(json(response).error, 'forbidden')
    assert.equal(response.headers['cache-control'], 'no-store')
  }
})

test('wrong methods answer 405 with a JSON body', async (t) => {
  const { state } = await mount(t)
  const response = await call(state, ROUTE_PATHS.health, { method: 'POST' })
  assert.equal(response.statusCode, 405)
  assert.equal(json(response).error, 'bad-request')
  const refresh = await call(state, ROUTE_PATHS.refresh, { method: 'GET' })
  assert.equal(refresh.statusCode, 405)
})

test('session is accepted as sessionId (client spelling) and as session (contract spelling)', async (t) => {
  const { state } = await mount(t, { listSessions: false })
  // With no session list and no explicit id, every request is a no-session.
  assert.equal((await call(state, ROUTE_PATHS.scenes)).statusCode, 400)
  for (const parameter of ['sessionId', 'session']) {
    const response = await call(state, ROUTE_PATHS.scenes, { url: `${ROUTE_PATHS.scenes}?${parameter}=session-1` })
    assert.equal(response.statusCode, 200, `${parameter} query parameter`)
    assert.deepEqual(json(response), { revision: 0, items: [] })
    const rev = await call(state, ROUTE_PATHS.rev, { url: `${ROUTE_PATHS.rev}?${parameter}=session-1` })
    assert.equal(rev.statusCode, 200, `${parameter} on /rev`)
    assert.deepEqual(json(rev), { revision: 0, pollMs: 1500 })
    const refresh = await call(state, ROUTE_PATHS.refresh, {
      method: 'POST',
      body: { [parameter]: 'session-1', slug: 'architecture' },
    })
    // The session resolved, so the refusal is the missing token, not the session.
    assert.equal(refresh.statusCode, 400, `${parameter} in a refresh body`)
    assert.equal(json(refresh).ok, false)
    assert.equal(json(refresh).error, 'mcp-unconfigured')
  }
})

test('no session at all is a 400 no-session, never process.cwd()', async (t) => {
  const { state } = await mount(t, { listSessions: false })
  const response = await call(state, ROUTE_PATHS.scenes)
  assert.equal(response.statusCode, 400)
  assert.deepEqual(json(response), {
    error: 'no-session',
    message: 'no session: this request or tool call did not identify a conversation',
  })
})

test('a bare request uses the only session from the real ctx.sessions.list() shape (P2-2)', async (t) => {
  const { state } = await mount(t)
  const rev = await call(state, ROUTE_PATHS.rev)
  assert.equal(rev.statusCode, 200)
  assert.deepEqual(json(rev), { revision: 0, pollMs: 1500 })
  const scenes = await call(state, ROUTE_PATHS.scenes)
  assert.equal(scenes.statusCode, 200)
  assert.deepEqual(json(scenes), { revision: 0, items: [] })
  const health = await call(state, ROUTE_PATHS.health)
  assert.equal(health.statusCode, 200)
  assert.equal(json(health).store, '.dsh/excalidraw')
})

test('scenes/scene/rev expose a seeded scene with ETag and 304', async (t) => {
  const { state, cwd } = await mount(t)
  // Seed the same directory behind the plugin's back, exactly like an agent
  // `fs.write` would.
  const store = createStore({ root: join(cwd, '.dsh/excalidraw'), watch: false })
  const written = await store.writeScene({
    slug: 'architecture',
    name: 'Architecture',
    sceneId: 'scene-1',
    document: DOCUMENT,
  })
  store.close()
  assert.equal(written.elements, 1)

  const scenes = await call(state, ROUTE_PATHS.scenes)
  assert.equal(scenes.statusCode, 200)
  assert.equal(scenes.headers['cache-control'], 'no-store')
  assert.deepEqual(json(scenes), {
    revision: written.revision,
    items: [
      {
        slug: 'architecture',
        name: 'Architecture',
        sceneId: 'scene-1',
        elements: 1,
        updatedAt: written.updatedAt,
      },
    ],
  })

  const scene = await call(state, ROUTE_PATHS.scene, { url: `${ROUTE_PATHS.scene}?slug=architecture` })
  assert.equal(scene.statusCode, 200)
  assert.equal(scene.body, JSON.stringify(DOCUMENT), 'the stored document is served verbatim')
  assert.equal(scene.headers.etag, `"${written.revision}-architecture"`)
  assert.equal(scene.headers['cache-control'], 'no-store')
  assert.equal(scene.headers['content-type'], 'application/json; charset=utf-8')

  const notModified = await call(state, ROUTE_PATHS.scene, {
    url: `${ROUTE_PATHS.scene}?slug=architecture`,
    headers: { 'if-none-match': scene.headers.etag },
  })
  assert.equal(notModified.statusCode, 304)
  assert.equal(notModified.headers.etag, scene.headers.etag)
  assert.equal(notModified.headers['cache-control'], 'no-store')
  assert.equal(notModified.body, '')

  const rev = await call(state, ROUTE_PATHS.rev)
  assert.equal(rev.statusCode, 200)
  assert.deepEqual(json(rev), { revision: written.revision, pollMs: 1500 })
  assert.equal(rev.headers.etag, `"rev-${written.revision}"`)
  assert.equal(rev.headers['cache-control'], 'no-store')

  // /rev matches exactly the validator it issued (the bare revision while no
  // focus exists). A scene ETag must not match: its `<slug>` suffix is
  // ambiguous with a focus value (review round 3).
  const cachedRev = await call(state, ROUTE_PATHS.rev, { headers: { 'if-none-match': `"rev-${written.revision}"` } })
  assert.equal(cachedRev.statusCode, 304)
  const sceneEtagOnRev = await call(state, ROUTE_PATHS.rev, { headers: { 'if-none-match': `"${written.revision}-architecture"` } })
  assert.equal(sceneEtagOnRev.statusCode, 200, 'a scene ETag is not a /rev validator')
  const stale = await call(state, ROUTE_PATHS.rev, { headers: { 'if-none-match': '"999"' } })
  assert.equal(stale.statusCode, 200)

  const defaultSlug = await call(state, ROUTE_PATHS.scene)
  assert.equal(defaultSlug.statusCode, 200, 'the default slug is architecture')
  const unknown = await call(state, ROUTE_PATHS.scene, { url: `${ROUTE_PATHS.scene}?slug=missing` })
  assert.equal(unknown.statusCode, 400)
  assert.equal(json(unknown).error, 'no-scene')
  const escape = await call(state, ROUTE_PATHS.scene, { url: `${ROUTE_PATHS.scene}?slug=../../etc/passwd` })
  assert.equal(escape.statusCode, 400)
  assert.equal(json(escape).error, 'no-scene')
  assert.equal(escape.body.includes('/etc/passwd'), false)
  assert.equal(unknown.body.includes(cwd), false, 'a no-scene message never carries the workspace path (P2-1)')
})

test('GET /scene cannot 304 bytes it never served after an external rewrite (P1-1)', async (t) => {
  const { state, cwd } = await mount(t)
  const root = join(cwd, '.dsh/excalidraw')
  const seed = createStore({ root, watch: false })
  const first = await seed.writeScene({ slug: 'architecture', name: 'Architecture', document: DOCUMENT })
  seed.close()

  const initial = await call(state, ROUTE_PATHS.scene, { url: `${ROUTE_PATHS.scene}?slug=architecture` })
  assert.equal(initial.statusCode, 200)
  const etag = initial.headers.etag
  assert.equal(etag, `"${first.revision}-architecture"`)

  // An agent `fs.write` rewrites the scene without changing the element count.
  const edited = JSON.parse(JSON.stringify(DOCUMENT))
  edited.elements[0].x = 999
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(root, `architecture${SCENE_SUFFIX}`), JSON.stringify(edited))

  const after = await call(state, ROUTE_PATHS.scene, {
    url: `${ROUTE_PATHS.scene}?slug=architecture`,
    headers: { 'if-none-match': etag },
  })
  assert.equal(after.statusCode, 200, 'the ETag must move with the bytes')
  assert.equal(JSON.parse(after.body).elements[0].x, 999)
  assert.notEqual(after.headers.etag, etag)

  const rev = await call(state, ROUTE_PATHS.rev)
  assert.equal(rev.statusCode, 200)
  assert.ok(json(rev).revision > first.revision, 'the revision poll sees the external edit')
})

test('a focus pointer recorded after the poll invalidates the cached /rev ETag (P2-7)', async (t) => {
  const { state, cwd } = await mount(t)
  const root = join(cwd, '.dsh/excalidraw')
  const seed = createStore({ root, watch: false })
  const written = await seed.writeScene({ slug: 'architecture', name: 'Architecture', document: DOCUMENT })
  seed.close()

  const before = await call(state, ROUTE_PATHS.rev)
  assert.equal(before.statusCode, 200)
  assert.deepEqual(json(before), { revision: written.revision, pollMs: 1500 })
  assert.equal(before.headers.etag, `"rev-${written.revision}"`)
  const cached = await call(state, ROUTE_PATHS.rev, { headers: { 'if-none-match': before.headers.etag } })
  assert.equal(cached.statusCode, 304)

  // The refresh path records the focus pointer at the revision it just wrote.
  const focused = createStore({ root, watch: false })
  await focused.markFocus({ sessionId: 'session-1', at: written.revision })
  focused.close()

  const after = await call(state, ROUTE_PATHS.rev, { headers: { 'if-none-match': before.headers.etag } })
  assert.equal(after.statusCode, 200, 'a cached revision must not hide a new focus pointer')
  assert.deepEqual(json(after), { revision: written.revision, focus: { sessionId: 'session-1', at: written.revision }, pollMs: 1500 })
  assert.equal(after.headers.etag, `"rev-${written.revision}-${written.revision}"`)
  const settled = await call(state, ROUTE_PATHS.rev, { headers: { 'if-none-match': after.headers.etag } })
  assert.equal(settled.statusCode, 304)
})

test('the scene route honours the configured size cap', async (t) => {
  const { state, cwd } = await mount(t, { config: { maxSceneBytes: 1024 } })
  const store = createStore({ root: join(cwd, '.dsh/excalidraw'), watch: false, maxSceneBytes: 1_000_000 })
  await store.writeScene({ slug: 'architecture', name: 'Architecture', document: DOCUMENT })
  store.close()
  // Grow the file past the route's cap behind the store's back.
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(cwd, '.dsh/excalidraw', `architecture${SCENE_SUFFIX}`), 'x'.repeat(2048))
  const response = await call(state, ROUTE_PATHS.scene, { url: `${ROUTE_PATHS.scene}?slug=architecture` })
  assert.equal(response.statusCode, 413)
  assert.equal(json(response).error, 'scene-too-large')
})

test('refresh without a token is a 400 mcp-unconfigured and no network call', async (t) => {
  const { state } = await mount(t)
  const response = await call(state, ROUTE_PATHS.refresh, { method: 'POST', body: {} })
  assert.equal(response.statusCode, 400)
  assert.equal(json(response).ok, false, 'a refresh failure keeps the tool-result discriminant')
  assert.equal(json(response).error, 'mcp-unconfigured')
  assert.match(json(response).message, /token/)

  const badJson = await call(state, ROUTE_PATHS.refresh, { method: 'POST', body: '{ not json' })
  assert.equal(badJson.statusCode, 400)
  assert.equal(json(badJson).error, 'bad-request')
})

test('the tools answer with the canonical result and a text projection', async (t) => {
  const { state } = await mount(t, { listSessions: false })
  const refresh = toolOf(state, 'excalidraw_refresh')
  const result = await refresh.execute({}, { signal: { throwIfAborted() {} } })
  assert.deepEqual(result, {
    ok: false,
    error: 'no-session',
    message: 'no session: this request or tool call did not identify a conversation',
  })
  const rendered = refresh.output.render({}, result)
  assert.equal(Array.isArray(rendered), true)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /no-session/)

  const open = toolOf(state, 'excalidraw_open')
  const opened = await open.execute({}, { signal: { throwIfAborted() {} } })
  assert.equal(opened.ok, false)
  assert.equal(opened.error, 'no-session')
})

test('the tools observe the abort signal before any I/O', async (t) => {
  const { state } = await mount(t)
  for (const name of ['excalidraw_refresh', 'excalidraw_open']) {
    await assert.rejects(
      toolOf(state, name).execute({}, {
        signal: {
          throwIfAborted() {
            throw Object.assign(new Error('aborted'), { name: 'AbortError' })
          },
        },
      }),
      (error) => error.name === 'AbortError',
    )
  }
})

test('an aborted refresh writes nothing and records no focus (P2-3)', async (t) => {
  const { createServer } = await import('node:http')
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (message.method === 'initialize') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } },
        }))
        return
      }
      if (message.method === 'notifications/initialized') {
        response.writeHead(202)
        response.end()
        return
      }
      // Answer `tools/call` late enough for the caller to cancel first.
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { structuredContent: DOCUMENT },
        }))
      }, 300)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  })
  const { port } = server.address()
  const { state, cwd } = await mount(t, {
    config: { mcpUrl: `http://127.0.0.1:${port}/mcp`, mcpToken: 'sk-test-abort' },
  })
  const controller = new AbortController()
  const pending = toolOf(state, 'excalidraw_refresh').execute(
    { sceneId: 'scene-1' },
    { signal: controller.signal, agent: { session: { id: 'session-1' } } },
  )
  setTimeout(() => controller.abort(), 120)
  const error = await pending.catch((caught) => caught)
  assert.equal(error.name, 'AbortError', 'a cancelled call rejects instead of returning a result')
  assert.notEqual(error.code, 'mcp-error', 'a cancellation is not mislabelled as an MCP failure')
  // Let the server's late answer land: it must not be written.
  await new Promise((resolve) => setTimeout(resolve, 350))
  const entries = await readdir(join(cwd, '.dsh/excalidraw')).catch(() => [])
  assert.deepEqual(entries, [], 'no scene, meta or index is written after the abort')
})

test('a cancelled refresh never writes a payload it already fetched (P2-3)', async () => {
  const { createSceneService } = await import('../lib/tools.js')
  const controller = new AbortController()
  let wrote = false
  const store = {
    listScenes: async () => ({ revision: 0, scenes: [] }),
    writeScene: async () => {
      wrote = true
      return {}
    },
    markFocus: async () => {
      wrote = true
      return {}
    },
  }
  const service = createSceneService({
    config: { mcpUrl: 'http://example.invalid/mcp', scenesDir: '.dsh/excalidraw', autoOpen: true },
    resolveSession: async () => ({ sessionId: 'session-1', cwd: '/work' }),
    resolveToken: async () => ({ token: 't' }),
    storeFor: () => store,
    mcpFactory: async () => ({
      callTool: async () => {
        controller.abort()
        return { structuredContent: DOCUMENT }
      },
      close: async () => {},
    }),
  })
  const error = await service.refresh({ sessionId: 'session-1', sceneId: 'scene-1', signal: controller.signal }).catch((caught) => caught)
  assert.equal(error.name, 'AbortError')
  assert.equal(wrote, false, 'the pre-write check stops the store call')
})

test('a cancelled open does not record a focus pointer (P2-3)', async () => {
  const { createSceneService } = await import('../lib/tools.js')
  const controller = new AbortController()
  let marked = false
  const store = {
    listScenes: async () => ({
      revision: 1,
      scenes: [{ slug: 'architecture', file: 'architecture.excalidraw', sceneId: 's', name: 'A', elements: 1, updatedAt: 1 }],
    }),
    bump: async () => {
      controller.abort()
      return 2
    },
    markFocus: async () => {
      marked = true
      return { revision: 2, focus: {} }
    },
  }
  const service = createSceneService({
    config: { scenesDir: '.dsh/excalidraw', autoOpen: true },
    resolveSession: async () => ({ sessionId: 'session-1', cwd: '/work' }),
    resolveToken: async () => ({ token: '' }),
    storeFor: () => store,
  })
  const error = await service.open({ sessionId: 'session-1', signal: controller.signal }).catch((caught) => caught)
  assert.equal(error.name, 'AbortError')
  assert.equal(marked, false, 'the pre-focus check stops the focus write')
})

test('read-only routes leave the store empty and writes stay under <cwd>/<scenesDir>', async (t) => {
  const { state, cwd } = await mount(t)
  const { readdir } = await import('node:fs/promises')
  await call(state, ROUTE_PATHS.health)
  await call(state, ROUTE_PATHS.scenes)
  await call(state, ROUTE_PATHS.rev)
  // Touching the store starts a watcher that creates the directory, but a
  // read must never materialize a scene document or an index.
  const entries = await readdir(join(cwd, '.dsh/excalidraw')).catch(() => [])
  assert.deepEqual(entries, [])
  const store = createStore({ root: join(cwd, '.dsh/excalidraw'), watch: false })
  await store.writeScene({ slug: 'architecture', name: 'Architecture', document: DOCUMENT })
  store.close()
  assert.deepEqual((await readdir(join(cwd, '.dsh/excalidraw'))).sort(), [
    'architecture.excalidraw',
    'architecture.meta.json',
    'index.json',
  ])
})


test('refresh without arguments reuses the stored scene id AND its slug (regression)', async (t) => {
  const { createSceneService } = await import('../lib/tools.js')
  const calls = []
  const writes = []
  const store = {
    listScenes: async () => ({
      revision: 5,
      scenes: [{ slug: 'wireframe', file: 'wireframe.excalidraw', sceneId: 'scene-stored', name: 'Wireframe', elements: 1, updatedAt: 5 }],
    }),
    writeScene: async (input) => {
      writes.push({ slug: input.slug, sceneId: input.sceneId })
      return { slug: input.slug, file: `${input.slug}.excalidraw`, elements: 1, revision: 6, updatedAt: 6 }
    },
    markFocus: async () => ({ revision: 6 }),
    snapshot: async () => ({ revision: 6 }),
  }
  const service = createSceneService({
    config: { mcpUrl: 'http://example.invalid/mcp', scenesDir: '.dsh/excalidraw', autoOpen: false },
    resolveSession: async () => ({ sessionId: 'session-1', cwd: '/work' }),
    resolveToken: async () => ({ token: 't' }),
    storeFor: () => store,
    mcpFactory: async () => ({
      callTool: async (name, args) => {
        calls.push([name, args])
        return { structuredContent: DOCUMENT }
      },
      close: async () => {},
    }),
  })
  const result = await service.refresh({ sessionId: 'session-1' })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [['get_scene_content', { sceneId: 'scene-stored' }]], 'the stored sceneId is reused')
  assert.deepEqual(writes, [{ slug: 'wireframe', sceneId: 'scene-stored' }], 'the stored slug is reused, not the default')
})

test('open without a slug opens the newest stored scene, whatever its slug is (regression)', async (t) => {
  const { createSceneService } = await import('../lib/tools.js')
  const store = {
    listScenes: async () => ({
      revision: 3,
      scenes: [
        { slug: 'old', file: 'old.excalidraw', sceneId: 'a', name: 'Old', elements: 1, updatedAt: 1 },
        { slug: 'newest', file: 'newest.excalidraw', sceneId: 'b', name: 'Newest', elements: 1, updatedAt: 2 },
      ],
    }),
    bump: async () => 4,
    markFocus: async () => ({ revision: 4 }),
  }
  const service = createSceneService({
    config: { mcpUrl: 'http://example.invalid/mcp', scenesDir: '.dsh/excalidraw', autoOpen: false },
    resolveSession: async () => ({ sessionId: 'session-1', cwd: '/work' }),
    resolveToken: async () => ({ token: 't' }),
    storeFor: () => store,
  })
  const result = await service.open({ sessionId: 'session-1' })
  assert.equal(result.ok, true)
  assert.equal(result.slug, 'newest')
})


test('excalidraw_export renders the stored scene to an SVG file (round 5)', async (t) => {
  const { state, cwd } = await mount(t)
  const seed = createStore({ root: join(cwd, '.dsh/excalidraw'), watch: false })
  await seed.writeScene({ slug: 'architecture', name: 'Architecture', sceneId: 'scene-1', document: DOCUMENT })
  seed.close()

  const exported = await toolOf(state, 'excalidraw_export').execute({}, { signal: { throwIfAborted() {} } })
  assert.equal(exported.ok, true, JSON.stringify(exported))
  assert.equal(exported.format, 'svg')
  assert.equal(exported.slug, 'architecture')
  assert.match(exported.file, /\.dsh\/excalidraw\/architecture\.svg$/)
  assert.ok(exported.bytes > 100)
  const svg = await readFile(join(cwd, '.dsh/excalidraw/architecture.svg'), 'utf8')
  assert.match(svg, /^<svg /)
  assert.match(svg, /<\/svg>/)
  assert.equal(exported.elements, DOCUMENT.elements.length)

  // PNG is a browser-side action; the host refuses the format instead of
  // silently writing something else.
  const png = await toolOf(state, 'excalidraw_export').execute({ format: 'png' }, { signal: { throwIfAborted() {} } })
  assert.equal(png.ok, false)
  assert.equal(png.error, 'bad-request')

  // An unknown slug is a clean no-scene refusal.
  const missing = await toolOf(state, 'excalidraw_export').execute({ slug: 'nope' }, { signal: { throwIfAborted() {} } })
  assert.equal(missing.ok, false)
  assert.equal(missing.error, 'no-scene')
})

test('a refresh by slug pulls THAT scene id and cannot overwrite another scene (round 5 P0)', async (t) => {
  const { createServer } = await import('node:http')
  const calls = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (message.method === 'tools/call') {
        calls.push({ name: message.params?.name, args: message.params?.arguments })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { structuredContent: { ...DOCUMENT, elements: [{ id: 'pulled', type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }] } },
        }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id ?? null,
        result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stub', version: '0' } },
      }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  })
  const { port } = server.address()
  const { state, cwd } = await mount(t, {
    config: { mcpUrl: `http://127.0.0.1:${port}/mcp`, mcpToken: 'sk-test-round5' },
  })
  const seed = createStore({ root: join(cwd, '.dsh/excalidraw'), watch: false })
  await seed.writeScene({ slug: 'alpha', name: 'Alpha', sceneId: 'scene-A', document: DOCUMENT })
  await seed.writeScene({ slug: 'beta', name: 'Beta', sceneId: 'scene-B', document: DOCUMENT })
  seed.close()

  const result = await toolOf(state, 'excalidraw_refresh').execute(
    { slug: 'alpha', sceneId: 'scene-A' },
    { signal: { throwIfAborted() {} }, agent: { session: { id: 'session-1' } } },
  )
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(calls[0].args, { sceneId: 'scene-A' }, 'the id of the requested scene is pulled')

  const store = createStore({ root: join(cwd, '.dsh/excalidraw'), watch: false })
  const listed = await store.listScenes()
  assert.deepEqual(listed.scenes.map((entry) => entry.slug).sort(), ['alpha', 'beta'], 'no scene appeared or vanished')
  const alpha = JSON.parse((await store.readScene('alpha')).text)
  assert.equal(alpha.elements[0].id, 'pulled', 'alpha really was refreshed')
  const beta = JSON.parse((await store.readScene('beta')).text)
  assert.deepEqual(beta, DOCUMENT, 'beta was not overwritten')
  store.close()

  // A scene id that belongs to another slug is refused instead of overwriting.
  const mismatch = await toolOf(state, 'excalidraw_refresh').execute(
    { slug: 'alpha', sceneId: 'scene-B' },
    { signal: { throwIfAborted() {} }, agent: { session: { id: 'session-1' } } },
  )
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.error, 'bad-request')
})

test('an id from another slug is refused, a re-point of the same slug is allowed (rounds 5+7)', async (t) => {
  const { createServer } = await import('node:http')
  const calls = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (message.method === 'tools/call') {
        calls.push(message.params?.arguments)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: DOCUMENT } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, result: { protocolVersion: '2025-06-18', capabilities: {} } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  })
  const { port } = server.address()
  const { state, cwd } = await mount(t, { config: { mcpUrl: `http://127.0.0.1:${port}/mcp`, mcpToken: 'sk-test-round7' } })
  const seed = createStore({ root: join(cwd, '.dsh/excalidraw'), watch: false })
  await seed.writeScene({ slug: 'alpha', name: 'Alpha', sceneId: 'scene-A', document: DOCUMENT })
  await seed.writeScene({ slug: 'beta', name: 'Beta', sceneId: 'scene-B', document: DOCUMENT })
  seed.close()
  const exec = { signal: { throwIfAborted() {} }, agent: { session: { id: 'session-1' } } }

  // An id that belongs to another slug is a mistake, not an overwrite.
  const cross = await toolOf(state, 'excalidraw_refresh').execute({ slug: 'alpha', sceneId: 'scene-B' }, exec)
  assert.equal(cross.ok, false)
  assert.equal(cross.error, 'bad-request')
  assert.deepEqual(calls, [], 'nothing is pulled for a foreign id')

  // The slug's own current id is what the UI path pulls (it sends no id).
  const ui = await toolOf(state, 'excalidraw_refresh').execute({ slug: 'alpha' }, exec)
  assert.equal(ui.ok, true, JSON.stringify(ui))
  assert.deepEqual(calls[0], { sceneId: 'scene-A' }, 'the id is resolved from the slug')

  // Deliberately re-pointing a slug is allowed: that is an agent's intent.
  const repoint = await toolOf(state, 'excalidraw_refresh').execute({ slug: 'alpha', sceneId: 'scene-C' }, exec)
  assert.equal(repoint.ok, true, JSON.stringify(repoint))
  assert.deepEqual(calls[1], { sceneId: 'scene-C' })
  const check = createStore({ root: join(cwd, '.dsh/excalidraw'), watch: false })
  assert.deepEqual((await check.listScenes()).scenes.find((entry) => entry.slug === 'alpha').sceneId, 'scene-C')
  check.close()
})

test('the default scene is the newest by updatedAt, even after an index rebuild reorders it (round 7)', async (t) => {
  const { state, cwd } = await mount(t)
  const seed = createStore({ root: join(cwd, '.dsh/excalidraw'), watch: false })
  await seed.writeScene({ slug: 'aaa', name: 'Aaa', sceneId: 's1', document: DOCUMENT })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await seed.writeScene({ slug: 'zzz', name: 'Zzz', sceneId: 's2', document: { ...DOCUMENT, elements: [{ id: 'zzz', type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }] } })
  seed.close()
  // A rebuild lists the scenes in directory order, which is NOT time order.
  await writeFile(join(cwd, '.dsh/excalidraw/index.json'), '{ corrupt')

  const exported = await toolOf(state, 'excalidraw_export').execute({}, { signal: { throwIfAborted() {} } })
  assert.equal(exported.ok, true, JSON.stringify(exported))
  assert.equal(exported.slug, 'zzz', 'the newest scene wins, not the alphabetically last')
})

test('the exported SVG carries the fonts the scene draws with (round 10)', async (t) => {
  const { state, cwd } = await mount(t)
  const withText = {
    ...DOCUMENT,
    elements: [
      { id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
      { id: 'b', type: 'text', x: 1, y: 1, width: 9, height: 9, text: 'hi', fontFamily: 8 },
    ],
  }
  const seed = createStore({ root: join(cwd, '.dsh/excalidraw'), watch: false })
  await seed.writeScene({ slug: 'architecture', name: 'A', sceneId: 's', document: withText })
  seed.close()
  const exported = await toolOf(state, 'excalidraw_export').execute({}, { signal: { throwIfAborted() {} } })
  assert.equal(exported.ok, true, JSON.stringify(exported))
  const svg = await readFile(join(cwd, '.dsh/excalidraw/architecture.svg'), 'utf8')
  assert.match(svg, /^<svg[^>]*><metadata>[^<]*dsh-excalidraw/)
  assert.match(svg, /<style type="text\/css"><!\[CDATA\[@font-face/)
  assert.match(svg, /font-family:'Comic Shanns'/)
  assert.match(svg, /data:font\/woff2;base64,/)
  assert.equal(/font-family:'Lilita One'/.test(svg), false, 'unused families are not embedded')
  // A scene with no text gets no style element at all.
  const plain = createStore({ root: join(cwd, '.dsh/excalidraw'), watch: false })
  await plain.writeScene({ slug: 'plain', name: 'P', sceneId: 'p2', document: DOCUMENT })
  plain.close()
  const tool2 = await toolOf(state, 'excalidraw_export').execute({ slug: 'plain' }, { signal: { throwIfAborted() {} } })
  assert.equal(tool2.ok, true, JSON.stringify(tool2))
  const svg2 = await readFile(join(cwd, '.dsh/excalidraw/plain.svg'), 'utf8')
  assert.equal(svg2.includes('<style'), false, 'no text means no embedded fonts')
})

test('exports embed a shipped font for every drawn family, including 5 (round 10 P1)', async (t) => {
  const { state, cwd } = await mount(t)
  const sceneFor = (fontFamily) => ({
    ...DOCUMENT,
    elements: [
      { id: 'r', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
      { id: 't', type: 'text', x: 1, y: 1, width: 9, height: 9, text: 'x', fontFamily },
    ],
  })
  for (const [fontFamily, family] of [[1, 'Virgil'], [5, 'Virgil'], [7, 'Lilita One'], [8, 'Comic Shanns']]) {
    const seed = createStore({ root: join(cwd, '.dsh/excalidraw'), watch: false })
    await seed.writeScene({ slug: 's' + fontFamily, name: 'S', sceneId: 'id' + fontFamily, document: sceneFor(fontFamily) })
    seed.close()
    const exported = await toolOf(state, 'excalidraw_export').execute({ slug: 's' + fontFamily }, { signal: { throwIfAborted() {} } })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    const svg = await readFile(join(cwd, `.dsh/excalidraw/s${fontFamily}.svg`), 'utf8')
    assert.match(svg, new RegExp(`font-family:'${family}'`), `family ${fontFamily} must embed ${family}`)
  }
})

test('a deleted text element does not drag its font into an export (round 10)', async (t) => {
  const { state, cwd } = await mount(t)
  const seed = createStore({ root: join(cwd, '.dsh/excalidraw'), watch: false })
  await seed.writeScene({
    slug: 'gone',
    name: 'G',
    sceneId: 'g',
    document: {
      ...DOCUMENT,
      elements: [
        { id: 'r', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
        { id: 't', type: 'text', x: 1, y: 1, width: 9, height: 9, text: 'gone', fontFamily: 8, isDeleted: true },
      ],
    },
  })
  seed.close()
  const exported = await toolOf(state, 'excalidraw_export').execute({ slug: 'gone' }, { signal: { throwIfAborted() {} } })
  assert.equal(exported.ok, true, JSON.stringify(exported))
  const svg = await readFile(join(cwd, '.dsh/excalidraw/gone.svg'), 'utf8')
  assert.equal(svg.includes('@font-face'), false, 'a deleted text must not embed a font')
})

test('a second mount of the same plugin warns instead of failing the web boot (round 11)', async (t) => {
  const { ctx, state } = await mount(t)
  // Make the fake server behave like DSH's: a duplicate path throws.
  const seen = new Set(state.routes.map((route) => route.path))
  state.routes.length = 0
  const originalRegister = ctx.webServer.register
  ctx.webServer.register = (route) => {
    if (seen.has(route.path)) throw new Error(`route already mounted: ${route.path}`)
    seen.add(route.path)
    return originalRegister(route)
  }
  const plugin = (await import('../index.js')).default ?? (await import('../index.js'))
  // Second mount: must not throw, must warn once per duplicate, and must keep
  // the first registration (the guard returns a no-op disposer).
  plugin.apply(ctx, {})
  const warnings = state.logs.filter(([level, args]) => level === 'warn' && String(args[0]).includes('already mounted'))
  assert.equal(warnings.length, 8, 'one warning per duplicate exact route plus the font prefix')
})


test('the host half reads no undeclared service property (cordis guard, round 14)', async (t) => {
  const { ctx, state } = await mount(t)
  // Wrap the harness ctx the way cordis 4 behaves: a property that is not a
  // declared service (or a core member) throws instead of returning undefined.
  const allowed = new Set(['effect', 'inject', 'get', 'logger', 'on', 'off', 'emit', 'set', 'provide',
    'webServer', 'sessions', 'connection', 'tools'])
  const proxy = new Proxy(ctx, {
    get(target, property) {
      if (typeof property === 'symbol' || allowed.has(property)) return target[property]
      throw new Error(`cannot get property "${String(property)}" without inject`)
    },
  })
  const plugin = (await import('../index.js')).default ?? (await import('../index.js'))
  // Re-applying with the strict ctx must not read anything undeclared.
  assert.doesNotThrow(() => plugin.apply(proxy, {}))
  assert.ok(state.routes.length >= 8)
})

test('a user-supplied font is embedded in an export when the scene names it (round 17)', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-xcal-extrafont-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))
  await writeFile(join(dir, 'Excalifont-Regular.woff2'), Buffer.from('wOF2-user-excalifont'))
  await writeFile(join(dir, 'fonts.json'), JSON.stringify({ fonts: [{ family: 'Excalifont', file: 'Excalifont-Regular.woff2' }] }))
  const { state, cwd } = await mount(t, { config: { extraFontsDir: dir } })
  const seed = createStore({ root: join(cwd, '.dsh/excalidraw'), watch: false })
  await seed.writeScene({
    slug: 'f5',
    name: 'F5',
    sceneId: 'f5',
    document: { ...DOCUMENT, elements: [{ id: 't', type: 'text', x: 0, y: 0, width: 9, height: 9, text: 'hi', fontFamily: 5 }] },
  })
  seed.close()
  const exported = await toolOf(state, 'excalidraw_export').execute({ slug: 'f5' }, { signal: { throwIfAborted() {} } })
  assert.equal(exported.ok, true, JSON.stringify(exported))
  const svg = await readFile(join(cwd, '.dsh/excalidraw/f5.svg'), 'utf8')
  assert.match(svg, /font-family:'Excalifont';src:url\(data:font\/woff2;base64,d09GMi11c2VyLWV4Y2FsaWZvbnQ=/, 'the user font bytes are embedded')
  assert.match(svg, /font-family:'Virgil'/, 'the bundled fallback stays too')
  assert.match(svg, /Embedded fonts: Excalifont; Virgil/, 'the notice names both')
})

test('excalidraw_import stores a local scene without any token or network (round 21)', async (t) => {
  const { state, cwd } = await mount(t, { config: { mcpToken: '' } })
  const importTool = toolOf(state, 'excalidraw_import')
  const document = {
    type: 'excalidraw',
    elements: [
      { id: 'r1', type: 'rectangle', x: 0, y: 0, width: 120, height: 60 },
      { id: 't1', type: 'text', x: 10, y: 10, width: 60, height: 20, text: 'hi', fontFamily: 5 },
    ],
  }
  const imported = await importTool.execute({ scene: document, name: 'Local diagram' }, { signal: { throwIfAborted() {} } })
  assert.equal(imported.ok, true, JSON.stringify(imported))
  assert.equal(imported.slug, 'local-diagram')
  assert.equal(imported.elements, 2)
  assert.ok(imported.revision > 0)
  assert.equal(imported.opened, true, 'autoOpen records the focus pointer')
  // The file is a real Excalidraw document on disk, and the export path sees it.
  const stored = JSON.parse(await readFile(join(cwd, '.dsh/excalidraw/local-diagram.excalidraw'), 'utf8'))
  assert.equal(stored.elements.length, 2)
  const exported = await toolOf(state, 'excalidraw_export').execute({ slug: 'local-diagram' }, { signal: { throwIfAborted() {} } })
  assert.equal(exported.ok, true, JSON.stringify(exported))
  assert.ok((await readFile(join(cwd, '.dsh/excalidraw/local-diagram.svg'), 'utf8')).includes('<svg'))
})

test('excalidraw_import reads a workspace file and refuses bad input (round 21)', async (t) => {
  const { state, cwd } = await mount(t)
  const importTool = toolOf(state, 'excalidraw_import')
  const dir = join(cwd, 'diagrams')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'flow.excalidraw'), JSON.stringify({ type: 'excalidraw', elements: [{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }] }))
  const fromFile = await importTool.execute({ path: 'diagrams/flow.excalidraw' }, { signal: { throwIfAborted() {} } })
  assert.equal(fromFile.ok, true, JSON.stringify(fromFile))
  assert.equal(fromFile.slug, 'flow')
  assert.equal(fromFile.elements, 1)

  // Nothing to import, or two sources at once.
  assert.equal((await importTool.execute({}, {})).error, 'bad-request')
  assert.equal((await importTool.execute({ path: 'diagrams/flow.excalidraw', scene: { elements: [] } }, {})).error, 'bad-request')
  // A malformed / non-scene document.
  assert.equal((await importTool.execute({ scene: { elements: 'nope' } }, {})).error, 'bad-request')
  await writeFile(join(cwd, 'broken.json'), '{not json')
  assert.equal((await importTool.execute({ path: 'broken.json' }, {})).error, 'bad-request')
  // A path outside the workspace is refused, absolute or relative.
  assert.equal((await importTool.execute({ path: '/etc/passwd' }, {})).error, 'bad-request')
  assert.equal((await importTool.execute({ path: '../../escape.excalidraw' }, {})).error, 'bad-request')
  // A missing file and an over-sized file are reported without writing anything.
  assert.equal((await importTool.execute({ path: 'diagrams/nope.excalidraw' }, {})).error, 'bad-request')
  const limited = await mount(t, { config: { maxSceneBytes: 1024 } })
  const limitedImport = toolOf(limited.state, 'excalidraw_import')
  await writeFile(join(limited.cwd, 'huge.excalidraw'), 'x'.repeat(2048))
  assert.equal((await limitedImport.execute({ path: 'huge.excalidraw' }, {})).error, 'scene-too-large')
})

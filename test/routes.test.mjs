/**
 * Route-level tests for the pieces the glue test cannot reach: the request
 * handlers are called directly with fake request/response objects, so the
 * session-parameter alias, the ETag/304 path and the browser fence are covered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoutes, ROUTE_PATHS } from '../lib/routes.js';

function fakeResponse() {
  const state = { status: 0, headers: {}, body: '' };
  return {
    state,
    headersSent: false,
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers ?? {};
      this.headersSent = true;
      return this;
    },
    end(body) {
      state.body = body ?? '';
    },
    destroy() {},
  };
}

function fakeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function makeRoutes({ resolveSession, snapshot = { revision: 7 } } = {}) {
  const seen = [];
  const stores = new Map();
  const storeFor = (cwd) => {
    seen.push(cwd);
    if (!stores.has(cwd)) stores.set(cwd, { snapshot: async () => snapshot, listScenes: async () => ({ revision: snapshot.revision, scenes: [] }), readScene: async () => ({ text: '{}' }) });
    return stores.get(cwd);
  };
  const routes = createRoutes({
    config: { scenesDir: '.dsh/excalidraw', autoOpen: true },
    connection: { requestRejection: () => undefined },
    resolveSession: resolveSession ?? (async (sessionId) => ({ sessionId: sessionId ?? 'recent', cwd: '/work/' + (sessionId ?? 'recent') })),
    resolveToken: async () => ({ token: '' }),
    refresh: async (input) => ({ ok: true, slug: input.slug ?? 'architecture', elements: 0, revision: 1 }),
    storeFor,
    logger: { warn() {}, debug() {} },
  });
  return { routes, seen };
}

test('GET /rev resolves the session from the sessionId alias and sends an ETag', async () => {
  const { routes, seen } = makeRoutes();
  const response = fakeResponse();
  await routes.rev(fakeRequest({ url: ROUTE_PATHS.rev + '?sessionId=session-abc' }), response);
  assert.equal(response.state.status, 200);
  assert.deepEqual(seen, ['/work/session-abc']);
  assert.equal(JSON.parse(response.state.body).revision, 7);
  assert.equal(response.state.headers.etag, '"rev-7"');
});

test("GET /rev also accepts the contract spelling of the session parameter", async () => {
  const { routes, seen } = makeRoutes();
  const response = fakeResponse();
  await routes.rev(fakeRequest({ url: ROUTE_PATHS.rev + '?session=session-xyz' }), response);
  assert.equal(response.state.status, 200);
  assert.deepEqual(seen, ['/work/session-xyz']);
});

test('GET /rev answers 304 when if-none-match matches the revision ETag', async () => {
  const { routes } = makeRoutes();
  const response = fakeResponse();
  await routes.rev(fakeRequest({ url: ROUTE_PATHS.rev, headers: { 'if-none-match': '"rev-7"' } }), response);
  assert.equal(response.state.status, 304);
  assert.equal(response.state.body, '');
});

test('GET /rev accepts only validators it could have issued (P2-7)', async () => {
  const { routes } = makeRoutes({ snapshot: { revision: 7, focus: { sessionId: 's', at: 7 } } });

  const fresh = fakeResponse();
  await routes.rev(fakeRequest({ url: ROUTE_PATHS.rev }), fresh);
  assert.equal(fresh.state.status, 200);
  assert.equal(fresh.state.headers.etag, '"rev-7-7"');
  assert.deepEqual(JSON.parse(fresh.state.body), { revision: 7, focus: { sessionId: 's', at: 7 }, pollMs: 1500 });

  // A client that cached the bare revision before the focus was recorded must
  // fetch again instead of being told "not modified".
  const stale = fakeResponse();
  await routes.rev(fakeRequest({ url: ROUTE_PATHS.rev, headers: { 'if-none-match': '"7"' } }), stale);
  assert.equal(stale.state.status, 200);
  assert.equal(JSON.parse(stale.state.body).focus.at, 7);

  // Exactly the validator /rev just issued matches…
  const cached = fakeResponse();
  await routes.rev(fakeRequest({ url: ROUTE_PATHS.rev, headers: { 'if-none-match': '"rev-7-7"' } }), cached);
  assert.equal(cached.state.status, 304);
  assert.equal(cached.state.headers.etag, '"rev-7-7"');

  // …a scene ETag does NOT: `"<revision>-<slug>"` shares the prefix, and a
  // numeric slug is indistinguishable from a focus value (review round 3).
  for (const etag of ['"7-architecture"', '"rev-7"', '"7"', '"7-7"']) {
    const sceneEtag = fakeResponse();
    await routes.rev(fakeRequest({ url: ROUTE_PATHS.rev, headers: { 'if-none-match': etag } }), sceneEtag);
    assert.equal(sceneEtag.state.status, 200, etag);
  }

  // An older focus value is stale too.
  const other = fakeResponse();
  await routes.rev(fakeRequest({ url: ROUTE_PATHS.rev, headers: { 'if-none-match': '"7-6"' } }), other);
  assert.equal(other.state.status, 200);
});

test('a request that fails the browser fence is refused with 403', async () => {
  const routes = createRoutes({
    config: { scenesDir: '.dsh/excalidraw' },
    connection: { requestRejection: () => ({ reason: 'untrusted-origin' }) },
    resolveSession: async () => ({ cwd: '/work' }),
    resolveToken: async () => ({ token: '' }),
    refresh: async () => ({ ok: true }),
    storeFor: () => ({ snapshot: async () => ({ revision: 1 }) }),
    logger: { warn() {} },
  });
  const response = fakeResponse();
  await routes.rev(fakeRequest({ url: ROUTE_PATHS.rev }), response);
  assert.equal(response.state.status, 403);
  assert.equal(JSON.parse(response.state.body).error, 'forbidden');
});

test('POST /refresh answers an internal failure without its path or detail (P2-1)', async () => {
  const logs = [];
  const routes = createRoutes({
    config: { scenesDir: '.dsh/excalidraw' },
    connection: { requestRejection: () => undefined },
    resolveSession: async () => ({ sessionId: 's', cwd: '/work' }),
    resolveToken: async () => ({ token: 't' }),
    refresh: async () => ({
      ok: false,
      error: 'internal',
      message: "ENOENT: no such file or directory, rename '/Users/alice/secret-project/.dsh/excalidraw/index.json.tmp'",
    }),
    storeFor: () => ({ snapshot: async () => ({ revision: 1 }) }),
    logger: { warn: (message) => logs.push(String(message)) },
  });
  const response = fakeResponse();
  await routes.refresh(fakeRequest({ method: 'POST', url: ROUTE_PATHS.refresh, body: {} }), response);
  assert.equal(response.state.status, 500);
  assert.deepEqual(JSON.parse(response.state.body), { ok: false, error: 'internal', message: 'internal error' });
  assert.equal(response.state.body.includes('/Users/alice'), false, 'no absolute path reaches the browser');
  assert.equal(response.state.body.includes('index.json.tmp'), false);
  assert.equal(logs.some((line) => line.includes('/Users/alice/secret-project')), true, 'the detail goes to the log instead');
});

test('POST /refresh forwards the body sessionId and the sceneId to the tool result', async () => {
  const calls = [];
  const routes = createRoutes({
    config: { scenesDir: '.dsh/excalidraw' },
    connection: { requestRejection: () => undefined },
    resolveSession: async (sessionId) => ({ sessionId, cwd: '/work' }),
    resolveToken: async () => ({ token: 't' }),
    refresh: async (input) => { calls.push(input); return { ok: true, slug: 'architecture', revision: 3, elements: 47 }; },
    storeFor: () => ({ snapshot: async () => ({ revision: 1 }) }),
    logger: { warn() {} },
  });
  const response = fakeResponse();
  await routes.refresh(fakeRequest({ method: 'POST', url: ROUTE_PATHS.refresh, body: { sessionId: 'session-1', sceneId: '6gbUPPB8Q7X' } }), response);
  assert.equal(response.state.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    { sessionId: calls[0].sessionId, sceneId: calls[0].sceneId, slug: calls[0].slug, name: calls[0].name },
    { sessionId: 'session-1', sceneId: '6gbUPPB8Q7X', slug: undefined, name: undefined },
  );
  assert.equal(typeof calls[0].signal?.aborted, 'boolean', 'the route hands a real AbortSignal to the tool');
});


test('GET /focus reports the newest pointer across every mounted workspace (round 8)', async () => {
  const routes = createRoutes({
    config: { scenesDir: '.dsh/excalidraw' },
    connection: { requestRejection: () => undefined },
    resolveSession: async () => ({ sessionId: 's', cwd: '/work' }),
    resolveToken: async () => ({ token: '' }),
    refresh: async () => ({ ok: true }),
    storeFor: () => ({ snapshot: async () => ({ revision: 1 }) }),
    listFocuses: async () => [
      { sessionId: 'old', at: 10 },
      { sessionId: 'newest', at: 30 },
      { sessionId: 'middle', at: 20 },
      null,
      { sessionId: 'broken' },
    ],
    logger: { warn() {} },
  })
  const response = fakeResponse();
  await routes.focus(fakeRequest({ url: ROUTE_PATHS.focus }), response);
  assert.equal(response.state.status, 200);
  assert.deepEqual(JSON.parse(response.state.body), { focus: { sessionId: 'newest', at: 30 } });
  assert.equal(response.state.headers['cache-control'], 'no-store');
})

test('GET /focus answers null when no workspace has a pointer, and fences untrusted callers', async () => {
  const make = (reject) => createRoutes({
    config: { scenesDir: '.dsh/excalidraw' },
    connection: { requestRejection: () => (reject ? { reason: 'bad' } : undefined) },
    resolveSession: async () => ({ sessionId: 's', cwd: '/work' }),
    resolveToken: async () => ({ token: '' }),
    refresh: async () => ({ ok: true }),
    storeFor: () => ({ snapshot: async () => ({ revision: 1 }) }),
    listFocuses: async () => [],
    logger: { warn() {} },
  })
  const empty = fakeResponse();
  await make(false).focus(fakeRequest({ url: ROUTE_PATHS.focus }), empty);
  assert.deepEqual(JSON.parse(empty.state.body), { focus: null })

  const refused = fakeResponse();
  await make(true).focus(fakeRequest({ url: ROUTE_PATHS.focus }), refused);
  assert.equal(refused.state.status, 403)
})

test('fonts are served from the package with an immutable cache (CONTRACT §6)', async () => {
  const { createFontHandler, FONT_ROUTE_PREFIX } = await import('../lib/routes.js')
  const { readFont, listFonts } = await import('../lib/fonts.js')
  const fonts = await listFonts()
  assert.ok(fonts.length >= 1)
  const handler = createFontHandler({
    findFont: async (name) => fonts.find((font) => font.file === name),
    readFont,
    connection: { requestRejection: () => undefined },
    logger: {},
  })
  const font = fonts[0]
  const response = fakeResponse()
  await handler(fakeRequest({ url: FONT_ROUTE_PREFIX + encodeURIComponent(font.file) }), response)
  assert.equal(response.state.status, 200)
  assert.equal(response.state.headers['content-type'], 'font/woff2')
  assert.equal(response.state.headers['cache-control'], 'public, max-age=31536000, immutable')
  const bytes = Buffer.isBuffer(response.state.body) ? response.state.body : Buffer.from(response.state.body)
  assert.equal(bytes.length, font.bytes)
  assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2')

  const missing = fakeResponse()
  await handler(fakeRequest({ url: FONT_ROUTE_PREFIX + 'nope.woff2' }), missing)
  assert.equal(missing.state.status, 404)

  const posted = fakeResponse()
  await handler(fakeRequest({ url: FONT_ROUTE_PREFIX + font.file, method: 'POST' }), posted)
  assert.equal(posted.state.status, 405)

  const untrusted = fakeResponse()
  const refusal = createFontHandler({
    findFont: async () => font, readFont,
    connection: { requestRejection: () => ({ reason: 'bad' }) },
    logger: {},
  })
  await refusal(fakeRequest({ url: FONT_ROUTE_PREFIX + font.file }), untrusted)
  assert.equal(untrusted.state.status, 403)
})

test('every font manifest entry decodes to its recorded digest', async () => {
  const { listFonts, readFont } = await import('../lib/fonts.js')
  for (const font of await listFonts()) {
    const bytes = await readFont(font.file)
    assert.equal(bytes.length, font.bytes, font.file)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), font.sha256, font.file)
  }
})

test('the font route refuses malformed, traversing and odd names without throwing (round 9)', async () => {
  const { createFontHandler, FONT_ROUTE_PREFIX } = await import('../lib/routes.js')
  const { readFont, listFonts } = await import('../lib/fonts.js')
  const fonts = await listFonts()
  const handler = createFontHandler({
    findFont: async (name) => fonts.find((font) => font.file === name),
    readFont,
    connection: { requestRejection: () => undefined },
    logger: {},
  })
  const cases = [
    [FONT_ROUTE_PREFIX + '%zz', 404, 'malformed escape'],
    [FONT_ROUTE_PREFIX + '%00', 404, 'NUL byte'],
    [FONT_ROUTE_PREFIX + '%2e%2e%2fpackage.json', 404, 'traversal'],
    [FONT_ROUTE_PREFIX + '..%5cpackage.json', 404, 'backslash traversal'],
    [FONT_ROUTE_PREFIX + 'a'.repeat(5000), 404, 'overlong name'],
    [FONT_ROUTE_PREFIX, 404, 'empty name'],
  ]
  for (const [url, status, label] of cases) {
    const response = fakeResponse()
    await handler(fakeRequest({ url }), response)
    assert.equal(response.state.status, status, label)
    assert.match(String(response.state.body), /no-font|no such font/, label)
  }
  // HEAD answers the headers without a body.
  const head = fakeResponse()
  await handler(fakeRequest({ url: FONT_ROUTE_PREFIX + fonts[0].file, method: 'HEAD' }), head)
  assert.equal(head.state.status, 200)
  assert.equal(head.state.headers['content-type'], 'font/woff2')
  assert.ok(head.state.body === undefined || head.state.body === '')
})

test('src/fonts-data.mjs cannot drift from fonts/MANIFEST.json (round 9)', async () => {
  const { readFile } = await import('node:fs/promises')
  const { FONTS } = await import('../src/fonts-data.mjs')
  const manifest = JSON.parse(await readFile(new URL('../fonts/MANIFEST.json', import.meta.url), 'utf8'))
  assert.equal(FONTS.length, manifest.fonts.length)
  FONTS.forEach((font, index) => {
    const entry = manifest.fonts[index]
    assert.deepEqual(
      { family: font.family, file: font.file, unicodeRange: font.unicodeRange ?? null, version: font.version ?? null },
      { family: entry.family, file: entry.file, unicodeRange: entry.unicodeRange ?? null, version: entry.sha256.slice(0, 8) },
      `entry ${index}: run node scripts/gen-fonts-data.mjs`,
    )
  })
})

test('font embedding: subsets follow the characters, and the root insertion is XML-safe (round 10)', async () => {
  const { embeddedFontCss, withStyle, injectIntoRoot, parseUnicodeRange, matchesUnicodeRange } = await import('../lib/fonts.js')
  const latin = await embeddedFontCss([{ type: 'text', fontFamily: 8, text: 'hello world' }])
  assert.equal((latin.match(/@font-face/g) || []).length, 1, 'one Latin subset')
  const cyrillic = await embeddedFontCss([{ type: 'text', fontFamily: 5, text: 'привет' }])
  assert.equal((cyrillic.match(/@font-face/g) || []).length, 1, 'family 5 embeds Virgil’s Cyrillic subset')
  assert.match(cyrillic, /font-family:'Virgil'/)
  assert.equal(matchesUnicodeRange('U+20-7e', 'λ'), false)
  assert.equal(matchesUnicodeRange('U+3bb', 'λ'), true)
  assert.deepEqual(parseUnicodeRange('U+20-7e,U+a1'), [[0x20, 0x7e], [0xa1, 0xa1]])
  assert.equal(parseUnicodeRange('nonsense'), null)

  const withProlog = '<?xml version="1.0"?>\n<!-- a comment -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect/></svg>'
  const styled = withStyle(withProlog, '@font-face{font-family:a}')
  assert.match(styled, /<svg[^>]*><style type="text\/css"><!\[CDATA\[@font-face\{font-family:a\}\]\]><\/style><rect\/><\/svg>$/)
  assert.equal(injectIntoRoot('<svg xmlns="x"/>', '<style></style>'), '<svg xmlns="x"/>', 'a self-closing root cannot host children')
  assert.equal(withStyle('<rect/>', '@font-face{}'), '<rect/>', 'no svg root means nothing is injected')
  const tricky = '<svg data-x="a>b"><rect/></svg>'
  assert.match(withStyle(tricky, '<x>'), /^<svg data-x="a>b"><style type="text\/css"><!\[CDATA\[<x>\]\]><\/style><rect\/><\/svg>$/, 'a > inside an attribute does not end the tag')
})

test('an export that only exceeds the cap because of embedded fonts still writes (round 10)', async () => {
  const { createStore } = await import('../lib/store.js')
  const root = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-allow-'))
  try {
    const store = createStore({ root, watch: false, maxSceneBytes: 2048 })
    const svg = '<svg xmlns="http://www.w3.org/2000/svg">' + 'x'.repeat(3000) + '</svg>'
    await assert.rejects(store.writeExport('big', svg), (error) => error.code === 'scene-too-large')
    const written = await store.writeExport('big', svg, { allowance: 4096 })
    assert.equal(written.bytes > 2048, true)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  }
})


test('frames and missing font families still yield self-contained exports (round 11 P1)', async () => {
  const { exportFonts, fontNotice, withStyle } = await import('../lib/fonts.js')
  const frame = await exportFonts([{ type: 'frame', name: 'Panel A' }, { type: 'rectangle' }])
  assert.deepEqual(frame.families, ['Virgil'], 'a frame name is drawn in the family-5 stack')
  const noFamily = await exportFonts([{ type: 'text', text: 'plain' }])
  assert.deepEqual(noFamily.families, ['Virgil'])
  const unknown = await exportFonts([{ type: 'text', fontFamily: 99, text: 'x' }])
  assert.deepEqual(unknown.families, ['Virgil'], 'an unknown family key falls back to family 5')
  const zero = await exportFonts([{ type: 'text', fontFamily: 0, text: 'x' }])
  assert.deepEqual(zero.families, ['Virgil'])
  const notice = fontNotice(frame.families)
  assert.match(notice, /Virgil \(SIL OFL 1\.1\)/)
  assert.equal(fontNotice([]), '', 'no fonts means no notice')
  // A `</style>` sequence inside the CSS must not close the element: the CSS
  // lives in a CDATA section, so only the wrapper's terminator exists.
  const svg = withStyle('<svg xmlns="x"></svg>', 'a</style><script>alert(1)</script>')
  // The whole CSS is one CDATA section: the inner `</style>` is text, not markup,
  // so the element can only be closed by the wrapper's own terminator.
  assert.match(svg, /^<svg xmlns="x"><style type="text\/css"><!\[CDATA\[a<\/style><script>alert\(1\)<\/script>\]\]><\/style><\/svg>$/)
})

test('the refresh route aborts the tool call when the client disconnects (round 11)', async () => {
  const { EventEmitter } = await import('node:events')
  let seen = null
  const routes = createRoutes({
    config: { scenesDir: '.dsh/excalidraw' },
    connection: { requestRejection: () => undefined },
    resolveSession: async (sessionId) => ({ sessionId, cwd: '/work' }),
    resolveToken: async () => ({ token: 't' }),
    refresh: async (input) => {
      seen = input.signal
      return new Promise((resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })))
      })
    },
    storeFor: () => ({ snapshot: async () => ({ revision: 1 }) }),
    logger: { warn() {} },
  })
  const base = fakeRequest({ method: 'POST', url: ROUTE_PATHS.refresh, body: { sessionId: 's' } })
  const request = Object.assign(base, {
    on: (event, handler) => handlers.set(event, handler),
    off: (event) => handlers.delete(event),
  })
  const handlers = new Map()
  const response = fakeResponse()
  const pending = routes.refresh(request, response)
  await new Promise((resolve) => setTimeout(resolve, 20))
  handlers.get('close')?.()
  await pending
  assert.equal(seen?.aborted, true, 'closing the request aborts the tool call')
  assert.equal(response.state.status, 400)
  assert.match(String(response.state.body), /aborted/)
})

test('user-supplied fonts are served only from the manifest, behind the fence (round 12)', async () => {
  const { createExtraFontHandler, FONT_EXTRA_PREFIX } = await import('../lib/routes.js')
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-xcal-extra-'))
  try {
    const bytes = Buffer.from('wOF2-excalifont-bytes')
    await writeFile(join(dir, 'Excalifont-Regular.woff2'), bytes)
    await writeFile(join(dir, 'fonts.json'), JSON.stringify({
      fonts: [
        { family: 'Excalifont', file: 'Excalifont-Regular.woff2' },
        { family: 'Bad', file: '../escape.woff2' },
        { family: '', file: 'x.woff2' },
        { family: 'Missing', file: 'nope.woff2' },
      ],
    }))
    const { listExtraFonts, readExtraFont } = await import('../lib/fonts.js')
    const listed = await listExtraFonts(dir)
    assert.deepEqual(listed.fonts.map((font) => font.family), ['Excalifont'], 'only usable entries survive')
    const handler = createExtraFontHandler({
      dir, listExtraFonts, readExtraFont,
      connection: { requestRejection: () => undefined },
      logger: {},
    })
    const ok = fakeResponse()
    await handler(fakeRequest({ url: FONT_EXTRA_PREFIX + 'Excalifont-Regular.woff2' }), ok)
    assert.equal(ok.state.status, 200)
    assert.equal(ok.state.headers['content-type'], 'font/woff2')
    assert.equal(Buffer.from(ok.state.body).toString(), 'wOF2-excalifont-bytes')
    for (const [url, status] of [
      [FONT_EXTRA_PREFIX + 'nope.woff2', 404],
      [FONT_EXTRA_PREFIX + '%2e%2e%2ffonts.json', 404],
      [FONT_EXTRA_PREFIX + 'fonts.json', 404],
    ]) {
      const response = fakeResponse()
      await handler(fakeRequest({ url }), response)
      assert.equal(response.state.status, status, url)
    }
    const refused = fakeResponse()
    await createExtraFontHandler({ dir, listExtraFonts, readExtraFont, connection: { requestRejection: () => ({}) }, logger: {} })(
      fakeRequest({ url: FONT_EXTRA_PREFIX + 'Excalifont-Regular.woff2' }), refused)
    assert.equal(refused.state.status, 403)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  }
})

test('GET /api/fonts lists the extra fonts with their route URLs (round 12)', async () => {
  const routes = createRoutes({
    config: { scenesDir: '.dsh/excalidraw', extraFontsDir: '/fonts' },
    connection: { requestRejection: () => undefined },
    resolveSession: async () => ({ sessionId: 's', cwd: '/work' }),
    resolveToken: async () => ({ token: '' }),
    refresh: async () => ({ ok: true }),
    storeFor: () => ({ snapshot: async () => ({ revision: 1 }) }),
    listExtraFonts: async () => ({ fonts: [{ family: 'Excalifont', file: 'Excalifont-Regular.woff2', weight: 400, style: 'normal' }] }),
    logger: { warn() {} },
  })
  const response = fakeResponse()
  await routes.fonts(fakeRequest({ url: ROUTE_PATHS.fonts }), response)
  assert.equal(response.state.status, 200)
  assert.deepEqual(JSON.parse(response.state.body), {
    extra: [{
      family: 'Excalifont',
      file: 'Excalifont-Regular.woff2',
      url: '/excalidraw/fonts-extra/Excalifont-Regular.woff2',
      weight: 400,
      style: 'normal',
    }],
  })
})

test('a corrupt or truncated font is rejected by the digest/length checks (round 14)', async () => {
  const { mkdtemp, writeFile, cp, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { readFont } = await import('../lib/fonts.js')
  const { readFileSync } = await import('node:fs')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-xcal-fonts-'))
  try {
    const manifest = JSON.parse(readFileSync(new URL('../fonts/MANIFEST.json', import.meta.url), 'utf8'))
    const font = manifest.fonts[0]
    const { chmod } = await import('node:fs/promises')
    await cp(new URL('../fonts/MANIFEST.json', import.meta.url), join(dir, 'MANIFEST.json'))
    // The copy inherits the source mode; make it writable for the tampering below.
    await chmod(join(dir, 'MANIFEST.json'), 0o644)
    for (let index = 0; index < font.parts; index += 1) {
      const target = join(dir, `${font.file}.${index}.b64`)
      await cp(new URL(`../fonts/${font.file}.${index}.b64`, import.meta.url), target)
      // cp preserves the source mode; a read-only copy cannot be rewritten below.
      await chmod(target, 0o644)
    }
    // The untouched copy verifies.
    const ok = await readFont(font.file, dir)
    assert.equal(ok.length, font.bytes)
    // A recorded digest that no longer matches must throw, not return bytes.
    const tampered = { ...manifest, fonts: [{ ...font, sha256: '0'.repeat(64) }] }
    await writeFile(join(dir, 'MANIFEST.json'), JSON.stringify(tampered))
    await assert.rejects(readFont(font.file, dir), (error) => error.code === 'bad-font')
    // A recorded byte count that disagrees must throw too.
    await writeFile(join(dir, 'MANIFEST.json'), JSON.stringify({ ...manifest, fonts: [{ ...font, bytes: font.bytes + 1 }] }))
    await assert.rejects(readFont(font.file, dir), (error) => error.code === 'bad-font')
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  }
})

test('the production font handler refuses names outside the manifest (round 14)', async () => {
  const { createFontHandler, FONT_ROUTE_PREFIX } = await import('../lib/routes.js')
  const { findFont, readFont } = await import('../lib/fonts.js')
  // No stubbed findFont: the real whitelist must reject a file that exists in
  // the package but is not a font (package.json) and a traversal escape.
  const handler = createFontHandler({
    findFont, readFont,
    connection: { requestRejection: () => undefined },
    logger: {},
  })
  for (const name of ['package.json', '..%2fpackage.json', 'MANIFEST.json']) {
    const response = fakeResponse()
    await handler(fakeRequest({ url: FONT_ROUTE_PREFIX + name }), response)
    assert.equal(response.state.status, 404, name)
  }
  const listed = await import('../lib/fonts.js').then((module) => module.listFonts())
  const ok = fakeResponse()
  await handler(fakeRequest({ url: FONT_ROUTE_PREFIX + listed[0].file }), ok)
  assert.equal(ok.state.status, 200)
})

test('a real HTTP disconnect aborts the refresh tool call (round 14)', async () => {
  const { createServer } = await import('node:http')
  let seenSignal = null
  const routes = createRoutes({
    config: { scenesDir: '.dsh/excalidraw' },
    connection: { requestRejection: () => undefined },
    resolveSession: async (sessionId) => ({ sessionId, cwd: '/work' }),
    resolveToken: async () => ({ token: 't' }),
    refresh: async (input) => {
      seenSignal = input.signal
      return new Promise((resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })))
        setTimeout(() => resolve({ ok: true, slug: 'late' }), 3000)
      })
    },
    storeFor: () => ({ snapshot: async () => ({ revision: 1 }) }),
    logger: { warn() {} },
  })
  const server = createServer((request, response) => {
    request.on('data', () => {})
    request.on('end', () => { routes.refresh(request, response) })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const request = (await import('node:http')).request({
      host: '127.0.0.1', port, path: ROUTE_PATHS.refresh, method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    request.on('error', () => {})
    request.end(JSON.stringify({ sessionId: 'session-1' }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    request.destroy()
    for (let i = 0; i < 40 && seenSignal?.aborted !== true; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(seenSignal?.aborted, true, 'the tool call was cancelled by the disconnect')
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('extra-font names with spaces and non-ASCII characters are served (round 16)', async () => {
  const { createExtraFontHandler, FONT_EXTRA_PREFIX } = await import('../lib/routes.js')
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-xcal-extra2-'))
  try {
    await writeFile(join(dir, 'My Font-Regular.woff2'), Buffer.from('wOF2-spaced'))
    await writeFile(join(dir, 'Schrift-中文.woff2'), Buffer.from('wOF2-cjk'))
    await writeFile(join(dir, 'fonts.json'), JSON.stringify({
      fonts: [
        { family: 'My Font', file: 'My Font-Regular.woff2' },
        { family: 'Schrift', file: 'Schrift-中文.woff2' },
        { family: 'Bad', file: '../escape.woff2' },
      ],
    }))
    const { listExtraFonts, readExtraFont } = await import('../lib/fonts.js')
    const handler = createExtraFontHandler({ dir, listExtraFonts, readExtraFont, connection: { requestRejection: () => undefined }, logger: {} })
    for (const [name, body] of [['My%20Font-Regular.woff2', 'wOF2-spaced'], ['Schrift-%E4%B8%AD%E6%96%87.woff2', 'wOF2-cjk']]) {
      const response = fakeResponse()
      await handler(fakeRequest({ url: FONT_EXTRA_PREFIX + name }), response)
      assert.equal(response.state.status, 200, name)
      assert.equal(Buffer.from(response.state.body).toString(), body, name)
    }
    for (const name of ['%2e%2e%2ffonts.json', 'fonts.json', '..%5cescape.woff2']) {
      const response = fakeResponse()
      await handler(fakeRequest({ url: FONT_EXTRA_PREFIX + name }), response)
      assert.equal(response.state.status, 404, name)
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  }
})

test('an index larger than the cap is rebuilt, not parsed (round 16)', async () => {
  const { mkdtemp, writeFile, rm, stat } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { createStore, SCENE_SUFFIX } = await import('../lib/store.js')
  const root = await mkdtemp(join(tmpdir(), 'dsh-xcal-bigindex-'))
  try {
    await writeFile(join(root, `a${SCENE_SUFFIX}`), JSON.stringify({ type: 'excalidraw', elements: [] }))
    // The oversized index claims a scene that is not on disk: only a rebuild can
    // produce ['a']. A trusted parse would report the ghost entry instead.
    await writeFile(join(root, 'index.json'), JSON.stringify({ revision: 424242, scenes: [{ slug: 'ghost' }] }) + ' '.repeat(9 * 1024 * 1024))
    const store = createStore({ root, watch: false, logger: { warn() {} } })
    const listed = await store.listScenes()
    assert.deepEqual(listed.scenes.map((entry) => entry.slug), ['a'], 'the oversized index was rebuilt, not trusted')
    // The next mutation persists the small rebuilt index over the oversized one.
    await store.writeScene({ slug: 'b', name: 'B', document: { type: 'excalidraw', elements: [] } })
    const info = await stat(join(root, 'index.json'))
    assert.ok(info.size < 9 * 1024 * 1024, 'the rewritten index is small again')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  }
})

test('a wildcard validator is honoured by /rev and /scene (round 18)', async () => {
  const { routes } = makeRoutes()
  const rev = fakeResponse()
  await routes.rev(fakeRequest({ url: ROUTE_PATHS.rev, headers: { 'if-none-match': '*' } }), rev)
  assert.equal(rev.state.status, 304)
  const sceneRoutes = createRoutes({
    config: { scenesDir: '.dsh/excalidraw' },
    connection: { requestRejection: () => undefined },
    resolveSession: async () => ({ sessionId: 's', cwd: '/work' }),
    resolveToken: async () => ({ token: '' }),
    refresh: async () => ({ ok: true }),
    storeFor: () => ({
      readScene: async () => ({ text: '{}', etag: '"1-arch"', path: '/work/.dsh/excalidraw/arch.excalidraw' }),
      listScenes: async () => ({ revision: 1, scenes: [{ slug: 'arch' }] }),
      snapshot: async () => ({ revision: 1 }),
    }),
    logger: { warn() {} },
  })
  const scene = fakeResponse()
  await sceneRoutes.scene(fakeRequest({ url: ROUTE_PATHS.scene + '?slug=arch', headers: { 'if-none-match': '*' } }), scene)
  assert.equal(scene.state.status, 304)
})

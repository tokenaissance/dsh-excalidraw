/**
 * Client-half tests. No DOM, no React: the built `client.js` is loaded through a
 * stubbed `window.__ModuleLoader__`, the factory receives a minimal React stub,
 * and the plugin is exercised through its registrations and its `__test` seam.
 *
 * What this does NOT prove: that React renders the tab. That is checked in the
 * browser against a scratch profile (see docs/CLIENT-NOTES.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/* ── stubs ─────────────────────────────────────────────────────────── */

function makeReactStub() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
  };
}

function makeDocumentStub() {
  const styles = [];
  return {
    styles,
    document: {
      visibilityState: 'visible',
      getElementById: (id) => styles.find((style) => style.id === id) ?? null,
      createElement: () => {
        const attributes = {};
        const element = {
          id: '',
          textContent: '',
          parentNode: null,
          setAttribute: (name, value) => { attributes[name] = String(value); },
          getAttribute: (name) => (name in attributes ? attributes[name] : null),
          remove: () => {
            const index = styles.indexOf(element);
            if (index >= 0) styles.splice(index, 1);
          },
        };
        return element;
      },
      head: {
        appendChild: (element) => {
          styles.push(element);
          element.parentNode = { removeChild: () => { const i = styles.indexOf(element); if (i >= 0) styles.splice(i, 1); } };
        },
        querySelector: (selector) => {
          const match = /\[data-dsh-excalidraw="([^"]+)"\]/.exec(selector);
          if (!match) return null;
          return styles.find((style) => (style.getAttribute ? style.getAttribute('data-dsh-excalidraw') : null) === match[1]) ?? null;
        },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  };
}

/** Load a built bundle under a fake module loader and return its factory. */
function loadBundle({ dir = ROOT } = {}) {
  const loaded = [];
  const previous = { window: globalThis.window, document: globalThis.document };
  const doc = makeDocumentStub();
  globalThis.window = {
    location: { origin: 'http://127.0.0.1:3099' },
    __ModuleLoader__: { load: (mod) => loaded.push(mod) },
  };
  doc.document.baseURI = 'http://127.0.0.1:3099/';
  globalThis.document = doc.document;
  // No test may reach the network by accident (the client probes /api/fonts on
  // apply); tests that need fetch install their own stub after this point.
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network disabled in client tests'); };
  const file = path.join(dir, 'client.js');
  assert.ok(fs.existsSync(file), `client.js missing at ${file}; run scripts/build-client.mjs`);
  const source = fs.readFileSync(file, 'utf8');
  // Execute the bundle the way the browser module table does: one load() call.
  // eslint-disable-next-line no-new-func
  new Function('window', source)(globalThis.window);
  assert.equal(loaded.length, 1, 'client.js must register exactly one module');
  const mod = loaded[0];
  if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window;
  if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document;
  globalThis.fetch = previousFetch;
  return { mod, doc };
}

function makeCtx() {
  const effects = [];
  const registered = { tabs: [], viewers: [], icons: [] };
  const service = {
    registerTab: (descriptor) => { registered.tabs.push(descriptor); return () => { registered.tabs = registered.tabs.filter((each) => each !== descriptor); }; },
    registerFileViewer: (descriptor) => { registered.viewers.push(descriptor); return () => { registered.viewers = registered.viewers.filter((each) => each !== descriptor); }; },
    registerFileIcon: (descriptor) => { registered.icons.push(descriptor); return () => { registered.icons = registered.icons.filter((each) => each !== descriptor); }; },
    openTab: () => {},
    subscribe: () => () => {},
    version: 'test',
  };
  const ctx = {
    effects,
    registered,
    service,
    effect(fn) { const disposer = fn(); if (typeof disposer === 'function') effects.push(disposer); return disposer; },
    inject(deps, callback) {
      const wanted = Array.isArray(deps) ? deps : [deps];
      if (wanted.includes('betterSidebar')) callback({ ...ctx, betterSidebar: service });
      else if (wanted.includes('locale')) callback({ ...ctx, locale: { register() {}, getSnapshot: () => ({ language: 'en' }), subscribe() {}, bind: () => (key) => key } });
      return () => {};
    },
    logger: { warn() {} },
  };
  return ctx;
}

/* ── build integrity ──────────────────────────────────────────────── */

test('client.js is a single module-loader registration for this package', () => {
  const { mod } = loadBundle();
  assert.equal(mod.id, MANIFEST.name);
  assert.equal(typeof mod.factory, 'function');
  const plugin = mod.factory(() => makeReactStub());
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(Array.isArray(plugin.inject));
});

test('client.js contains no module syntax and stays small', () => {
  const source = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  assert.doesNotMatch(source, /^\s*(import|export)\s/m);
  assert.ok(Buffer.byteLength(source) < 512 * 1024, 'client.js must stay under 512 KiB');
});

/* ── registrations ────────────────────────────────────────────────── */

test('apply registers exactly one tab, one viewer and one icon, then disposes them', () => {
  const { mod } = loadBundle();
  const plugin = mod.factory(() => makeReactStub());
  const ctx = makeCtx();
  plugin.apply(ctx);
  try {
  assert.equal(ctx.registered.tabs.length, 1);
  const tab = ctx.registered.tabs[0];
  assert.equal(tab.id, 'excalidraw');
  assert.equal(tab.single, true);
  assert.equal(typeof tab.component, 'function');
  // Both settings the old release exposed are host config now, so the tab
  // declares no plugin-local toggles (round 7: they were dead switches).
  assert.equal(tab.settings, undefined);

  assert.equal(ctx.registered.viewers.length, 1);
  const viewer = ctx.registered.viewers[0];
  assert.deepEqual(viewer.exts, ['excalidraw']);
  assert.equal(viewer.fetchStrategy, 'fsRead');
  assert.ok(viewer.detect('notes.excalidraw.json', ''));
  assert.ok(viewer.detect('untitled.json', '{"type":"excalidraw","elements":[]}'));
  assert.equal(viewer.detect('package.json', '{"name":"x"}'), false);

  assert.equal(ctx.registered.icons.length, 1);
  assert.deepEqual(ctx.registered.icons[0].exts, ['excalidraw']);

  } finally {
    for (const disposer of ctx.effects) disposer();
  }
  assert.equal(ctx.registered.tabs.length, 0);
  assert.equal(ctx.registered.viewers.length, 0);
  assert.equal(ctx.registered.icons.length, 0);
});

test('apply survives a host without betterSidebar', () => {
  const { mod } = loadBundle();
  const plugin = mod.factory(() => makeReactStub());
  const ctx = makeCtx();
  ctx.inject = () => () => {};
  assert.doesNotThrow(() => { plugin.apply(ctx); });
  for (const disposer of ctx.effects) disposer();
});

test('the tab component renders its header copy through the React stub', () => {
  const { mod } = loadBundle();
  const plugin = mod.factory(() => makeReactStub());
  const ctx = makeCtx();
  plugin.apply(ctx);
  const tab = ctx.registered.tabs[0];
  const tree = tab.component({ ctx, store: {}, scope: { sessionId: 's1', cwd: '/work' }, tab: { id: 'excalidraw' }, visible: false });
  for (const disposer of ctx.effects) disposer();
  const text = collectText(tree);
  assert.ok(text.includes('Excalidraw'), `expected the title in ${JSON.stringify(text)}`);
  assert.ok(text.some((line) => line.includes('Loading') || line.includes('No scene')), `expected a status line in ${JSON.stringify(text)}`);
});

function collectText(node, into = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 8) return into;
  if (typeof node === 'string' || typeof node === 'number') { into.push(String(node)); return into; }
  if (Array.isArray(node)) { for (const child of node) collectText(child, into, depth + 1); return into; }
  if (typeof node === 'object') {
    // Nesting a component (a function `type`) is how this plugin composes; the
    // stub React never invokes it, so the smoke test does it here.
    if (typeof node.type === 'function') collectText(node.type(node.props ?? {}), into, depth + 1);
    for (const child of node.children ?? []) collectText(child, into, depth + 1);
  }
  return into;
}

/* ── pure helpers ─────────────────────────────────────────────────── */

test('renderSafely turns a missing scene and a renderer crash into usable states', () => {
  const { mod } = loadBundle();
  const { renderSafely } = mod.factory(() => makeReactStub()).__test;
  assert.equal(renderSafely(null), null);
  assert.equal(renderSafely(undefined), null);
  const ok = renderSafely({ elements: [{ type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }] });
  assert.ok(ok.svg.includes('<svg'));
  assert.ok(ok.width > 0 && ok.height > 0);
  // A scene whose elements make the renderer throw must not take the tab down.
  const broken = renderSafely({ elements: [{ type: 'rectangle', x: 0, y: 0, width: 10, height: 10, points: [{ get bad() { throw new Error('boom'); } }] }] });
  assert.ok(broken === null || typeof broken.error === 'string' || typeof broken.svg === 'string');
});

test('followTarget pins a manual pick and otherwise follows the newest scene', () => {
  const { mod } = loadBundle();
  const { followTarget } = mod.factory(() => makeReactStub()).__test;
  assert.equal(followTarget(true, 'wireframe'), 'wireframe');
  assert.equal(followTarget(false, 'architecture'), undefined);
});

test('pickSceneSlug prefers the explicit slug, then the newest scene', () => {
  const { mod } = loadBundle();
  const { pickSceneSlug } = mod.factory(() => makeReactStub()).__test;
  const items = [
    { slug: 'old', updatedAt: 100 },
    { slug: 'newest', updatedAt: 300 },
    { slug: 'middle', updatedAt: 200 },
  ];
  assert.equal(pickSceneSlug(items, 'explicit'), 'explicit');
  assert.equal(pickSceneSlug(items, undefined), 'newest');
  assert.equal(pickSceneSlug([], undefined), 'architecture');
  assert.equal(pickSceneSlug(undefined, undefined), 'architecture');
  assert.equal(pickSceneSlug([{ slug: 'only' }], undefined), 'only');
});

test('parseScene also accepts an already-parsed document object', () => {
  const { mod } = loadBundle();
  const { parseScene } = mod.factory(() => makeReactStub()).__test;
  const doc = { type: 'excalidraw', elements: [{ id: 'a' }] };
  assert.equal(parseScene(doc).elements.length, 1);
  assert.equal(parseScene({ elements: [{ id: 'b' }] }).elements.length, 1);
  assert.equal(parseScene([{ id: 'c' }]).elements.length, 1);
  assert.equal(parseScene({ elements: 'nope' }), null);
});

test('parseScene accepts a document, a bare array, and rejects junk', () => {
  const { mod } = loadBundle();
  const { parseScene } = mod.factory(() => makeReactStub()).__test;
  assert.equal(parseScene('{"type":"excalidraw","elements":[{"id":"a"}]}').elements.length, 1);
  assert.equal(parseScene('[{"id":"a"},{"id":"b"}]').elements.length, 2);
  assert.equal(parseScene(''), null);
  assert.equal(parseScene('{'), null);
  assert.equal(parseScene('{"elements":"nope"}'), null);
  assert.equal(parseScene(undefined), null);
});

test('formatClock renders a time and never throws on junk', () => {
  const { mod } = loadBundle();
  const { formatClock } = mod.factory(() => makeReactStub()).__test;
  assert.match(formatClock(Date.UTC(2026, 0, 2, 3, 4)), /\d/);
  assert.equal(formatClock(undefined), '');
  assert.equal(formatClock('not-a-date'), '');
});

test('createApi accepts a string hostRouteUrl (the service returns either form)', async () => {
  const { mod } = loadBundle();
  const { createApi } = mod.factory(() => makeReactStub()).__test;
  const savedFetch = globalThis.fetch;
  const savedWindow = globalThis.window;
  const savedDocument = globalThis.document;
  globalThis.document = { baseURI: 'http://127.0.0.1:3099/' };
  globalThis.window = { location: { origin: 'http://127.0.0.1:3099', pathname: '/' } };
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"revision":1}' };
  };
  try {
    const asString = createApi({ betterSidebar: { hostRouteUrl: (path) => 'http://127.0.0.1:3099/' + path }, inject: () => () => {} });
    await asString.rev({ sessionId: 's' });
    assert.equal(calls[0], 'http://127.0.0.1:3099/excalidraw/api/rev?sessionId=s');

    const asUrl = createApi({ betterSidebar: { hostRouteUrl: (path) => new URL('http://127.0.0.1:3099/' + path) }, inject: () => () => {} });
    await asUrl.rev({ sessionId: 's' });
    assert.equal(calls[1], 'http://127.0.0.1:3099/excalidraw/api/rev?sessionId=s');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedWindow === undefined) delete globalThis.window; else globalThis.window = savedWindow;
    if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument;
  }
});

test('createApi builds fenced URLs, sends the session, and maps 304 / errors', async () => {
  // Every file shares one process when the run-tests shim loads them, so the
  // browser globals this test fakes must be restored for the suites after it.
  const savedFetch = globalThis.fetch;
  const savedWindow = globalThis.window;
  const savedDocument = globalThis.document;
  globalThis.document = { baseURI: 'http://127.0.0.1:3099/' };
  globalThis.window = { location: { origin: 'http://127.0.0.1:3099', pathname: '/' } };
  const { mod } = loadBundle();
  const { createApi } = mod.factory(() => makeReactStub()).__test;
  const calls = [];
  const responses = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    const headers = new Map(Object.entries(next.headers ?? {}));
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      statusText: '',
      headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
      text: async () => next.body,
    };
  };
  const api = createApi({ inject: () => () => {} });

  responses.push({ status: 200, body: '{"revision":7}' });
  const rev = await api.rev({ sessionId: 's1' });
  assert.equal(rev.payload.revision, 7);
  assert.equal(calls[0].url, 'http://127.0.0.1:3099/excalidraw/api/rev?sessionId=s1');
  assert.equal(calls[0].init.credentials, 'same-origin');

  responses.push({ status: 304, body: '', headers: { etag: '"7-architecture"' } });
  const cached = await api.scene({ sessionId: 's1', slug: 'architecture' }, '"7-architecture"');
  assert.equal(cached.notModified, true);
  assert.equal(calls[1].init.headers['if-none-match'], '"7-architecture"');

  responses.push({ status: 502, body: '{"error":"mcp-error","message":"boom"}' });
  await assert.rejects(() => api.refresh({ sessionId: 's1' }), (error) => {
    assert.equal(error.code, 'mcp-error');
    assert.match(error.message, /boom/);
    return true;
  });
  globalThis.fetch = savedFetch;
  if (savedWindow === undefined) delete globalThis.window; else globalThis.window = savedWindow;
  if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument;
});


test('the registered file viewer renders a scene and never throws (round 7 P0)', () => {
  const { mod } = loadBundle();
  const plugin = mod.factory(() => makeReactStub());
  const ctx = makeCtx();
  plugin.apply(ctx);
  try {
    const viewer = ctx.registered.viewers[0];
    const content = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }] });
    const tree = viewer.component({ ctx, content, path: '/w/diagram.excalidraw', title: 'diagram.excalidraw' });
    const text = collectText(tree);
    assert.ok(text.some((line) => line.includes('diagram.excalidraw')), `title missing in ${JSON.stringify(text)}`);
    assert.ok(text.some((line) => line.includes('1')), 'the element count is rendered');
    assert.ok(text.some((line) => line.includes('Read-only')), 'the viewer marks itself read-only');

    // A file that is not a scene shows the error state instead of throwing.
    const broken = viewer.component({ ctx, content: 'not json', path: '/w/x.excalidraw', title: 'x' });
    assert.ok(collectText(broken).some((line) => line.includes('Could not load')));
  } finally {
    for (const dispose of ctx.effects) dispose();
  }
});


test('the font @font-face rules are actually injected, versioned and idempotent (round 9 P0)', () => {
  const { mod } = loadBundle();
  const plugin = mod.factory(() => makeReactStub());
  const doc = makeDocumentStub();
  doc.document.baseURI = 'http://127.0.0.1:3099/';
  const previous = globalThis.document;
  globalThis.document = doc.document;
  try {
    const ctx = makeCtx();
    plugin.apply(ctx);
    const fontStyle = doc.styles.find((style) => (style.getAttribute ? style.getAttribute('data-dsh-excalidraw') : null) === 'fonts');
    assert.ok(fontStyle !== undefined, 'the font <style> was never injected (injectFontFaces failed silently)');
    const rules = fontStyle.textContent.split('@font-face').length - 1;
    assert.equal(rules, 7, 'one rule per shipped font subset');
    assert.match(fontStyle.textContent, /font-family:'Comic Shanns'/);
    assert.match(fontStyle.textContent, /font-family:'Virgil'/);
    assert.match(fontStyle.textContent, /excalidraw\/fonts\/ComicShanns-/);
    assert.match(fontStyle.textContent, /\?v=[0-9a-f]{8}/, 'the URL is versioned so immutable caching cannot pin old glyphs');
    assert.match(fontStyle.textContent, /unicode-range:U\+20-7e/, 'subsets keep their unicode ranges');
    // A second apply must not stack another <style>.
    plugin.apply(ctx);
    const count = doc.styles.filter((style) => (style.getAttribute ? style.getAttribute('data-dsh-excalidraw') : null) === 'fonts').length;
    assert.equal(count, 1, 'injection is idempotent');
    for (const dispose of ctx.effects) dispose();
  } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
});

test('an export embeds the fonts it needs, and only those (round 9 P1)', async () => {
  const { mod } = loadBundle();
  const plugin = mod.factory(() => makeReactStub());
  const t = plugin.__test;
  const scene = {
    elements: [
      { type: 'text', fontFamily: 8, text: 'hello' },
      { type: 'rectangle' },
      { type: 'text', fontFamily: 1, text: 'drawn' },
    ],
  };
  const fetched = [];
  const previousFetch = globalThis.fetch;
  const previousBtoa = globalThis.btoa;
  globalThis.btoa = (binary) => Buffer.from(binary, 'binary').toString('base64');
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return { ok: true, arrayBuffer: async () => new Uint8Array([119, 79, 70, 50]).buffer };
  };
  try {
    const service = { hostRouteUrl: (path) => new URL(path, 'http://127.0.0.1:3099/') };
    const ctxStub = { get: (name) => (name === 'betterSidebar' ? service : undefined) };
    const css = await t.embeddedFontCss(ctxStub, scene);
    // Latin text needs one Comic Shanns subset, not four; Lilita One is unused.
    assert.equal(css.split('@font-face').length - 1, 2, 'one Comic Shanns subset + Virgil');
    assert.match(css, /data:font\/woff2;base64,d09GMg==/);
    assert.equal(fetched.filter((url) => url.includes('Lilita')).length, 0, 'unused families are not embedded');
    // A Greek codepoint pulls the Greek subset in addition to the Latin one.
    const greek = await t.embeddedFontCss(ctxStub,
      { elements: [{ type: 'text', fontFamily: 8, text: 'λ' }] });
    assert.equal(greek.split('@font-face').length - 1, 1, 'the Greek subset alone covers the Greek text');
    assert.equal(t.matchesUnicodeRange('U+3bb', 'λ'), true);
    assert.equal(t.matchesUnicodeRange('U+20-7e', 'λ'), false);
    const svg = t.withStyle('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', css);
    assert.match(svg, /^<svg[^>]*><style type="text\/css"><!\[CDATA\[@font-face/);
    assert.equal(t.withStyle('<svg/>', ''), '<svg/>', 'no fonts means no style element');
    assert.equal(t.base64Of(new Uint8Array([119, 79, 70, 50]).buffer), 'd09GMg==');
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch; else globalThis.fetch = previousFetch;
    if (previousBtoa === undefined) delete globalThis.btoa; else globalThis.btoa = previousBtoa;
  }
});

test('the committed client.js is built from the committed sources (round 14)', async () => {
  const { createHash } = await import('node:crypto');
  // Every source the bundle inlines participates in the signature, so a stale
  // renderer/client/font table is caught by the same check.
  const hash = createHash('sha256');
  for (const [name, file] of [
    ['src/renderer.mjs', 'src/renderer.mjs'],
    ['src/fonts-data.mjs', 'src/fonts-data.mjs'],
    ['src/client.mjs', 'src/client.mjs'],
    ['scripts/build-client.mjs', 'scripts/build-client.mjs'],
  ]) {
    const bytes = fs.readFileSync(path.join(ROOT, file));
    hash.update(`${name}:${bytes.length}\n`);
    hash.update(bytes);
  }
  const signature = hash.digest('hex').slice(0, 16);
  const bundle = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  assert.match(bundle, new RegExp(`sources-signature: ${signature}`),
    'client.js was built from different sources: run node scripts/gen-fonts-data.mjs && node scripts/build-client.mjs');
  // and the generated module itself must match the manifest
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/gen-fonts-data.mjs'), '--check'], { cwd: ROOT, stdio: 'pipe' });
});

test('exports carry the provenance notice and the PNG input is the self-contained SVG (round 10)', async () => {
  const { mod } = loadBundle();
  const plugin = mod.factory(() => makeReactStub());
  const t = plugin.__test;
  const rendered = { svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', width: 10, height: 10, rendered: 1 };
  const selfContained = '<svg xmlns="http://www.w3.org/2000/svg"><metadata>x</metadata><rect/></svg>';
  // The PNG path must rasterise the embedded-font SVG, never the bare one.
  assert.equal(t.pngInput(rendered, selfContained).svg, selfContained);
  assert.equal(t.pngInput(rendered, selfContained).width, 10);
  assert.equal(t.pngInput(rendered, selfContained).rendered, 1);
});

test('the client export insertion is XML-safe too (round 10)', () => {
  const { mod } = loadBundle();
  const plugin = mod.factory(() => makeReactStub());
  const t = plugin.__test;
  const prolog = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect/></svg>';
  assert.match(t.withStyle(prolog, '@font-face{font-family:a}'), /<svg[^>]*><style type="text\/css"><!\[CDATA\[@font-face\{font-family:a\}\]\]><\/style><rect\/><\/svg>$/);
  assert.equal(t.withStyle('<svg xmlns="x"/>', '@font-face{}'), '<svg xmlns="x"/>');
  assert.equal(t.rootTagEnd('<svg data-x="a>b"><rect/></svg>'), 17);
  assert.match(t.withMetadata('<svg xmlns="x"><rect/></svg>', 'a < b & c'), /<metadata>a &lt; b &amp; c<\/metadata>/);
});

test('client exports: family 5, frames, deleted text and the PNG wiring are covered (round 11 P1)', async () => {
  const { mod } = loadBundle();
  const plugin = mod.factory(() => makeReactStub());
  const t = plugin.__test;
  const previousFetch = globalThis.fetch;
  const previousBtoa = globalThis.btoa;
  globalThis.btoa = (binary) => Buffer.from(binary, 'binary').toString('base64');
  globalThis.fetch = async (url) => ({ ok: true, arrayBuffer: async () => new Uint8Array([119, 79, 70, 50]).buffer });
  const service = { hostRouteUrl: (path) => new URL(path, 'http://127.0.0.1:3099/') };
  const ctx = { get: (name) => (name === 'betterSidebar' ? service : undefined) };
  try {
    const familiesOf = (scene) => [...t.fontCharacters(scene).families];
    assert.deepEqual(familiesOf({ elements: [{ type: 'text', text: 'x' }] }), ['Virgil']);
    assert.deepEqual(familiesOf({ elements: [{ type: 'text', fontFamily: 5, text: 'x' }] }), ['Virgil']);
    assert.deepEqual(familiesOf({ elements: [{ type: 'text', fontFamily: 99, text: 'x' }] }), ['Virgil']);
    assert.deepEqual(familiesOf({ elements: [{ type: 'frame', name: 'Panel' }] }), ['Virgil']);
    assert.deepEqual(familiesOf({ elements: [{ type: 'text', fontFamily: 8, text: 'x', isDeleted: true }] }), []);
    assert.deepEqual(familiesOf({ elements: [{ type: 'rectangle' }] }), []);

    const rendered = { svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', width: 10, height: 10, rendered: 1 };
    const scene = { elements: [{ type: 'text', fontFamily: 8, text: 'hi' }] };
    const artifacts = await t.exportArtifacts(ctx, scene, rendered);
    assert.match(artifacts.svg, /<style type="text\/css"><!\[CDATA\[@font-face/);
    assert.match(artifacts.svg, /<metadata>Rendered by dsh-excalidraw\. Embedded fonts: Comic Shanns/);
    // The PNG path must rasterise the embedded-font SVG, never the bare one.
    assert.equal(artifacts.png.svg, artifacts.svg);
    assert.equal(artifacts.png.width, 10);
    // A scene with no text gets no fonts and no notice.
    const plain = await t.exportArtifacts(ctx, { elements: [{ type: 'rectangle' }] }, rendered);
    assert.equal(plain.svg, rendered.svg);
    assert.equal(plain.png.svg, rendered.svg);
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch; else globalThis.fetch = previousFetch;
    if (previousBtoa === undefined) delete globalThis.btoa; else globalThis.btoa = previousBtoa;
  }
});

test('apply never reads an undeclared service property (cordis inject guard, round 11 P0)', () => {
  const { mod } = loadBundle();
  const plugin = mod.factory(() => makeReactStub());
  const allowed = new Set(['effect', 'inject', 'get', 'logger', 'locale', 'set', 'on', 'off', 'emit']);
  const registry = { tab: null, viewer: null, icon: null };
  const service = {
    registerTab: (descriptor) => { registry.tab = descriptor; return () => { registry.tab = null; }; },
    registerFileViewer: (descriptor) => { registry.viewer = descriptor; return () => { registry.viewer = null; }; },
    registerFileIcon: (descriptor) => { registry.icon = descriptor; return () => { registry.icon = null; }; },
    hostRouteUrl: (path) => new URL(path, 'http://127.0.0.1:3099/'),
  };
  const effects = [];
  const effectLabels = [];
  const base = {
    effect: (fn, label) => { effectLabels.push(String(label ?? '')); effects.push(fn()); },
    inject: (deps, callback) => callback({
      betterSidebar: service,
      effect: (fn) => { effects.push(fn()); },
      inject: () => {},
      get: (name) => (name === 'betterSidebar' ? service : undefined),
      logger: { warn() {} },
      locale: { register: () => () => {} },
    }),
    get: (name) => (name === 'betterSidebar' ? service : undefined),
    logger: { warn() {} },
    locale: { register: () => () => {} },
  };
  const ctx = new Proxy(base, {
    get(target, property) {
      if (typeof property === 'symbol' || allowed.has(property)) return target[property];
      // What cordis 4 does on an undeclared service read:
      throw new Error(`cannot get property "${String(property)}" without inject`);
    },
  });
  const doc = makeDocumentStub();
  doc.document.baseURI = 'http://127.0.0.1:3099/';
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = doc.document;
  globalThis.window = { location: { origin: 'http://127.0.0.1:3099', pathname: '/' } };
  try {
    plugin.apply(ctx);
    assert.equal(registry.tab?.id, 'excalidraw', 'the tab registered despite the strict ctx');
    assert.ok(registry.viewer !== null && registry.icon !== null);
    const fontStyle = doc.styles.find((style) => (style.getAttribute ? style.getAttribute('data-dsh-excalidraw') : null) === 'fonts');
    assert.ok(fontStyle !== undefined, 'font registration must not touch undeclared services');
  } finally {
    for (const dispose of effects) if (typeof dispose === 'function') dispose();
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
});

test('user-supplied fonts are registered after the bundled ones (round 12)', async () => {
  const { mod } = loadBundle();
  const plugin = mod.factory(() => makeReactStub());
  const t = plugin.__test;
  const previousFetch = globalThis.fetch;
  const previousNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test-browser' }, configurable: true, writable: true });
  globalThis.fetch = async (url) => {
    if (String(url).includes('excalidraw/api/fonts')) {
      return { ok: true, json: async () => ({ extra: [{ family: 'Excalifont', file: 'Excalifont-Regular.woff2', url: '/excalidraw/fonts-extra/Excalifont-Regular.woff2', weight: 400, style: 'normal' }] }) };
    }
    return { ok: false, json: async () => ({}) };
  };
  try {
    const doc = makeDocumentStub();
    doc.document.baseURI = 'http://127.0.0.1:3099/';
    const previousDocument = globalThis.document;
    globalThis.document = doc.document;
    try {
      const ctx = makeCtx();
      plugin.apply(ctx);
      const fontStyle = doc.styles.find((style) => (style.getAttribute ? style.getAttribute('data-dsh-excalidraw') : null) === 'fonts');
      assert.ok(fontStyle !== undefined);
      for (let i = 0; i < 20 && !fontStyle.textContent.includes("font-family:'Excalifont'"); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.match(fontStyle.textContent, /font-family:'Excalifont'/);
      assert.match(fontStyle.textContent, /excalidraw\/fonts-extra\/Excalifont-Regular\.woff2/);
      // Dispose the watcher and timers: an undisposed effect keeps --test alive.
      for (const dispose of ctx.effects) if (typeof dispose === 'function') dispose();
    } finally {
      if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    }
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch; else globalThis.fetch = previousFetch;
  }
});

test('a native DSH slots profile gets a conversation.view without better-sidebar (round 13)', () => {
  const { mod } = loadBundle();
  const plugin = mod.factory(() => makeReactStub());
  const registrations = [];
  const effectLabels = [];
  const slots = {
    inject: (name, factory) => { factory(); return () => { registrations.push(['dispose', name]); }; },
    register: (descriptor, component) => { registrations.push([descriptor, component]); return () => {}; },
  };
  const base = {
    effect: (fn, label) => { effectLabels.push(String(label ?? '')); },
    inject: () => {},
    get: (name) => (name === 'slots' ? slots : undefined),
    logger: { warn() {} },
    locale: { register: () => () => {} },
  };
  const ctx = new Proxy(base, {
    get(target, property) {
      if (typeof property === 'symbol' || ['effect', 'inject', 'get', 'logger', 'locale'].includes(property)) return target[property];
      throw new Error(`cannot get property "${String(property)}" without inject`);
    },
  });
  const doc = makeDocumentStub();
  doc.document.baseURI = 'http://127.0.0.1:3099/';
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = doc.document;
  globalThis.window = { location: { origin: 'http://127.0.0.1:3099', pathname: '/' } };
  try {
    plugin.apply(ctx);
    const descriptor = registrations.find(([entry]) => entry && entry.name === 'conversation.view');
    assert.ok(descriptor !== undefined, 'the native conversation view was registered');
    assert.equal(descriptor[0].id, 'excalidraw');
    assert.equal(typeof descriptor[0].label, 'function');
    // The UI calls label/inject later, outside apply: both must work then (a
    // closure over apply-local state throws exactly like the round-13 P0 did).
    assert.equal(typeof descriptor[0].label(), 'string');
    assert.ok(descriptor[0].label().length > 0);
    const props = descriptor[0].inject('session-1');
    assert.equal(typeof props, 'object');
    assert.equal(props.sessionId, 'session-1');
    assert.equal(typeof descriptor[1], 'function', 'a component came with it');
    // It still does not touch betterSidebar (absent in this profile).
    assert.equal(registrations.filter(([entry]) => entry && entry.id === 'excalidraw').length, 1);
    assert.ok(effectLabels.some((label) => label.includes('focus watcher (native)')),
      'the stock profile installs the native focus watcher');
  } finally {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
});

test('stock-DSH auto-open activates the registered conversation view (round 14)', () => {
  const { mod } = loadBundle();
  const plugin = mod.factory(() => makeReactStub());
  const t = plugin.__test;
  const activated = [];
  // `activate` only exists for registered *view targets*; a slot view id is not
  // one (the real DSH silently no-ops), so the helper insists on the registry.
  const ctx = {
    get: (name) => (name === 'uiConversation'
      ? {
        views: { get: (id) => (id === 'excalidraw' ? { target: 'excalidraw' } : undefined) },
        binding: (sessionId) => ({ activate: (viewId) => activated.push([sessionId, viewId]) }),
      }
      : undefined),
  };
  assert.equal(t.activateNativeView(ctx, 'session-1'), true);
  assert.deepEqual(activated, [['session-1', 'excalidraw']]);
  // A profile without the service, an unknown session and a broken binding are
  // all non-events (the focus watcher must never throw).
  assert.equal(t.activateNativeView({ get: () => undefined }, 'session-1'), false);
  // A service without the target registry stays a no-op (stock DSH today).
  const noTarget = { get: () => ({ binding: () => ({ activate: () => activated.push(['x', 'y']) }) }) };
  assert.equal(t.activateNativeView(noTarget, 'session-1'), false);
  assert.deepEqual(activated, [['session-1', 'excalidraw']], 'nothing else was activated');
  assert.equal(t.activateNativeView({ get: () => ({ binding: () => { throw new Error('unknown session') } }) }, 'x'), false);
  assert.equal(t.activateNativeView({ get: () => ({ binding: () => undefined }) }, 'x'), false);
  assert.equal(t.activateNativeView(ctx, ''), false);
});


test('every locale key the client uses exists in en and zh (round 14)', () => {
  const { mod } = loadBundle();
  const plugin = mod.factory(() => makeReactStub());
  const t = plugin.__test;
  const source = fs.readFileSync(path.join(ROOT, 'src/client.mjs'), 'utf8');
  const used = new Set([...source.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)].map((match) => match[1]));
  assert.ok(used.size > 10, `expected the client to use locale keys, found ${used.size}`);
  for (const key of used) {
    assert.equal(typeof t.DICT.en[key], 'string', `DICT.en is missing "${key}"`);
    assert.equal(typeof t.DICT.zh[key], 'string', `DICT.zh is missing "${key}"`);
  }
  // The native slot label is resolved outside React and uses the same table.
  assert.equal(typeof t.DICT.en.title, 'string');
  assert.equal(t.DICT.en.title, 'Excalidraw');
  assert.equal(t.DICT.zh.title, 'Excalidraw 图');
})

test('a viewRequest for this view follows the newest scene and is completed (round 15)', () => {
  const { mod } = loadBundle();
  const plugin = mod.factory(() => makeReactStub());
  const t = plugin.__test;
  assert.deepEqual(t.nativeViewRequestAction({ view: 'excalidraw' }), { follow: true });
  assert.deepEqual(t.nativeViewRequestAction({ view: 'excalidraw', focus: 'x' }), { follow: true });
  assert.equal(t.nativeViewRequestAction({ view: 'chat' }), null);
  assert.equal(t.nativeViewRequestAction(null), null);
  assert.equal(t.nativeViewRequestAction({}), null);
  // The effect wiring: an own request follows the newest scene and settles.
  const calls = [];
  assert.equal(t.settleViewRequest({ view: 'excalidraw' }, {
    unpin: () => calls.push('unpin'),
    completeViewRequest: () => calls.push('complete'),
  }), true);
  assert.deepEqual(calls, ['unpin', 'complete']);
  assert.equal(t.settleViewRequest({ view: 'chat' }, { unpin: () => calls.push('unpin'), completeViewRequest: () => calls.push('complete') }), false);
  assert.deepEqual(calls, ['unpin', 'complete'], 'a foreign request changes nothing');
})

test('a user-supplied font is embedded in a client export too (round 17)', async () => {
  const { mod } = loadBundle();
  const plugin = mod.factory(() => makeReactStub());
  const t = plugin.__test;
  const previousFetch = globalThis.fetch;
  const previousBtoa = globalThis.btoa;
  globalThis.btoa = (binary) => Buffer.from(binary, 'binary').toString('base64');
  globalThis.fetch = async (url) => {
    if (String(url).includes('excalidraw/api/fonts')) {
      return { ok: true, json: async () => ({ extra: [{ family: 'Excalifont', file: 'Excalifont-Regular.woff2', url: '/excalidraw/fonts-extra/Excalifont-Regular.woff2', weight: 400, style: 'normal' }] }) };
    }
    return { ok: true, arrayBuffer: async () => new Uint8Array([119, 79, 70, 50]).buffer };
  };
  try {
    const service = { hostRouteUrl: (path) => new URL(path, 'http://127.0.0.1:3099/') };
    const ctx = { get: (name) => (name === 'betterSidebar' ? service : undefined) };
    const fonts = await t.exportFonts(ctx, { elements: [{ type: 'text', fontFamily: 5, text: 'hi' }] });
    assert.match(fonts.css, /font-family:'Excalifont'/, 'the user face is embedded');
    assert.match(fonts.css, /font-family:'Virgil'/, 'the bundled fallback stays');
    assert.ok(fonts.families.includes('Excalifont'));
    // A scene that never names the extra family gets no extra rule.
    const plain = await t.exportFonts(ctx, { elements: [{ type: 'text', fontFamily: 8, text: 'hi' }] });
    assert.equal(plain.css.includes("font-family:'Excalifont'"), false);
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch; else globalThis.fetch = previousFetch;
    if (previousBtoa === undefined) delete globalThis.btoa; else globalThis.btoa = previousBtoa;
  }
});

test('exactly one focus watcher is installed per profile (round 18)', () => {
  const { mod } = loadBundle();
  const plugin = mod.factory(() => makeReactStub());
  const labelsFor = (services) => {
    const labels = [];
    const ctx = {
      effect: (fn, label) => { labels.push(String(label ?? '')); },
      inject: (deps, callback) => callback({
        ...services,
        effect: (fn, label) => { labels.push(String(label ?? '')); },
        logger: { warn() {} },
      }),
      get: (name) => (name === 'betterSidebar' ? services.betterSidebar : undefined),
      logger: { warn() {} },
      locale: { register: () => () => {} },
    };
    const doc = makeDocumentStub();
    doc.document.baseURI = 'http://127.0.0.1:3099/';
    const previousDocument = globalThis.document;
    globalThis.document = doc.document;
    try {
      plugin.apply(ctx);
    } finally {
      if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    }
    return labels.filter((label) => label.includes('focus watcher'));
  };
  assert.deepEqual(labelsFor({}), ['dsh-excalidraw: focus watcher (native)']);
  assert.deepEqual(labelsFor({
    betterSidebar: {
      registerTab: () => () => {},
      registerFileViewer: () => () => {},
      registerFileIcon: () => () => {},
      openTab: () => {},
      hostRouteUrl: (path) => new URL(path, 'http://127.0.0.1:3099/'),
    },
  }), ['dsh-excalidraw: focus watcher']);
});

test('wheel gestures: pan by default, zoom with ctrl/meta, shift pans x (round 20)', () => {
  const { mod } = loadBundle();
  const t = mod.factory(() => makeReactStub()).__test;
  assert.equal(t.wheelIntent({ ctrlKey: true, deltaY: -10 }), 'zoom');
  assert.equal(t.wheelIntent({ metaKey: true, deltaY: -10 }), 'zoom');
  assert.equal(t.wheelIntent({ shiftKey: true, deltaY: 10 }), 'pan-x');
  assert.equal(t.wheelIntent({ deltaY: 10, deltaX: 3 }), 'pan');
  // Zooming in (negative delta) yields > 1, out < 1, and stays bounded.
  assert.ok(t.wheelZoomFactor(-100) > 1);
  assert.ok(t.wheelZoomFactor(100) < 1);
  assert.equal(t.wheelZoomFactor(0), 1);
  assert.ok(t.wheelZoomFactor(-1, 1) > 1, 'line-mode deltas still zoom');
})

test('zoom keeps the point under the cursor fixed and clamps (round 20)', () => {
  const { mod } = loadBundle();
  const t = mod.factory(() => makeReactStub()).__test;
  const view = { scale: 1, x: 0, y: 0 };
  const point = { x: 40, y: -25 };
  const zoomed = t.zoomAt(view, point, 2);
  assert.equal(zoomed.scale, 2);
  // The scene coordinate under the cursor is unchanged.
  assert.equal((point.x - zoomed.x) / zoomed.scale, (point.x - view.x) / view.scale);
  assert.equal((point.y - zoomed.y) / zoomed.scale, (point.y - view.y) / view.scale);
  assert.equal(t.zoomAt({ scale: 16, x: 0, y: 0 }, point, 2).scale, 16);
  assert.equal(t.zoomAt({ scale: 0.02, x: 0, y: 0 }, point, 0.5).scale, 0.02);
  assert.deepEqual(t.panBy({ scale: 1.5, x: 2, y: 3 }, -4, 5), { scale: 1.5, x: -2, y: 8 });
})

test('screen/scene transforms round-trip and the box centre is the origin (round 20)', () => {
  const { mod } = loadBundle();
  const t = mod.factory(() => makeReactStub()).__test;
  const rendered = { width: 200, height: 100, svg: '<svg/>' };
  const view = { scale: 2, x: 30, y: -10 };
  const centre = t.sceneToScreen(view, rendered, { x: 100, y: 50 });
  assert.deepEqual(centre, { x: 30, y: -10 });
  const back = t.screenToScene(view, rendered, centre);
  assert.ok(Math.abs(back.x - 100) < 1e-9 && Math.abs(back.y - 50) < 1e-9);
  const corner = t.screenToScene(view, rendered, { x: -60, y: 0 });
  assert.deepEqual(corner, { x: 55, y: 55 });
  const box = t.geometryScreenBox(view, rendered, {
    box: { x: 0, y: 0, width: 50, height: 20 }, angle: 0,
  });
  assert.equal(box.width, 100);
  assert.equal(box.height, 40);
  assert.equal(box.left, -170);
  assert.equal(box.top, -110);
  assert.deepEqual(t.marqueeRect({ x: 10, y: 10 }, { x: -5, y: 30 }), { minX: -5, minY: 10, maxX: 10, maxY: 30 });
})

test('fit scale honours the margin, the viewport and the clamps (round 20)', () => {
  const { mod } = loadBundle();
  const t = mod.factory(() => makeReactStub()).__test;
  assert.equal(t.fitScaleFor({ width: 100, height: 50 }, 200, 100), Math.min(8, 2 * 0.94));
  assert.equal(t.fitScaleFor({ width: 0, height: 0 }, 200, 100), 1);
  assert.ok(Math.abs(t.fitScaleFor({ width: 200000, height: 1000 }, 800, 600) - 0.00376) < 1e-9);
  assert.equal(t.fitScaleFor({ width: 1e9, height: 1e9 }, 800, 600), 0.001);
  assert.equal(t.fitScaleFor({ width: 10, height: 10 }, 0, 0), 1);
})

test('selection bounds drive zoom-to-selection (round 20)', () => {
  const { mod } = loadBundle();
  const t = mod.factory(() => makeReactStub()).__test;
  const geometries = [
    { id: 'a', box: { x: 0, y: 0, width: 20, height: 10 }, angle: 0 },
    { id: 'b', box: { x: 100, y: 50, width: 20, height: 10 }, angle: 0 },
    { id: 'c', box: { x: 500, y: 500, width: 10, height: 10 }, angle: 0 },
  ];
  assert.deepEqual(t.selectionBounds(geometries, ['a', 'b']), { minX: 0, minY: 0, maxX: 120, maxY: 60 });
  assert.equal(t.selectionBounds(geometries, []), null);
  assert.equal(t.selectionBounds(geometries, ['missing']), null);
  // A 90° rotation swaps the extents around its centre.
  const rotated = t.selectionBounds([{ id: 'r', box: { x: 0, y: 0, width: 100, height: 20 }, angle: Math.PI / 2 }], ['r']);
  assert.equal(Math.round(rotated.maxX - rotated.minX), 20);
  assert.equal(Math.round(rotated.maxY - rotated.minY), 100);
})

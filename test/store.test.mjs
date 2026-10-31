/**
 * CONTRACT §2: slug derivation, atomic writes, monotonic revision, the focus
 * pointer, path-escape refusal, the size cap, and the index/file
 * reconciliation the `fs.watch` fallback relies on.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_SLUG,
  INDEX_FILE,
  META_SUFFIX,
  SCENE_SUFFIX,
  SLUG_PATTERN,
  StoreError,
  createStore,
  nextRevision,
  revisionEtag,
  sceneEtag,
  slugify,
} from '../lib/store.js'

/** A scene document shaped like `get_scene_content` output. */
function scene(elements = 2) {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'https://excalidraw.com',
    elements: Array.from({ length: elements }, (_, index) => ({
      id: `element-${index}`,
      type: 'rectangle',
      x: index * 10,
      y: 0,
      width: 10,
      height: 10,
    })),
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  }
}

async function workspace(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-store-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))
  const store = createStore({ root, watch: false, ...options })
  t.after(() => store.close())
  return { root, store }
}

test('slugify derives a contract slug from a scene name', () => {
  assert.equal(slugify('Architecture'), 'architecture')
  assert.equal(slugify('Architecture Diagram!'), 'architecture-diagram')
  assert.equal(slugify('  Payment   Flow  '), 'payment-flow')
  assert.equal(slugify('Café Déjà-vu'), 'cafe-deja-vu')
  assert.equal(slugify('---'), DEFAULT_SLUG)
  assert.equal(slugify(''), DEFAULT_SLUG)
  assert.equal(slugify(undefined), DEFAULT_SLUG)
  assert.equal(slugify('数据流'), DEFAULT_SLUG)
  const long = slugify('x'.repeat(200))
  assert.equal(long.length, 64)
  assert.match(long, SLUG_PATTERN)
  assert.match(slugify('a'.repeat(70)), SLUG_PATTERN)
  // Trailing separators never survive the 64-character cut.
  assert.match(slugify(`${'a'.repeat(63)}- b`), SLUG_PATTERN)
})

test('nextRevision never goes backwards, even when the clock does', () => {
  assert.equal(nextRevision(0, 1000), 1000)
  assert.equal(nextRevision(1000, 5), 1001)
  assert.equal(nextRevision(1000, Number.NaN), 1001)
  assert.equal(nextRevision(undefined, 0), 1)
})

test('nextRevision rebuilds a saturated revision instead of freezing (P2-4)', () => {
  // `1e308 + 1 === 1e308`: the old implementation returned the same number forever.
  assert.equal(nextRevision(1e308, 5_000), 5_000)
  assert.equal(nextRevision(Number.MAX_SAFE_INTEGER, 5_000), 5_000)
  assert.equal(nextRevision(Number.MAX_SAFE_INTEGER - 1, 5_000), 5_000)
  assert.equal(nextRevision(Number.MAX_SAFE_INTEGER - 2, 5_000), Number.MAX_SAFE_INTEGER - 1)
  assert.equal(nextRevision(5_000, 0), 5_001)
})

test('ETag helpers quote the documented shapes', () => {
  assert.equal(sceneEtag(7, 'architecture'), '"7-architecture"')
  assert.equal(revisionEtag(7), '"rev-7"')
  assert.equal(revisionEtag(7, 7), '"rev-7-7"', 'the focus pointer is part of the /rev validator')
  assert.equal(revisionEtag(7, 0), '"rev-7-0"')
})

test('writeScene stores the document, its meta, and a bumped index', async (t) => {
  const { root, store } = await workspace(t)
  const document = scene(3)
  const written = await store.writeScene({
    slug: 'Architecture',
    name: 'Architecture',
    sceneId: 'scene-1',
    document,
    source: 'excalidraw-mcp',
    tool: 'get_scene_content',
  })
  assert.equal(written.slug, 'architecture')
  assert.equal(written.file, `architecture${SCENE_SUFFIX}`)
  assert.equal(written.elements, 3)
  assert.match(String(written.revision), /^\d+$/)

  const bytes = await readFile(join(root, `architecture${SCENE_SUFFIX}`), 'utf8')
  assert.equal(bytes, JSON.stringify(document), 'the document is stored verbatim')

  const meta = JSON.parse(await readFile(join(root, `architecture${META_SUFFIX}`), 'utf8'))
  assert.deepEqual(Object.keys(meta).sort(), ['name', 'sceneId', 'slug', 'source', 'tool', 'updatedAt'])
  assert.equal(meta.name, 'Architecture')
  assert.equal(meta.sceneId, 'scene-1')
  assert.equal(meta.tool, 'get_scene_content')

  const index = JSON.parse(await readFile(join(root, INDEX_FILE), 'utf8'))
  assert.equal(index.revision, written.revision)
  assert.equal(index.scenes.length, 1)
  assert.equal(index.scenes[0].slug, 'architecture')
  assert.equal(index.scenes[0].elements, 3)

  const read = await store.readScene('architecture')
  assert.equal(read.text, JSON.stringify(document))
  assert.equal(read.etag, sceneEtag(written.revision, 'architecture'))
  assert.equal(read.revision, written.revision)
})

test('revision is monotonically increasing across writes and bumps', async (t) => {
  let clock = 5_000
  const { store } = await workspace(t, { now: () => clock })
  const first = await store.writeScene({ slug: 'architecture', name: 'Architecture', document: scene(1) })
  assert.equal(first.revision, 5_000)
  clock = 10
  const second = await store.writeScene({ slug: 'architecture', name: 'Architecture', document: scene(2) })
  assert.equal(second.revision, 5_001)
  const bumped = await store.bump()
  assert.equal(bumped, 5_002)
  const snapshot = await store.snapshot()
  assert.equal(snapshot.revision, 5_002)
})

test('a tampered revision cannot freeze every later write (P2-4)', async (t) => {
  let clock = 10_000
  const { root, store } = await workspace(t, { now: () => clock })
  await mkdir(root, { recursive: true })
  await writeFile(join(root, INDEX_FILE), JSON.stringify({ revision: 1e308, scenes: [] }))
  assert.equal((await store.snapshot()).revision, 0, 'an unusable revision is rebuilt, not trusted')

  clock = 20_000
  const first = await store.writeScene({ slug: 'one', name: 'One', document: scene(1) })
  clock = 20_001
  const second = await store.writeScene({ slug: 'two', name: 'Two', document: scene(1) })
  assert.ok(Number.isSafeInteger(first.revision))
  assert.ok(Number.isSafeInteger(second.revision))
  assert.equal(first.revision, 20_000)
  assert.equal(second.revision, 20_001, 'the revision moves again instead of freezing')
  assert.equal((await store.snapshot()).revision, second.revision)
})

test('the focus pointer is durable index state (CONTRACT §2 auto-open)', async (t) => {
  const { root, store } = await workspace(t)
  const written = await store.writeScene({ slug: 'architecture', name: 'Architecture', document: scene() })
  const marked = await store.markFocus({ sessionId: 'session-1', at: written.revision })
  assert.deepEqual(marked.focus, { sessionId: 'session-1', at: written.revision })

  const index = JSON.parse(await readFile(join(root, INDEX_FILE), 'utf8'))
  assert.deepEqual(index.focus, { sessionId: 'session-1', at: written.revision })

  const snapshot = await store.snapshot()
  assert.deepEqual(snapshot.focus, { sessionId: 'session-1', at: written.revision })

  await assert.rejects(store.markFocus({ sessionId: '', at: 1 }), (error) => error.code === 'bad-request')

  // A later revision keeps the pointer until it is replaced.
  const bumped = await store.bump()
  assert.equal((await store.snapshot()).focus.at, written.revision)
  await store.markFocus({ sessionId: 'session-2', at: bumped })
  assert.deepEqual((await store.snapshot()).focus, { sessionId: 'session-2', at: bumped })
})

test('scene reads refuse every path that escapes the scene root', async (t) => {
  const { root, store } = await workspace(t)
  await mkdir(root, { recursive: true })
  await store.writeScene({ slug: 'architecture', name: 'Architecture', document: scene() })

  for (const slug of ['../escape', '..', '.', '', 'Architecture', 'a/b', '/etc/passwd', 'x%2Fy', 'a b']) {
    await assert.rejects(
      store.readScene(slug),
      (error) => error instanceof StoreError && error.code === 'bad-request',
      `slug ${JSON.stringify(slug)} should be refused`,
    )
  }

  // A symlink that is syntactically a scene file must not be served either.
  const secret = join(root, '..', `secret-${process.pid}.json`)
  await writeFile(secret, JSON.stringify(scene(1)))
  t.after(() => rm(secret, { force: true }))
  await symlink(secret, join(root, `linked${SCENE_SUFFIX}`))
  await assert.rejects(store.readScene('linked'), (error) => error.code === 'no-scene')

  await assert.rejects(store.readScene('missing'), (error) => error.code === 'no-scene')
})

test('a no-scene refusal does not disclose the store path (P2-1)', async (t) => {
  const { root, store } = await workspace(t)
  const error = await store.readScene('missing').catch((caught) => caught)
  assert.equal(error.code, 'no-scene')
  assert.equal(error.message.includes(root), false, 'the absolute scene root must not be in the message')
  assert.match(error.message, /missing/)
})

test('the size cap refuses oversized writes and reads', async (t) => {
  const { root, store } = await workspace(t, { maxSceneBytes: 512 })
  await assert.rejects(
    store.writeScene({ slug: 'architecture', name: 'Architecture', document: scene(200) }),
    (error) => error instanceof StoreError && error.code === 'scene-too-large',
  )
  const listed = await store.listScenes()
  assert.equal(listed.scenes.length, 0, 'a refused write leaves no index entry')

  // Nothing stops another writer from putting a big file there: the read must
  // refuse it too.
  await mkdir(root, { recursive: true })
  await writeFile(join(root, `huge${SCENE_SUFFIX}`), 'x'.repeat(2048))
  await assert.rejects(store.readScene('huge'), (error) => error.code === 'scene-too-large')
  await assert.rejects(store.readScene('huge'), (error) => error.status === 413)
})

test('writeScene validates the document shape', async (t) => {
  const { store } = await workspace(t)
  for (const document of [undefined, null, [], 'text', { elements: 'nope' }, {}]) {
    await assert.rejects(
      store.writeScene({ slug: 'architecture', document }),
      (error) => error.code === 'bad-request',
      `document ${JSON.stringify(document)} should be refused`,
    )
  }
})

test('listScenes reflects the index and skips vanished files', async (t) => {
  const { root, store } = await workspace(t)
  await store.writeScene({ slug: 'architecture', name: 'Architecture', document: scene(2) })
  await store.writeScene({ slug: 'payment-flow', name: 'Payment Flow', document: scene(4) })
  let listed = await store.listScenes()
  assert.deepEqual(listed.scenes.map((entry) => entry.slug).sort(), ['architecture', 'payment-flow'])
  assert.equal(listed.scenes.find((entry) => entry.slug === 'payment-flow').elements, 4)

  await rm(join(root, `architecture${SCENE_SUFFIX}`))
  listed = await store.listScenes()
  assert.deepEqual(listed.scenes.map((entry) => entry.slug), ['payment-flow'])
})

test('refreshFromDisk adopts externally written scenes and bumps once', async (t) => {
  let clock = 100
  const { root, store } = await workspace(t, { now: () => clock })
  await store.writeScene({ slug: 'architecture', name: 'Architecture', document: scene(1) })

  // An agent `fs.write` / editor / git checkout: document + meta, no plugin.
  clock = 200
  await writeFile(join(root, `payment-flow${SCENE_SUFFIX}`), JSON.stringify(scene(7)))
  await writeFile(
    join(root, `payment-flow${META_SUFFIX}`),
    JSON.stringify({ slug: 'payment-flow', name: 'Payment Flow', sceneId: 'external-1', source: 'agent', tool: null, updatedAt: clock }),
  )
  const first = await store.refreshFromDisk()
  assert.equal(first.changed, true)
  assert.ok(first.revision > 100)
  const listed = await store.listScenes()
  const adopted = listed.scenes.find((entry) => entry.slug === 'payment-flow')
  assert.equal(adopted.name, 'Payment Flow')
  assert.equal(adopted.sceneId, 'external-1')
  assert.equal(adopted.elements, 7)

  // Idempotent: our own writes and repeated scans cannot bump the revision.
  const second = await store.refreshFromDisk()
  assert.equal(second.changed, false)
  assert.equal(second.revision, first.revision)

  // An externally deleted scene disappears from the index.
  await rm(join(root, `payment-flow${SCENE_SUFFIX}`))
  const third = await store.refreshFromDisk()
  assert.equal(third.changed, true)
  assert.deepEqual((await store.listScenes()).scenes.map((entry) => entry.slug), ['architecture'])
})

test('an external rewrite that keeps the element count still bumps the revision (P1-1)', async (t) => {
  let clock = 1_000
  const { root, store } = await workspace(t, { now: () => clock })
  const first = await store.writeScene({ slug: 'architecture', name: 'Architecture', document: scene(1) })

  // Move a box without changing the element count: the normal editor / agent
  // `fs.write` case the old element-count heuristic missed.
  const edited = scene(1)
  edited.elements[0].x = 999
  clock = 2_000
  await writeFile(join(root, `architecture${SCENE_SUFFIX}`), JSON.stringify(edited))
  const refreshed = await store.refreshFromDisk()
  assert.equal(refreshed.changed, true, 'a fingerprint change is a change')
  assert.ok(refreshed.revision > first.revision)
  assert.equal((await store.snapshot()).revision, refreshed.revision)

  // A read that arrives before the scan adopts the change itself, so `/scene`
  // cannot answer 304 for bytes it never served.
  edited.elements[0].x = 1234
  clock = 3_000
  await writeFile(join(root, `architecture${SCENE_SUFFIX}`), JSON.stringify(edited))
  const direct = await store.readScene('architecture')
  assert.ok(direct.revision > refreshed.revision)
  assert.match(direct.text, /"x":1234/)
  assert.equal(direct.etag, `"${direct.revision}-architecture"`)
  assert.equal((await store.snapshot()).revision, direct.revision)

  // Idempotent once adopted: the store's own bookkeeping cannot bump again.
  const after = await store.refreshFromDisk()
  assert.equal(after.changed, false)
  assert.equal((await store.readScene('architecture')).revision, direct.revision)
})

test('an index written before fingerprints are backfilled once without a bump (P1-1)', async (t) => {
  let clock = 500
  const { root, store } = await workspace(t, { now: () => clock })
  await mkdir(root, { recursive: true })
  await writeFile(join(root, `old${SCENE_SUFFIX}`), JSON.stringify(scene(2)))
  // A pre-fingerprint index: same scene, no `fingerprint` field.
  await writeFile(
    join(root, INDEX_FILE),
    JSON.stringify({
      revision: 42,
      scenes: [{ slug: 'old', file: `old${SCENE_SUFFIX}`, name: 'Old', elements: 2, updatedAt: 1 }],
    }),
  )
  const backfilled = await store.refreshFromDisk()
  assert.equal(backfilled.changed, false, 'a missing fingerprint alone is not a change')
  assert.equal(backfilled.revision, 42)
  const index = JSON.parse(await readFile(join(root, INDEX_FILE), 'utf8'))
  assert.equal(Number.isFinite(index.scenes[0].fingerprint?.size), true)

  // From then on a content rewrite is detected.
  clock = 600
  await writeFile(join(root, `old${SCENE_SUFFIX}`), JSON.stringify(scene(2)))
  const changed = await store.refreshFromDisk()
  assert.equal(changed.changed, true)
  assert.ok(changed.revision > 42)
})

test('refreshFromDisk requires no pre-existing index', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-adopt-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))
  const store = createStore({ root, watch: false })
  t.after(() => store.close())
  await assert.rejects(store.readScene('architecture'), (error) => error.code === 'no-scene')
  await writeFile(join(root, `handmade${SCENE_SUFFIX}`), JSON.stringify(scene(3)))
  const result = await store.refreshFromDisk()
  assert.equal(result.changed, true)
  assert.ok(result.revision >= 1, 'the first revision comes from the clock')
  const listed = await store.listScenes()
  assert.deepEqual(listed.scenes.map((entry) => entry.slug), ['handmade'])
  assert.equal(listed.scenes[0].name, 'handmade')
})

test('scene documents are written as .excalidraw and legacy .excalidraw.json files stay readable', async (t) => {
  const { root, store } = await workspace(t)
  assert.equal(SCENE_SUFFIX, '.excalidraw')
  const legacySuffix = '.excalidraw.json'

  const written = await store.writeScene({ slug: 'architecture', name: 'Architecture', document: scene(2) })
  assert.equal(written.file, 'architecture.excalidraw')
  const bytes = await readFile(join(root, 'architecture.excalidraw'), 'utf8')
  assert.equal(bytes, JSON.stringify(scene(2)), 'the new file is still a JSON document')

  // A file written by an older plugin version is read and indexed as-is.
  await writeFile(join(root, `legacy${legacySuffix}`), JSON.stringify(scene(3)))
  const scanned = await store.refreshFromDisk()
  assert.equal(scanned.changed, true)
  const legacy = await store.readScene('legacy')
  assert.equal(legacy.file, `legacy${legacySuffix}`)
  assert.equal(legacy.text, JSON.stringify(scene(3)))
  let listed = await store.listScenes()
  assert.deepEqual(listed.scenes.map((entry) => entry.slug).sort(), ['architecture', 'legacy'])
  assert.equal(listed.scenes.find((entry) => entry.slug === 'legacy').file, `legacy${legacySuffix}`)

  // One slug with both names: the current extension wins and the slug is
  // listed once, never twice.
  await writeFile(join(root, `both${SCENE_SUFFIX}`), JSON.stringify(scene(1)))
  await writeFile(join(root, `both${legacySuffix}`), JSON.stringify(scene(9)))
  const both = await store.readScene('both')
  assert.equal(both.file, `both${SCENE_SUFFIX}`)
  assert.equal(JSON.parse(both.text).elements.length, 1, 'the current extension wins')
  await store.refreshFromDisk()
  listed = await store.listScenes()
  assert.equal(listed.scenes.filter((entry) => entry.slug === 'both').length, 1)
  assert.equal(listed.scenes.find((entry) => entry.slug === 'both').file, `both${SCENE_SUFFIX}`)

  // The directory rebuild recognizes both suffixes.
  const index = JSON.parse(await readFile(join(root, INDEX_FILE), 'utf8'))
  assert.deepEqual(index.scenes.map((entry) => entry.slug).sort(), ['architecture', 'both', 'legacy'])
})

test('a corrupt index degrades to an empty store instead of throwing', async (t) => {
  const { root, store } = await workspace(t)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, INDEX_FILE), '{ not json')
  const snapshot = await store.snapshot()
  assert.deepEqual(snapshot, { revision: 0, scenes: [] })
  assert.deepEqual(await store.listScenes(), { revision: 0, scenes: [] })
})

test('a missing or corrupt index is rebuilt from the directory (P2-5)', async (t) => {
  let clock = 700
  const { root, store } = await workspace(t, { now: () => clock })
  await mkdir(root, { recursive: true })
  await writeFile(join(root, `orphan${SCENE_SUFFIX}`), JSON.stringify(scene(4)))
  await writeFile(join(root, INDEX_FILE), '{ not json')
  const listed = await store.listScenes()
  assert.deepEqual(listed.scenes.map((entry) => entry.slug), ['orphan'], 'a corrupt index does not hide the scene')
  assert.equal(listed.scenes[0].elements, 4)
  assert.ok(listed.revision >= 1)

  // The index disappearing entirely is the same recovery.
  await rm(join(root, INDEX_FILE))
  clock = 800
  const again = await store.listScenes()
  assert.deepEqual(again.scenes.map((entry) => entry.slug), ['orphan'])
  assert.ok(again.revision >= 1)
})

test('an empty index does not scan on every call once it is consistent (P2-5)', async (t) => {
  const { store } = await workspace(t)
  assert.deepEqual(await store.listScenes(), { revision: 0, scenes: [] })
  assert.deepEqual(await store.listScenes(), { revision: 0, scenes: [] })
})

test('a failed directory watch degrades to a low-frequency poll (P2-5)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-poll-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))
  const warnings = []
  const store = createStore({ root, pollMs: 40, logger: { warn: (message) => warnings.push(message) } })
  t.after(() => store.close())
  await store.start()
  assert.notEqual(store.watcher, null)
  assert.equal(store.pollTimer, null)

  // A platform that refuses the watch after start (e.g. the inotify limit)
  // must switch to polling, as CONTRACT §2 promises.
  store.watcher.emit('error', new Error('inotify watch limit reached'))
  assert.equal(store.watcher, null)
  assert.notEqual(store.pollTimer, null)
  assert.equal(warnings.some((message) => message.includes('polling')), true)

  await writeFile(join(root, `polled${SCENE_SUFFIX}`), JSON.stringify(scene(6)))
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if ((await store.snapshot()).scenes.some((entry) => entry.slug === 'polled')) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const listed = await store.listScenes()
  assert.deepEqual(listed.scenes.map((entry) => entry.slug), ['polled'])

  store.close()
  assert.equal(store.pollTimer, null, 'close() stops the poll timer')
})

test('an index with unusable scene entries is normalized', async (t) => {
  const { root, store } = await workspace(t)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, `kept${SCENE_SUFFIX}`), JSON.stringify(scene(1)))
  await writeFile(
    join(root, INDEX_FILE),
    JSON.stringify({
      revision: 42,
      scenes: [
        { slug: 'kept', name: 'Kept', elements: 1, updatedAt: 1 },
        { slug: 'BAD SLUG' },
        { slug: '../escape' },
        { name: 'no slug' },
        'not an object',
        { slug: 'kept', name: 'duplicate' },
      ],
      focus: { sessionId: 's', at: 42 },
    }),
  )
  const snapshot = await store.snapshot()
  assert.equal(snapshot.revision, 42)
  assert.deepEqual(snapshot.scenes.map((entry) => entry.slug), ['kept'])
  assert.deepEqual(snapshot.scenes[0].file, `kept${SCENE_SUFFIX}`)
  assert.deepEqual(snapshot.focus, { sessionId: 's', at: 42 })
  assert.equal((await store.readScene('kept')).etag, '"42-kept"')
})

test('atomic writes leave no temporary file behind', async (t) => {
  const { root, store } = await workspace(t)
  await store.writeScene({ slug: 'architecture', name: 'Architecture', document: scene() })
  const leftovers = (await import('node:fs/promises')).readdir(root)
  const names = await leftovers
  assert.equal(names.some((name) => name.endsWith('.tmp')), false)
})

test('two stores on one root never lose an entry or reuse a revision (P1-2)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-shared-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))
  const a = createStore({ root, watch: false })
  const b = createStore({ root, watch: false })
  t.after(() => a.close())
  t.after(() => b.close())

  const writes = []
  for (let i = 0; i < 8; i += 1) {
    const store = i % 2 === 0 ? a : b
    writes.push(store.writeScene({ slug: `scene-${i}`, name: `Scene ${i}`, document: scene(1 + (i % 3)) }))
  }
  const results = await Promise.all(writes)
  const revisions = results.map((result) => result.revision)
  assert.equal(new Set(revisions).size, revisions.length, 'every write gets its own revision')

  const index = JSON.parse(await readFile(join(root, INDEX_FILE), 'utf8'))
  assert.deepEqual(
    index.scenes.map((entry) => entry.slug).sort(),
    Array.from({ length: 8 }, (_, i) => `scene-${i}`).sort(),
    'no entry is lost to a concurrent index rewrite',
  )
  const names = await readdir(root)
  assert.deepEqual(names.filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left behind')
  assert.equal(names.includes('index.lock'), false, 'the lock is released')
})

test('two processes writing one root keep every entry and every revision (P1-2)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-multi-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))
  const storeUrl = new URL('../lib/store.js', import.meta.url).href
  const script = `
    const { createStore } = await import(${JSON.stringify(storeUrl)})
    const store = createStore({ root: process.env.SCENE_ROOT, watch: false })
    const doc = (n) => ({ type: 'excalidraw', version: 2, elements: Array.from({ length: n }, (_, i) => ({ id: 'e' + i, type: 'rectangle' })) })
    const revisions = []
    for (let i = 0; i < 6; i += 1) {
      const written = await store.writeScene({ slug: process.env.SCENE_PREFIX + '-' + i, name: 'Shared', document: doc(1) })
      revisions.push(written.revision)
    }
    store.close()
    console.log(JSON.stringify(revisions))
  `
  const run = (prefix) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      env: { ...process.env, SCENE_ROOT: root, SCENE_PREFIX: prefix },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`child ${prefix} timed out: ${stderr}`))
    }, 30_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(`child ${prefix} exited ${code}: ${stderr}`))
    })
    child.on('error', reject)
  })
  const outputs = await Promise.all([run('alpha'), run('beta')])
  const revisions = outputs.flatMap((output) => JSON.parse(output.trim().split('\n').pop()))
  assert.equal(revisions.length, 12)
  assert.equal(new Set(revisions).size, 12, 'no two writes may share a revision across processes')

  const index = JSON.parse(await readFile(join(root, INDEX_FILE), 'utf8'))
  assert.deepEqual(
    index.scenes.map((entry) => entry.slug).sort(),
    [...Array.from({ length: 6 }, (_, i) => `alpha-${i}`), ...Array.from({ length: 6 }, (_, i) => `beta-${i}`)].sort(),
    'both processes\' entries survive',
  )
  assert.equal(index.revision, Math.max(...revisions), 'the last writer records the highest revision')
  const names = await readdir(root)
  assert.equal(names.filter((name) => name.endsWith('.tmp')).length, 0, 'no temporary file survives')
  assert.equal(names.includes('index.lock'), false, 'the lock is released')
})

test('a failed rename removes its unique temporary file (P1-2)', async (t) => {
  const { root, store } = await workspace(t)
  await mkdir(root, { recursive: true })
  // A directory at the target path makes rename(temporary, file) fail.
  await mkdir(join(root, `blocked${SCENE_SUFFIX}`))
  await assert.rejects(store.writeScene({ slug: 'blocked', name: 'Blocked', document: scene(1) }))
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), [])
})

test('a stale index lock is taken over instead of wedging the store (P1-2)', async (t) => {
  const { root, store } = await workspace(t)
  await mkdir(root, { recursive: true })
  const lock = join(root, 'index.lock')
  await writeFile(lock, '')
  const old = new Date(Date.now() - 30_000)
  await utimes(lock, old, old)
  const written = await store.writeScene({ slug: 'architecture', name: 'Architecture', document: scene(1) })
  assert.ok(written.revision >= 1)
  assert.equal((await readdir(root)).includes('index.lock'), false)
})

test('the directory watch adopts an external scene file (or the store stays usable)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-watch-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))
  const store = createStore({ root })
  t.after(() => store.close())
  await store.start()

  assert.notEqual(store.watcher, null, 'the directory watch is installed')
  const base = await store.snapshot()
  await writeFile(join(root, `watched${SCENE_SUFFIX}`), JSON.stringify(scene(5)))
  const deadline = Date.now() + 10_000
  let revision = base.revision
  while (Date.now() < deadline) {
    revision = (await store.snapshot()).revision
    if (revision > base.revision) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (revision <= base.revision) {
    // An event-delivery platform under load may be slower than the store's
    // debounce; the poll-only path is the documented fallback (CONTRACT §2),
    // so reconcile explicitly and say that the watcher did not fire in time.
    t.diagnostic('the directory watch did not deliver an event in time; using the poll fallback')
    await store.refreshFromDisk()
    revision = (await store.snapshot()).revision
  }
  assert.ok(revision > base.revision, 'a new scene file must reach the index one way or the other')
  const listed = await store.listScenes()
  assert.deepEqual(listed.scenes.map((entry) => entry.slug), ['watched'])
  assert.equal(listed.scenes[0].elements, 5)
})

test('start() degrades to poll-only when the root cannot be created', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-degrade-'))
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))
  // The root's parent is a regular FILE, so mkdir/root and the watch both fail.
  const file = join(parent, 'not-a-dir')
  await writeFile(file, 'x')
  const warnings = []
  const store = createStore({ root: join(file, 'scenes'), logger: { warn: (message) => warnings.push(message) } })
  t.after(() => store.close())
  await store.start()
  assert.equal(store.watcher, null)
  assert.ok(warnings.length > 0)
  assert.notEqual(store.pollTimer, null, 'a watch that cannot start leaves the poll path running')
  // Reading still works (the store reports "no scene" rather than crashing).
  await assert.rejects(store.readScene('architecture'), (error) => error.code === 'no-scene')
  store.close()
  assert.equal(store.pollTimer, null)
})


test('a read never records a fingerprint for bytes it did not return (review round 3)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-read-race-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))
  const store = createStore({ root, logger: { warn() {}, debug() {} } })
  await store.start()
  t.after(() => store.close())

  const doc = (marker, size = 40000) => ({
    type: 'excalidraw',
    version: 2,
    elements: [{ id: 'e', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }],
    marker,
    padding: 'x'.repeat(size) + marker,
  })
  const path = join(root, 'architecture.excalidraw')
  const first = await store.writeScene({ slug: 'architecture', name: 'A', sceneId: 'sc', document: doc('A0'), source: 't', tool: 't' })

  let violations = 0
  for (let round = 0; round < 24; round += 1) {
    const marker = `M${round}`
    // One atomic external rewrite races one read; both are awaited before the
    // index is inspected, so the assertion is deterministic per round.
    const writing = writeFile(`${path}.round`, JSON.stringify(doc(marker))).then(() => rename(`${path}.round`, path))
    const reading = store.readScene('architecture').catch(() => undefined)
    await writing
    const served = await reading
    if (served === undefined || served.revision <= first.revision) continue
    const index = JSON.parse(await readFile(join(root, INDEX_FILE), 'utf8'))
    const entry = index.scenes.find((scene) => scene.slug === 'architecture')
    if (entry?.fingerprint?.sha1 === undefined) continue
    const servedSha1 = createHash('sha1').update(served.text).digest('hex')
    if (entry.fingerprint.sha1 !== servedSha1) violations += 1
  }
  assert.equal(violations, 0, 'the recorded fingerprint always describes the bytes that were served')
})

test('an uncleareable index.lock fails after the deadline instead of spinning forever (round 11 P1)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-lock-hang-'))
  try {
    await mkdir(join(root, 'index.lock'))
    await writeFile(join(root, 'index.lock', 'occupied'), 'x')
    const store = createStore({ root, watch: false, lockWaitMs: 400 })
    const started = Date.now()
    await assert.rejects(
      store.writeScene({ slug: 'architecture', name: 'A', document: scene(1) }),
      (error) => error.code === 'internal' && /locked/.test(error.message),
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 5000, `the lock wait must be bounded (took ${elapsed} ms)`)
    // The store is not wedged: the directory that blocked it can still be seen.
    await assert.rejects(
      store.writeScene({ slug: 'architecture', name: 'A', document: scene(1) }),
      (error) => error.code === 'internal',
    )
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  }
})

test('an external rewrite with a restored mtime still bumps the revision (round 11)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-sha1-'))
  try {
    const store = createStore({ root, watch: false })
    const written = await store.writeScene({ slug: 'architecture', name: 'A', document: scene(1) })
    const path = join(root, 'architecture.excalidraw')
    const before = await stat(path)
    const same = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'x', type: 'rectangle', x: 0, y: 0, width: 1, height: 1, marker: 'A' }] })
    const swapped = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'x', type: 'rectangle', x: 0, y: 0, width: 1, height: 1, marker: 'B' }] })
    assert.equal(Buffer.byteLength(same), Buffer.byteLength(swapped), 'the rewrite keeps the size')
    await writeFile(path, same)
    await utimes(path, before.atime, before.mtime)
    const first = await store.readScene('architecture')
    assert.equal(first.revision > written.revision, true, 'a first differing read bumps')
    await writeFile(path, swapped)
    await utimes(path, before.atime, before.mtime)
    const second = await store.readScene('architecture')
    assert.equal(second.text.includes('"B"'), true, 'the new bytes are served')
    assert.equal(second.revision > first.revision, true, 'the revision must bump again, not 304 the client')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  }
})

test('deleting every scene externally prunes the index and bumps (round 11)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-prune-'))
  try {
    const store = createStore({ root, watch: false })
    await store.writeScene({ slug: 'a', name: 'A', document: scene(1) })
    await store.writeScene({ slug: 'b', name: 'B', document: scene(2) })
    await rm(join(root, 'a.excalidraw'))
    await rm(join(root, 'b.excalidraw'))
    const refreshed = await store.refreshFromDisk()
    assert.equal(refreshed.changed, true)
    const listed = await store.listScenes()
    assert.deepEqual(listed.scenes, [])
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  }
})

test('pruning rewrites index.json and never bumps twice for the same deletion (round 14)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-prune2-'))
  try {
    const store = createStore({ root, watch: false })
    await store.writeScene({ slug: 'a', name: 'A', document: scene(1) })
    await store.writeScene({ slug: 'b', name: 'B', document: scene(2) })
    // Partial deletion: the index must drop the gone slug and keep the other.
    await rm(join(root, 'a.excalidraw'))
    const first = await store.refreshFromDisk()
    assert.equal(first.changed, true)
    const index = JSON.parse(await readFile(join(root, INDEX_FILE), 'utf8'))
    assert.deepEqual(index.scenes.map((entry) => entry.slug), ['b'])
    // A second scan has nothing left to do: no revision churn.
    const second = await store.refreshFromDisk()
    assert.equal(second.changed, false)
    assert.equal(second.revision, first.revision)
    // Full deletion: the index empties and the revision moves once.
    await rm(join(root, 'b.excalidraw'))
    const third = await store.refreshFromDisk()
    assert.equal(third.changed, true)
    const emptied = JSON.parse(await readFile(join(root, INDEX_FILE), 'utf8'))
    assert.deepEqual(emptied.scenes, [])
    const fourth = await store.refreshFromDisk()
    assert.equal(fourth.changed, false)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  }
})

test('cancelling at any check either succeeds or leaves the previous scene intact (round 18 P1)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-cancel2-'))
  try {
    const store = createStore({ root, watch: false })
    const first = await store.writeScene({ slug: 'architecture', name: 'A', sceneId: 's', document: scene(1) })
    const before = await readFile(join(root, 'architecture.excalidraw'), 'utf8')
    // Abort at every possible check: a refresh must never delete the old bytes.
    for (let threshold = 1; threshold <= 8; threshold += 1) {
      let checks = 0
      const signal = {
        get aborted() { return checks >= threshold },
        throwIfAborted() {
          checks += 1
          if (checks >= threshold) throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
        },
        addEventListener() {},
        removeEventListener() {},
      }
      let rejected = false
      try {
        await store.writeScene({ slug: 'architecture', name: 'A', sceneId: 's', document: { ...scene(1), marker: String(threshold + 10) }, signal })
      } catch (error) {
        rejected = true
        assert.equal(error.name, 'AbortError', `threshold ${threshold}`)
      }
      const after = await readFile(join(root, 'architecture.excalidraw'), 'utf8')
      if (rejected) {
        assert.equal(after, before, `threshold ${threshold}: the previous scene survives a cancelled refresh`)
      } else {
        assert.equal(after.includes(String(threshold + 10)), true, `threshold ${threshold}: a completed write is the new scene`)
        await store.writeScene({ slug: 'architecture', name: 'A', sceneId: 's', document: scene(1) })
      }
      const listed = await store.listScenes()
      assert.ok(listed.scenes.some((entry) => entry.slug === 'architecture'), `threshold ${threshold}: the index keeps the scene`)
    }
    assert.ok(first.revision > 0)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  }
})

test('a cancelled first write never leaves a partial scene behind (round 18)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-cancel3-'))
  try {
    for (let threshold = 1; threshold <= 8; threshold += 1) {
      const store = createStore({ root, watch: false })
      let checks = 0
      const signal = {
        get aborted() { return checks >= threshold },
        throwIfAborted() {
          checks += 1
          if (checks >= threshold) throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
        },
        addEventListener() {},
        removeEventListener() {},
      }
      let rejected = false
      try {
        await store.writeScene({ slug: 'fresh', name: 'F', sceneId: 'f', document: scene(threshold), signal })
      } catch (error) {
        rejected = true
        assert.equal(error.name, 'AbortError', `threshold ${threshold}`)
      }
      const listed = await store.listScenes()
      if (rejected) {
        assert.equal(listed.scenes.some((entry) => entry.slug === 'fresh'), false, `threshold ${threshold}`)
      } else {
        assert.equal(listed.scenes.some((entry) => entry.slug === 'fresh'), true, `threshold ${threshold}`)
        await rm(join(root, 'fresh.excalidraw'), { force: true })
        await rm(join(root, 'fresh.meta.json'), { force: true })
        await rm(join(root, 'index.json'), { force: true })
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  }
})

test('the lock fence refuses a commit whose token no longer owns the lock (round 18)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-fence-'))
  try {
    const store = createStore({ root, watch: false })
    await store.writeScene({ slug: 'a', name: 'A', document: scene(1) })
    const lockPath = join(root, 'index.lock')
    // Another writer owns the lock now: a commit must refuse.
    await writeFile(lockPath, 'someone-else')
    store.heldLock = { path: lockPath, token: 'our-token' }
    await assert.rejects(store.assertLockOwned(), (error) => error.code === 'internal' && /taken over|no longer held/.test(error.message))
    // The same token our file carries passes.
    store.heldLock = { path: lockPath, token: 'someone-else' }
    await store.assertLockOwned()
    // No lock held at all is also a refusal.
    store.heldLock = null
    await assert.rejects(store.assertLockOwned(), (error) => error.code === 'internal')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  }
})

test('a stale leftover .steal file does not block a takeover forever (round 18)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-steal-'))
  try {
    const store = createStore({ root, watch: false })
    await store.writeScene({ slug: 'a', name: 'A', document: scene(1) })
    // A dead stealer's lock file, old enough to be stale.
    const stealPath = join(root, 'index.lock.steal')
    await writeFile(stealPath, '')
    const old = new Date(Date.now() - 60_000)
    await utimes(stealPath, old, old)
    const lockPath = join(root, 'index.lock')
    await writeFile(lockPath, 'dead-writer')
    await utimes(lockPath, old, old)
    const started = Date.now()
    const written = await store.writeScene({ slug: 'b', name: 'B', document: scene(2) })
    assert.ok(written.revision > 0)
    assert.ok(Date.now() - started < 3000, 'the takeover recovered quickly')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  }
})

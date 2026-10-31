/**
 * The scene store (CONTRACT §2): one directory per conversation workspace,
 * holding scene documents, their meta sidecars, and `index.json`.
 *
 * Invariants implemented here:
 *  - `index.json` is the only revision source; `revision` strictly increases
 *    (`max(prev + 1, now)`), so a clock that jumps backwards cannot rewind it.
 *  - Every write is atomic: a unique `<file>.<pid>.<n>.tmp` then rename, and
 *    a failed rename removes the temporary file.
 *  - `index.json` read-modify-write cycles are serialized across processes by
 *    an exclusive lock file, so two hosts writing one root cannot lose an
 *    entry or hand out the same revision.
 *  - Scene paths are fenced: a slug is validated, the resolved path is
 *    prefix-checked against the root, and only a regular file (not a symlink)
 *    is served.
 *  - A scene larger than `maxSceneBytes` is refused on write and on read.
 *  - Every scene index entry carries a content fingerprint (size + mtime), so
 *    an external rewrite that keeps the element count is still a change.
 *  - `fs.watch` refreshes the index when files change outside the plugin; a
 *    watcher that cannot start degrades to poll-only, never throws.
 *  - `focus` (CONTRACT §2 auto-open handshake) is durable index state.
 */

import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { watch as watchDirectory } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, rename, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'

/** The slug grammar of CONTRACT §2. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
/** Slug used when a name yields nothing usable. */
export const DEFAULT_SLUG = 'architecture'
/**
 * Suffix of a scene document file. The bytes are still an Excalidraw JSON
 * document; the extension is `.excalidraw` so the sidebar's file viewer
 * (`exts: ['excalidraw']`) claims the file by name.
 */
export const SCENE_SUFFIX = '.excalidraw'
/** The suffix older versions wrote; reads and the directory scan still accept it. */
export const LEGACY_SCENE_SUFFIX = '.excalidraw.json'
/** Suffix of a scene meta file. */
export const META_SUFFIX = '.meta.json'
/** The revision/index file name inside the store root. */
export const INDEX_FILE = 'index.json'
/** The lock file serializing one root's index read-modify-write cycles. */
export const LOCK_FILE = 'index.lock'
/** A lock file older than this belongs to a writer that died: take it over.
 *  Comfortably above {@link LOCK_HEARTBEAT_MS} so a slow writer is not stolen. */
/** True for an AbortSignal cancellation (name survives wrappers). */
function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

/** Anything larger than this is corrupt, not a scene index. */
const MAX_INDEX_BYTES = 8 * 1024 * 1024

const LOCK_STALE_MS = 6000
/** While the lock is held its mtime is refreshed, so liveness outranks age. */
const LOCK_HEARTBEAT_MS = 500
/** How long to wait between lock attempts. */
const LOCK_RETRY_MS = 10
/** How long to wait for another writer before answering an internal error. */
const LOCK_WAIT_MS = 10_000
/** Low-frequency scan used when the directory watch is unavailable. */
const DEFAULT_POLL_MS = 5000
/** CONTRACT §1 default of `maxSceneBytes`. */
export const DEFAULT_MAX_SCENE_BYTES = 4194304

/** A refusal a route or tool can map to a wire code. */
export class StoreError extends Error {
  /**
   * @param {'bad-request' | 'no-scene' | 'scene-too-large' | 'internal'} code
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'StoreError'
    this.code = code
    this.status = status
  }
}

/**
 * Derive a slug from a scene name: lowercase, accents stripped, every run of
 * non-alphanumerics collapsed to one `-`, trimmed, capped at 64 characters
 * (CONTRACT §2).
 *
 * @param {unknown} name
 * @param {string} [fallback]
 * @returns {string} a string satisfying {@link SLUG_PATTERN}.
 */
export function slugify(name, fallback = DEFAULT_SLUG) {
  const raw = typeof name === 'string' ? name : ''
  let slug = raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64)
    .replace(/-+$/, '')
  if (slug === '') slug = fallback
  return SLUG_PATTERN.test(slug) ? slug : fallback
}

/**
 * Turn any caller-supplied slug into a valid one. An already valid slug is
 * kept verbatim (an explicit slug wins, CONTRACT §4); anything else is
 * slugified, never used as a path.
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export function normalizeSlug(value, fallback = DEFAULT_SLUG) {
  if (typeof value === 'string' && SLUG_PATTERN.test(value)) return value
  return slugify(value, fallback)
}

/** The slug a scene file name carries, or `undefined` for any other name. */
export function slugOfSceneFile(name) {
  if (typeof name !== 'string') return undefined
  const suffix = name.endsWith(LEGACY_SCENE_SUFFIX)
    ? LEGACY_SCENE_SUFFIX
    : name.endsWith(SCENE_SUFFIX)
      ? SCENE_SUFFIX
      : undefined
  if (suffix === undefined) return undefined
  const slug = name.slice(0, -suffix.length)
  return SLUG_PATTERN.test(slug) ? slug : undefined
}

/** One of a slug's scene file names; anything else falls back to the current suffix. */
function sceneFileName(slug, candidate) {
  if (typeof candidate === 'string' && (candidate === `${slug}${SCENE_SUFFIX}` || candidate === `${slug}${LEGACY_SCENE_SUFFIX}`)) {
    return candidate
  }
  return `${slug}${SCENE_SUFFIX}`
}

/**
 * The content fingerprint of one scene file: its size and modification time.
 * The index keeps it so a rewrite that leaves the element count unchanged is
 * still a change (CONTRACT §2: external edits must reach the revision).
 */
function fingerprintOf(info, bytes) {
  if (info === undefined || info === null) return undefined
  if (!Number.isFinite(info.mtimeMs) || !Number.isFinite(info.size)) return undefined
  const fingerprint = { mtimeMs: info.mtimeMs, size: info.size }
  if (Buffer.isBuffer(bytes) || typeof bytes === 'string') {
    // mtime+size misses a rewrite that restores the timestamp at the same size;
    // a hash of the served bytes closes that gap on every path that has them.
    fingerprint.sha1 = createHash('sha1').update(bytes).digest('hex')
  }
  return fingerprint
}

function isFingerprint(value) {
  return value !== null && typeof value === 'object' && Number.isFinite(value.mtimeMs) && Number.isFinite(value.size)
}

function sameFingerprint(left, right) {
  if (left === undefined || right === undefined || left === null || right === null) return false
  if (typeof left.sha1 === 'string' && typeof right.sha1 === 'string') return left.sha1 === right.sha1
  return left.mtimeMs === right.mtimeMs
    && left.size === right.size
}

/** Distinguishes concurrent atomic writes of one process (module-wide). */
let temporaryCounter = 0

/** A temporary name no other writer can collide with: `<file>.<pid>.<n>.tmp`. */
function temporaryName(file) {
  temporaryCounter += 1
  return `${file}.${process.pid}.${temporaryCounter}.tmp`
}

/** The ETag of one scene document: `"<revision>-<slug>"` (CONTRACT §3). */
export function sceneEtag(revision, slug) {
  return `"${revision}-${slug}"`
}

/**
 * The ETag of the revision projection (CONTRACT §3, extended by P2-7):
 * `"<revision>"` before a focus pointer exists, `"<revision>-<focus.at>"`
 * after it, so a client that cached the revision cannot be answered
 * "not modified" while the focus it watches has changed.
 */
export function revisionEtag(revision, focusAt) {
  // `rev-` namespaces the poll validator: a scene ETag is `"<revision>-<slug>"`,
  // so a numeric slug could otherwise alias a focus value (round 14).
  return Number.isFinite(focusAt) ? `"rev-${revision}-${Math.trunc(focusAt)}"` : `"rev-${revision}"`
}

/**
 * The largest revision the store will keep using: above it, `revision + 1` is
 * no longer exact (the frozen-revision bug of P2-4).
 */
export const MAX_REVISION = Number.MAX_SAFE_INTEGER - 1

/**
 * The next revision: monotonic even when the wall clock moves backwards.
 *
 * A stored value that is not a safe integer, or one that has reached the float
 * ceiling (`base + 1 === base`), is rebuilt from the clock. Clamping such a
 * value to the ceiling would only postpone the freeze by one write and the
 * client's `next <= current.revision` rule would then ignore every later
 * revision, so a corrupt revision is reset instead of clamped.
 */
export function nextRevision(previous, now) {
  const base = Number.isFinite(previous) ? Math.trunc(previous) : 0
  const clock = Number.isFinite(now) ? Math.trunc(now) : 0
  const rebuilt = clock > 0 ? clock : 1
  if (!Number.isSafeInteger(base) || base >= MAX_REVISION) return rebuilt
  return Math.max(base + 1, clock)
}

function emptyIndex() {
  return { revision: 0, scenes: [] }
}

/** Coerce a parsed `index.json` into the shape the store relies on. */
function normalizeIndex(raw) {
  const index = emptyIndex()
  if (raw === null || typeof raw !== 'object') return index
  // Only a safe integer is a usable revision; anything else (a tampered
  // `1e308`, `2^53`, a float) is rebuilt from the clock by `nextRevision`.
  if (typeof raw.revision === 'number' && Number.isSafeInteger(Math.trunc(raw.revision)) && Math.trunc(raw.revision) > 0) {
    index.revision = Math.min(Math.trunc(raw.revision), MAX_REVISION)
  }
  if (Array.isArray(raw.scenes)) {
    const seen = new Set()
    for (const candidate of raw.scenes) {
      if (candidate === null || typeof candidate !== 'object') continue
      const slug = candidate.slug
      if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug) || seen.has(slug)) continue
      seen.add(slug)
      const entry = {
        slug,
        file: sceneFileName(slug, candidate.file),
        name: typeof candidate.name === 'string' && candidate.name.trim() !== '' ? candidate.name.trim() : slug,
        sceneId: typeof candidate.sceneId === 'string' && candidate.sceneId !== '' ? candidate.sceneId : null,
        elements: Number.isFinite(candidate.elements) ? Math.max(0, Math.trunc(candidate.elements)) : 0,
        updatedAt: Number.isFinite(candidate.updatedAt) ? Math.trunc(candidate.updatedAt) : 0,
      }
      if (isFingerprint(candidate.fingerprint)) {
        entry.fingerprint = { mtimeMs: candidate.fingerprint.mtimeMs, size: candidate.fingerprint.size }
        if (typeof candidate.fingerprint.sha1 === 'string') entry.fingerprint.sha1 = candidate.fingerprint.sha1
      }
      index.scenes.push(entry)
    }
  }
  const focus = raw.focus
  if (focus !== null && typeof focus === 'object' && typeof focus.sessionId === 'string' && focus.sessionId !== '' && Number.isFinite(focus.at)) {
    index.focus = { sessionId: focus.sessionId, at: Math.trunc(focus.at) }
  }
  return index
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One conversation workspace's scene directory.
 *
 * Construct it with an absolute root; call {@link SceneStore#start} once to
 * bring up the directory watch, and {@link SceneStore#close} on plugin
 * teardown.
 */
export class SceneStore {
  /**
   * @param {object} options
   * @param {string} options.root - absolute scene root (`<cwd>/<scenesDir>`).
   * @param {number} [options.maxSceneBytes]
   * @param {{ warn?: Function, info?: Function, debug?: Function }} [options.logger]
   * @param {() => number} [options.now] - injectable clock (tests).
   * @param {number} [options.debounceMs] - watcher debounce.
   * @param {number} [options.pollMs] - poll-only fallback interval (CONTRACT §2).
   * @param {boolean} [options.watch] - `false` disables the directory watch.
   */
  constructor(options) {
    const {
      root,
      maxSceneBytes = DEFAULT_MAX_SCENE_BYTES,
      logger,
      now = () => Date.now(),
      debounceMs = 100,
      pollMs = DEFAULT_POLL_MS,
      watch = true,
      lockWaitMs = LOCK_WAIT_MS,
    } = options ?? {}
    if (typeof root !== 'string' || !isAbsolute(root)) {
      throw new StoreError('internal', 'the scene store root must be an absolute path', 500)
    }
    this.root = resolve(root)
    this.maxSceneBytes = Number.isFinite(maxSceneBytes) ? Math.trunc(maxSceneBytes) : DEFAULT_MAX_SCENE_BYTES
    this.logger = logger
    this.now = now
    this.debounceMs = debounceMs
    this.lockWaitMs = Number.isFinite(lockWaitMs) && lockWaitMs > 0 ? Math.trunc(lockWaitMs) : LOCK_WAIT_MS
    this.pollMs = Number.isFinite(pollMs) && pollMs > 0 ? Math.trunc(pollMs) : DEFAULT_POLL_MS
    this.watchEnabled = watch !== false
    this.indexCache = null
    this.indexStamp = null
    this.queue = Promise.resolve()
    this.watcher = null
    this.watchTimer = null
    this.pollTimer = null
    this.closed = false
  }

  /** Path of one scene document. */
  scenePath(slug) {
    return this.fencedPath(slug)
  }

  /**
   * Write one exported artifact next to the scenes (`<slug>.svg`). The atomic
   * write keeps a reader from seeing half a file.
   *
   * @param {string} rawSlug
   * @param {string} text
   * @returns {Promise<{ file: string, bytes: number }>}
   */
  async writeExport(rawSlug, text, options = {}) {
    const slug = this.requireSlug(rawSlug)
    if (typeof text !== 'string' || text === '') {
      throw new StoreError('bad-request', 'an export needs content')
    }
    // Embedded fonts are deterministic overhead the scene itself does not carry;
    // they must not turn a scene that fits into a `scene-too-large` refusal.
    const allowance = Number.isFinite(options.allowance) && options.allowance > 0 ? Math.trunc(options.allowance) : 0
    const limit = this.maxSceneBytes + allowance
    const size = Buffer.byteLength(text, 'utf8')
    if (size > limit) {
      throw new StoreError('scene-too-large', `export "${slug}" would be ${size} bytes, above the ${limit}-byte limit`, 413)
    }
    await this.ensureRoot()
    const file = `${slug}.svg`
    await this.atomicWrite(this.fencedName(file), text)
    return { file, bytes: size }
  }

  /** Relative file name of a scene document written now. */
  fileOf(slug) {
    return `${slug}${SCENE_SUFFIX}`
  }

  /** Absolute path of one of a slug's scene files (current or legacy name). */
  sceneFilePath(slug, file) {
    const name = sceneFileName(slug, file)
    return this.fencedPath(slug, name === `${slug}${LEGACY_SCENE_SUFFIX}` ? LEGACY_SCENE_SUFFIX : SCENE_SUFFIX)
  }

  /** Path of one scene's meta sidecar. */
  metaPath(slug) {
    return join(this.root, `${slug}${META_SUFFIX}`)
  }

  /** Create the store root on demand (CONTRACT §2: `<cwd>/<scenesDir>`). */
  async ensureRoot() {
    await mkdir(this.root, { recursive: true })
  }

  /**
   * Start the directory watch. Failures are logged and left as poll-only
   * (CONTRACT §2: "Watcher failures must degrade to poll only, never crash").
   */
  async start() {
    if (!this.watchEnabled || this.closed) return
    try {
      await this.ensureRoot()
    } catch (error) {
      this.log('warn', `cannot create the scene directory ${this.root}: ${messageOf(error)}; falling back to polling`)
      this.startPolling()
      return
    }
    if (this.closed) return
    try {
      this.watcher = watchDirectory(this.root, { persistent: false })
      this.watcher.on('error', (error) => {
        this.log('warn', `scene directory watch failed (${messageOf(error)}); falling back to polling`)
        try {
          this.watcher?.close?.()
        } catch {
          // Nothing left to close.
        }
        this.watcher = null
        this.startPolling()
      })
      this.watcher.on('change', (_event, filename) => this.scheduleRefresh(filename))
    } catch (error) {
      this.log('warn', `scene directory watch could not start (${messageOf(error)}); falling back to polling`)
      this.watcher = null
      this.startPolling()
    }
  }

  /**
   * Start the low-frequency `refreshFromDisk` scan that CONTRACT §2 promises
   * when `fs.watch` is unavailable. Idempotent and unreferenced, so it never
   * keeps the process alive.
   */
  startPolling() {
    if (!this.watchEnabled || this.closed || this.pollTimer !== null) return
    this.pollTimer = setInterval(() => {
      this.refreshFromDisk().catch((error) => {
        this.log('warn', `scene poll refresh failed: ${messageOf(error)}`)
      })
    }, this.pollMs)
    this.pollTimer.unref?.()
  }

  /** Stop the watcher and drop the index cache. */
  close() {
    this.closed = true
    if (this.watchTimer !== null) {
      clearTimeout(this.watchTimer)
      this.watchTimer = null
    }
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    try {
      this.watcher?.close?.()
    } catch {
      // Already closed.
    }
    this.watcher = null
    this.indexCache = null
    this.indexStamp = null
  }

  /**
   * The revision projection (`/rev`): `{ revision, scenes, focus? }`.
   * Cheap on the hot path — an `index.json` stat validates the cached copy.
   */
  async snapshot() {
    const index = await this.loadIndex()
    return {
      revision: index.revision,
      scenes: index.scenes.map((entry) => ({ ...entry })),
      ...(index.focus === undefined ? {} : { focus: { ...index.focus } }),
    }
  }

  /**
   * Scenes that can actually be served, in index order.
   * @returns {Promise<{ revision: number, scenes: Array<{slug: string, file: string, name: string, sceneId: string | null, elements: number, updatedAt: number}> }>}
   */
  async listScenes() {
    let index = await this.loadIndex()
    if (index.scenes.length === 0 || this.indexDirty === true) {
      // A missing or corrupt index must not hide every scene forever: scan the
      // directory once, exactly like a watcher event would (P2-5).
      await this.refreshFromDisk()
      index = await this.loadIndex()
    }
    const scenes = []
    for (const entry of index.scenes) {
      try {
        const info = await lstat(this.sceneFilePath(entry.slug, entry.file))
        if (!info.isFile()) continue
      } catch {
        // The file vanished behind the index: the watcher (or the next read)
        // reconciles it; never advertise a scene that cannot be served.
        continue
      }
      scenes.push({ ...entry })
    }
    return { revision: index.revision, scenes }
  }

  /**
   * Read one scene document as the exact bytes on disk, with its ETag.
   *
   * @param {string} rawSlug
   * @returns {Promise<{ slug: string, bytes: Buffer, text: string, revision: number, etag: string }>}
   */
  /**
   * Read one scene file with a stat pair that brackets the read. A write landing
   * between the read and the stat used to record the NEW fingerprint next to the
   * OLD bytes, which made the client's next ETag a 304 for content it never saw.
   * When the file will not hold still, no stat is claimed (`info` undefined) and
   * the caller answers the current revision without adopting anything.
   *
   * @param {string} path
   * @returns {Promise<{ bytes: Buffer, info: import('node:fs').Stats | undefined }>}
   */
  async readVerified(path) {
    let bytes = Buffer.alloc(0)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let before
      try {
        before = await lstat(path)
      } catch (error) {
        return { bytes, info: undefined, missing: error?.code === 'ENOENT' }
      }
      bytes = await readFile(path)
      let after
      try {
        after = await lstat(path)
      } catch {
        continue
      }
      if (after.mtimeMs === before.mtimeMs && after.size === before.size && bytes.length === before.size) {
        return { bytes, info: before }
      }
    }
    return { bytes, info: undefined, missing: false }
  }

  async readScene(rawSlug) {
    const slug = this.requireSlug(rawSlug)
    const located = await this.locateScene(slug)
    const { info } = located
    if (info.size > this.maxSceneBytes) {
      throw new StoreError(
        'scene-too-large',
        `scene "${slug}" is ${info.size} bytes, above the ${this.maxSceneBytes}-byte limit`,
        413,
      )
    }
    let bytes
    let verified
    try {
      const read = await this.readVerified(located.path)
      bytes = read.bytes
      verified = read.info
      if (read.missing === true) throw new StoreError('no-scene', `no scene "${slug}"`)
    } catch (error) {
      if (error instanceof StoreError) throw error
      throw new StoreError('no-scene', `no scene "${slug}"`)
    }
    if (bytes.length > this.maxSceneBytes) {
      throw new StoreError(
        'scene-too-large',
        `scene "${slug}" is ${bytes.length} bytes, above the ${this.maxSceneBytes}-byte limit`,
        413,
      )
    }
    // The index is the only revision source, but an external write may land
    // between scans: adopt it before answering so the ETag moves with the
    // bytes instead of 304-ing a stale revision (P1-1).
    // Only a fingerprint that provably describes `bytes` may be adopted. When
    // the file will not hold still, the bytes still must not ride an unchanged
    // revision: bump, so a client caching this ETag cannot keep them forever.
    const revision = verified === undefined
      ? await this.adoptExternalChange(slug, located.file, undefined, bytes)
      : await this.adoptExternalChange(slug, located.file, verified, bytes)
    return {
      slug,
      file: located.file,
      bytes,
      text: bytes.toString('utf8'),
      revision,
      etag: sceneEtag(revision, slug),
    }
  }

  /**
   * Make the index agree with a scene file that was just read. A change the
   * watcher has not seen yet bumps the revision here, so `/scene` and `/rev`
   * cannot keep serving the old bytes under an unchanged ETag.
   *
   * An entry written before fingerprints existed is backfilled once without a
   * bump, because whether it changed is unknowable.
   *
   * @param {string} slug - an already validated slug.
   * @param {string} file - the actual scene file name the read used.
   * @param {import('node:fs').Stats | undefined} info - its stat.
   * @returns {Promise<number>} the revision this read must carry.
   */
  async adoptExternalChange(slug, file, info, bytes) {
    return this.mutate(() => this.withIndexLock(async () => {
      const index = await this.loadIndex(true)
      const position = index.scenes.findIndex((entry) => entry.slug === slug)
      const current = position === -1 ? undefined : index.scenes[position]
      const dirty = this.indexDirty === true

      if (info === undefined) {
        // The read raced a rewrite: advance the revision without claiming a
        // fingerprint, so these bytes never ride a stale revision.
        const revision = nextRevision(index.revision, this.now())
        await this.writeIndex({ ...index, revision })
        return revision
      }

      const fingerprint = fingerprintOf(info, bytes)
      const known = isFingerprint(current?.fingerprint)
      const drifted = known && !sameFingerprint(current.fingerprint, fingerprint)
      const moved = current !== undefined && current.file !== file
      let scenes = index.scenes
      let changed = false

      if (current === undefined || drifted || moved) {
        const refreshed = await this.describeFile(current, slug, file)
        if (fingerprint !== undefined) refreshed.fingerprint = fingerprint
        scenes = current === undefined
          ? [...index.scenes, refreshed]
          : index.scenes.map((entry, at) => (at === position ? refreshed : entry))
        changed = true
      } else if (!known && fingerprint !== undefined) {
        // Legacy entry: adopt a fingerprint once, without pretending the scene
        // changed.
        scenes = index.scenes.map((entry, at) => (at === position ? { ...entry, fingerprint } : entry))
      }

      if (index.scenes.length === 0) {
        // Reading one scene must not hide the others: when the index was
        // missing or unreadable, carry the directory's scenes over.
        const scanned = await this.scanIndexFromFiles()
        const present = new Set(scenes.map((entry) => entry.slug))
        scenes = [...scenes, ...scanned.scenes.filter((entry) => !present.has(entry.slug))]
        changed = true
      }

      if (!changed && !dirty) return index.revision
      // A scanned index (dirty) is not persisted yet; a changed one must be.
      const revision = changed || dirty ? nextRevision(index.revision, this.now()) : index.revision
      await this.writeIndex({ ...index, revision, scenes })
      return revision
    }))
  }

  /**
   * Describe every scene file in the directory as an index. Reads only: the
   * caller persists it (inside the lock) if it decides to. Used when the index
   * is missing or unreadable, so a damaged index cannot hide the scenes.
   *
   * @returns {Promise<{ revision: number, scenes: object[] }>}
   */
  async scanIndexFromFiles() {
    let names
    try {
      names = await readdir(this.root)
    } catch {
      return emptyIndex()
    }
    const found = new Map()
    for (const name of names) {
      const slug = slugOfSceneFile(name)
      if (slug === undefined) continue
      const legacy = name.endsWith(LEGACY_SCENE_SUFFIX)
      const previous = found.get(slug)
      if (previous === undefined || (previous.legacy && !legacy)) found.set(slug, { file: name, legacy })
    }
    if (found.size === 0) return emptyIndex()
    const scenes = []
    for (const [slug, actual] of found) {
      const entry = await this.describeFile(undefined, slug, actual.file).catch(() => null)
      if (entry !== null && entry !== undefined) scenes.push(entry)
    }
    return { revision: 0, scenes }
  }

  /** The current content fingerprint of one scene path (`undefined` when unreadable). */
  async fingerprintOf(path) {
    try {
      return fingerprintOf(await stat(path))
    } catch {
      return undefined
    }
  }

  /**
   * Find one scene's document: the current `<slug>.excalidraw` first, the
   * legacy `<slug>.excalidraw.json` second. A path that exists but is not a
   * regular file is refused rather than skipped, so a symlink cannot shadow
   * the legacy file.
   *
   * @param {string} slug - an already validated slug.
   * @returns {Promise<{ path: string, file: string, info: import('node:fs').Stats }>}
   */
  async locateScene(slug) {
    for (const suffix of [SCENE_SUFFIX, LEGACY_SCENE_SUFFIX]) {
      const path = this.fencedPath(slug, suffix)
      let info
      try {
        info = await lstat(path)
      } catch {
        continue
      }
      if (!info.isFile()) throw new StoreError('no-scene', `"${slug}" is not a scene file`)
      return { path, file: `${slug}${suffix}`, info }
    }
    throw new StoreError('no-scene', `no scene "${slug}"`)
  }

  /**
   * Write one scene document and its meta sidecar atomically, then bump the
   * revision and record the scene in the index.
   *
   * @param {object} input
   * @param {string} [input.slug] - explicit or name-derived slug.
   * @param {string} [input.name] - display name.
   * @param {string | null} [input.sceneId]
   * @param {object} input.document - the Excalidraw scene document.
   * @param {string} [input.source]
   * @param {string} [input.tool]
   * @returns {Promise<{slug: string, file: string, name: string, sceneId: string | null, elements: number, updatedAt: number, revision: number}>}
   */
  async writeScene(input, options = {}) {
    const { slug: rawSlug, name, sceneId = null, document, source = null, tool = null } = input ?? {}
    // The tool passes the signal inside the input; keep accepting the options
    // form too. Without this the cancellation path was never reached (round 18).
    const signal = options?.signal ?? input?.signal
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
      throw new StoreError('bad-request', 'a scene document must be an object')
    }
    if (!Array.isArray(document.elements)) {
      throw new StoreError('bad-request', 'a scene document must carry an elements array')
    }
    const slug = normalizeSlug(rawSlug, DEFAULT_SLUG)
    const displayName = typeof name === 'string' && name.trim() !== '' ? name.trim() : slug
    const text = JSON.stringify(document)
    const size = Buffer.byteLength(text, 'utf8')
    if (size > this.maxSceneBytes) {
      throw new StoreError(
        'scene-too-large',
        `scene "${slug}" would be ${size} bytes, above the ${this.maxSceneBytes}-byte limit`,
        413,
      )
    }
    return this.mutate(async () => {
      signal?.throwIfAborted?.()
      await this.ensureRoot()
      const updatedAt = this.now()

      return this.withIndexLock(async () => {
        signal?.throwIfAborted?.()
        // Inside the lock: an abort while waiting for it must leave no scene.
        // Record whether these files already exist: a cancelled *refresh* must
        // not delete the scene it was replacing (round 17 over-corrected).
        const previous = await lstat(this.fencedPath(slug)).then((info) => info.isFile()).catch(() => false)
        const previousMeta = await lstat(this.metaPath(slug)).then((info) => info.isFile()).catch(() => false)
        // Keep the bytes a cancelled refresh has to put back (bounded by the same
        // size limit as the scene itself).
        const previousText = previous ? await readFile(this.fencedPath(slug), 'utf8').catch(() => null) : null
        const previousMetaText = previousMeta ? await readFile(this.metaPath(slug), 'utf8').catch(() => null) : null
        // Fencing: if our lock was stolen, do not write at all.
        await this.assertLockOwned()
        await this.atomicWrite(this.fencedPath(slug), text)
        const meta = { slug, name: displayName, sceneId: sceneId ?? null, source, tool, updatedAt }
        await this.atomicWrite(this.metaPath(slug), `${JSON.stringify(meta, null, 2)}\n`)
        const index = await this.loadIndex(true)
        const scenes = index.scenes.filter((entry) => entry.slug !== slug)
        const entry = {
          slug,
          file: this.fileOf(slug),
          name: displayName,
          sceneId: meta.sceneId,
          elements: document.elements.length,
          updatedAt,
        }
        const written = await lstat(this.fencedPath(slug)).catch(() => null)
        const fingerprint = written === null ? undefined : fingerprintOf(written, text)
        if (fingerprint !== undefined) entry.fingerprint = fingerprint
        scenes.push(entry)
        const revision = nextRevision(index.revision, this.now())
        try {
          signal?.throwIfAborted?.()
          await this.writeIndex({ ...index, revision, scenes })
        } catch (error) {
          if (isAbortError(error)) {
            // "Writes nothing": a *new* slug loses the files it just created, and
            // a refresh puts the previous bytes back instead of leaving a scene
            // the index never recorded (round 18).
            if (!previous) await unlink(this.fencedPath(slug)).catch(() => {})
            else if (previousText !== null) await this.atomicWrite(this.fencedPath(slug), previousText).catch(() => {})
            if (!previousMeta) await unlink(this.metaPath(slug)).catch(() => {})
            else if (previousMetaText !== null) await this.atomicWrite(this.metaPath(slug), previousMetaText).catch(() => {})
          }
          throw error
        }
        return { slug, file: this.fileOf(slug), name: displayName, sceneId: meta.sceneId, elements: document.elements.length, updatedAt, revision }
      }, signal)
    })
  }

  /**
   * Bump the revision without touching a scene (the `excalidraw_open`
   * handshake needs a fresh focus target).
   * @returns {Promise<number>} the new revision.
   */
  async bump(now = this.now(), options = {}) {
    return this.mutate(() => this.withIndexLock(async () => {
      const index = await this.loadIndex(true)
      const revision = nextRevision(index.revision, now)
      await this.writeIndex({ ...index, revision })
      return revision
    }, options.signal))
  }

  /**
   * Record the auto-open focus pointer (CONTRACT §2). `at` defaults to the
   * current revision; the caller normally passes the revision it just wrote.
   *
   * @param {{ sessionId: string, at?: number }} input
   * @returns {Promise<{ revision: number, focus: { sessionId: string, at: number } }>}
   */
  async markFocus(input, options = {}) {
    const sessionId = input?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new StoreError('bad-request', 'the focus pointer needs a session id')
    }
    return this.mutate(() => this.withIndexLock(async () => {
      options.signal?.throwIfAborted?.()
      const index = await this.loadIndex(true)
      const at = Number.isFinite(input.at) ? Math.trunc(input.at) : index.revision
      const focus = { sessionId, at }
      await this.writeIndex({ ...index, focus })
      return { revision: index.revision, focus: { ...focus } }
    }, options.signal))
  }

  /**
   * Reconcile `index.json` with the scene files on disk. Runs on watcher
   * events and on demand; a no-op (same revision) when nothing changed, so our
   * own writes cannot trigger a feedback bump.
   *
   * @returns {Promise<{ changed: boolean, revision: number }>}
   */
  async refreshFromDisk() {
    return this.mutate(() => this.withIndexLock(async () => {
      const index = await this.loadIndex(true)
      let names
      try {
        names = await readdir(this.root)
      } catch {
        return { changed: false, revision: index.revision }
      }
      // One entry per slug; the current extension wins when both names exist.
      const found = new Map()
      for (const name of names) {
        const slug = slugOfSceneFile(name)
        if (slug === undefined) continue
        const legacy = name.endsWith(LEGACY_SCENE_SUFFIX)
        const previous = found.get(slug)
        if (previous === undefined || (previous.legacy && !legacy)) found.set(slug, { file: name, legacy })
      }

      const next = []
      let changed = false
      let backfill = false
      const kept = new Set()
      for (const entry of index.scenes) {
        const actual = found.get(entry.slug)
        if (actual === undefined) {
          changed = true
          continue
        }
        kept.add(entry.slug)
        const refreshed = await this.describeFile(entry, entry.slug, actual.file)
        if (!isFingerprint(entry.fingerprint)) {
          // An index written before content fingerprints existed: record one
          // now (once) without a revision bump, so the next real change is
          // detected from this point on.
          backfill = true
        } else if (
          !sameFingerprint(entry.fingerprint, refreshed.fingerprint)
          || refreshed.file !== entry.file
          || refreshed.elements !== entry.elements
          || refreshed.name !== entry.name
          || refreshed.sceneId !== entry.sceneId
        ) {
          changed = true
        }
        next.push(refreshed)
      }
      for (const slug of [...found.keys()].filter((candidate) => !kept.has(candidate)).sort()) {
        next.push(await this.describeFile(undefined, slug, found.get(slug).file))
        changed = true
      }
      if (!changed && !backfill && this.indexDirty !== true) {
        return { changed: false, revision: index.revision }
      }
      if (next.length === 0) {
        if (index.scenes.length === 0) {
          // Nothing on disk and nothing recorded: no index write, no revision.
          this.indexDirty = false
          return { changed: false, revision: index.revision }
        }
        // Every scene disappeared externally: prune the index and bump, or
        // `/rev` keeps advertising scenes that `/scenes` no longer has.
        const revision = nextRevision(index.revision, this.now())
        await this.writeIndex({ ...index, revision, scenes: [], focus: null })
        return { changed: true, revision }
      }
      if (!changed) {
        // A scanned index (or a legacy one) must reach the disk, and the
        // revision it carries is not trustworthy: take it from the clock.
        const revision = this.indexDirty === true ? nextRevision(index.revision, this.now()) : index.revision
        await this.writeIndex({ ...index, revision, scenes: next })
        return { changed: this.indexDirty === true, revision }
      }

      const revision = nextRevision(index.revision, this.now())
      await this.writeIndex({ ...index, revision, scenes: next })
      return { changed: true, revision }
    }))
  }

  /** Describe one scene file, preferring an existing index entry / its meta. */
  async describeFile(entry, slug, file) {
    const sceneSlug = slug ?? entry.slug
    const fileName = sceneFileName(sceneSlug, file ?? entry?.file)
    const path = this.sceneFilePath(sceneSlug, fileName)
    const meta = await this.readJsonSafe(this.metaPath(sceneSlug))
    let elements = entry?.elements ?? 0
    let fingerprint
    try {
      const info = await stat(path)
      fingerprint = fingerprintOf(info)
      if (info.size <= this.maxSceneBytes) {
        const document = JSON.parse(await readFile(path, 'utf8'))
        if (Array.isArray(document?.elements)) elements = document.elements.length
      }
    } catch {
      // An unreadable/oversized file keeps the last known element count.
    }
    const described = {
      slug: sceneSlug,
      file: fileName,
      name: typeof meta?.name === 'string' && meta.name.trim() !== '' ? meta.name.trim() : (entry?.name ?? sceneSlug),
      sceneId: typeof meta?.sceneId === 'string' && meta.sceneId !== '' ? meta.sceneId : (entry?.sceneId ?? null),
      elements,
      updatedAt: entry?.updatedAt ?? (Number.isFinite(meta?.updatedAt) ? Math.trunc(meta.updatedAt) : this.now()),
    }
    if (fingerprint !== undefined) described.fingerprint = fingerprint
    return described
  }

  /** Validate and resolve a scene file path, fencing it inside the root. */
  fencedPath(slug, suffix = SCENE_SUFFIX) {
    return this.fencedName(`${slug}${suffix}`)
  }

  /** Resolve one file name inside the scene root, refusing any escape. */
  fencedName(name) {
    if (typeof name !== 'string' || name === '' || name.includes('/') || name.includes('\\')) {
      throw new StoreError('bad-request', 'invalid file name in the scene directory')
    }
    const file = resolve(this.root, name)
    const prefix = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`
    if (file !== this.root && !file.startsWith(prefix)) {
      throw new StoreError('bad-request', 'scene path escapes the scene directory')
    }
    return file
  }

  /** Enforce the slug grammar; a path-like value never reaches the filesystem. */
  requireSlug(rawSlug) {
    if (typeof rawSlug !== 'string' || !SLUG_PATTERN.test(rawSlug)) {
      throw new StoreError('bad-request', 'invalid scene slug')
    }
    return rawSlug
  }

  async readJsonSafe(file) {
    try {
      // A bounded read: an index this large is corruption, not a scene list.
      const info = await stat(file)
      if (!info.isFile() || info.size > MAX_INDEX_BYTES) return undefined
      return JSON.parse(await readFile(file, 'utf8'))
    } catch {
      return undefined
    }
  }

  /** Serialize every mutation, so index read-modify-write cycles never race. */
  mutate(work) {
    const result = this.queue.then(work)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /**
   * Read (and cache) `index.json`.
   * @param {boolean} [fresh] - bypass the cache; a lock holder must see what
   *   the other process wrote before it took the lock.
   */
  async loadIndex(fresh = false) {
    // An out-of-bounds index is corruption: rebuild from the files instead of
    // parsing it into memory (round 16 — the cap used to guard only meta.json).
    const size = await stat(join(this.root, INDEX_FILE)).then((info) => info.size).catch(() => 0)
    if (size > MAX_INDEX_BYTES) {
      this.logger?.warn?.(`dsh-excalidraw: index.json is ${size} bytes, rebuilding from the scene files`)
      const rebuilt = await this.scanIndexFromFiles()
      this.indexDirty = true
      this.indexCache = rebuilt
      // Inside a mutation the rebuilt index can replace the oversized file right
      // away; a plain read leaves the persistence to the next write.
      if (this.heldLock !== null && this.heldLock !== undefined) {
        await this.writeIndex(rebuilt)
      }
      return rebuilt
    }
    const file = join(this.root, INDEX_FILE)
    let info
    try {
      info = await stat(file)
    } catch {
      this.indexCache = emptyIndex()
      this.indexStamp = null
      return this.indexCache
    }
    const stamp = `${info.size}:${info.mtimeMs}`
    if (!fresh && this.indexCache !== null && this.indexStamp === stamp) return this.indexCache
    try {
      this.indexCache = normalizeIndex(JSON.parse(await readFile(file, 'utf8')))
      this.indexStamp = stamp
    } catch (error) {
      this.log('warn', `index.json is unreadable (${messageOf(error)}); rebuilding it from the directory`)
      this.indexCache = await this.scanIndexFromFiles()
      this.indexStamp = null
      this.indexDirty = true
    }
    return this.indexCache
  }

  async writeIndex(index) {
    // Fencing: never commit while our lock file says someone else owns it.
    if (this.heldLock !== null && this.heldLock !== undefined) await this.assertLockOwned()
    this.indexDirty = false
    const file = join(this.root, INDEX_FILE)
    await this.atomicWrite(file, `${JSON.stringify(index, null, 2)}\n`)
    this.indexCache = index
    try {
      const info = await stat(file)
      this.indexStamp = `${info.size}:${info.mtimeMs}`
    } catch {
      this.indexStamp = null
    }
  }

  async atomicWrite(file, data) {
    // A fixed `<file>.tmp` let two writers of one root rename each other's
    // temporary away (P1-2); the name is unique per process and call.
    const temporary = temporaryName(file)
    try {
      await writeFile(temporary, data)
      await rename(temporary, file)
    } catch (error) {
      try {
        await unlink(temporary)
      } catch {
        // The write itself failed: nothing to remove.
      }
      throw error
    }
  }

  /**
   * Serialize one `index.json` read-modify-write cycle across every process
   * that writes this root (P1-2). The lock is an exclusive-create file; a lock
   * older than {@link LOCK_STALE_MS} belongs to a writer that died and is taken
   * over, so a crash cannot wedge the store forever.
   *
   * @template T
   * @param {() => Promise<T>} work
   * @returns {Promise<T>}
   */
  /**
   * Take the index lock, run `work`, release. Every retry goes through `retry()`
   * so a lock path that cannot be cleared (a non-empty directory, an immutable
   * file) fails after LOCK_WAIT_MS instead of spinning the event loop forever.
   */
  async withIndexLock(work, signal) {
    const lockPath = join(this.root, LOCK_FILE)
    await this.ensureRoot()
    const token = `${process.pid}-${randomUUID()}`
    const deadline = Date.now() + this.lockWaitMs

    const retry = async () => {
      signal?.throwIfAborted?.()
      if (Date.now() > deadline) {
        throw new StoreError('internal', 'the scene index is locked by another writer', 500)
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, LOCK_RETRY_MS))
    }

    /** Best-effort removal of a pathological node at the lock path. */
    const clearOdd = async (path) => {
      const odd = await lstat(path).catch(() => null)
      if (odd === null) return false
      if (odd.isSymbolicLink()) {
        await unlink(path).catch(() => {})
        return true
      }
      if (odd.isDirectory()) {
        await rmdir(path).catch(() => {})
        return true
      }
      return false
    }

    this.heldLock = { path: lockPath, token }
    let handle = null
    while (handle === null) {
      signal?.throwIfAborted?.()
      try {
        handle = await open(lockPath, 'wx')
        await handle.writeFile(token)
        break
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          // A directory, a dangling symlink or an unreadable node at the lock
          // path: clear it and retry, bounded by the same deadline.
          if (await clearOdd(lockPath)) {
            await retry()
            continue
          }
        }
        if (await clearOdd(lockPath)) {
          await retry()
          continue
        }
        const info = await lstat(lockPath).catch(() => null)
        if (info !== null && info.isFile() && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          // Takeovers are serialized by a second lock file, and the path is
          // re-checked while it is held: no stealer can move a lock that a live
          // writer re-acquired between the stat and the removal.
          const stealPath = `${lockPath}.steal`
          let steal = null
          try {
            steal = await open(stealPath, 'wx')
          } catch (stealError) {
            if (stealError?.code !== 'EEXIST') {
              await clearOdd(stealPath)
            } else {
              // A stealer that died mid-takeover left `.steal` behind; without
              // this, a stale lock could never be taken over again (round 16).
              const stale = await lstat(stealPath).catch(() => null)
              if (stale !== null && Date.now() - stale.mtimeMs > LOCK_STALE_MS) {
                await unlink(stealPath).catch(() => {})
              }
            }
          }
          if (steal === null) {
            await retry()
            continue
          }
          try {
            const again = await lstat(lockPath).catch(() => null)
            if (again !== null && again.isFile() && Date.now() - again.mtimeMs > LOCK_STALE_MS) {
              await unlink(lockPath).catch(() => {})
            }
          } finally {
            try {
              await steal.close()
            } catch {
              // Already closed.
            }
            await unlink(stealPath).catch(() => {})
          }
          await retry()
          continue
        }
        await retry()
      }
    }
    // A writer that is slow rather than dead must not be mistaken for stale.
    const heartbeat = setInterval(() => {
      const now = new Date()
      utimes(lockPath, now, now).catch(() => {})
    }, LOCK_HEARTBEAT_MS)
    heartbeat.unref?.()
    try {
      signal?.throwIfAborted?.()
      return await work()
    } finally {
      this.heldLock = null
      clearInterval(heartbeat)
      try {
        await handle.close()
      } catch {
        // Already closed.
      }
      // Release only a lock this call still owns.
      const owner = await readFile(lockPath, 'utf8').catch(() => null)
      if (owner === token) await unlink(lockPath).catch(() => {})
    }
  }

  /**
   * The lock we believed we held may have been deleted or replaced: confirm the
   * token is still ours before committing an index write (round 16). Without
   * this a second writer could RMW concurrently and drop entries.
   */
  async assertLockOwned() {
    const held = this.heldLock
    if (held === undefined || held === null) {
      throw new StoreError('internal', 'the scene index lock is no longer held', 500)
    }
    const owner = await readFile(held.path, 'utf8').catch(() => null)
    if (owner !== held.token) {
      throw new StoreError('internal', 'the scene index lock was taken over by another writer', 500)
    }
  }

  scheduleRefresh(filename) {
    if (this.closed) return
    if (filename === INDEX_FILE) {
      // Someone else rewrote the index: drop the cache so the next read (and
      // the `/rev` hot path) picks it up.
      this.indexStamp = null
      return
    }
    if (
      typeof filename === 'string'
      && !filename.endsWith(SCENE_SUFFIX)
      && !filename.endsWith(LEGACY_SCENE_SUFFIX)
      && !filename.endsWith(META_SUFFIX)
    ) return
    if (this.watchTimer !== null) return
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null
      this.refreshFromDisk().catch((error) => {
        this.log('warn', `scene watch refresh failed: ${messageOf(error)}`)
      })
    }, this.debounceMs)
    this.watchTimer.unref?.()
  }

  log(level, message) {
    const write = this.logger?.[level]
    if (typeof write !== 'function') return
    try {
      write.call(this.logger, message)
    } catch {
      // A broken logger must never break the store.
    }
  }
}

/**
 * Create a scene store.
 * @param {ConstructorParameters<typeof SceneStore>[0]} options
 * @returns {SceneStore}
 */
export function createStore(options) {
  return new SceneStore(options)
}


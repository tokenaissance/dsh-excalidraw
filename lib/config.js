/**
 * dsh-excalidraw host configuration: the cordis-row schema factory plus the
 * pure default/clamp resolver.
 *
 * This module deliberately imports nothing from DSH. `index.js` hands it DSH's
 * own `z` (`@deepseek-ai/schemastery`) through {@link createConfigSchema}, so a
 * bad cordis row still fails loudly at activation, while plain Node (the test
 * suite, and any embedder that bypasses the Loader) can import this file with
 * no installed dependency at all.
 */

/** Every key's documented default (CONTRACT §1). */
export const CONFIG_DEFAULTS = Object.freeze({
  mcpUrl: 'https://api.excalidraw.com/api/v1/mcp',
  mcpToken: '',
  scenesDir: '.dsh/excalidraw',
  extraFontsDir: '',
  pollIntervalMs: 1500,
  autoOpen: true,
  maxSceneBytes: 4194304,
})

/** Inclusive clamp of `pollIntervalMs` (CONTRACT §1: 500–10000). */
export const POLL_INTERVAL_MIN = 500
export const POLL_INTERVAL_MAX = 10000

/** A scene smaller than this cannot even hold an empty Excalidraw document. */
export const MAX_SCENE_BYTES_MIN = 1024

/** Only HTTP(S) endpoints are allowed; the URL never comes from a request. */
const HTTP_URL = /^https?:\/\//i

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)

function clampInt(value, min, max, fallback) {
  if (!isFiniteNumber(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Apply the CONTRACT §1 defaults and bounds to a raw cordis row, for callers
 * that bypass the Loader (and for the tests). Never throws: an unusable value
 * falls back to its documented default, so a host running without a validated
 * schema still behaves.
 *
 * @param {unknown} raw - the row's `config` object.
 * @returns {{mcpUrl: string, mcpToken: string, scenesDir: string, pollIntervalMs: number, autoOpen: boolean, maxSceneBytes: number}}
 */
import { isAbsolute, resolve } from 'node:path'

/** One base for the directory: listing and reading must agree (round 14). */
function resolveExtraFontsDir(value) {
  const dir = text(value).trim()
  if (dir === '') return ''
  if (isAbsolute(dir)) return resolve(dir)
  const base = text(process.env.DSH_PROFILE_DIR).trim()
  return resolve(base !== '' ? base : process.cwd(), dir)
}

export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const mcpUrl = text(input.mcpUrl)
  const scenesDir = text(input.scenesDir).replace(/^\.\//, '').replace(/[\\/]+$/, '')
  return {
    mcpUrl: mcpUrl !== '' && HTTP_URL.test(mcpUrl) ? mcpUrl : CONFIG_DEFAULTS.mcpUrl,
    mcpToken: text(input.mcpToken),
    scenesDir: scenesDir !== '' ? scenesDir : CONFIG_DEFAULTS.scenesDir,
    extraFontsDir: resolveExtraFontsDir(text(input.extraFontsDir)),
    pollIntervalMs: clampInt(
      input.pollIntervalMs,
      POLL_INTERVAL_MIN,
      POLL_INTERVAL_MAX,
      CONFIG_DEFAULTS.pollIntervalMs,
    ),
    autoOpen: typeof input.autoOpen === 'boolean' ? input.autoOpen : CONFIG_DEFAULTS.autoOpen,
    maxSceneBytes: clampInt(
      input.maxSceneBytes,
      MAX_SCENE_BYTES_MIN,
      Number.MAX_SAFE_INTEGER,
      CONFIG_DEFAULTS.maxSceneBytes,
    ),
  }
}

/**
 * Build the plugin's exported `Config` schema with a schemastery-compatible
 * `z`. DSH's schemastery is the only accepted implementation (see
 * dsh-better-sidebar's config for why), but any object with the same fluent
 * shape is enough to exercise this factory in tests.
 *
 * @param {object} z - schemastery (`@deepseek-ai/schemastery`) default export.
 * @returns {object} the schemastery schema for the `dsh-excalidraw` row.
 */
export function createConfigSchema(z) {
  // DSH's schemastery default export IS the schema factory (a callable), not a
  // namespace object; a CJS interop wrapper arrives as `{ default: Schema }`.
  // Both shapes are accepted here so the host never dies on module plumbing.
  const factory = typeof z === 'function' ? z : (typeof z?.object === 'function' ? z : z?.default)
  if (factory === null || factory === undefined || typeof factory.object !== 'function') {
    throw new TypeError('createConfigSchema needs a schemastery-compatible z')
  }
  return factory.object({
    mcpUrl: factory.string().pattern(HTTP_URL).default(CONFIG_DEFAULTS.mcpUrl),
    mcpToken: factory.string().default(CONFIG_DEFAULTS.mcpToken),
    scenesDir: factory.string().default(CONFIG_DEFAULTS.scenesDir),
    extraFontsDir: factory.string().default(CONFIG_DEFAULTS.extraFontsDir),
    pollIntervalMs: factory.number().step(1).min(POLL_INTERVAL_MIN).max(POLL_INTERVAL_MAX).default(CONFIG_DEFAULTS.pollIntervalMs),
    autoOpen: factory.boolean().default(CONFIG_DEFAULTS.autoOpen),
    maxSceneBytes: factory.number().step(1).min(MAX_SCENE_BYTES_MIN).default(CONFIG_DEFAULTS.maxSceneBytes),
  })
}

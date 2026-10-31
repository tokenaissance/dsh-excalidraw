/**
 * CONTRACT §1: every config key's default, its bounds, and the schema the
 * cordis row is validated against. Plain Node: lib/config.js imports nothing
 * from DSH, and the schema factory is exercised with a recording `z`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONFIG_DEFAULTS,
  MAX_SCENE_BYTES_MIN,
  POLL_INTERVAL_MAX,
  POLL_INTERVAL_MIN,
  createConfigSchema,
  resolveConfig,
} from '../lib/config.js'

/** A schemastery-shaped recorder: every chain method returns itself. */
function recordingZ() {
  const calls = []
  const field = (kind) => {
    const meta = { kind, calls: [] }
    const api = {
      meta,
      pattern(regexp) {
        meta.pattern = regexp
        meta.calls.push('pattern')
        return api
      },
      default(value) {
        meta.default = value
        meta.calls.push('default')
        return api
      },
      min(value) {
        meta.min = value
        meta.calls.push('min')
        return api
      },
      max(value) {
        meta.max = value
        meta.calls.push('max')
        return api
      },
      step(value) {
        meta.step = value
        meta.calls.push('step')
        return api
      },
    }
    calls.push(api)
    return api
  }
  return {
    calls,
    string: () => field('string'),
    number: () => field('number'),
    boolean: () => field('boolean'),
    object: (shape) => ({ shape }),
  }
}

test('resolveConfig fills every documented default', () => {
  for (const raw of [undefined, null, {}, 'nonsense', 42, []]) {
    assert.deepEqual(resolveConfig(raw), { ...CONFIG_DEFAULTS })
  }
})

test('resolveConfig clamps pollIntervalMs to 500–10000 and truncates', () => {
  assert.equal(resolveConfig({ pollIntervalMs: 100 }).pollIntervalMs, POLL_INTERVAL_MIN)
  assert.equal(resolveConfig({ pollIntervalMs: 999999 }).pollIntervalMs, POLL_INTERVAL_MAX)
  assert.equal(resolveConfig({ pollIntervalMs: 1000.9 }).pollIntervalMs, 1000)
  assert.equal(resolveConfig({ pollIntervalMs: 2000 }).pollIntervalMs, 2000)
  // Non-numbers fall back rather than becoming NaN.
  for (const value of ['1500', null, {}, Number.NaN, Infinity]) {
    assert.equal(resolveConfig({ pollIntervalMs: value }).pollIntervalMs, CONFIG_DEFAULTS.pollIntervalMs)
  }
})

test('resolveConfig bounds maxSceneBytes from below and keeps a valid value', () => {
  assert.equal(resolveConfig({ maxSceneBytes: 0 }).maxSceneBytes, MAX_SCENE_BYTES_MIN)
  assert.equal(resolveConfig({ maxSceneBytes: -5 }).maxSceneBytes, MAX_SCENE_BYTES_MIN)
  assert.equal(resolveConfig({ maxSceneBytes: 1 }).maxSceneBytes, MAX_SCENE_BYTES_MIN)
  assert.equal(resolveConfig({ maxSceneBytes: 65536 }).maxSceneBytes, 65536)
  assert.equal(resolveConfig({ maxSceneBytes: 65536.7 }).maxSceneBytes, 65536)
  assert.equal(resolveConfig({ maxSceneBytes: '1' }).maxSceneBytes, CONFIG_DEFAULTS.maxSceneBytes)
})

test('resolveConfig only accepts an http(s) mcpUrl', () => {
  assert.equal(resolveConfig({ mcpUrl: 'ftp://example.com/mcp' }).mcpUrl, CONFIG_DEFAULTS.mcpUrl)
  assert.equal(resolveConfig({ mcpUrl: '' }).mcpUrl, CONFIG_DEFAULTS.mcpUrl)
  assert.equal(resolveConfig({ mcpUrl: 'not a url' }).mcpUrl, CONFIG_DEFAULTS.mcpUrl)
  assert.equal(resolveConfig({ mcpUrl: '  https://example.com/mcp  ' }).mcpUrl, 'https://example.com/mcp')
  assert.equal(resolveConfig({ mcpUrl: 'HTTP://example.com/mcp' }).mcpUrl, 'HTTP://example.com/mcp')
})

test('resolveConfig normalizes scenesDir and never leaves it empty', () => {
  assert.equal(resolveConfig({ scenesDir: '' }).scenesDir, CONFIG_DEFAULTS.scenesDir)
  assert.equal(resolveConfig({ scenesDir: '   ' }).scenesDir, CONFIG_DEFAULTS.scenesDir)
  assert.equal(resolveConfig({ scenesDir: './.dsh/excalidraw/' }).scenesDir, '.dsh/excalidraw')
  assert.equal(resolveConfig({ scenesDir: 'custom/scenes///' }).scenesDir, 'custom/scenes')
  assert.equal(resolveConfig({ scenesDir: 42 }).scenesDir, CONFIG_DEFAULTS.scenesDir)
})

test('resolveConfig trims the token and coerces only booleans', () => {
  assert.equal(resolveConfig({ mcpToken: '  sk-test  ' }).mcpToken, 'sk-test')
  assert.equal(resolveConfig({ mcpToken: 42 }).mcpToken, '')
  assert.equal(resolveConfig({ autoOpen: false }).autoOpen, false)
  assert.equal(resolveConfig({ autoOpen: true }).autoOpen, true)
  assert.equal(resolveConfig({ autoOpen: 'false' }).autoOpen, true)
})

test('createConfigSchema covers every key with the documented default', () => {
  const z = recordingZ()
  const schema = createConfigSchema(z)
  assert.equal(typeof schema, 'object')
  const shape = schema.shape
  assert.deepEqual(Object.keys(shape).sort(), Object.keys(CONFIG_DEFAULTS).sort())
  for (const [key, expected] of Object.entries(CONFIG_DEFAULTS)) {
    const field = shape[key].meta
    assert.equal(field.default, expected, `${key} default`)
    assert.equal(field.kind, typeof expected, `${key} kind`)
  }
  assert.equal(shape.pollIntervalMs.meta.min, POLL_INTERVAL_MIN)
  assert.equal(shape.pollIntervalMs.meta.max, POLL_INTERVAL_MAX)
  assert.equal(shape.pollIntervalMs.meta.step, 1)
  assert.equal(shape.maxSceneBytes.meta.min, MAX_SCENE_BYTES_MIN)
  assert.ok(shape.mcpUrl.meta.pattern instanceof RegExp)
})

test('createConfigSchema rejects a non-schemastery z', () => {
  for (const value of [undefined, null, {}, { object: 'no' }]) {
    assert.throws(() => createConfigSchema(value), TypeError)
  }
})

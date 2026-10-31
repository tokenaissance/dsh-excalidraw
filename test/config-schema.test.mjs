/**
 * The cordis row schema must build through BOTH schemastery shapes DSH can hand
 * the host: the callable default export (what the real loader provides, since
 * `@deepseek-ai/schemastery` ships `export { Schema as default }`) and a
 * `{ default }` interop wrapper. Regression: a guard that only accepted the
 * object form killed the plugin at activation with
 * "createConfigSchema needs a schemastery-compatible z".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfigSchema, CONFIG_DEFAULTS } from '../lib/config.js';

/** A chainable stand-in for one schemastery node. */
function node(kind) {
  const self = {
    kind,
    pattern: () => self,
    min: () => self,
    max: () => self,
    step: () => self,
    description: () => self,
    default: (value) => { self.value = value; return self; },
  };
  return self;
}

/** A schemastery-compatible factory: callable, and carrying the type builders. */
function makeZ() {
  const factory = (shape) => ({ kind: 'object', shape });
  factory.object = factory;
  factory.string = () => node('string');
  factory.number = () => node('number');
  factory.boolean = () => node('boolean');
  return factory;
}

test('the schema builds from the callable default export (real DSH shape)', () => {
  const schema = createConfigSchema(makeZ());
  assert.equal(schema.kind, 'object');
  assert.equal(schema.shape.mcpUrl.value, CONFIG_DEFAULTS.mcpUrl);
  assert.equal(schema.shape.scenesDir.value, CONFIG_DEFAULTS.scenesDir);
  assert.equal(schema.shape.pollIntervalMs.value, CONFIG_DEFAULTS.pollIntervalMs);
  assert.equal(schema.shape.autoOpen.value, CONFIG_DEFAULTS.autoOpen);
  assert.equal(schema.shape.maxSceneBytes.value, CONFIG_DEFAULTS.maxSceneBytes);
});

test('the schema builds from a { default } interop wrapper', () => {
  const schema = createConfigSchema({ default: makeZ() });
  assert.equal(schema.kind, 'object');
  assert.equal(schema.shape.mcpUrl.value, CONFIG_DEFAULTS.mcpUrl);
});

test('an unusable z still fails loudly instead of mounting blind', () => {
  assert.throws(() => createConfigSchema({}), /schemastery-compatible/);
  assert.throws(() => createConfigSchema(undefined), /schemastery-compatible/);
});

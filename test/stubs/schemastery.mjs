/**
 * Minimal `@deepseek-ai/schemastery` stand-in for the glue test: the fluent
 * builder shape `lib/config.js#createConfigSchema` uses, recording only the
 * metadata that factory sets. It does NOT validate — validation belongs to the
 * real DSH package at activation time.
 */
function field(kind) {
  const api = {
    kind,
    meta: { kind },
    pattern(regexp) {
      api.meta.pattern = regexp
      return api
    },
    default(value) {
      api.meta.default = value
      return api
    },
    min(value) {
      api.meta.min = value
      return api
    },
    max(value) {
      api.meta.max = value
      return api
    },
    step(value) {
      api.meta.step = value
      return api
    },
  }
  return api
}

const z = {
  string: () => field('string'),
  number: () => field('number'),
  boolean: () => field('boolean'),
  object: (shape) => ({ shape }),
}

export default z

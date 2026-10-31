/**
 * A `node:module` resolve hook that maps the two DSH-provided packages onto
 * local stubs, so `test/glue.test.mjs` can import the real `index.js` in plain
 * Node with no profile and no node_modules.
 *
 * Only these two specifiers are intercepted; everything else resolves
 * normally, so the plugin's own `./lib/*.js` imports are the real modules.
 */
const STUBS = new Map([
  ['@deepseek-ai/schemastery', new URL('./schemastery.mjs', import.meta.url).href],
  ['@deepseek-ai/dsh-tools', new URL('./dsh-tools.mjs', import.meta.url).href],
])

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS.get(specifier)
  if (stub !== undefined) return { url: stub, shortCircuit: true }
  return nextResolve(specifier, context)
}

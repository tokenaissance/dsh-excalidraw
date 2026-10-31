/**
 * `@deepseek-ai/dsh-tools` stand-in for the glue test: `defineTool` is a
 * pass-through, so the test registers the plugin's real tool definitions and
 * can inspect their sugar shape (name/description/parameters/output/execute).
 */
export function defineTool(definition) {
  return definition
}

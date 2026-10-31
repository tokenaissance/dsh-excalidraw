/**
 * Excalidraw+ MCP token resolution (CONTRACT §1).
 *
 * Order: the row's `mcpToken`, then `EXCALIDRAW_MCP_TOKEN`, then the
 * `Authorization: Bearer …` header of the profile's own `serverName:
 * excalidraw` insert row in `$DSH_PROFILE_DIR/cordis.patch.yml`.
 *
 * The profile file is read-only here: this module never writes a token, never
 * logs one, and never puts one in an error. Parsing is a small, line-oriented
 * YAML reader for exactly the shape the profile uses (a top-level list entry
 * `- insert:` holding a `serverName` and a `headers:` map); no YAML dependency
 * is involved, and anything it does not recognise resolves to "no token".
 */

import { readFile as readFileFromDisk } from 'node:fs/promises'
import { join } from 'node:path'

/** Environment variable override for the token. */
export const TOKEN_ENV = 'EXCALIDRAW_MCP_TOKEN'
/** The DSH profile directory whose patch layer carries the MCP row. */
export const PROFILE_DIR_ENV = 'DSH_PROFILE_DIR'
/** The profile patch file holding the `mcp-excalidraw` insert row. */
export const PROFILE_PATCH_FILE = 'cordis.patch.yml'

/** A `- key:` list item at any indentation (a row inside a top-level item). */
const ROW_ITEM = /^\s*-\s+[A-Za-z_][A-Za-z0-9_-]*:/

const TOP_LEVEL_ITEM = /^-(?:\s|$)/
const SERVER_NAME = /^\s*serverName\s*:\s*(.*)$/
const AUTHORIZATION = /^\s*authorization\s*:\s*(.*)$/i
const BEARER = /^bearer\s+(.+)$/i

/** Drop a trailing YAML ` #comment`, ignoring `#` inside a quoted scalar. */
function stripComment(line) {
  let quote = null
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (quote !== null) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index)
    }
  }
  return line
}

/** Strip the surrounding quotes of a single-line YAML scalar. */
function unquoteScalar(value) {
  const trimmed = stripComment(value).trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim()
    }
  }
  return trimmed
}

/**
 * Read a YAML scalar that starts on line `index` (the text after the `:`),
 * following a quoted value across line breaks. YAML folds the break of a
 * multi-line quoted scalar into one space, which is exactly how the profile
 * writes `Authorization: "Bearer\n  sk-…"`.
 */
function readScalar(lines, index, rest, end) {
  const value = rest.trim()
  if (value === '') return ''
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : null
  if (quote === null) return stripComment(value).trim()

  let accumulated = value.slice(1)
  let cursor = index
  const closed = () => accumulated.endsWith(quote) && accumulated[accumulated.length - 2] !== '\\'
  while (!closed() && cursor + 1 < end) {
    cursor += 1
    accumulated += `\n${lines[cursor]}`
  }
  if (closed()) accumulated = accumulated.slice(0, -1)
  return accumulated
    .replace(/[ \t]*\r?\n[ \t]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extract the token from an `Authorization` value. Only the `Bearer` scheme is
 * accepted (CONTRACT §2), and the token never appears in a return value or a
 * thrown error beyond this function's result.
 *
 * @param {unknown} value - the raw header value.
 * @returns {string} the token, or `''`.
 */
export function extractBearer(value) {
  let text = String(value ?? '').trim()
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) text = text.slice(1, -1).trim()
  }
  const match = BEARER.exec(text)
  if (match === null) return ''
  let token = match[1].trim()
  if (token.length >= 2) {
    const first = token[0]
    const last = token[token.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      token = token.slice(1, -1).trim()
    }
  }
  // A trailing YAML comment is not part of the credential: drop it. What is left
  // must be a single opaque word — a surviving quote, whitespace or `#` means an
  // unclosed scalar or a multi-field line, and must never be sent upstream.
  token = token.replace(/\s+#.*$/, '').trim()
  if (token === '' || /[\s"'#\\]/.test(token)) return ''
  return token
}

/**
 * Find the bearer token of the `serverName: excalidraw` insert row.
 *
 * The scan is confined to the enclosing top-level list entry, so another MCP
 * server's header can never be picked up by accident.
 *
 * @param {unknown} text - the profile patch file's contents.
 * @returns {string} the token, or `''` when the file has no such row.
 */
export function parseProfileToken(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const server = SERVER_NAME.exec(stripComment(lines[index]))
    if (server === null) continue
    if (unquoteScalar(server[1]) !== 'excalidraw') continue

    // The Authorization must belong to THIS row: a single `- insert:` can carry
    // several server rows (`- id: …`), and taking the first Authorization in the
    // whole block would leak the neighbour's bearer to Excalidraw (round 11).
    const indentOf = (line) => line.length - line.trimStart().length
    const indent = indentOf(lines[index])
    let start = 0
    let rowIndent = -1
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const match = ROW_ITEM.exec(lines[cursor])
      if (match === null) continue
      if (indentOf(lines[cursor]) < indent) {
        start = cursor
        rowIndent = indentOf(lines[cursor])
        break
      }
    }
    if (rowIndent < 0) {
      for (let cursor = index; cursor >= 0; cursor -= 1) {
        if (TOP_LEVEL_ITEM.test(lines[cursor])) {
          start = cursor
          break
        }
      }
    }
    let end = lines.length
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (rowIndent >= 0) {
        if (ROW_ITEM.test(lines[cursor]) && indentOf(lines[cursor]) === rowIndent) {
          end = cursor
          break
        }
        continue
      }
      if (TOP_LEVEL_ITEM.test(lines[cursor])) {
        end = cursor
        break
      }
    }
    for (let cursor = start; cursor < end; cursor += 1) {
      const authorization = AUTHORIZATION.exec(lines[cursor])
      if (authorization === null) continue
      const token = extractBearer(readScalar(lines, cursor, authorization[1], end))
      if (token !== '') return token
    }
  }
  return ''
}

/**
 * Resolve the effective MCP token.
 *
 * @param {object} [options]
 * @param {string} [options.configToken] - the row's `mcpToken`.
 * @param {Record<string, string | undefined>} [options.env] - environment (defaults to `process.env`).
 * @param {(path: string, encoding: string) => Promise<string>} [options.readFile] - injectable reader.
 * @returns {Promise<{ token: string, source: 'config' | 'env' | 'profile' | 'none' }>}
 *   `source` names where the token came from; the object never carries the
 *   token anywhere except `token`, and `source: 'none'` always means an empty
 *   token.
 */
export async function resolveToken(options = {}) {
  const env = options.env ?? process.env
  const readFile = options.readFile ?? readFileFromDisk

  const fromConfig = typeof options.configToken === 'string' ? options.configToken.trim() : ''
  if (fromConfig !== '') return { token: fromConfig, source: 'config' }

  const fromEnv = typeof env?.[TOKEN_ENV] === 'string' ? env[TOKEN_ENV].trim() : ''
  if (fromEnv !== '') return { token: fromEnv, source: 'env' }

  const profileDir = typeof env?.[PROFILE_DIR_ENV] === 'string' ? env[PROFILE_DIR_ENV].trim() : ''
  if (profileDir === '') return { token: '', source: 'none' }

  try {
    const text = await readFile(join(profileDir, PROFILE_PATCH_FILE), 'utf8')
    const token = parseProfileToken(text)
    return token === '' ? { token: '', source: 'none' } : { token, source: 'profile' }
  } catch {
    // A missing or unreadable profile is "no token", never a failure: the
    // plugin is usable (health, routes) without a configured MCP server.
    return { token: '', source: 'none' }
  }
}

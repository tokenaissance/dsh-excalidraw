/**
 * The Excalidraw web fonts this plugin ships (CONTRACT §6).
 *
 * The font binaries are stored as base64 text so they travel through the same
 * text-only storage as the rest of the plugin; this module decodes and caches
 * them, and is the only place that knows the file layout:
 *
 *   fonts/MANIFEST.json          families, unicode ranges, byte sizes, sha256
 *   fonts/<file>.<n>.b64         base64 chunks, concatenated in order
 *
 * Licenses are per font and live next to them (`fonts/LICENSE-*.txt`).
 */

import { createHash } from 'node:crypto'
import { fontStackOf } from '../src/renderer.mjs'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'

const FONTS_DIR = new URL('../fonts/', import.meta.url)
const cache = new Map()
// One in-flight decode per font: two concurrent first reads share the work.
const pending = new Map()

/** Parsed `fonts/MANIFEST.json`, read once. */
let manifestPromise = null

function loadManifest() {
  if (manifestPromise === null) {
    manifestPromise = readFile(new URL('MANIFEST.json', FONTS_DIR), 'utf8')
      .then((text) => JSON.parse(text))
      .then((parsed) => (Array.isArray(parsed?.fonts) ? parsed.fonts : []))
      // A malformed entry (`null`, a string, a missing file) must not poison the
      // whole list: drop it instead of throwing on every request.
      .then((fonts) => fonts.filter((font) => font !== null && typeof font === 'object'
        && typeof font.file === 'string' && typeof font.family === 'string'))
      .catch(() => {
        // Do not cache a failure for the life of the process: a transient read
        // error would otherwise make every font 404 until a restart.
        manifestPromise = null
        return []
      })
  }
  return manifestPromise
}

/** Every shipped font descriptor, in manifest order. */
export async function listFonts() {
  return loadManifest()
}

/** The descriptor for one file name, or `undefined`. */
export async function findFont(name) {
  if (typeof name !== 'string' || name === '' || name.includes('/') || name.includes('\\')) return undefined
  return (await loadManifest()).find((font) => font.file === name)
}

/**
 * Decode one shipped font. The sha256 from the manifest is verified, so a
 * corrupted chunk fails loudly instead of serving half a font.
 *
 * @param {string} name
 * @returns {Promise<Buffer>} the woff2 bytes
 */
export async function readFont(name, dirOverride) {
  if (dirOverride !== undefined && dirOverride !== null) {
    // Test seam: decode from another directory (and skip the shared cache).
    return decodeFontFrom(name, dirOverride)
  }
  const cached = cache.get(name)
  if (cached !== undefined) return cached
  const inFlight = pending.get(name)
  if (inFlight !== undefined) return inFlight
  const work = decodeFont(name).finally(() => { pending.delete(name) })
  pending.set(name, work)
  return work
}

/** Decode + verify one font from a directory (used by the test seam). */
async function decodeFontFrom(name, dir) {
  const dirURL = dir instanceof URL ? dir : new URL(`file://${resolve(String(dir))}/`)
  const manifest = JSON.parse(await readFile(new URL('MANIFEST.json', dirURL), 'utf8'))
  const font = (Array.isArray(manifest?.fonts) ? manifest.fonts : []).find((entry) => entry?.file === name)
  if (font === undefined) throw Object.assign(new Error(`unknown font "${name}"`), { code: 'no-font' })
  const chunks = []
  for (let index = 0; index < font.parts; index += 1) {
    chunks.push(await readFile(new URL(`${font.file}.${index}.b64`, dirURL), 'utf8'))
  }
  const bytes = Buffer.from(chunks.join('').replace(/\s+/g, ''), 'base64')
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== font.sha256) {
    throw Object.assign(new Error(`font "${name}" is corrupt (sha256 mismatch)`), { code: 'bad-font' })
  }
  if (bytes.length !== font.bytes) {
    throw Object.assign(new Error(`font "${name}" is truncated`), { code: 'bad-font' })
  }
  return bytes
}

/** Decode + verify one font (the body of `readFont`). */
async function decodeFont(name) {
  const font = await findFont(name)
  if (font === undefined) {
    throw Object.assign(new Error(`unknown font "${name}"`), { code: 'no-font' })
  }
  const chunks = []
  for (let index = 0; index < font.parts; index += 1) {
    chunks.push(await readFile(new URL(`${font.file}.${index}.b64`, FONTS_DIR), 'utf8'))
  }
  const bytes = Buffer.from(chunks.join('').replace(/\s+/g, ''), 'base64')
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== font.sha256) {
    throw Object.assign(new Error(`font "${name}" is corrupt (sha256 mismatch)`), { code: 'bad-font' })
  }
  if (bytes.length !== font.bytes) {
    throw Object.assign(new Error(`font "${name}" is truncated`), { code: 'bad-font' })
  }
  cache.set(name, bytes)
  return bytes
}

/** The renderer's fallback family key when an element's fontFamily is unusable. */
export const DEFAULT_FAMILY_KEY = 5

/** Which shipped family an Excalidraw `fontFamily` key maps to (0 = none). */
const SHIPPED_BY_KEY = Object.freeze({
  // Family 5 is Excalifont (not redistributable); the renderer's stack falls
  // through to Virgil, so an export must carry Virgil for it as well.
  1: 'Virgil',
  5: 'Virgil',
  7: 'Lilita One',
  8: 'Comic Shanns',
})

/**
 * Families whose renderer stack is a *system* font (Helvetica, Cascadia Code,
 * Liberation Sans, Nunito): no shipped face is involved, so an export must not
 * add Virgil for them (review round 14).
 */
const SYSTEM_FAMILY_KEYS = new Set([2, 3, 4, 6])

/**
 * `@font-face` rules with the font bytes inlined, for the families a scene
 * actually draws text with. An exported SVG (and the `<img>` a PNG rasteriser
 * draws) is a separate document: the page's rules do not apply inside it, so the
 * bytes have to travel with the file.
 *
 * @param {Array<object>} elements
 * @returns {Promise<string>} the rules, or '' when no shipped family is used
 */
/** Every shipped family and character a scene actually draws text with. */
export function fontCharacters(elements) {
  const families = new Set()
  let characters = ''
  const add = (rawKey, text) => {
    // The renderer maps a missing/null/unknown key to its family-5 stack, so the
    // embedder must do the same or an export loses that text's font.
    const key = Number(rawKey ?? DEFAULT_FAMILY_KEY)
    if (SYSTEM_FAMILY_KEYS.has(key)) return
    const family = SHIPPED_BY_KEY[key] ?? SHIPPED_BY_KEY[DEFAULT_FAMILY_KEY]
    if (family === undefined) return
    families.add(family)
    characters += String(text ?? '')
  }
  for (const element of Array.isArray(elements) ? elements : []) {
    if (element === null || typeof element !== 'object' || element.isDeleted === true) continue
    if (element.type === 'text') add(element.fontFamily, element.text)
    // The renderer draws a frame's name as text in the family-5 stack.
    else if (element.type === 'frame' && typeof element.name === 'string' && element.name !== '') {
      add(DEFAULT_FAMILY_KEY, element.name)
    }
  }
  return { families, characters }
}

/** The `@font-face` rules for the families a scene draws, plus those families. */
export async function exportFonts(elements, options = {}) {
  const extraRules = []
  const { families: used, characters } = fontCharacters(elements)
  if (used.size === 0) return { css: '', families: [] }
  // A user-supplied face (Excalifont and friends) is part of the renderer's
  // stack: an export that names it must carry its bytes too.
  const stackNames = new Set()
  for (const element of Array.isArray(elements) ? elements : []) {
    if (element === null || typeof element !== 'object' || element.isDeleted === true) continue
    if (element.type === 'text' || (element.type === 'frame' && typeof element.name === 'string' && element.name !== '')) {
      for (const name of fontStackOf(element.fontFamily ?? DEFAULT_FAMILY_KEY).split(',')) {
        const clean = name.trim().replace(/^['"]|['"]$/g, '')
        if (clean !== '') stackNames.add(clean)
      }
    }
  }
  const embedded = new Set()
  for (const extra of Array.isArray(options.extraFonts) ? options.extraFonts : []) {
    if (!stackNames.has(extra.family) || extra.bytes === undefined) continue
    const range = extra.unicodeRange ? `;unicode-range:${extra.unicodeRange}` : ''
    extraRules.push(`@font-face{font-family:'${extra.family}';src:url(data:font/woff2;base64,${extra.bytes.toString('base64')}) format("woff2");`
      + `font-weight:400;font-style:normal${range}}`)
    embedded.add(extra.family)
  }
  const rules = []
  for (const font of await listFonts()) {
    if (!used.has(font.family)) continue
    // A subset whose range shares no character with the scene is dead weight:
    // a Latin-only diagram needs one Comic Shanns file, not four.
    if (font.unicodeRange && !matchesUnicodeRange(font.unicodeRange, characters)) continue
    try {
      const bytes = await readFont(font.file)
      const range = font.unicodeRange ? `;unicode-range:${font.unicodeRange}` : ''
      rules.push(`@font-face{font-family:'${font.family}';src:url(data:font/woff2;base64,${bytes.toString('base64')}) format("woff2");`
        + `font-weight:400;font-style:normal${range}}`)
      embedded.add(font.family)
    } catch {
      // One unreadable font must not block the export.
    }
  }
  return { css: [...extraRules, ...rules].join('\n'), families: [...embedded] }
}

/** Backwards-compatible convenience: just the CSS for a scene's fonts. */
export async function embeddedFontCss(elements) {
  return (await exportFonts(elements)).css
}

/** Human-readable provenance/licence notice for a set of embedded families. */
export function fontNotice(families) {
  const names = Array.isArray(families) ? families : []
  if (names.length === 0) return ''
  const licences = names.map((family) => {
    if (family === 'Comic Shanns') return 'Comic Shanns (MIT, Copyright (c) 2018 Shannon Miwa and contributors)'
    if (family === 'Virgil') return 'Virgil (SIL OFL 1.1)'
    if (family === 'Lilita One') return 'Lilita One (SIL OFL 1.1, Copyright (c) 2011 Juan Montoreano)'
    return family
  })
  return `Rendered by dsh-excalidraw. Embedded fonts: ${licences.join('; ')}. `
    + 'Licence texts: https://github.com/excalidraw fonts directory (shipped with the plugin).'
}

/** Parse a CSS `unicode-range` list into `[lo, hi]` code point pairs. */
export function parseUnicodeRange(value) {
  if (typeof value !== 'string' || value === '') return null
  const ranges = []
  for (const part of value.split(',')) {
    const match = /^\s*U\+([0-9a-f]+)(?:-([0-9a-f]+))?\s*$/i.exec(part)
    if (match === null) continue
    const lo = Number.parseInt(match[1], 16)
    const hi = match[2] === undefined ? lo : Number.parseInt(match[2], 16)
    if (Number.isFinite(lo) && Number.isFinite(hi)) ranges.push([lo, hi])
  }
  return ranges.length === 0 ? null : ranges
}

/** Whether any character of `text` falls inside the given range list. */
export function matchesUnicodeRange(range, text) {
  const ranges = parseUnicodeRange(range)
  if (ranges === null) return true
  for (const character of text) {
    const code = character.codePointAt(0)
    if (ranges.some(([lo, hi]) => code >= lo && code <= hi)) return true
  }
  return false
}

/** The index of the `>` that closes the root `<svg …>` tag, or -1. */
export function rootTagEnd(svg) {
  if (typeof svg !== 'string') return -1
  const start = svg.indexOf('<svg')
  if (start < 0) return -1
  let quote = null
  for (let index = start + 4; index < svg.length; index += 1) {
    const character = svg[index]
    if (quote !== null) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '>') return index
  }
  return -1
}

/**
 * Insert markup right inside the root `<svg>` element. Skips an XML prolog or a
 * leading comment, and refuses a self-closing root (nothing can be inserted
 * there) instead of producing malformed XML.
 */
export function injectIntoRoot(svg, inner) {
  const end = rootTagEnd(svg)
  if (end < 0 || svg[end - 1] === '/') return svg
  return svg.slice(0, end + 1) + inner + svg.slice(end + 1)
}

/**
 * Insert a `<style>` with the given rules right inside the `<svg>` element.
 * The CSS travels in a CDATA section: a raw `<` (for example a `</style>`
 * sequence inside a font-family name) would make the SVG invalid XML.
 */
export function withStyle(svg, css) {
  if (typeof css !== 'string' || css === '') return svg
  const safe = css.replace(/\]\]>/g, ']]]]><![CDATA[>')
  return injectIntoRoot(svg, `<style type="text/css"><![CDATA[${safe}]]></style>`)
}

/* ------------------------------------------------------------------------ */
/* user-supplied fonts (extraFontsDir)                                      */
/* ------------------------------------------------------------------------ */

/** Font file extensions the extra-fonts directory may serve. */
const EXTRA_FONT_FILE = /\.(woff2|woff|ttf|otf)$/i

/** A family name that is safe inside a CSS `font-family` string. */
const SAFE_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/
/** A `unicode-range` list we are willing to copy into CSS. */
const SAFE_UNICODE_RANGE = /^[Uu]\+[0-9A-Fa-f?]+(-[0-9A-Fa-f]+)?(\s*,\s*[Uu]\+[0-9A-Fa-f?]+(-[0-9A-Fa-f]+)?)*$/

/** A manifest entry is usable only if it names a family and a safe file. */
function usableExtra(entry) {
  if (entry === null || typeof entry !== 'object') return null
  if (typeof entry.family !== 'string' || entry.family.trim() === '') return null
  if (!SAFE_FAMILY.test(entry.family.trim())) return null
  if (typeof entry.file !== 'string' || entry.file === '' || entry.file.includes('/') || entry.file.includes('\\')) return null
  if (!EXTRA_FONT_FILE.test(entry.file)) return null
  const font = {
    family: entry.family.trim(),
    file: entry.file,
    weight: Number.isFinite(entry.weight) ? Math.trunc(entry.weight) : 400,
    style: entry.style === 'italic' ? 'italic' : 'normal',
  }
  if (typeof entry.unicodeRange === 'string' && entry.unicodeRange !== '') {
    if (!SAFE_UNICODE_RANGE.test(entry.unicodeRange)) return null
    font.unicodeRange = entry.unicodeRange
  }
  return font
}

/**
 * Fonts the user dropped into `config.extraFontsDir` — the legal way to bring
 * Excalifont (or any other face) without the plugin redistributing it.
 *
 * The directory holds the font files plus a `fonts.json` manifest:
 * `{ "fonts": [{ "family": "Excalifont", "file": "Excalifont-Regular.woff2" }] }`
 *
 * @param {string|null|undefined} dir absolute or relative directory, or empty
 * @returns {Promise<{ dir: string, fonts: object[], error: string|null }>}
 */
export async function listExtraFonts(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') return { dir: '', fonts: [], error: null }
  const resolved = isAbsolute(dir) ? dir : resolve(process.env.DSH_PROFILE_DIR ?? process.cwd(), dir)
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(resolved, 'fonts.json'), 'utf8'))
  } catch (error) {
    return {
      dir: resolved,
      fonts: [],
      error: error?.code === 'ENOENT' ? null : `cannot read ${join(resolved, 'fonts.json')}`,
    }
  }
  const list = Array.isArray(manifest?.fonts) ? manifest.fonts : []
  const fonts = []
  // Compare real paths on both sides (macOS /var → /private/var symlink).
  const realDir = await realpath(resolved).catch(() => null)
  if (realDir === null) return { dir: resolved, fonts: [], error: null }
  for (const entry of list) {
    const font = usableExtra(entry)
    if (font === null) continue
    try {
      const path = join(resolved, font.file)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) continue
      // A hard link to an outside file has the same inode: refuse any link count
      // above one (round 18), then require the real path to stay inside.
      const real = await realpath(path)
      if (info.nlink > 1) continue
      if (!real.startsWith(`${realDir}${sep}`) && real !== realDir) continue
    } catch {
      continue
    }
    fonts.push(font)
  }
  return { dir: resolved, fonts, error: null }
}

/** Read one user-supplied font, refusing names that escape the directory. */
export async function readExtraFont(dir, name) {
  const { dir: resolved, fonts } = await listExtraFonts(dir)
  const font = fonts.find((candidate) => candidate.file === name)
  if (font === undefined) {
    throw Object.assign(new Error(`unknown extra font "${name}"`), { code: 'no-font' })
  }
  return readFile(join(resolved, font.file))
}

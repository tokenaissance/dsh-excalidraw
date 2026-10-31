#!/usr/bin/env node
/**
 * Bundle the client half: inline `src/renderer.mjs` + `src/client.mjs` into the
 * `window.__ModuleLoader__.load({ id, factory })` wrapper DSH's browser module
 * table expects, and write `client.js` at the package root.
 *
 * Deliberately not a general bundler: these two files are our own, they import
 * nothing, and the wrapper has to be exactly the host's format. The build fails
 * loudly if any module syntax survives, instead of emitting a broken bundle.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Drop ESM syntax so the body can live inside the loader factory closure. */
function stripModuleSyntax(source, rel) {
  const out = source
    .replace(/^[ \t]*import\s+[^;\n]*;?[ \t]*$/gm, '')
    .replace(/\bexport\s+default\s+(function|class)\b/g, '$1')
    .replace(/\bexport\s+(function|class|const|let|var)\b/g, '$1')
    .replace(/^[ \t]*export\s*\{[^}]*\};?[ \t]*$/gm, '');
  const leftover = out.split('\n').find((line) => /^\s*(import|export)\s/.test(line));
  if (leftover !== undefined) {
    throw new Error(`${rel}: module syntax survived the strip: ${leftover.trim()}`);
  }
  return out.trimEnd();
}

// The signature covers every input the bundle depends on — the three sources and
// this build script — with length prefixes so bytes cannot slide across a part
// boundary (round 16).
function signatureOf(parts) {
  const hash = createHash('sha256')
  for (const [name, text] of parts) {
    const bytes = Buffer.from(text, 'utf8')
    hash.update(`${name}:${bytes.length}\n`)
    hash.update(bytes)
  }
  return hash.digest('hex').slice(0, 16)
}
const sourceSignature = signatureOf([
  ['src/renderer.mjs', read('src/renderer.mjs')],
  ['src/fonts-data.mjs', read('src/fonts-data.mjs')],
  ['src/client.mjs', read('src/client.mjs')],
  ['scripts/build-client.mjs', read('scripts/build-client.mjs')],
])

const banner = [
  '/**',
  ' * GENERATED FILE — edit src/renderer.mjs and src/client.mjs, then `npm run build`.',
  ` * sources-signature: ${sourceSignature}`,
  ' * Registers the dsh-excalidraw client half into DSH\'s browser module table.',
  ' */',
].join('\n');

const body = [
  banner,
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(manifest.name)},`,
  '  factory(require) {',
  "    const React = require('react');",
  '',
  '    // ── inlined src/renderer.mjs ───────────────────────────────────────',
  stripModuleSyntax(read('src/renderer.mjs'), 'src/renderer.mjs'),
  '',
  '    // ── inlined src/fonts-data.mjs ─────────────────────────────────────',
  stripModuleSyntax(read('src/fonts-data.mjs'), 'src/fonts-data.mjs'),
  '',
  '    // ── inlined src/client.mjs ─────────────────────────────────────────',
  stripModuleSyntax(read('src/client.mjs'), 'src/client.mjs'),
  '',
  '    return createPlugin(React);',
  '  },',
  '});',
  '',
].join('\n');

const target = path.join(ROOT, 'client.js');
fs.writeFileSync(target, body);
const size = fs.statSync(target).size;
console.log(`client.js: ${size} bytes (id=${manifest.name})`);
if (size > 1024 * 1024) throw new Error(`client.js is ${size} bytes; the client bundle must stay small`);

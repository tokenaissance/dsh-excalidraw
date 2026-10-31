#!/usr/bin/env node
/**
 * Render one Excalidraw scene file to SVG.
 *
 *   node scripts/render-scene.mjs <scene.json> <out.svg> [--background] [--padding N]
 *
 * Reads either a full scene document (`{ elements: [...] }`) or a bare elements
 * array. Writes the SVG to <out.svg> and prints one summary line:
 *
 *   elements=47 rendered=47 skipped=[] bounds=68,-1,3678,698 bytes=12345
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { renderScene } from '../src/renderer.mjs';

const DEFAULT_PADDING = 24;

function usage() {
  const text = [
    'usage: node scripts/render-scene.mjs <scene.json|-> <out.svg> [--background] [--padding N]',
    '',
    '  <scene.json>  an Excalidraw scene document or a bare elements array',
    '  -             read the scene JSON from stdin',
    '  --background  paint a white background rectangle behind the scene',
    '  --padding N   viewBox padding in scene units (default 24)',
  ].join('\n');
  console.error(text);
  process.exit(2);
}

function fail(message) {
  console.error(`render-scene: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
let input = null;
let output = null;
let background = false;
let padding = DEFAULT_PADDING;

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--help' || arg === '-h') usage();
  else if (arg === '--background') background = true;
  else if (arg === '--padding') {
    const value = Number(argv[i + 1]);
    if (!Number.isFinite(value) || value < 0) fail('--padding expects a non-negative number');
    padding = value;
    i += 1;
  } else if (arg.startsWith('--')) fail(`unknown option: ${arg}`);
  else if (input === null) input = arg;
  else if (output === null) output = arg;
  else fail(`unexpected extra argument: ${arg}`);
}

if (input === null || output === null) usage();

let raw;
try {
  raw = input === '-' ? readFileSync(0, 'utf8') : readFileSync(input, 'utf8');
} catch (error) {
  fail(`cannot read ${input}: ${error.message}`);
}

let document;
try {
  document = JSON.parse(raw);
} catch (error) {
  fail(`invalid JSON in ${input}: ${error.message}`);
}

const elements = Array.isArray(document) ? document : document?.elements;
if (!Array.isArray(elements)) {
  fail(`no elements array in ${input} (expected an array or { "elements": [...] })`);
}

let result;
try {
  result = renderScene(elements, { padding, background, files: document?.files });
} catch (error) {
  fail(`renderer failed: ${error.message}`);
}

try {
  writeFileSync(output, result.svg);
} catch (error) {
  fail(`cannot write ${output}: ${error.message}`);
}

const counts = new Map();
for (const skip of result.skipped) {
  counts.set(skip.reason, (counts.get(skip.reason) ?? 0) + 1);
}
const skippedSummary = `[${[...counts.entries()]
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([reason, count]) => `${reason}:${count}`)
  .join(',')}]`;

const round = (value) => String(Number(value.toFixed(3)));
const boundsSummary = result.bounds
  ? `${round(result.bounds.minX)},${round(result.bounds.minY)},` +
    `${round(result.bounds.maxX)},${round(result.bounds.maxY)}`
  : 'none';

for (const skip of result.skipped.slice(0, 20)) {
  console.error(
    `render-scene: skipped ${skip.id ?? '?'} (${skip.type ?? '?'}): ${skip.reason}`,
  );
}
if (result.skipped.length > 20) {
  console.error(`render-scene: ... and ${result.skipped.length - 20} more skipped`);
}

console.log(
  `elements=${elements.length} rendered=${result.rendered} ` +
    `skipped=${skippedSummary} bounds=${boundsSummary} ` +
    `bytes=${Buffer.byteLength(result.svg, 'utf8')}`,
);

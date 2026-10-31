import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  arrowHeadPath,
  escapeXml,
  renderScene,
  sceneBounds,
  SUPPORTED_TYPES,
} from '../src/renderer.mjs';

const fixtureUrl = new URL('./fixtures/design-scene.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
const elements = fixture.elements;

let elementCounter = 0;

/** A valid element of any supported type, with overridable defaults. */
function el(type, overrides = {}) {
  elementCounter += 1;
  return {
    id: `${type}-${elementCounter}`,
    type,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    roundness: null,
    ...overrides,
  };
}

/** Cheap XML sanity: root, balanced groups, quoted attributes, escaped text. */
function assertWellFormed(svg) {
  assert.match(svg, /^<svg\s[^>]*>\n/);
  assert.ok(svg.trimEnd().endsWith('</svg>'));
  const tags = svg.match(/<[^>]*>/g) ?? [];
  for (const tag of tags) {
    const quotes = (tag.match(/"/g) ?? []).length;
    assert.equal(quotes % 2, 0, `unbalanced quotes in tag: ${tag.slice(0, 80)}`);
  }
  assert.equal((svg.match(/<g\b/g) ?? []).length, (svg.match(/<\/g>/g) ?? []).length);
  assert.equal((svg.match(/<text\b/g) ?? []).length, (svg.match(/<\/text>/g) ?? []).length);
  // No bare ampersand: everything must be an entity.
  const withoutEntities = svg.replace(
    /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g,
    '',
  );
  assert.ok(!withoutEntities.includes('&'), 'unescaped & in SVG');
}

function viewBoxOf(svg) {
  const match = svg.match(/viewBox="([^"]+)"/);
  assert.ok(match, 'missing viewBox');
  return match[1].split(/\s+/).map(Number);
}

test('escapeXml escapes the four XML metacharacters', () => {
  assert.equal(escapeXml('a & b < c > d "e"'), 'a &amp; b &lt; c &gt; d &quot;e&quot;');
  assert.equal(escapeXml(''), '');
});

test('fixture: every element is rendered exactly once', () => {
  assert.equal(elements.length, 47);
  const result = renderScene(elements);
  assert.equal(result.rendered, 47);
  assert.deepEqual(result.skipped, []);
  assert.equal((result.svg.match(/<g data-el=/g) ?? []).length, 47);
  for (const element of elements) {
    assert.ok(
      result.svg.includes(`data-id="${element.id}"`),
      `element ${element.id} missing from SVG`,
    );
  }
  assertWellFormed(result.svg);
  assert.doesNotMatch(result.svg, /\b(?:NaN|undefined|Infinity)\b/);
  assert.ok(!result.svg.includes('>null<'));
});

test('fixture: title text is present and escaped text survives', () => {
  const result = renderScene(elements);
  assert.ok(result.svg.includes('dsh-excalidraw：一次刷新的架构与数据流'));
  assert.ok(result.svg.includes('SVG 渲染器'));
});

test('fixture: viewBox covers bounds and matches width/height', () => {
  const result = renderScene(elements);
  assert.ok(result.bounds);
  const [vx, vy, vw, vh] = viewBoxOf(result.svg);
  assert.ok(vx <= result.bounds.minX);
  assert.ok(vy <= result.bounds.minY);
  assert.ok(vx + vw >= result.bounds.maxX);
  assert.ok(vy + vh >= result.bounds.maxY);
  // The SVG format rounds coordinates to three decimals; the returned numbers
  // are exact, so compare with a formatting tolerance.
  assert.ok(Math.abs(vw - result.width) < 0.001);
  assert.ok(Math.abs(vh - result.height) < 0.001);
  assert.ok(Math.abs(result.width - (result.bounds.maxX - result.bounds.minX + 48)) < 1e-9);
  assert.ok(Math.abs(result.height - (result.bounds.maxY - result.bounds.minY + 48)) < 1e-9);
});

test('deterministic: two renders are byte identical', () => {
  const first = renderScene(elements);
  const second = renderScene(structuredClone(elements));
  assert.equal(first.svg, second.svg);
  assert.equal(first.width, second.width);
  assert.equal(first.height, second.height);
  assert.deepEqual(first.bounds, second.bounds);
});

test('each supported element type is rendered', () => {
  const scene = [
    el('rectangle', { id: 'box', x: 0, y: 0, width: 120, height: 60, roundness: { type: 3 } }),
    el('text', {
      id: 'bound-text',
      containerId: 'box',
      x: 10,
      y: 10,
      width: 100,
      height: 24,
      text: 'Inside',
      fontSize: 20,
      textAlign: 'center',
      verticalAlign: 'middle',
    }),
    el('ellipse', { id: 'oval', x: 200, y: 0, width: 100, height: 60, backgroundColor: '#e7f5ff' }),
    el('diamond', { id: 'diamond', x: 360, y: 0, width: 80, height: 80 }),
    el('line', {
      id: 'line',
      x: 0,
      y: 100,
      width: 100,
      height: 0,
      points: [[0, 0], [100, 0]],
    }),
    el('arrow', {
      id: 'arrow',
      x: 0,
      y: 150,
      width: 100,
      height: 0,
      points: [[0, 0], [100, 0]],
      startArrowhead: 'triangle',
      endArrowhead: 'bar',
    }),
    el('text', {
      id: 'arrow-label',
      containerId: 'arrow',
      x: 40,
      y: 140,
      width: 40,
      height: 20,
      text: 'label',
      fontSize: 16,
      textAlign: 'center',
      verticalAlign: 'middle',
    }),
    el('frame', { id: 'frame', x: 0, y: 220, width: 200, height: 150, name: 'Slide 1' }),
    el('image', { id: 'image', x: 250, y: 220, width: 100, height: 80 }),
    el('text', {
      id: 'standalone',
      x: 400,
      y: 220,
      width: 120,
      height: 25,
      text: 'Hello',
      fontSize: 20,
      textAlign: 'left',
      verticalAlign: 'top',
    }),
  ];
  const result = renderScene(scene);
  assert.equal(result.rendered, scene.length);
  for (const type of SUPPORTED_TYPES) {
    assert.ok(result.svg.includes(`data-el="${type}"`), `missing ${type}`);
  }
  // Rounded rectangle from roundness {type:3}: min(32, min(120,60)*0.25) = 15.
  assert.match(result.svg, /rx="15"/);
  // Bound arrow label: white chip at the polyline midpoint.
  assert.match(result.svg, /data-role="label-chip"[^>]*fill="#ffffff"/);
  assert.match(result.svg, /<text[^>]*>.*Inside.*<\/text>/);
  assert.match(result.svg, /Slide 1/);
  assert.match(result.svg, /data-role="image-placeholder"/);
  // Arrow heads: filled triangle + bar line.
  assert.match(result.svg, /<path d="M [^"]+ Z" fill="#1e1e1e"/);
  assert.match(result.svg, /<line x1="[^"]+" y1="[^"]+" x2="[^"]+" y2="[^"]+" stroke="#1e1e1e"/);
  assert.equal(result.skipped.length, 0);
});

test('text is XML-escaped', () => {
  const scene = [
    el('text', {
      id: 'escape',
      x: 0,
      y: 0,
      width: 220,
      height: 24,
      text: 'A & B <tag> "quote"',
      fontSize: 20,
      textAlign: 'left',
      verticalAlign: 'top',
    }),
  ];
  const { svg } = renderScene(scene, { padding: 0 });
  assert.match(svg, /A &amp; B &lt;tag&gt; &quot;quote&quot;/);
  assert.ok(!svg.includes('<tag>'));
  assertWellFormed(svg);
});

test('invalid elements are skipped, counted, and never leak NaN/undefined', () => {
  const scene = [
    el('rectangle', { id: 'valid', x: 0, y: 0, width: 10, height: 10 }),
    el('rectangle', { id: 'nan-width', width: Number.NaN }),
    el('arrow', { id: 'no-points' }),
    el('rectangle', { id: 'deleted', isDeleted: true }),
    el('blob', { id: 'unknown' }),
  ];
  const result = renderScene(scene, { padding: 0 });
  assert.equal(result.rendered, 1);
  assert.deepEqual(
    result.skipped.map((skip) => skip.reason).sort(),
    ['bad-geometry', 'bad-points', 'deleted', 'unknown-type'],
  );
  assert.ok(result.skipped.every((skip) => typeof skip.reason === 'string'));
  assert.ok(!/\b(?:NaN|undefined)\b/.test(result.svg));
  assert.deepEqual(result.bounds, { minX: 0, minY: 0, maxX: 10, maxY: 10 });
  assert.equal(sceneBounds(scene.filter((element) => element.id !== 'valid')), null);
});

test('rotation emits a rotate() transform around the element centre', () => {
  const scene = [
    el('rectangle', { id: 'rotated', x: 10, y: 10, width: 100, height: 60, angle: Math.PI / 6 }),
    el('rectangle', { id: 'straight', x: 200, y: 10, width: 20, height: 20 }),
  ];
  const { svg } = renderScene(scene);
  assert.match(svg, /transform="rotate\(30 60 40\)"/);
  const straightGroup = svg.match(/<g data-el="rectangle" data-id="straight"[^>]*>/);
  assert.ok(straightGroup);
  assert.ok(!straightGroup[0].includes('transform='));
});

test('strokeStyle and opacity map to SVG attributes', () => {
  const scene = [
    el('rectangle', { id: 'dashed', strokeStyle: 'dashed', opacity: 50 }),
    el('rectangle', { id: 'dotted', x: 200, strokeStyle: 'dotted' }),
  ];
  const { svg } = renderScene(scene);
  assert.match(svg, /stroke-dasharray="8 4"/);
  assert.match(svg, /stroke-dasharray="0.2 4"/);
  assert.match(svg, /opacity="0\.5"/);
  assert.match(svg, /stroke-linecap="round"/);
});

test('background option paints a white backing rect', () => {
  const withBackground = renderScene(elements, { background: true }).svg;
  assert.match(withBackground, /data-el="background"/);
  assert.match(withBackground, /fill="#ffffff"/);
  assert.ok(!renderScene(elements).svg.includes('data-el="background"'));
  const empty = renderScene([], { padding: 0, background: true });
  assert.match(empty.svg, /viewBox="0 0 1 1"/);
  assert.match(empty.svg, /data-el="background"/);
});

test('sceneBounds unions valid geometry and returns null for nothing renderable', () => {
  assert.equal(sceneBounds([]), null);
  assert.equal(sceneBounds('nope'), null);
  const bounds = sceneBounds([
    el('rectangle', { x: 10, y: 20, width: 100, height: 50 }),
    el('ellipse', { x: 200, y: 0, width: 50, height: 100, angle: 0 }),
  ]);
  assert.deepEqual(bounds, { minX: 10, minY: 0, maxX: 250, maxY: 100 });
});

test('sceneBounds uses arrow points and rotated corners', () => {
  const arrow = el('arrow', {
    x: 0,
    y: 0,
    width: 10,
    height: 0,
    points: [[0, 0], [100, 0]],
  });
  assert.deepEqual(sceneBounds([arrow]), { minX: 0, minY: 0, maxX: 100, maxY: 0 });
  const rotated = sceneBounds([
    el('rectangle', { x: 0, y: 0, width: 100, height: 50, angle: Math.PI / 2 }),
  ]);
  assert.ok(Math.abs(rotated.minX - 25) < 1e-9);
  assert.ok(Math.abs(rotated.maxX - 75) < 1e-9);
  assert.ok(Math.abs(rotated.minY + 25) < 1e-9);
  assert.ok(Math.abs(rotated.maxY - 75) < 1e-9);
});

test('font families 5, 7 and 8 each map to a defined stack', () => {
  const scene = [5, 7, 8].map((fontFamily, index) =>
    el('text', {
      id: `font-${fontFamily}`,
      x: 0,
      y: index * 30,
      width: 120,
      height: 20,
      text: `font ${fontFamily}`,
      fontSize: 16,
      fontFamily,
      textAlign: 'left',
      verticalAlign: 'top',
    }),
  );
  const { svg } = renderScene(scene);
  assert.match(svg, /font-family="Excalifont/);
  assert.match(svg, /font-family="'Lilita One'/);
  assert.match(svg, /font-family="'Comic Shanns'/);
  assert.ok(!svg.includes('undefined'));
  // Family 7 is the display face, not a cursive hand-drawn fallback.
  assert.doesNotMatch(svg.match(/font-family="'Lilita One'[^"]*"/)[0], /cursive/);
});

test('array order is preserved (Excalidraw z-order)', () => {
  const scene = [
    el('rectangle', { id: 'first', x: 0, y: 0, width: 50, height: 50 }),
    el('rectangle', { id: 'second', x: 0, y: 0, width: 50, height: 50 }),
  ];
  const { svg } = renderScene(scene);
  assert.ok(svg.indexOf('data-id="first"') < svg.indexOf('data-id="second"'));
});

test('arrowHeadPath supports the contract head types', () => {
  const points = [[0, 0], [100, 0]];
  assert.match(arrowHeadPath(points, false, 'arrow', 2, '#000'), /<path /);
  assert.match(arrowHeadPath(points, false, 'triangle', 2, '#000'), /fill="#000"/);
  assert.match(arrowHeadPath(points, false, 'triangle_outline', 2, '#000'), /fill="none"/);
  assert.match(arrowHeadPath(points, false, 'bar', 2, '#000'), /<line /);
  assert.match(arrowHeadPath(points, false, 'dot', 2, '#000'), /<circle /);
  assert.match(arrowHeadPath(points, true, 'arrow', 2, '#000'), /<path /);
  assert.equal(arrowHeadPath(points, false, null, 2, '#000'), '');
  assert.equal(arrowHeadPath(points, false, 'unknown-head', 2, '#000'), '');
  assert.equal(arrowHeadPath([[0, 0]], false, 'arrow', 2, '#000'), '');
});

test('script renders the fixture and prints the summary line', () => {
  const directory = mkdtempSync(join(tmpdir(), 'xcal-render-'));
  try {
    const scenePath = fileURLToPath(fixtureUrl);
    const outPath = join(directory, 'out.svg');
    const scriptPath = fileURLToPath(new URL('../scripts/render-scene.mjs', import.meta.url));
    const stdout = execFileSync(process.execPath, [scriptPath, scenePath, outPath], {
      encoding: 'utf8',
    });
    assert.match(
      stdout,
      /^elements=47 rendered=47 skipped=\[\] bounds=-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+ bytes=\d+\n$/,
    );
    const svg = readFileSync(outPath, 'utf8');
    assert.ok(svg.startsWith('<svg '));
    assertWellFormed(svg);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('control characters are stripped so the SVG stays well-formed (round 5)', async () => {
  const { renderScene } = await import('../src/renderer.mjs')
  const svg = renderScene([{ type: 'text', x: 0, y: 0, width: 200, height: 40, text: 'a\u0000b\u0001c', fontSize: 16 }]).svg
  assert.equal(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(svg), false)
  assert.match(svg, />abc</)
})

test('absurd coordinates cannot make the viewBox infinite (round 5)', async () => {
  const { renderScene } = await import('../src/renderer.mjs')
  const out = renderScene([
    { type: 'rectangle', x: 1e308, y: -1e308, width: 1e308, height: 1e308 },
    { type: 'arrow', x: 1e308, y: 1e308, width: 1, height: 1, points: [[0, 0], [1e308, 1e308]] },
  ], { padding: 24 })
  assert.equal(/Infinity/.test(out.svg), false)
  assert.equal(Number.isFinite(out.width), true)
  assert.equal(Number.isFinite(out.height), true)
})

test('a real in-app scene renders every element with a matching frame (fidelity fixture)', async () => {
  const { renderScene, sceneBounds } = await import('../src/renderer.mjs')
  const fs = await import('node:fs')
  const scene = JSON.parse(fs.readFileSync(new URL('./fixtures/app-scene.json', import.meta.url), 'utf8'))
  const live = scene.elements.filter((element) => element.isDeleted !== true)
  const out = renderScene(scene.elements, { padding: 24, background: false })
  assert.equal(out.rendered, live.length, 'every live element is drawn')
  assert.deepEqual(out.skipped.map((entry) => entry.reason), ['deleted'])
  assert.equal(/NaN|Infinity|undefined/.test(out.svg), false)
  // Excalidraw's own export of this scene is 934x1079 (aspect 0.866); the frame
  // must keep that aspect, which is what keeps our fit/zoom honest.
  const aspect = out.width / out.height
  assert.ok(Math.abs(aspect - 934 / 1079) < 0.01, `aspect ${aspect.toFixed(3)} must match the reference export`)
  const bounds = sceneBounds(scene.elements)
  const reference = scene.elements.find((element) => element.id === '21_YOtyfr6gpq8_8hPYDg')
  assert.ok(bounds.minX <= reference.x && bounds.minY <= reference.y, 'the frame covers the reference content')
  assert.equal(renderScene(scene.elements, { padding: 24, background: false }).svg, out.svg, 'deterministic')
})

test('hachure and cross-hatch fills become real hatch patterns (rounds 12-13)', async () => {
  const { renderScene } = await import('../src/renderer.mjs')
  const out = renderScene([
    { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 60, backgroundColor: '#ffd8a8', fillStyle: 'hachure', strokeColor: '#e8590c', strokeWidth: 2 },
    { id: 'b', type: 'rectangle', x: 0, y: 80, width: 100, height: 60, backgroundColor: '#ffd8a8', fillStyle: 'hachure', strokeColor: '#e8590c', strokeWidth: 2 },
    { id: 'c', type: 'ellipse', x: 120, y: 0, width: 80, height: 80, backgroundColor: '#b2f2bb', fillStyle: 'cross-hatch', strokeColor: '#2f9e44' },
  ], {})
  const defs = out.svg.match(/<defs>[\s\S]*?<\/defs>/)[0]
  // Two identical hatches share one definition; cross-hatch adds two tiles and
  // the composite pattern that layers them.
  assert.equal((defs.match(/<pattern /g) || []).length, 4)
  assert.equal((out.svg.match(/fill="url\(#hatch-\d+\)"/g) || []).length, 3, 'two hachure elements and one cross-hatch')
  // The rotation lives on the <pattern>: rotating the line inside an 8 px tile
  // clips it away (the round-13 regression), and the line sits at its centre.
  assert.match(defs, /<pattern id="hatch-1"[^>]*patternTransform="rotate\(41\)"[^>]*><line x1="4" y1="0" x2="4" y2="8"/)
  assert.equal((defs.match(/<line[^>]*transform=/g) || []).length, 0, 'the line itself is never rotated')
  assert.match(defs, /<pattern id="hatch-2-a"[^>]*rotate\(41\)/)
  assert.match(defs, /<pattern id="hatch-2-b"[^>]*rotate\(-41\)/)
  assert.match(defs, /<pattern id="hatch-2"[^>]*><rect width="8" height="8" fill="url\(#hatch-2-a\)"\/><rect width="8" height="8" fill="url\(#hatch-2-b\)"\/><\/pattern>/)
  // A scene with no textured fill gains no defs at all.
  const plain = renderScene([{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, backgroundColor: '#fff' }], {})
  assert.equal(plain.svg.includes('<defs>'), false)
})

test('a scene image with a safe data URL is drawn; anything else is a placeholder (round 12)', async () => {
  const { renderScene } = await import('../src/renderer.mjs')
  const element = { id: 'i', type: 'image', x: 0, y: 0, width: 100, height: 50, fileId: 'f1' }
  const safe = renderScene([element], { files: { f1: { dataURL: 'data:image/png;base64,iVBORw0KGgo=' } } })
  assert.match(safe.svg, /<image data-role="image"[^>]*href="data:image\/png;base64,iVBORw0KGgo="/)
  assert.match(safe.svg, /preserveAspectRatio="none"/)
  assert.equal(safe.svg.includes('image-placeholder'), false)
  for (const bad of [
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/png;base64,<script>',
    'https://example.com/a.png',
  ]) {
    const out = renderScene([element], { files: { f1: { dataURL: bad } } })
    assert.equal(out.svg.includes('image-placeholder'), true, bad)
    assert.equal(out.svg.includes('javascript:'), false, bad)
  }
  const noFiles = renderScene([element], {})
  assert.equal(noFiles.svg.includes('image-placeholder'), true)
})

test('image whitelist accepts every allowed type and the family-5 stack keeps Virgil (round 14)', async () => {
  const { renderScene } = await import('../src/renderer.mjs')
  const element = { id: 'i', type: 'image', x: 0, y: 0, width: 10, height: 10, fileId: 'f' }
  for (const mime of ['png', 'jpeg', 'jpg', 'gif', 'webp', 'avif', 'svg+xml']) {
    const out = renderScene([element], { files: { f: { dataURL: `data:image/${mime};base64,AAAA` } } })
    assert.match(out.svg, /<image data-role="image"/, mime)
  }
  for (const bad of ['data:image/bmp;base64,AAAA', 'data:image/png,AAAA', 'data:image/png;base64,']) {
    const out = renderScene([element], { files: { f: { dataURL: bad } } })
    assert.equal(out.svg.includes('image-placeholder'), true, bad)
  }
  // Family 5 (Excalifont) must fall through to the shipped Virgil in the CSS stack.
  const text = renderScene([{ id: 't', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'hi', fontFamily: 5 }], {})
  assert.match(text.svg, /font-family="Excalifont, Virgil, 'Comic Sans MS', cursive"/)
})

test('a CDATA-breaking sequence in the styles is escaped, not emitted raw (round 14)', async () => {
  const { withStyle } = await import('../lib/fonts.js')
  const css = 'a]]>b'
  const svg = withStyle('<svg xmlns="x"></svg>', css)
  assert.match(svg, /<!\[CDATA\[a\]\]\]\]><!\[CDATA\[>b\]\]>/)
  assert.equal(svg.includes('a]]>b'), false, 'the raw terminator never survives')
})

test('a colour with control characters cannot break the XML (round 14)', async () => {
  const { renderScene } = await import('../src/renderer.mjs')
  const out = renderScene([
    { id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, backgroundColor: '#ff\u0000d8', strokeColor: '#e8\u0001590c' },
  ], {})
  assert.equal(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(out.svg), false)
  assert.match(out.svg, /fill="#ffd8"/)
  assert.match(out.svg, /stroke="#e8590c"/)
})

test('element geometries expose selectable boxes in paint order (round 20)', async () => {
  const { elementGeometries } = await import('../src/renderer.mjs')
  const list = [
    { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
    { id: 'del', type: 'rectangle', x: 0, y: 0, width: 5, height: 5, isDeleted: true },
    { id: 'b', type: 'ellipse', x: 200, y: 0, width: 40, height: 40 },
    { type: 'diamond', x: 300, y: 0, width: 20, height: 20 },
    { id: 'bad', type: 'rectangle', x: 'nope', y: 0, width: 1, height: 1 },
  ]
  const geometries = elementGeometries(list)
  assert.deepEqual(geometries.map((g) => g.id), ['a', 'b', 'element-3'])
  assert.equal(geometries[1].box.width, 40)
  assert.equal(elementGeometries(null).length, 0)
})

test('hit testing respects boxes, strokes and rotation (round 20)', async () => {
  const { elementGeometries, hitsGeometry, hitTestGeometry } = await import('../src/renderer.mjs')
  const rect = { id: 'r', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 }
  const arrow = { id: 'a', type: 'arrow', x: 0, y: 0, width: 100, height: 100, points: [[0, 0], [100, 100]] }
  const rotated = { id: 'rot', type: 'rectangle', x: 0, y: 0, width: 100, height: 20, angle: Math.PI / 2 }
  const [r, a, rot] = elementGeometries([rect, arrow, rotated])
  assert.equal(hitsGeometry(r, { x: 50, y: 25 }), true)
  assert.equal(hitsGeometry(r, { x: 150, y: 25 }), false)
  assert.equal(hitsGeometry(r, { x: 103, y: 25 }), true, 'slop still selects near the border')
  // A diagonal stroke is selectable along the line, not in the empty corner.
  assert.equal(hitsGeometry(a, { x: 50, y: 50 }), true)
  assert.equal(hitsGeometry(a, { x: 90, y: 10 }, 2), false)
  // A 90° rotation swaps the box extents around the centre.
  assert.equal(hitsGeometry(rot, { x: 50, y: 50 }), true);
  // The rotated box runs vertically: x=10 is beside it, x=50 y=45 is inside.
  assert.equal(hitsGeometry(rot, { x: 10, y: 10 }), false);
  assert.equal(hitsGeometry(rot, { x: 50, y: 45 }), true);
  assert.equal(hitsGeometry(rot, { x: 95, y: 90 }), false)
  // Topmost wins on overlap.
  const over = [
    { id: 'under', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
    { id: 'over', type: 'rectangle', x: 10, y: 10, width: 40, height: 40 },
  ]
  assert.equal(hitTestGeometry(elementGeometries(over), { x: 20, y: 20 }).id, 'over')
  assert.equal(hitTestGeometry(elementGeometries(over), { x: 90, y: 90 }).id, 'under')
  assert.equal(hitTestGeometry(elementGeometries(over), { x: 500, y: 500 }), null)
})

test('marquee selection uses the rotated bounds (round 20)', async () => {
  const { elementGeometries, elementsInRect, intersectsRect } = await import('../src/renderer.mjs')
  const [a, b] = elementGeometries([
    { id: 'a', type: 'rectangle', x: 0, y: 0, width: 20, height: 20 },
    { id: 'b', type: 'rectangle', x: 200, y: 0, width: 20, height: 20 },
  ])
  assert.equal(intersectsRect(a, { minX: 10, minY: 10, maxX: 15, maxY: 15 }), true)
  assert.equal(intersectsRect(b, { minX: 10, minY: 10, maxX: 15, maxY: 15 }), false)
  assert.deepEqual(elementsInRect([a, b], { minX: -5, minY: -5, maxX: 25, maxY: 25 }).map((g) => g.id), ['a'])
  assert.deepEqual(elementsInRect([a, b], { minX: -5, minY: -5, maxX: 500, maxY: 500 }).map((g) => g.id), ['a', 'b'])
})

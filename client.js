/**
 * GENERATED FILE — edit src/renderer.mjs and src/client.mjs, then `npm run build`.
 * sources-signature: fc747c29c46ed4a0
 * Registers the dsh-excalidraw client half into DSH's browser module table.
 */
window.__ModuleLoader__.load({
  id: "dsh-excalidraw",
  factory(require) {
    const React = require('react');

    // ── inlined src/renderer.mjs ───────────────────────────────────────
/**
 * dsh-excalidraw — pure, DOM-free, deterministic SVG renderer for Excalidraw
 * scene elements.
 *
 * No dependencies. No DOM. No randomness, clocks or environment lookups: the
 * same element array always produces a byte-identical SVG string.
 *
 * Public API (see docs/CONTRACT.md §6):
 *   renderScene(elements, options) -> { svg, width, height, bounds, rendered, skipped }
 *   sceneBounds(elements)          -> { minX, minY, maxX, maxY } | null
 *
 * Optional helpers exported for the tests and for the client:
 *   escapeXml(value) -> string
 *   arrowHeadPath(points, atStart, type, strokeWidth, strokeColor) -> string
 *   SUPPORTED_TYPES -> frozen array of element types this renderer draws
 */

const DEFAULT_PADDING = 24;
/** Coordinates beyond this are clamped: a scene of 1e308 made the viewBox Infinity. */
const MAX_COORD = 1e7;

/** Clamp one coordinate into the renderable range. */
function clampCoord(value) {
  return Math.max(-MAX_COORD, Math.min(MAX_COORD, value));
}
const DEFAULT_STROKE = '#1e1e1e';
const DEFAULT_FONT_SIZE = 20;
const DEFAULT_LINE_HEIGHT = 1.25;

const SUPPORTED_TYPES = Object.freeze([
  'rectangle',
  'ellipse',
  'diamond',
  'line',
  'arrow',
  'text',
  'frame',
  'image',
]);

const SUPPORTED_TYPE_SET = new Set(SUPPORTED_TYPES);

/**
 * Excalidraw font families, mapped to web-safe fallback stacks. The first name
 * is the real Excalidraw font when it happens to be installed; the fallbacks
 * keep the SVG readable everywhere.
 */
const FONT_FAMILIES = Object.freeze({
  1: "Virgil, 'Segoe Print', 'Comic Sans MS', cursive",
  2: 'Helvetica, Arial, sans-serif',
  3: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace",
  4: "'Liberation Sans', Arial, Helvetica, sans-serif",
  5: "Excalifont, Virgil, 'Comic Sans MS', cursive",
  6: "Nunito, 'Segoe UI', sans-serif",
  7: "'Lilita One', Nunito, 'Segoe UI', sans-serif",
  8: "'Comic Shanns', 'Comic Mono', monospace",
});

/* ------------------------------------------------------------------ */
/* Small validation / formatting helpers                               */
/* ------------------------------------------------------------------ */

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveNumber(value) {
  return isFiniteNumber(value) && value > 0 ? value : null;
}

/**
 * Format a number for the SVG at most three decimals, never `NaN`, `undefined`
 * or `-0`, and never scientific notation for ordinary scene coordinates.
 */
function fmt(value) {
  if (!isFiniteNumber(value)) return '0';
  const rounded = Math.round((value + Number.EPSILON) * 1000) / 1000;
  if (Object.is(rounded, -0)) return '0';
  return String(rounded);
}

/**
 * Escape the four XML metacharacters that matter in both text content and
 * double-quoted attribute values.
 */
function escapeXml(value) {
  return String(value)
    // A C0 control character is not a legal XML character: it made the whole
    // SVG unparsable (review round 5).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Accept a CSS colour-ish string from the scene, reject anything that could
 * break out of the attribute or fetch an external resource, and map Excalidraw's
 * `transparent` to SVG's `none`.
 */
function cssColor(value, fallback) {
  if (typeof value !== 'string') return fallback;
  // Control characters are not legal XML text: strip them before the shape
  // checks, or a hostile colour breaks the whole exported document.
  const trimmed = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF]/g, '').trim();
  if (!trimmed) return fallback;
  if (/[<>"'&\r\n]/.test(trimmed)) return fallback;
  if (/url\s*\(/i.test(trimmed)) return fallback;
  if (trimmed.toLowerCase() === 'transparent') return 'none';
  return trimmed;
}

/** The CSS stack the renderer uses for one Excalidraw family key. */
function fontStackOf(value) {
  const key = typeof value === 'string' ? Number(value) : value;
  if (isFiniteNumber(key) && key !== 0 && FONT_FAMILIES[key]) return FONT_FAMILIES[key];
  return FONT_FAMILIES[5];
}

function fontFamilyOf(value) {
  if (typeof value === 'string' && value.trim() && !/[<>"&]/.test(value)) {
    return value.trim();
  }
  const key = typeof value === 'string' ? Number(value) : value;
  if (isFiniteNumber(key) && FONT_FAMILIES[key]) return FONT_FAMILIES[key];
  return FONT_FAMILIES[5];
}

function strokeWidthOf(el) {
  if (isFiniteNumber(el.strokeWidth)) {
    return el.strokeWidth > 0 ? Math.min(el.strokeWidth, 100) : 1;
  }
  return 2;
}

function dashArrayOf(style, strokeWidth) {
  if (style === 'dashed') return `${fmt(strokeWidth * 4)} ${fmt(strokeWidth * 2)}`;
  if (style === 'dotted') return `${fmt(strokeWidth * 0.1)} ${fmt(strokeWidth * 2)}`;
  return null;
}

function opacityOf(el) {
  if (!isFiniteNumber(el.opacity)) return null;
  const clamped = Math.max(0, Math.min(100, el.opacity));
  if (clamped >= 100) return null;
  return fmt(clamped / 100);
}

/**
 * Register (once) the SVG `<pattern>` that draws a hachure/cross-hatch fill the
 * way Excalidraw does — parallel strokes, not a solid tint — and return its id.
 *
 * The tile stays axis-aligned and the *pattern transform* rotates it: rotating a
 * line inside a tiny tile clips it against the tile edge (which drew single
 * pixels instead of strokes). Cross-hatch layers a second, opposite-angle tile
 * through a pattern whose content references the first one.
 */
function hatchPatternOf(hatch, style, color, strokeWidth) {
  if (!hatch || !(hatch.ids instanceof Map) || !Array.isArray(hatch.defs)) return null;
  const gap = Math.max(4, Math.min(24, strokeWidth * 4));
  const width = Math.max(1, strokeWidth);
  const key = `${style}|${color}|${fmt(gap)}|${fmt(width)}`;
  const existing = hatch.ids.get(key);
  if (existing !== undefined) return existing;
  const id = `hatch-${hatch.ids.size + 1}`;
  hatch.ids.set(key, id);
  const tile = (angle) => `<pattern id="${id}-${angle < 0 ? 'b' : 'a'}" patternUnits="userSpaceOnUse" `
    + `width="${fmt(gap)}" height="${fmt(gap)}" patternTransform="rotate(${angle})">`
    + `<line x1="${fmt(gap / 2)}" y1="0" x2="${fmt(gap / 2)}" y2="${fmt(gap)}" stroke="${color}" `
    + `stroke-width="${fmt(width)}"/></pattern>`;
  if (style === 'cross-hatch') {
    hatch.defs.push(tile(41), tile(-41));
    hatch.defs.push(
      `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${fmt(gap)}" height="${fmt(gap)}">`
        + `<rect width="${fmt(gap)}" height="${fmt(gap)}" fill="url(#${id}-a)"/>`
        + `<rect width="${fmt(gap)}" height="${fmt(gap)}" fill="url(#${id}-b)"/></pattern>`,
    );
  } else {
    hatch.defs.push(
      `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${fmt(gap)}" height="${fmt(gap)}" `
        + `patternTransform="rotate(${style === 'zigzag' ? 0 : 41})">`
        + `<line x1="${fmt(gap / 2)}" y1="0" x2="${fmt(gap / 2)}" y2="${fmt(gap)}" stroke="${color}" `
        + `stroke-width="${fmt(width)}"/></pattern>`,
    );
  }
  return id;
}

function fillAttrsOf(el, hatch) {
  const fill = cssColor(el.backgroundColor, 'none');
  if (fill === 'none') return 'fill="none"';
  const style = el.fillStyle;
  if (style === 'hachure' || style === 'cross-hatch' || style === 'zigzag') {
    const id = hatchPatternOf(hatch, style, fill, strokeWidthOf(el));
    if (id !== null) return `fill="url(#${id})"`;
    // No pattern registry (a caller rendering one element): keep a light tint.
    return `fill="${fill}" fill-opacity="0.35"`;
  }
  return `fill="${fill}"`;
}

function commonPaint(el, hatch) {
  const strokeWidth = strokeWidthOf(el);
  const attrs = [
    fillAttrsOf(el, hatch),
    `stroke="${cssColor(el.strokeColor, DEFAULT_STROKE)}"`,
    `stroke-width="${fmt(strokeWidth)}"`,
  ];
  const dash = dashArrayOf(el.strokeStyle, strokeWidth);
  if (dash) {
    attrs.push(`stroke-dasharray="${dash}"`);
    if (el.strokeStyle === 'dotted') attrs.push('stroke-linecap="round"');
  }
  const opacity = opacityOf(el);
  if (opacity) attrs.push(`opacity="${opacity}"`);
  return attrs.join(' ');
}

function group(type, id, inner, transform = '') {
  const idAttr =
    typeof id === 'string' && id.length > 0 ? ` data-id="${escapeXml(id)}"` : '';
  return `<g data-el="${type}"${idAttr}${transform}>${inner}</g>`;
}

function rotationFor(el, box) {
  if (!isFiniteNumber(el.angle) || el.angle === 0) return '';
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const degrees = (el.angle * 180) / Math.PI;
  return ` transform="rotate(${fmt(degrees)} ${fmt(cx)} ${fmt(cy)})"`;
}

function cornerRadiusOf(el, box) {
  if (!el.roundness || typeof el.roundness !== 'object') return 0;
  const type = el.roundness.type;
  if (type !== 1 && type !== 2 && type !== 3) return 0;
  const shortest = Math.min(box.width, box.height);
  if (!(shortest > 0)) return 0;
  const radius = Math.min(32, shortest * 0.25);
  return radius >= 0.5 ? radius : 0;
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

function normalizeBox(el) {
  if (!el || typeof el !== 'object') return null;
  let { x, y, width, height } = el;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height)
  ) {
    return null;
  }
  if (width < 0) {
    x += width;
    width = -width;
  }
  x = clampCoord(x);
  y = clampCoord(y);
  width = Math.min(clampCoord(width), MAX_COORD * 2);
  height = Math.min(clampCoord(height), MAX_COORD * 2);
  if (height < 0) {
    y += height;
    height = -height;
  }
  // Reject boxes whose far corner overflows to Infinity.
  if (!isFiniteNumber(x + width) || !isFiniteNumber(y + height)) return null;
  return { x, y, width, height };
}

function linearPoints(el) {
  if (!Array.isArray(el.points) || el.points.length < 2) return null;
  const points = [];
  for (const point of el.points) {
    let px;
    let py;
    if (Array.isArray(point)) {
      px = point[0];
      py = point[1];
    } else if (point && typeof point === 'object') {
      px = point.x;
      py = point.y;
    } else {
      return null;
    }
    if (!isFiniteNumber(px) || !isFiniteNumber(py)) return null;
    // Points are added to the element origin: clamp before the sum overflows.
    const x = clampCoord(clampCoord(el.x) + clampCoord(px));
    const y = clampCoord(clampCoord(el.y) + clampCoord(py));
    points.push([x, y]);
  }
  return points;
}

function boundsOfPoints(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function rotateBoxBounds(box, angle) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x + box.width, box.y + box.height],
    [box.x, box.y + box.height],
  ]) {
    const dx = px - cx;
    const dy = py - cy;
    const x = cx + dx * cos - dy * sin;
    const y = cy + dx * sin + dy * cos;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function polylineMidpoint(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  if (!(total > 0)) return { x: points[0][0], y: points[0][1] };
  let remaining = total / 2;
  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const segment = Math.hypot(x1 - x0, y1 - y0);
    if (segment >= remaining && segment > 0) {
      const t = remaining / segment;
      return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t };
    }
    remaining -= segment;
  }
  const last = points[points.length - 1];
  return { x: last[0], y: last[1] };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function inspect(el) {
  if (!el || typeof el !== 'object' || Array.isArray(el)) {
    return { ok: false, reason: 'invalid-element' };
  }
  if (el.isDeleted === true) return { ok: false, reason: 'deleted' };
  if (!SUPPORTED_TYPE_SET.has(el.type)) return { ok: false, reason: 'unknown-type' };
  const box = normalizeBox(el);
  if (!box) return { ok: false, reason: 'bad-geometry' };
  if (el.type === 'arrow' || el.type === 'line') {
    const points = linearPoints(el);
    if (!points) return { ok: false, reason: 'bad-points' };
    return { ok: true, box, points };
  }
  if (el.type === 'text' && (typeof el.text !== 'string' || el.text.length === 0)) {
    return { ok: false, reason: 'empty-text' };
  }
  return { ok: true, box };
}

/**
 * Axis-aligned union of the renderable elements' geometry.
 * Rotation is accounted for by rotating the corners around the element centre.
 * Returns `null` when nothing renderable is present.
 */
function sceneBounds(elements) {
  if (!Array.isArray(elements)) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;

  for (const el of elements) {
    let info;
    try {
      info = inspect(el);
    } catch {
      continue;
    }
    if (!info.ok) continue;
    let bounds = info.points ? boundsOfPoints(info.points) : {
      minX: info.box.x,
      minY: info.box.y,
      maxX: info.box.x + info.box.width,
      maxY: info.box.y + info.box.height,
    };
    if (!bounds) continue;
    if (isFiniteNumber(el.angle) && el.angle !== 0) {
      bounds = rotateBoxBounds(info.box, el.angle);
    }
    if (bounds.maxX < bounds.minX || bounds.maxY < bounds.minY) continue;
    any = true;
    if (bounds.minX < minX) minX = bounds.minX;
    if (bounds.minY < minY) minY = bounds.minY;
    if (bounds.maxX > maxX) maxX = bounds.maxX;
    if (bounds.maxY > maxY) maxY = bounds.maxY;
  }

  if (!any) return null;
  return { minX, minY, maxX, maxY };
}

/* ------------------------------------------------------------------ */
/* Selection geometry (preview-only hit testing)                       */
/* ------------------------------------------------------------------ */

/**
 * The selectable geometry of every renderable element, in scene coordinates and
 * in paint order (the last entry is the topmost element).
 *
 * @param {Array<object>} elements
 * @returns {Array<{id: string, index: number, type: string, box: object, angle: number, points: Array<[number,number]>|null}>}
 */
function elementGeometries(elements) {
  const result = [];
  if (!Array.isArray(elements)) return result;
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    let info;
    try {
      info = inspect(element);
    } catch {
      continue;
    }
    if (!info.ok) continue;
    result.push({
      id: typeof element.id === 'string' && element.id !== '' ? element.id : `element-${index}`,
      index,
      type: element.type,
      box: info.box,
      angle: isFiniteNumber(element.angle) ? element.angle : 0,
      points: info.points ?? null,
    });
  }
  return result;
}

/** Rotate a point into an element's own (unrotated) coordinate frame. */
function unrotate(point, geometry) {
  const angle = geometry.angle;
  if (angle === 0) return point;
  const cx = geometry.box.x + geometry.box.width / 2;
  const cy = geometry.box.y + geometry.box.height / 2;
  const dx = point.x - cx;
  const dy = point.y - cy;
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/** Shortest distance from a point to a segment. */
function distanceToSegment(point, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a[0], point.y - a[1]);
  let t = ((point.x - a[0]) * dx + (point.y - a[1]) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (a[0] + dx * t), point.y - (a[1] + dy * t));
}

/**
 * Whether a scene point is inside (or close enough to) one geometry.
 *
 * Rectangles, ellipses, diamonds and text use their box (with `slop` pixels of
 * tolerance); arrows, lines and freedraw use their polyline, so a click near the
 * stroke works and the empty corner of a diagonal arrow does not.
 *
 * @param {object} geometry an entry of {@link elementGeometries}
 * @param {{x: number, y: number}} point scene coordinates
 * @param {number} [slop=6] tolerance in scene units
 */
function hitsGeometry(geometry, point, slop = 6) {
  if (geometry === null || geometry === undefined) return false;
  const local = unrotate(point, geometry);
  if (geometry.points !== null) {
    const points = geometry.points;
    if (points.length === 1) return Math.hypot(local.x - points[0][0], local.y - points[0][1]) <= slop;
    for (let index = 1; index < points.length; index += 1) {
      if (distanceToSegment(local, points[index - 1], points[index]) <= slop) return true;
    }
    return false;
  }
  const box = geometry.box;
  const tolerance = geometry.type === 'text' ? 2 : slop;
  return local.x >= box.x - tolerance && local.x <= box.x + box.width + tolerance
    && local.y >= box.y - tolerance && local.y <= box.y + box.height + tolerance;
}

/**
 * The topmost selectable element under a scene point (last painted wins).
 *
 * @param {Array<object>} geometries result of {@link elementGeometries}
 * @param {{x: number, y: number}} point scene coordinates
 * @param {number} [slop=6]
 * @returns {object|null}
 */
function hitTestGeometry(geometries, point, slop = 6) {
  if (!Array.isArray(geometries)) return null;
  for (let index = geometries.length - 1; index >= 0; index -= 1) {
    if (hitsGeometry(geometries[index], point, slop)) return geometries[index];
  }
  return null;
}

/** Whether an element's (rotated) bounds intersect a marquee rectangle. */
function intersectsRect(geometry, rect) {
  if (geometry === null || geometry === undefined) return false;
  const bounds = geometry.angle === 0
    ? {
      minX: geometry.box.x, minY: geometry.box.y,
      maxX: geometry.box.x + geometry.box.width, maxY: geometry.box.y + geometry.box.height,
    }
    : rotateBoxBounds(geometry.box, geometry.angle);
  return bounds.maxX >= rect.minX && bounds.minX <= rect.maxX
    && bounds.maxY >= rect.minY && bounds.minY <= rect.maxY;
}

/**
 * Every element a marquee rectangle touches, in paint order.
 *
 * @param {Array<object>} geometries result of {@link elementGeometries}
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} rect
 */
function elementsInRect(geometries, rect) {
  if (!Array.isArray(geometries)) return [];
  return geometries.filter((geometry) => intersectsRect(geometry, rect));
}

/* ------------------------------------------------------------------ */
/* Arrowheads                                                          */
/* ------------------------------------------------------------------ */

/**
 * One arrowhead as SVG markup, in absolute scene coordinates.
 *
 * @param {Array<[number, number]>} points absolute polyline points
 * @param {boolean} atStart true for the first point, false for the last
 * @param {string} type `arrow`, `triangle`, `triangle_outline`, `bar`, `dot`
 *   or `circle`; anything else (including `null`/`none`) draws nothing
 * @param {number} [strokeWidth=2]
 * @param {string} [strokeColor='#1e1e1e']
 * @returns {string} markup, or an empty string when there is no head
 */
function arrowHeadPath(
  points,
  atStart,
  type,
  strokeWidth = 2,
  strokeColor = DEFAULT_STROKE,
) {
  if (!Array.isArray(points) || points.length < 2) return '';
  const kind = typeof type === 'string' ? type.toLowerCase() : '';
  if (!kind || kind === 'none' || kind === 'null' || kind === 'undefined') return '';

  const tipIndex = atStart ? 0 : points.length - 1;
  const tip = points[tipIndex];
  if (!Array.isArray(tip) || !isFiniteNumber(tip[0]) || !isFiniteNumber(tip[1])) {
    return '';
  }

  let previous = null;
  if (atStart) {
    for (let i = 1; i < points.length; i += 1) {
      if (Math.hypot(points[i][0] - tip[0], points[i][1] - tip[1]) > 1e-6) {
        previous = points[i];
        break;
      }
    }
  } else {
    for (let i = points.length - 2; i >= 0; i -= 1) {
      if (Math.hypot(points[i][0] - tip[0], points[i][1] - tip[1]) > 1e-6) {
        previous = points[i];
        break;
      }
    }
  }
  if (!previous) return '';

  const direction = Math.atan2(tip[1] - previous[1], tip[0] - previous[0]);
  const sw = isFiniteNumber(strokeWidth) && strokeWidth > 0 ? Math.min(strokeWidth, 100) : 2;
  const size = Math.max(12, Math.min(30, sw * 6));
  const ux = Math.cos(direction);
  const uy = Math.sin(direction);
  const px = -uy;
  const py = ux;
  const stroke = cssColor(strokeColor, DEFAULT_STROKE);

  const bx1 = tip[0] - ux * size + px * size * 0.55;
  const by1 = tip[1] - uy * size + py * size * 0.55;
  const bx2 = tip[0] - ux * size - px * size * 0.55;
  const by2 = tip[1] - uy * size - py * size * 0.55;

  if (kind === 'arrow') {
    return (
      `<path d="M ${fmt(bx1)} ${fmt(by1)} L ${fmt(tip[0])} ${fmt(tip[1])} ` +
      `L ${fmt(bx2)} ${fmt(by2)}" fill="none" stroke="${stroke}" ` +
      `stroke-width="${fmt(sw)}" stroke-linecap="round" stroke-linejoin="round"/>`
    );
  }
  if (kind === 'triangle' || kind === 'triangle_outline') {
    const fill = kind === 'triangle' ? stroke : 'none';
    return (
      `<path d="M ${fmt(tip[0])} ${fmt(tip[1])} L ${fmt(bx1)} ${fmt(by1)} ` +
      `L ${fmt(bx2)} ${fmt(by2)} Z" fill="${fill}" stroke="${stroke}" ` +
      `stroke-width="${fmt(sw)}" stroke-linejoin="round"/>`
    );
  }
  if (kind === 'bar') {
    const half = size * 0.6;
    return (
      `<line x1="${fmt(tip[0] + px * half)}" y1="${fmt(tip[1] + py * half)}" ` +
      `x2="${fmt(tip[0] - px * half)}" y2="${fmt(tip[1] - py * half)}" ` +
      `stroke="${stroke}" stroke-width="${fmt(sw)}" stroke-linecap="round"/>`
    );
  }
  if (kind === 'dot' || kind === 'circle') {
    return (
      `<circle cx="${fmt(tip[0])}" cy="${fmt(tip[1])}" r="${fmt(size * 0.35)}" ` +
      `fill="${stroke}" stroke="none"/>`
    );
  }
  // Unknown head types are ignored rather than guessed.
  return '';
}

/* ------------------------------------------------------------------ */
/* Element renderers                                                   */
/* ------------------------------------------------------------------ */

function renderRectangle(el, info, hatch) {
  const b = info.box;
  const radius = cornerRadiusOf(el, b);
  const round = radius > 0 ? ` rx="${fmt(radius)}" ry="${fmt(radius)}"` : '';
  return group(
    'rectangle',
    el.id,
    `<rect x="${fmt(b.x)}" y="${fmt(b.y)}" width="${fmt(b.width)}" ` +
      `height="${fmt(b.height)}"${round} ${commonPaint(el, hatch)}/>`,
    rotationFor(el, b),
  );
}

function renderEllipse(el, info, hatch) {
  const b = info.box;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  return group(
    'ellipse',
    el.id,
    `<ellipse cx="${fmt(cx)}" cy="${fmt(cy)}" rx="${fmt(b.width / 2)}" ` +
      `ry="${fmt(b.height / 2)}" ${commonPaint(el, hatch)}/>`,
    rotationFor(el, b),
  );
}

function renderDiamond(el, info, hatch) {
  const b = info.box;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const points = [
    [cx, b.y],
    [b.x + b.width, cy],
    [cx, b.y + b.height],
    [b.x, cy],
  ]
    .map(([x, y]) => `${fmt(x)},${fmt(y)}`)
    .join(' ');
  return group(
    'diamond',
    el.id,
    `<polygon points="${points}" ${commonPaint(el, hatch)} stroke-linejoin="round"/>`,
    rotationFor(el, b),
  );
}

function renderLinear(el, info) {
  const points = info.points;
  const strokeWidth = strokeWidthOf(el);
  const attrs = [
    `fill="none"`,
    `stroke="${cssColor(el.strokeColor, DEFAULT_STROKE)}"`,
    `stroke-width="${fmt(strokeWidth)}"`,
    'stroke-linecap="round"',
    'stroke-linejoin="round"',
  ];
  const dash = dashArrayOf(el.strokeStyle, strokeWidth);
  if (dash) attrs.push(`stroke-dasharray="${dash}"`);
  const opacity = opacityOf(el);
  if (opacity) attrs.push(`opacity="${opacity}"`);

  const pointList = points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' ');
  let inner = `<polyline points="${pointList}" ${attrs.join(' ')}/>`;

  if (el.type === 'arrow') {
    const color = cssColor(el.strokeColor, DEFAULT_STROKE);
    if (el.startArrowhead) {
      inner += arrowHeadPath(points, true, el.startArrowhead, strokeWidth, color);
    }
    if (el.endArrowhead) {
      inner += arrowHeadPath(points, false, el.endArrowhead, strokeWidth, color);
    }
  }

  return group(el.type, el.id, inner, rotationFor(el, info.box));
}

function renderFrame(el, info) {
  const b = info.box;
  const stroke = cssColor(el.strokeColor, '#adb5bd');
  const fill = cssColor(el.backgroundColor, 'none');
  const angle = rotationFor(el, b);
  const name =
    typeof el.name === 'string' && el.name.length > 0
      ? `<text data-role="frame-name" x="${fmt(b.x)}" y="${fmt(b.y - 7)}" ` +
        `font-family="${escapeXml(fontFamilyOf(el.fontFamily))}" font-size="12" ` +
        `fill="#868e96">${escapeXml(el.name)}</text>`
      : '';
  return group(
    'frame',
    el.id,
    name +
      `<rect x="${fmt(b.x)}" y="${fmt(b.y)}" width="${fmt(b.width)}" ` +
      `height="${fmt(b.height)}" rx="8" ry="8" fill="${fill}" ` +
      `stroke="${stroke}" stroke-width="1" stroke-dasharray="6 4"/>`,
    angle,
  );
}

/** Only a self-contained raster/SVG image may become an `<image href>`. */
const SAFE_IMAGE_SRC = /^data:image\/(png|jpeg|jpg|gif|webp|avif|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

function renderImage(el, info, files) {
  const b = info.box;
  const opacity = opacityOf(el);
  const opacityAttr = opacity ? ` opacity="${opacity}"` : '';
  const fileId = typeof el.fileId === 'string' ? el.fileId : '';
  const dataURL = fileId !== '' && files !== null && typeof files === 'object' ? files[fileId]?.dataURL : undefined;
  if (typeof dataURL === 'string' && SAFE_IMAGE_SRC.test(dataURL)) {
    // Excalidraw stretches an image to its element box.
    return group(
      'image',
      el.id,
      `<image data-role="image" x="${fmt(b.x)}" y="${fmt(b.y)}" ` +
        `width="${fmt(b.width)}" height="${fmt(b.height)}" preserveAspectRatio="none" ` +
        `href="${dataURL}"${opacityAttr}/>`,
      rotationFor(el, b),
    );
  }
  return group(
    'image',
    el.id,
    `<rect data-role="image-placeholder" x="${fmt(b.x)}" y="${fmt(b.y)}" ` +
      `width="${fmt(b.width)}" height="${fmt(b.height)}" fill="#e9ecef" ` +
      `stroke="#adb5bd" stroke-width="1" stroke-dasharray="6 4"${opacityAttr}/>`,
    rotationFor(el, b),
  );
}

function findContainer(el, byId) {
  if (typeof el.containerId !== 'string' || el.containerId.length === 0) return null;
  const container = byId.get(el.containerId);
  if (!container || container.isDeleted === true) return null;
  if (!SUPPORTED_TYPE_SET.has(container.type)) return null;
  return container;
}

function renderText(el, info, state) {
  const text = el.text;
  if (typeof text !== 'string' || text.length === 0) return null;
  const lines = text.split('\n');
  const fontSize = Math.min(
    4096,
    positiveNumber(el.fontSize) ?? positiveNumber(el.baseFontSize) ?? DEFAULT_FONT_SIZE,
  );
  const lineHeight = Math.min(10, positiveNumber(el.lineHeight) ?? DEFAULT_LINE_HEIGHT);
  const step = fontSize * lineHeight;
  const blockHeight = step * lines.length;
  const box = info.box;
  const container = findContainer(el, state.byId);

  let textAnchor = 'start';
  let anchorX;
  let top;
  let chip = '';
  let rotationSource = el;
  let rotationBox = box;
  let positioned = false;

  if (container) {
    const containerBox = normalizeBox(container);
    if (containerBox) {
      if (container.type === 'arrow' || container.type === 'line') {
        const points = linearPoints(container);
        if (points) {
          const midpoint = polylineMidpoint(points);
          textAnchor = 'middle';
          anchorX = midpoint.x;
          top = midpoint.y - blockHeight / 2;
          const chipWidth = Math.max(0, box.width) + 8;
          const chipHeight = Math.max(0, box.height) + 6;
          chip =
            `<rect data-role="label-chip" x="${fmt(midpoint.x - chipWidth / 2)}" ` +
            `y="${fmt(midpoint.y - chipHeight / 2)}" width="${fmt(chipWidth)}" ` +
            `height="${fmt(chipHeight)}" rx="3" ry="3" fill="#ffffff"/>`;
          rotationSource = container;
          rotationBox = containerBox;
          positioned = true;
        }
      } else {
        // CONTRACT §6: bound text is centred in its container, honouring
        // verticalAlign. Horizontal centring wins over textAlign here.
        textAnchor = 'middle';
        anchorX = containerBox.x + containerBox.width / 2;
        const vertical = el.verticalAlign;
        if (vertical === 'top') {
          top = containerBox.y + 5;
        } else if (vertical === 'bottom') {
          top = containerBox.y + containerBox.height - 5 - blockHeight;
        } else {
          top = containerBox.y + containerBox.height / 2 - blockHeight / 2;
        }
        rotationSource = container;
        rotationBox = containerBox;
        positioned = true;
      }
    }
  }

  if (!positioned) {
    // Standalone text (or bound text whose container is gone/invalid).
    const align = el.textAlign;
    if (align === 'center') {
      textAnchor = 'middle';
      anchorX = box.x + box.width / 2;
    } else if (align === 'right') {
      textAnchor = 'end';
      anchorX = box.x + box.width;
    } else {
      textAnchor = 'start';
      anchorX = box.x;
    }
    const vertical = el.verticalAlign;
    if (vertical === 'middle') {
      top = box.y + box.height / 2 - blockHeight / 2;
    } else if (vertical === 'bottom') {
      top = box.y + box.height - blockHeight;
    } else {
      top = box.y;
    }
  }

  const color = cssColor(el.strokeColor, DEFAULT_STROKE);
  const font = fontFamilyOf(el.fontFamily);
  const opacity = opacityOf(el);
  const tspans = lines
    .map(
      (line, index) =>
        `<tspan x="${fmt(anchorX)}" y="${fmt(top + step * index + step / 2)}">` +
        `${escapeXml(line)}</tspan>`,
    )
    .join('');
  const textMarkup =
    `<text text-anchor="${textAnchor}" font-family="${escapeXml(font)}" ` +
    `font-size="${fmt(fontSize)}" fill="${color}" dominant-baseline="central" ` +
    `xml:space="preserve"${opacity ? ` opacity="${opacity}"` : ''}>${tspans}</text>`;

  return group('text', el.id, chip + textMarkup, rotationFor(rotationSource, rotationBox));
}

function renderElement(el, info, state) {
  switch (el.type) {
    case 'rectangle':
      return renderRectangle(el, info, state?.hatch);
    case 'ellipse':
      return renderEllipse(el, info, state?.hatch);
    case 'diamond':
      return renderDiamond(el, info, state?.hatch);
    case 'line':
    case 'arrow':
      return renderLinear(el, info);
    case 'frame':
      return renderFrame(el, info);
    case 'image':
      return renderImage(el, info, state?.files);
    case 'text':
      return renderText(el, info, state);
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

function normalizePadding(value) {
  if (!isFiniteNumber(value) || value < 0) return DEFAULT_PADDING;
  return Math.min(value, 100000);
}

/**
 * Render an Excalidraw `elements` array to a standalone SVG string.
 *
 * @param {Array<object>} elements
 * @param {{ padding?: number, background?: boolean }} [options]
 * @returns {{ svg: string, width: number, height: number, bounds: object|null,
 *             rendered: number, skipped: Array<{id: any, type: any, reason: string}> }}
 */
function renderScene(elements, options = {}) {
  const list = Array.isArray(elements) ? elements : [];
  const opts = options && typeof options === 'object' ? options : {};
  const padding = normalizePadding(opts.padding);
  const background = opts.background === true;

  const byId = new Map();
  for (const el of list) {
    if (el && typeof el === 'object' && typeof el.id === 'string' && el.id.length > 0) {
      byId.set(el.id, el);
    }
  }

  const bounds = sceneBounds(list);
  const paddedWidth = bounds ? bounds.maxX - bounds.minX + padding * 2 : padding * 2;
  const paddedHeight = bounds ? bounds.maxY - bounds.minY + padding * 2 : padding * 2;
  const width = Math.max(1, paddedWidth);
  const height = Math.max(1, paddedHeight);
  const minX = bounds ? bounds.minX - padding : 0;
  const minY = bounds ? bounds.minY - padding : 0;

  const svgParts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" ` +
      `viewBox="${fmt(minX)} ${fmt(minY)} ${fmt(width)} ${fmt(height)}" fill="none">`,
  ];

  if (background) {
    svgParts.push(
      `<rect data-el="background" x="${fmt(minX)}" y="${fmt(minY)}" ` +
        `width="${fmt(width)}" height="${fmt(height)}" fill="#ffffff"/>`,
    );
  }

  const hatch = { ids: new Map(), defs: [] };
  const state = { byId, hatch, files: opts.files ?? null };
  const skipped = [];
  let rendered = 0;

  for (let index = 0; index < list.length; index += 1) {
    const el = list[index];
    let info;
    try {
      info = inspect(el);
    } catch {
      skipped.push({ id: null, type: null, reason: 'invalid-element' });
      continue;
    }
    if (!info.ok) {
      skipped.push({
        id: el && typeof el === 'object' ? el.id ?? null : null,
        type: el && typeof el === 'object' ? el.type ?? null : null,
        reason: info.reason,
      });
      continue;
    }
    try {
      const markup = renderElement(el, info, state);
      if (markup) {
        svgParts.push(markup);
        rendered += 1;
      } else {
        skipped.push({
          id: el.id ?? null,
          type: el.type ?? null,
          reason: 'render-error',
        });
      }
    } catch {
      skipped.push({
        id: el.id ?? null,
        type: el.type ?? null,
        reason: 'render-error',
      });
    }
  }

  if (hatch.defs.length > 0) {
    // <defs> may appear after the referencing elements in SVG, but emitting it
    // before the body keeps the file readable and streaming-friendly.
    svgParts.splice(svgParts.length, 0, `<defs>${hatch.defs.join('')}</defs>`);
  }
  svgParts.push('</svg>');
  const svg = `${svgParts.join('\n')}\n`;

  return { svg, width, height, bounds, rendered, skipped };
}

    // ── inlined src/fonts-data.mjs ─────────────────────────────────────
// Generated by scripts/gen-fonts-data.mjs from fonts/MANIFEST.json — do not edit by hand.
const FONTS = [
  {
    family: "Comic Shanns",
    file: "ComicShanns-Regular-279a7b317d12eb88de06167bd672b4b4.woff2",
    weight: 400,
    style: "normal",
    version: "fa930fce",
    unicodeRange: "U+20-7e,U+a1-a6,U+a8,U+ab-ac,U+af-b1,U+b4,U+b8,U+bb-bc,U+bf-cf,U+d1-d7,U+d9-de,U+e0-ef,U+f1-f7,U+f9-ff,U+131,U+152-153,U+2c6,U+2da,U+2dc,U+2013-2014,U+2018-201a,U+201c-201d,U+2020-2022,U+2026,U+2039-203a,U+2044,U+20ac,U+2191,U+2193,U+2212",
  },
  {
    family: "Comic Shanns",
    file: "ComicShanns-Regular-fcb0fc02dcbee4c9846b3e2508668039.woff2",
    weight: 400,
    style: "normal",
    version: "ee641c2e",
    unicodeRange: "U+100-10f,U+112-125,U+128-130,U+134-137,U+139-13c,U+141-148,U+14c-151,U+154-161,U+164-165,U+168-17f,U+1bf,U+1f7,U+218-21b,U+237,U+1e80-1e85,U+1ef2-1ef3,U+a75b",
  },
  {
    family: "Comic Shanns",
    file: "ComicShanns-Regular-dc6a8806fa96795d7b3be5026f989a17.woff2",
    weight: 400,
    style: "normal",
    version: "61c376d3",
    unicodeRange: "U+2c7,U+2d8-2d9,U+2db,U+2dd,U+315,U+2190,U+2192,U+2200,U+2203-2204,U+2264-2265,U+f6c3",
  },
  {
    family: "Comic Shanns",
    file: "ComicShanns-Regular-6e066e8de2ac57ea9283adb9c24d7f0c.woff2",
    weight: 400,
    style: "normal",
    version: "782f2408",
    unicodeRange: "U+3bb",
  },
  {
    family: "Virgil",
    file: "Virgil-Regular.woff2",
    weight: 400,
    style: "normal",
    version: "2279cf7d",
  },
  {
    family: "Lilita One",
    file: "Lilita-Regular-i7dPIFZ9Zz-WBtRtedDbYEF8RXi4EwQ.woff2",
    weight: 400,
    style: "normal",
    version: "8d6cd0f2",
    unicodeRange: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  },
  {
    family: "Lilita One",
    file: "Lilita-Regular-i7dPIFZ9Zz-WBtRtedDbYE98RXi4EwSsbg.woff2",
    weight: 400,
    style: "normal",
    version: "2b6568c7",
    unicodeRange: "U+0100-02AF,U+0304,U+0308,U+0329,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
  },
]

    // ── inlined src/client.mjs ─────────────────────────────────────────
/**
 * dsh-excalidraw — client half.
 *
 * A lazy client module for DSH's module loader: `scripts/build-client.mjs`
 * inlines `src/renderer.mjs` and wraps this factory into `client.js`, which
 * registers the "Excalidraw" sidebar tab and a `.excalidraw` file viewer through
 * `ctx.betterSidebar`.
 *
 * This file is authored as an ESM factory with no imports: the build strips the
 * `export` keyword and calls `createPlugin(React)` inside the loader factory, so
 * the renderer functions (`renderScene`, `sceneBounds`) and the shipped font list
 * (`FONTS`) are free variables supplied by the inlined modules.
 *
 * See docs/CONTRACT.md §5 for the normative behaviour.
 */

function createPlugin(React) {
  const h = React.createElement;
  const { useState, useEffect, useMemo, useRef, useCallback } = React;

  const API_BASE = 'excalidraw/api';
  const TAB_TYPE = 'excalidraw';
  const LOCALE_NS = 'excalidraw';
  const POLL_FLOOR = 500;
  const POLL_CEIL = 10000;
  const REQUEST_TIMEOUT = 10000;
  const FOCUS_POLL = 6000;
  const DEFAULT_POLL_MS = 1500;
  const MAX_PNG_DIMENSION = 2048;
  const MIN_SCALE = 0.001;
  const MIN_PNG_SCALE = 0.0005;
  const MAX_SCALE = 8;

  /* ------------------------------------------------------------------ */
  /* copy                                                                */
  /* ------------------------------------------------------------------ */

  const DICT = {
    en: {
      title: 'Excalidraw',
      description: 'Live Excalidraw scene of this workspace',
      refresh: 'Refresh',
      refreshTitle: 'Pull the newest scene from Excalidraw+',
      empty: 'No scene yet. Ask the agent to refresh from Excalidraw+ or import a local scene.',
      loading: 'Loading scene…',
      error: 'Could not load the scene',
      updated: 'Updated',
      elements: 'elements',
      noScene: 'No scene yet',
      readonly: 'Read-only',
      exportSvg: 'SVG',
      exportPng: 'PNG',
      exportSvgTitle: 'Download the scene as SVG',
      exportPngTitle: 'Download the scene as PNG (up to 2x, capped at 2048 px)',
      exportFailed: 'Export failed',
      follow: 'Follow',
      emptyHint: 'Ask the agent to refresh or import a scene first',
      canvasHint: 'Drag to pan · ⌘/Ctrl + wheel or pinch to zoom · Shift-drag to select',
      selected: 'selected',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      resetZoom: 'Reset zoom to 100%',
      fitToScreen: 'Fit to screen',
    },
    zh: {
      title: 'Excalidraw 图',
      description: '当前工作区的实时 Excalidraw 场景',
      refresh: '刷新',
      refreshTitle: '从 Excalidraw+ 拉取最新场景',
      empty: '还没有场景。让 agent 从 Excalidraw+ 刷新，或导入本地场景。',
      loading: '正在加载场景…',
      error: '场景加载失败',
      updated: '更新于',
      elements: '个元素',
      noScene: '暂无场景',
      readonly: '只读',
      exportSvg: 'SVG',
      exportPng: 'PNG',
      exportSvgTitle: '把当前场景下载为 SVG',
      exportPngTitle: '把当前场景下载为 PNG（最多 2 倍，长边上限 2048 px）',
      exportFailed: '导出失败',
      follow: '跟随最新',
      emptyHint: '先让 agent 刷新或导入一次场景',
      canvasHint: '拖动平移 · ⌘/Ctrl + 滚轮或双指缩放 · Shift + 拖动框选',
      selected: '已选中',
      zoomIn: '放大',
      zoomOut: '缩小',
      resetZoom: '重置为 100%',
      fitToScreen: '适应窗口',
    },
  };

  const LITERAL_FALLBACK = DICT.en;

  const translateCache = new WeakMap();
  // The plugin's own translate seat, created once in apply; components never
  // register the locale namespace during a render.
  let pluginTranslate = null;
  // The poll interval the host asked for (`/rev.public pollMs`), used until a
  // response arrives.
  let hostPollMs = DEFAULT_POLL_MS;

  /** Translation seat: the locale service when present, plain literals otherwise. */
  function createTranslate(ctx) {
    if (pluginTranslate !== null) return pluginTranslate;
    if (ctx !== null && typeof ctx === 'object') {
      const cached = translateCache.get(ctx);
      if (cached !== undefined) return cached;
      const fresh = buildTranslate(ctx);
      translateCache.set(ctx, fresh);
      return fresh;
    }
    return buildTranslate(ctx);
  }

  function buildTranslate(ctx) {
    let bound = null;
    let active = LITERAL_FALLBACK;
    let unsubscribe = null;
    try {
      ctx.inject(['locale'], (lctx) => {
        const service = lctx.locale;
        if (service === undefined) return;
        try {
          service.register(LOCALE_NS, DICT);
        } catch (error) {
          // A duplicate namespace registration must not take the tab down.
          if (ctx.logger !== undefined) ctx.logger.warn?.(`dsh-excalidraw: locale register failed: ${String(error)}`);
        }
        const snapshot = service.getSnapshot?.();
        if (snapshot?.language !== undefined) active = DICT[snapshot.language] ?? LITERAL_FALLBACK;
        try {
          const stop = service.subscribe?.((snap) => {
            active = DICT[snap?.language] ?? LITERAL_FALLBACK;
          });
          if (typeof stop === 'function') unsubscribe = stop;
        } catch {
          /* subscribe is best-effort */
        }
        bound = service.bind?.(LOCALE_NS) ?? null;
      });
    } catch {
      /* no locale service: literals */
    }
    const translate = (key) => {
      if (typeof bound === 'function') {
        try {
          const text = bound(key);
          if (typeof text === 'string' && text !== key) return text;
        } catch {
          /* fall through to the literal */
        }
      }
      return active[key] ?? LITERAL_FALLBACK[key] ?? key;
    };
    // The locale service keeps the listener until it is released; the plugin's
    // own dispose must release it (one per context, so this is the only one).
    if (typeof unsubscribe === 'function') {
      const dispose = () => {
        try { unsubscribe(); } catch { /* already gone */ }
        translateCache.delete(ctx);
      };
      if (ctx?.effect !== undefined) ctx.effect(() => dispose, 'dsh-excalidraw: locale subscription');
    }
    return translate;
  }

  /* ------------------------------------------------------------------ */
  /* transport                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve one host route against the PAGE's own base, never the origin root:
   * a reverse-proxied subpath and Electron's `dsh-app://app/` both break a
   * leading-slash URL. `ctx.betterSidebar.hostRouteUrl` is the same rule, and is
   * preferred when the service is there.
   */
  function resolveHostUrl(ctx, path) {
    const relative = String(path).replace(/^\/+/, '');
    // `ctx.get` must be used, not `ctx.betterSidebar`: cordis throws on a direct
    // read of a service the plugin did not inject, and this runs during apply
    // (font registration) before `ctx.inject(['betterSidebar'])` has fired.
    // Reading the property first would throw even behind `??`.
    const service = typeof ctx?.get === 'function' ? ctx.get('betterSidebar') : undefined;
    if (service !== undefined && typeof service.hostRouteUrl === 'function') {
      try {
        const resolved = service.hostRouteUrl(relative);
        if (resolved !== undefined && resolved !== null) {
          return resolved instanceof URL ? resolved : new URL(String(resolved), document.baseURI);
        }
      } catch {
        /* fall through to the base rule */
      }
    }
    const base = typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== ''
      ? document.baseURI
      : `${window.location.origin}${window.location.pathname}`;
    return new URL(relative, base);
  }

  function createApi(ctx) {
    const request = async (method, path, { params, body, etag } = {}) => {
      const url = resolveHostUrl(ctx, API_BASE + path);
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      try {
        const response = await fetch(url, {
          method,
          credentials: 'same-origin',
          headers: {
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(etag === undefined ? {} : { 'if-none-match': etag }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        if (response.status === 304) return { notModified: true, etag: response.headers.get('etag') };
        const text = await response.text();
        let payload = null;
        if (text !== '') {
          try {
            payload = JSON.parse(text);
          } catch {
            payload = null;
          }
        }
        if (!response.ok) {
          const code = typeof payload?.error === 'string' && payload.error !== '' ? payload.error : `http-${response.status}`;
          const message = typeof payload?.message === 'string' && payload.message !== '' ? payload.message : response.statusText;
          throw Object.assign(new Error(message), { code, status: response.status });
        }
        return { payload, etag: response.headers.get('etag') };
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw Object.assign(new Error('request timed out'), { code: 'timeout' });
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };
    return {
      rev: (params, etag) => request('GET', '/rev', { params, etag }),
      focus: () => request('GET', '/focus'),
      scenes: (params) => request('GET', '/scenes', { params }),
      scene: (params, etag) => request('GET', '/scene', { params, etag }),
      health: (params) => request('GET', '/health', { params }),
      refresh: (body) => request('POST', '/refresh', { body }),
    };
  }

  /* ------------------------------------------------------------------ */
  /* scene helpers                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * The slug to show when the caller did not name one: the explicit slug wins,
   * then the NEWEST stored scene (the store appends, and the tab follows the
   * last refresh), then the default.
   */
  function pickSceneSlug(items, explicit) {
    if (typeof explicit === 'string' && explicit !== '') return explicit;
    if (!Array.isArray(items) || items.length === 0) return 'architecture';
    let newest = items[items.length - 1];
    for (const entry of items) {
      const a = Number(entry?.updatedAt ?? 0);
      const b = Number(newest?.updatedAt ?? 0);
      if (a > b) newest = entry;
    }
    return typeof newest?.slug === 'string' && newest.slug !== '' ? newest.slug : 'architecture';
  }

  /**
   * Which scene a revision bump should load: a pinned (manually picked) slug
   * stays; otherwise `undefined` asks for the newest stored scene, so an
   * agent-driven refresh of another scene moves the tab with it.
   */
  function followTarget(pinned, currentSlug) {
    return pinned === true ? currentSlug : undefined;
  }

  /** Parse an Excalidraw document from text; null when it is not one. */
  function parseScene(input) {
    if (input === null || input === undefined) return null;
    let doc;
    if (typeof input === 'string') {
      if (input.trim() === '') return null;
      try {
        doc = JSON.parse(input);
      } catch {
        return null;
      }
    } else if (typeof input === 'object') {
      doc = input;
    } else {
      return null;
    }
    const elements = Array.isArray(doc) ? doc : doc?.elements;
    if (!Array.isArray(elements)) return null;
    return { elements, appState: doc?.appState ?? null, files: doc?.files ?? null };
  }

  function formatClock(value) {
    const at = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(at)) return '';
    try {
      return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return new Date(at).toISOString().slice(11, 16);
    }
  }

  /* ------------------------------------------------------------------ */
  /* styles                                                              */
  /* ------------------------------------------------------------------ */

  const STYLE_ID = 'dsh-excalidraw-styles';
  const CSS = `
.dsh-xcal { display:flex; flex-direction:column; height:100%; min-height:0; font-size:12px; color:currentColor; background:transparent; }
/* The native conversation view fills the conversation pane, which may not be a
   flex column with a definite height: give it the frame it expects. */
.dsh-xcal-native { position:relative; min-height:320px; height:100%; }
.dsh-xcal-head { display:flex; align-items:center; gap:8px; padding:8px 10px; border-bottom:1px solid rgba(128,128,128,.22); flex:0 0 auto; }
.dsh-xcal-titles { display:flex; flex-direction:column; min-width:0; flex:1 1 auto; }
.dsh-xcal-title { font-weight:600; font-size:13px; line-height:1.2; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-xcal-sub { font-size:11px; opacity:.62; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-xcal-rev { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10px; opacity:.6; padding:2px 6px; border:1px solid rgba(128,128,128,.28); border-radius:999px; white-space:nowrap; }
.dsh-xcal-btn { appearance:none; border:1px solid rgba(128,128,128,.32); background:transparent; color:inherit; border-radius:6px; font:inherit; font-size:11px; line-height:1; padding:6px 9px; cursor:pointer; white-space:nowrap; }
.dsh-xcal-btn:hover:not(:disabled) { background:rgba(128,128,128,.14); }
.dsh-xcal-btn:disabled { opacity:.45; cursor:default; }
.dsh-xcal-btn-primary { border-color:#3b5bdb; color:#3b5bdb; }
.dsh-xcal-tools { display:flex; align-items:center; gap:6px; padding:6px 10px; border-bottom:1px solid rgba(128,128,128,.14); flex:0 0 auto; }
.dsh-xcal-select { appearance:none; border:1px solid rgba(128,128,128,.32); background:transparent; color:inherit; border-radius:6px; font:inherit; font-size:11px; padding:5px 6px; max-width:170px; }
.dsh-xcal-canvas { position:relative; flex:1 1 auto; min-height:0; overflow:hidden; cursor:grab; touch-action:none; background:transparent; }
.dsh-xcal-canvas.dragging { cursor:grabbing; }
.dsh-xcal-canvas:focus-visible { outline:2px solid #6965db; outline-offset:-2px; }
.dsh-xcal-sel { position:absolute; border:1.5px solid #6965db; border-radius:4px; pointer-events:none; }
.dsh-xcal-marquee { position:absolute; border:1px solid #6965db; background:rgba(105,101,219,.10); border-radius:2px; pointer-events:none; }
.dsh-xcal-hint { position:absolute; left:10px; bottom:10px; font-size:10px; opacity:.58; pointer-events:none; max-width:60%; }
.dsh-xcal-zoom { position:absolute; right:10px; bottom:10px; display:flex; align-items:center; gap:2px; padding:2px; border:1px solid rgba(128,128,128,.28); border-radius:8px; background:rgba(127,127,127,.10); }
.dsh-xcal-zbtn { appearance:none; border:0; background:transparent; color:inherit; font:inherit; font-size:11px; line-height:1; min-width:24px; height:24px; padding:0 6px; border-radius:6px; cursor:pointer; }
.dsh-xcal-zbtn:hover { background:rgba(128,128,128,.16); }
.dsh-xcal-viewport { position:absolute; inset:0; pointer-events:none; }
.dsh-xcal-viewport > div { position:absolute; left:50%; top:50%; transform-origin:center center; will-change:transform; }
.dsh-xcal-viewport svg { display:block; max-width:none; }
.dsh-xcal-note { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center; padding:24px; opacity:.7; font-size:12px; line-height:1.6; pointer-events:none; }
.dsh-xcal-note-error { color:#c92a2a; opacity:.95; }
.dsh-xcal-foot { display:flex; align-items:center; gap:8px; padding:6px 10px; border-top:1px solid rgba(128,128,128,.14); font-size:10px; opacity:.72; flex:0 0 auto; }
.dsh-xcal-dot { width:6px; height:6px; border-radius:50%; background:#40c057; flex:0 0 auto; }
.dsh-xcal-dot.stale { background:#fab005; }
.dsh-xcal-dot.error { background:#fa5252; }
.dsh-xcal-grow { flex:1 1 auto; }
`;

  /** The URL one shipped font is served from (versioned: the route is immutable). */
  function fontUrl(ctx, font) {
    const relative = `excalidraw/fonts/${encodeURIComponent(font.file)}${font.version ? `?v=${font.version}` : ''}`
    return String(resolveHostUrl(ctx, relative))
  }

  /** One `@font-face` rule for a shipped font, or '' when it cannot be resolved. */
  function fontFaceRule(ctx, font) {
    const url = fontUrl(ctx, font)
    if (url === '') return ''
    const range = font.unicodeRange ? `;unicode-range:${font.unicodeRange}` : ''
    return `@font-face{font-family:'${font.family}';src:url("${url}") format("woff2");`
      + `font-weight:${font.weight ?? 400};font-style:${font.style ?? 'normal'};font-display:swap${range}}`
  }


  /** The plugin context, captured for the native slot component (props carry only sessionId). */
  let nativeCtx = null;

  /**
   * The "Excalidraw" conversation view: the same scene, rendered on DSH's own slot
   * surface, so the plugin is useful without better-sidebar. Props are the slot
   * injection (`sessionId`); everything else comes from the captured context.
   */
  /**
   * What DSH's `viewRequest` means for this view: the conversation component
   * receives `{ view, focus }` plus `completeViewRequest`, and a view that
   * ignores its own request leaves the switch pending. Only our own id counts.
   */
  function nativeViewRequestAction(viewRequest) {
    if (viewRequest === null || typeof viewRequest !== 'object') return null;
    if (viewRequest.view !== TAB_TYPE && viewRequest.view !== 'excalidraw') return null;
    return { follow: true };
  }

  /** Apply a view request to the scene state (separated so it is testable). */
  function settleViewRequest(viewRequest, actions) {
    if (nativeViewRequestAction(viewRequest) === null) return false;
    if (typeof actions?.unpin === 'function') actions.unpin();
    if (typeof actions?.completeViewRequest === 'function') actions.completeViewRequest();
    return true;
  }

  function NativeDesignView({ sessionId, viewRequest, completeViewRequest }) {
    const lastViewRequestRef = useRef(null);
    const ctx = nativeCtx;
    const api = useMemo(() => createApi(ctx), [ctx]);
    const t = useMemo(() => createTranslate(ctx), [ctx]);
    const scope = useMemo(() => ({ sessionId }), [sessionId]);
    const tab = useScene(api, scope, true, hostPollMs);
    const rendered = useMemo(() => renderSafely(tab.scene), [tab.scene]);
    const [exportError, setExportError] = useState(null);
    // An agent refresh asks the UI to show the scene it just wrote: follow the
    // newest one and settle the request so DSH's view switch completes.
    useEffect(() => {
      if (viewRequest === lastViewRequestRef.current) return;
      if (viewRequest === null || viewRequest === undefined) return;
      lastViewRequestRef.current = viewRequest;
      settleViewRequest(viewRequest, { unpin: tab.unpin, completeViewRequest });
    }, [viewRequest, tab, completeViewRequest]);
    const failed = tab.error !== null && tab.error !== undefined;
    const subtitle = tab.status === 'ready' && tab.scene !== null
      ? `${tab.slug ?? 'architecture'} · ${tab.scene.elements.length} ${t('elements')}`
      : tab.status === 'empty' ? t('noScene') : tab.status === 'error' ? t('error') : t('loading');
    const doExport = async (kind) => {
      if (rendered === null || rendered.svg === '') return;
      setExportError(null);
      try {
        const artifacts = await exportArtifacts(ctx, tab.scene, rendered);
        if (kind === 'svg') await downloadSvg(tab.slug ?? 'excalidraw-scene', artifacts.svg);
        else await downloadPng(tab.slug ?? 'excalidraw-scene', artifacts.png);
      } catch (error) {
        setExportError(String(error?.message ?? error));
      }
    };
    return h('div', { className: 'dsh-xcal dsh-xcal-native' },
      h('div', { className: 'dsh-xcal-head' },
        h('div', { className: 'dsh-xcal-titles' },
          h('div', { className: 'dsh-xcal-title' }, t('title')),
          h('div', { className: 'dsh-xcal-sub' }, subtitle)),
        h('div', { className: 'dsh-xcal-tools' },
          h('span', { className: 'dsh-xcal-grow' }),
          h('button', {
            type: 'button', className: 'dsh-xcal-btn', title: t('exportSvgTitle'),
            disabled: rendered === null || rendered.svg === '',
            onClick: () => doExport('svg'),
          }, t('exportSvg')),
          h('button', {
            type: 'button', className: 'dsh-xcal-btn',
            disabled: rendered === null || rendered.svg === '',
            onClick: () => doExport('png'),
          }, t('exportPng')))),
      h(SceneCanvas, { rendered, scene: tab.scene, t, error: tab.error, status: tab.status }),
      h('div', { className: 'dsh-xcal-foot' },
        h('span', { className: `dsh-xcal-dot${failed || exportError !== null ? ' error' : ''}` }),
        h('span', { title: tab.error ?? exportError ?? '' }, failed
          ? `${tab.error !== null && tab.error !== undefined ? t('error') : t('exportFailed')}: ${String(tab.error ?? exportError ?? '').slice(0, 80)}`
          : t('readonly'))));
  }

  /**
   * Register the Excalidraw web fonts the plugin ships (CONTRACT §6). The files
   * are served by the host half from the package itself, so no third-party
   * request is made while rendering a scene.
   */
  function injectFontFaces(ctx) {
    if (typeof document === 'undefined' || typeof document.head?.appendChild !== 'function') {
      return () => {}
    }
    // Idempotent: a second apply (hot reload, two mount points) reuses the rules
    // already in the document instead of stacking another <style>.
    const existing = typeof document.head.querySelector === 'function'
      ? document.head.querySelector('[data-dsh-excalidraw="fonts"]')
      : null;
    if (existing !== null) return () => {}
    const rules = FONTS.map((font) => fontFaceRule(ctx, font)).filter((rule) => rule !== '')
    if (rules.length === 0) return () => {}
    const element = document.createElement('style')
    element.setAttribute('data-dsh-excalidraw', 'fonts')
    element.textContent = rules.join('\n')
    document.head.appendChild(element)
    // User-supplied fonts (config.extraFontsDir) arrive asynchronously; a failed
    // fetch must never affect the bundled faces already applied.
    fetchExtraFonts(ctx, element).catch(() => {})
    return () => { element.remove?.() }
  }

  /** Append `@font-face` rules for the fonts the user supplied (Excalifont). */
  async function fetchExtraFonts(ctx, element) {
    // Only a real page has a navigator; a non-browser host (tests, SSR) must not
    // open a network probe for optional fonts.
    if (typeof navigator === 'undefined' || typeof navigator.userAgent !== 'string') return;
    // Optional fonts must never hold the page open: bound the probe and always
    // clear its timer (a lingering timeout keeps a test process alive).
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller === null ? null : setTimeout(() => controller.abort(), 4000)
    let listed
    try {
      listed = await fetch(String(resolveHostUrl(ctx, 'excalidraw/api/fonts')), {
        credentials: 'same-origin',
        ...(controller === null ? {} : { signal: controller.signal }),
      })
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
    if (!listed.ok) return
    const body = await listed.json()
    const extra = Array.isArray(body?.extra) ? body.extra : []
    const rules = extra.map((font) => {
      if (typeof font?.family !== 'string' || typeof font?.url !== 'string') return ''
      const url = String(resolveHostUrl(ctx, font.url.replace(/^\/+/, '')))
      const range = font.unicodeRange ? `;unicode-range:${font.unicodeRange}` : ''
      return `@font-face{font-family:'${font.family}';src:url("${url}") format("woff2");`
        + `font-weight:${font.weight ?? 400};font-style:${font.style ?? 'normal'};font-display:swap${range}}`
    }).filter((rule) => rule !== '')
    if (rules.length === 0) return
    element.textContent = `${element.textContent}\n${rules.join('\n')}`
  }


  function ensureStyles() {
    if (typeof document === 'undefined') return () => {};
    if (document.getElementById(STYLE_ID) !== null) return () => {};
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
    return () => {
      if (style.parentNode !== null) style.parentNode.removeChild(style);
    };
  }

  /* ------------------------------------------------------------------ */
  /* export                                                              */
  /* ------------------------------------------------------------------ */

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /** Save the rendered SVG as a file; the tab keeps no server-side state. */
  /** Which shipped family a scene `fontFamily` key maps to (0 = none shipped). */
  const SHIPPED_FAMILY = Object.freeze({
    // Family 5 falls through to Virgil in the renderer stack (Excalifont is not
    // redistributable), so its exports need Virgil embedded too.
    1: 'Virgil',
    5: 'Virgil',
    7: 'Lilita One',
    8: 'Comic Shanns',
  });
  /** Families 2/3/4/6 render with system fonts: nothing to embed. */
  const SYSTEM_FAMILY_KEYS = new Set([2, 3, 4, 6]);

  /** Base64 of an ArrayBuffer, chunked so a 56 KB font cannot blow the stack. */
  function base64Of(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  }

  /**
   * The `@font-face` rules an export needs, with the font bytes embedded.
   *
   * A downloaded SVG (and the `<img>` the PNG path rasterises) is a separate
   * document: the page's `@font-face` rules do not apply inside it, so the bytes
   * have to travel with the file. Only the families the scene actually uses are
   * embedded.
   */
  // Fetched font bytes, kept for the page's lifetime: a second export must not
  // re-download ~135 KB of woff2.
  const fontBytes = new Map();
  /** The renderer's fallback family key when an element's fontFamily is unusable. */
  const DEFAULT_FAMILY_KEY = 5;

  /** Parse a CSS `unicode-range` list into `[lo, hi]` pairs. */
  function parseUnicodeRange(value) {
    if (typeof value !== 'string' || value === '') return null;
    const ranges = [];
    for (const part of value.split(',')) {
      const match = /^\s*U\+([0-9a-f]+)(?:-([0-9a-f]+))?\s*$/i.exec(part);
      if (match === null) continue;
      const lo = Number.parseInt(match[1], 16);
      const hi = match[2] === undefined ? lo : Number.parseInt(match[2], 16);
      if (Number.isFinite(lo) && Number.isFinite(hi)) ranges.push([lo, hi]);
    }
    return ranges.length === 0 ? null : ranges;
  }

  /** Whether any character of `text` falls inside the given range list. */
  function matchesUnicodeRange(range, text) {
    const ranges = parseUnicodeRange(range);
    if (ranges === null) return true;
    for (const character of text) {
      const code = character.codePointAt(0);
      if (ranges.some(([lo, hi]) => code >= lo && code <= hi)) return true;
    }
    return false;
  }

  /** Every shipped family and character a scene actually draws text with. */
  function fontCharacters(scene) {
    const families = new Set();
    let characters = '';
    const add = (rawKey, text) => {
      const key = Number(rawKey ?? DEFAULT_FAMILY_KEY);
      if (SYSTEM_FAMILY_KEYS.has(key)) return;
      const family = SHIPPED_FAMILY[key] ?? SHIPPED_FAMILY[DEFAULT_FAMILY_KEY];
      if (family === undefined) return;
      families.add(family);
      characters += String(text ?? '');
    };
    for (const element of scene?.elements ?? []) {
      if (element === null || typeof element !== 'object' || element.isDeleted === true) continue;
      if (element.type === 'text') add(element.fontFamily, element.text);
      else if (element.type === 'frame' && typeof element.name === 'string' && element.name !== '') {
        add(DEFAULT_FAMILY_KEY, element.name);
      }
    }
    return { families, characters };
  }

  /** The extra fonts the host lists (cached for the page's lifetime). */
  let extraFontList = null;
  async function extraFontEntries(ctx) {
    if (extraFontList !== null) return extraFontList;
    try {
      const response = await fetch(String(resolveHostUrl(ctx, 'excalidraw/api/fonts')), { credentials: 'same-origin' });
      if (!response.ok) return [];
      const body = await response.json();
      extraFontList = Array.isArray(body?.extra) ? body.extra : [];
    } catch {
      return [];
    }
    return extraFontList;
  }

  /** Every family name in the renderer stack of a used font key. */
  function stackNamesOf(scene) {
    const names = new Set();
    for (const element of scene?.elements ?? []) {
      if (element === null || typeof element !== 'object' || element.isDeleted === true) continue;
      let key;
      if (element.type === 'text') key = element.fontFamily ?? DEFAULT_FAMILY_KEY;
      else if (element.type === 'frame' && typeof element.name === 'string' && element.name !== '') key = DEFAULT_FAMILY_KEY;
      else continue;
      const stack = typeof fontStackOf === 'function' ? fontStackOf(key) : '';
      for (const name of String(stack).split(',')) {
        const clean = name.trim().replace(/^['"]|['"]$/g, '');
        if (clean !== '') names.add(clean);
      }
    }
    return names;
  }

  /** Embed a user-supplied font's bytes for an export (round 17). */
  async function embedExtraFonts(ctx, scene, embedded, rules) {
    const names = stackNamesOf(scene);
    if (names.size === 0) return;
    const entries = await extraFontEntries(ctx);
    for (const entry of entries) {
      if (typeof entry?.family !== 'string' || typeof entry?.url !== 'string') continue;
      if (!names.has(entry.family) || embedded.has(entry.family)) continue;
      try {
        const response = await fetch(String(resolveHostUrl(ctx, entry.url.replace(/^\/+/, ''))), { credentials: 'same-origin' });
        if (!response.ok) continue;
        const data = base64Of(await response.arrayBuffer());
        const range = entry.unicodeRange ? `;unicode-range:${entry.unicodeRange}` : '';
        rules.push(`@font-face{font-family:'${entry.family}';src:url(data:font/woff2;base64,${data}) format("woff2");`
          + `font-weight:${entry.weight ?? 400};font-style:${entry.style ?? 'normal'}${range}}`);
        embedded.add(entry.family);
      } catch {
        /* a missing user font never blocks the export */
      }
    }
  }

  /** The embedded font rules for a scene, plus the families they cover. */
  async function exportFonts(ctx, scene) {
    const { families: used, characters } = fontCharacters(scene);
    if (used.size === 0) return { css: '', families: [] };
    const embedded = new Set();
    const rules = [];
    for (const font of FONTS) {
      if (!used.has(font.family)) continue;
      // Skip subsets whose unicode range shares no character with the scene.
      if (font.unicodeRange && !matchesUnicodeRange(font.unicodeRange, characters)) continue;
      try {
        let data = fontBytes.get(font.file);
        if (data === undefined) {
          const response = await fetch(fontUrl(ctx, font));
          if (!response.ok) continue;
          data = base64Of(await response.arrayBuffer());
          fontBytes.set(font.file, data);
        }
        const range = font.unicodeRange ? `;unicode-range:${font.unicodeRange}` : '';
        rules.push(`@font-face{font-family:'${font.family}';src:url(data:font/woff2;base64,${data}) format("woff2");`
          + `font-weight:${font.weight ?? 400};font-style:${font.style ?? 'normal'}${range}}`);
        embedded.add(font.family);
      } catch {
        /* one missing font must not block the export */
      }
    }
    await embedExtraFonts(ctx, scene, embedded, rules);
    return { css: rules.join('\n'), families: [...embedded] };
  }

  /** Backwards-compatible convenience: just the CSS for a scene's fonts. */
  async function embeddedFontCss(ctx, scene) {
    return (await exportFonts(ctx, scene)).css;
  }

  /** Human-readable provenance/licence notice for the embedded families. */
  function fontNotice(families) {
    const names = Array.isArray(families) ? families : [];
    if (names.length === 0) return '';
    const licences = names.map((family) => {
      if (family === 'Comic Shanns') return 'Comic Shanns (MIT, Copyright (c) 2018 Shannon Miwa and contributors)';
      if (family === 'Virgil') return 'Virgil (SIL OFL 1.1)';
      if (family === 'Lilita One') return 'Lilita One (SIL OFL 1.1, Copyright (c) 2011 Juan Montoreano)';
      return family;
    });
    return `Rendered by dsh-excalidraw. Embedded fonts: ${licences.join('; ')}. `
      + 'Licence texts ship with the plugin (fonts/ directory).';
  }

  /** The index of the `>` that closes the root `<svg …>` tag, or -1. */
  function rootTagEnd(svg) {
    if (typeof svg !== 'string') return -1;
    const start = svg.indexOf('<svg');
    if (start < 0) return -1;
    let quote = null;
    for (let index = start + 4; index < svg.length; index += 1) {
      const character = svg[index];
      if (quote !== null) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === '>') return index;
    }
    return -1;
  }

  /** Insert markup right inside the root `<svg>` element (no prolog, no self-closing root). */
  function injectIntoRoot(svg, inner) {
    const end = rootTagEnd(svg);
    if (end < 0 || svg[end - 1] === '/') return svg;
    return svg.slice(0, end + 1) + inner + svg.slice(end + 1);
  }

  /** Insert a `<metadata>` notice right inside the root, after the styles. */
  function withMetadata(svg, notice) {
    if (typeof notice !== 'string' || notice === '') return svg;
    const escaped = notice.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return injectIntoRoot(svg, `<metadata>${escaped}</metadata>`);
  }

  /** Insert a `<style>` with the given rules right inside the `<svg>` element. */
  function withStyle(svg, css) {
    if (typeof css !== 'string' || css === '') return svg;
    const safe = css.replace(/\]\]>/g, ']]]]><![CDATA[>');
    return injectIntoRoot(svg, `<style type="text/css"><![CDATA[${safe}]]></style>`);
  }

  /** Provenance + licence notice carried by every self-contained export. */
  const EXPORT_NOTICE = 'Rendered by dsh-excalidraw. Embedded fonts: Comic Shanns (MIT), '
    + 'Virgil and Lilita One (SIL OFL 1.1); see the plugin\'s fonts/README.md.';

  /** The self-contained SVG an export writes (fonts embedded + notice). */
  async function exportSvg(ctx, scene, svg) {
    const { css, families } = await exportFonts(ctx, scene);
    const styled = withStyle(svg, css);
    return withMetadata(styled, fontNotice(families));
  }

  /** The input `downloadPng` rasterises: the SAME self-contained SVG. */
  function pngInput(rendered, selfContained) {
    return { ...rendered, svg: selfContained };
  }

  /**
   * Everything an export of this scene needs: the self-contained SVG and the
   * rasteriser input. One helper, so the PNG path cannot silently keep using the
   * bare SVG.
   */
  async function exportArtifacts(ctx, scene, rendered) {
    const svg = await exportSvg(ctx, scene, rendered.svg);
    return { svg, png: pngInput(rendered, svg) };
  }

  async function downloadSvg(filename, svg) {
    downloadBlob(`${filename}.svg`, new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  }

  /**
   * Rasterise the SVG through an <img> and one canvas — no rasteriser ships
   * with the plugin, and this stays inside the browser's own codecs.
   */
  async function downloadPng(filename, rendered) {
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rendered.svg)}`;
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('the SVG could not be rasterised'));
      image.src = svgUrl;
    });
    const longest = Math.max(rendered.width, 1, rendered.height);
    // Never let the lower clamp break the cap: a 200 000-unit scene must still
    // come out at most MAX_PNG_DIMENSION pixels on its long side.
    const scale = Math.min(2, Math.max(MIN_PNG_SCALE, MAX_PNG_DIMENSION / longest));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(rendered.width * scale));
    canvas.height = Math.max(1, Math.round(rendered.height * scale));
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('no 2d context');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => (value === null ? reject(new Error('the PNG could not be encoded')) : resolve(value)), 'image/png');
    });
    downloadBlob(`${filename}.png`, blob);
  }

  /* ------------------------------------------------------------------ */
  /* canvas                                                              */
  /* ------------------------------------------------------------------ */

  /** Render one scene, turning a renderer crash into an error state. */
  function renderSafely(scene) {
    if (scene === null || scene === undefined) return null;
    try {
      return renderScene(scene.elements, { padding: 24, background: true, files: scene.files });
    } catch (error) {
      return { svg: '', width: 0, height: 0, error: String(error?.message ?? error) };
    }
  }

  /**
   * Render one scene into a pan/zoom surface.
   * `svg` is produced by the pure renderer; this component only positions it.
   */
  /* ------------------------------------------------------------------ */
  /* viewport: pan, zoom, preview and selection (no editing)             */
  /* ------------------------------------------------------------------ */

  const FIT_MARGIN = 0.94;
  const USER_MIN_SCALE = 0.02;
  const USER_MAX_SCALE = 16;
  const ZOOM_STEP = 1.12;
  const PAN_STEP = 40;
  const DRAG_THRESHOLD = 3;
  const HIT_SLOP = 6;

  /** One zoom factor from a wheel delta (honours line/page delta modes). */
  function wheelZoomFactor(deltaY, deltaMode = 0) {
    const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1;
    const amount = Math.max(-50, Math.min(50, (Number(deltaY) || 0) / unit));
    return Math.pow(ZOOM_STEP, -amount / 50 * 2.5);
  }

  /**
   * What a wheel/trackpad gesture means, the way Excalidraw reads it:
   * ctrl/meta (a pinch also reports ctrl) zooms, shift scrolls horizontally,
   * everything else scrolls the canvas.
   */
  function wheelIntent(event) {
    if (event?.ctrlKey === true || event?.metaKey === true) return 'zoom';
    if (event?.shiftKey === true) return 'pan-x';
    return 'pan';
  }

  /** Zoom around one host-relative point, keeping the scene point under it. */
  function zoomAt(view, point, factor, limits = {}) {
    const min = limits.min ?? USER_MIN_SCALE;
    const max = limits.max ?? USER_MAX_SCALE;
    const scale = Math.min(max, Math.max(min, view.scale * factor));
    const applied = scale / view.scale;
    return {
      scale,
      x: point.x - (point.x - view.x) * applied,
      y: point.y - (point.y - view.y) * applied,
    };
  }

  function panBy(view, dx, dy) {
    return { scale: view.scale, x: view.x + dx, y: view.y + dy };
  }

  /** Host-relative screen point -> scene coordinates (the box is centred). */
  function screenToScene(view, rendered, point) {
    return {
      x: (point.x - view.x) / view.scale + rendered.width / 2,
      y: (point.y - view.y) / view.scale + rendered.height / 2,
    };
  }

  /** Scene coordinates -> host-relative screen point. */
  function sceneToScreen(view, rendered, point) {
    return {
      x: (point.x - rendered.width / 2) * view.scale + view.x,
      y: (point.y - rendered.height / 2) * view.scale + view.y,
    };
  }

  /** Union of the selected geometries' (rotated) scene bounds, or null. */
  function selectionBounds(geometries, ids) {
    if (!Array.isArray(geometries) || !Array.isArray(ids) || ids.length === 0) return null;
    const wanted = new Set(ids);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let any = false;
    for (const geometry of geometries) {
      if (!wanted.has(geometry.id)) continue;
      const box = geometry.box;
      const angle = geometry.angle ?? 0;
      const cos = Math.abs(Math.cos(angle));
      const sin = Math.abs(Math.sin(angle));
      const halfW = (box.width * cos + box.height * sin) / 2;
      const halfH = (box.width * sin + box.height * cos) / 2;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      any = true;
      minX = Math.min(minX, cx - halfW);
      minY = Math.min(minY, cy - halfH);
      maxX = Math.max(maxX, cx + halfW);
      maxY = Math.max(maxY, cy + halfH);
    }
    return any ? { minX, minY, maxX, maxY } : null;
  }

  /** The selection rectangle in scene coordinates, normalised. */
  function marqueeRect(sceneA, sceneB) {
    return {
      minX: Math.min(sceneA.x, sceneB.x),
      minY: Math.min(sceneA.y, sceneB.y),
      maxX: Math.max(sceneA.x, sceneB.x),
      maxY: Math.max(sceneA.y, sceneB.y),
    };
  }

  /** Scene bounds -> the on-screen box (kept axis-aligned, rotated in CSS). */
  function geometryScreenBox(view, rendered, geometry) {
    const box = geometry.box;
    const angle = geometry.angle ?? 0;
    const width = Math.abs(box.width) * view.scale;
    const height = Math.abs(box.height) * view.scale;
    const centre = sceneToScreen(view, rendered, {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    });
    return {
      left: centre.x - width / 2,
      top: centre.y - height / 2,
      width,
      height,
      rotate: angle,
    };
  }

  function fitScaleFor(rendered, width, height) {
    if (rendered === null || rendered.width <= 0 || rendered.height <= 0) return 1;
    if (width < 8 || height < 8) return 1;
    const raw = Math.min(width / rendered.width, height / rendered.height) * FIT_MARGIN;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, raw));
  }

  /**
   * Render one scene on a pan/zoom surface.
   *
   * This is a *viewer*: drag pans, ctrl/meta + wheel (or a pinch) zooms at the
   * cursor, shift-drag marquees, click selects, double-click fits. Nothing here
   * mutates the scene — selection never leaves the plugin.
   */
  function SceneCanvas({ rendered, scene, t, error, status = 'ready', onDoubleClick }) {
    const hostRef = useRef(null);
    const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
    const [hostSize, setHostSize] = useState({ w: 0, h: 0 });
    const [dragging, setDragging] = useState(false);
    const [selection, setSelection] = useState([]);
    const [marquee, setMarquee] = useState(null);
    const dragRef = useRef(null);
    const pointersRef = useRef(new Map());
    const pinchRef = useRef(null);
    const sizeRef = useRef({ w: 0, h: 0, fitScale: 1 });
    const viewRef = useRef(view);
    const fitRef = useRef(null);
    const renderedRef = useRef(rendered);
    const failed = (error !== undefined && error !== null) || status === 'error';
    viewRef.current = view;
    renderedRef.current = rendered;

    const geometries = useMemo(() => {
      if (scene === null || scene === undefined) return [];
      try {
        return elementGeometries(scene.elements);
      } catch {
        return [];
      }
    }, [scene]);
    const geometriesRef = useRef(geometries);
    geometriesRef.current = geometries;
    const selectionRef = useRef(selection);
    selectionRef.current = selection;

    // A new scene invalidates the old selection indexes.
    const sceneKey = rendered === null ? 'none' : `${rendered.width}:${rendered.height}:${rendered.svg.length}`;
    useEffect(() => {
      setSelection([]);
      setMarquee(null);
    }, [sceneKey]);

    const fit = useCallback(() => {
      const host = hostRef.current;
      if (host === null) return;
      const box = host.getBoundingClientRect();
      if (box.width < 8 || box.height < 8) return;
      const scale = fitScaleFor(renderedRef.current, box.width, box.height);
      sizeRef.current = { w: box.width, h: box.height, fitScale: scale };
      setHostSize({ w: box.width, h: box.height });
      setView({ scale, x: 0, y: 0 });
    }, []);

    useEffect(() => {
      fit();
    }, [fit, rendered]);

    fitRef.current = fit;
    const mounted = rendered !== null;

    // The surface is resizable (sidebar drag, window resize): re-fit only while
    // the reader has not shaped the view by hand.
    useEffect(() => {
      const host = hostRef.current;
      if (host === null || typeof ResizeObserver === 'undefined') return undefined;
      let pending = null;
      const observer = new ResizeObserver(() => {
        if (pending !== null) clearTimeout(pending);
        pending = setTimeout(() => {
          pending = null;
          const box = host.getBoundingClientRect();
          sizeRef.current = { w: box.width, h: box.height, fitScale: sizeRef.current.fitScale };
          setHostSize({ w: box.width, h: box.height });
          const rest = viewRef.current;
          const fitted = rest.x === 0 && rest.y === 0
            && Math.abs(rest.scale - sizeRef.current.fitScale) < 1e-6;
          if (fitted) fitRef.current?.();
        }, 60);
      });
      observer.observe(host);
      return () => {
        if (pending !== null) clearTimeout(pending);
        observer.disconnect();
      };
    }, [mounted]);

    // Wheel / trackpad: pan is the default, ctrl/meta (pinch) zooms at the cursor.
    useEffect(() => {
      const host = hostRef.current;
      if (host === null) return undefined;
      const onWheel = (event) => {
        if (renderedRef.current === null) return;
        event.preventDefault();
        const rect = host.getBoundingClientRect();
        const point = {
          x: event.clientX - (rect.left + rect.width / 2),
          y: event.clientY - (rect.top + rect.height / 2),
        };
        const intent = wheelIntent(event);
        if (intent === 'zoom') {
          const factor = wheelZoomFactor(event.deltaY, event.deltaMode);
          setView((current) => zoomAt(current, point, factor));
          return;
        }
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
        const dx = intent === 'pan-x' ? -(event.deltaY || event.deltaX) * unit : -(event.deltaX || 0) * unit;
        const dy = intent === 'pan-x' ? 0 : -(event.deltaY || 0) * unit;
        setView((current) => panBy(current, dx, dy));
      };
      host.addEventListener('wheel', onWheel, { passive: false });
      return () => host.removeEventListener('wheel', onWheel);
    }, [mounted]);

    /** Host-relative point of a pointer/mouse event. */
    const pointOf = useCallback((event) => {
      const host = hostRef.current;
      if (host === null) return { x: 0, y: 0 };
      const rect = host.getBoundingClientRect();
      return { x: event.clientX - (rect.left + rect.width / 2), y: event.clientY - (rect.top + rect.height / 2) };
    }, []);

    const selectAt = useCallback((scenePoint, additive) => {
      const hit = hitTestGeometry(geometriesRef.current, scenePoint, HIT_SLOP);
      const ids = selectionRef.current;
      if (hit === null) {
        if (!additive) setSelection([]);
        return;
      }
      const key = hit.id;
      if (!additive) {
        setSelection([key]);
        return;
      }
      setSelection(ids.includes(key) ? ids.filter((id) => id !== key) : [...ids, key]);
    }, []);

    const onPointerDown = useCallback((event) => {
      if (renderedRef.current === null) return;
      // Buttons inside the canvas (zoom controls) keep their own behaviour.
      if (event.target !== event.currentTarget && event.target?.dataset?.noPan === 'true') return;
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointersRef.current.size === 2) {
        const [a, b] = [...pointersRef.current.values()];
        pinchRef.current = {
          distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          view,
        };
        dragRef.current = null;
        setDragging(false);
        return;
      }
      if (event.button !== 0 && event.button !== 1) return;
      if (event.button === 1) event.preventDefault();
      // Keyboard shortcuts apply to the canvas the reader just touched.
      event.currentTarget.focus?.({ preventScroll: true });
      const marqueeMode = event.button === 0 && event.shiftKey === true;
      dragRef.current = {
        mode: marqueeMode ? 'marquee' : 'pan',
        button: event.button,
        startClient: { x: event.clientX, y: event.clientY },
        startView: view,
        startPoint: pointOf(event),
        moved: false,
      };
      if (!marqueeMode) setDragging(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }, [pointOf, view]);

    const onPointerMove = useCallback((event) => {
      const pointers = pointersRef.current;
      if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      // Two fingers: pinch zoom + pan, anchored at the midpoint.
      const pinch = pinchRef.current;
      if (pinch !== null && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const host = hostRef.current;
        if (host === null) return;
        const rect = host.getBoundingClientRect();
        const anchor = { x: mid.x - (rect.left + rect.width / 2), y: mid.y - (rect.top + rect.height / 2) };
        const previous = { x: pinch.mid.x - (rect.left + rect.width / 2), y: pinch.mid.y - (rect.top + rect.height / 2) };
        const zoomed = zoomAt(pinch.view, previous, distance / pinch.distance);
        setView(panBy(zoomed, anchor.x - previous.x, anchor.y - previous.y));
        return;
      }
      const drag = dragRef.current;
      if (drag === null) return;
      const dx = event.clientX - drag.startClient.x;
      const dy = event.clientY - drag.startClient.y;
      if (!drag.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD) drag.moved = true;
      if (!drag.moved) return;
      if (drag.mode === 'pan') {
        setView(panBy(drag.startView, dx, dy));
      } else {
        setMarquee({ a: drag.startPoint, b: pointOf(event) });
      }
    }, [pointOf]);

    const endPointer = useCallback((event) => {
      pointersRef.current.delete(event.pointerId);
      if (pointersRef.current.size < 2) pinchRef.current = null;
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      setDragging(false);
      if (!drag.moved && drag.button === 0) {
        selectAt(screenToScene(drag.startView, renderedRef.current, drag.startPoint), event.shiftKey === true);
        setMarquee(null);
        return;
      }
      if (drag.mode === 'marquee' && drag.moved) {
        const current = screenToScene(viewRef.current, renderedRef.current, pointOf(event));
        const rect = marqueeRect(drag.startPoint, current);
        const picked = elementsInRect(geometriesRef.current, rect);
        setSelection((ids) => {
          const merged = new Set(event.shiftKey === true ? ids : []);
          for (const geometry of picked) merged.add(geometry.id);
          return [...merged];
        });
      }
      setMarquee(null);
    }, [pointOf, selectAt]);

    const handleDoubleClick = useCallback((event) => {
      const point = screenToScene(viewRef.current, renderedRef.current, pointOf(event));
      const hit = hitTestGeometry(geometriesRef.current, point, HIT_SLOP);
      if (hit === null) {
        fit();
        onDoubleClick?.();
        return;
      }
      // Double-click an element: frame it (read-only "zoom to element").
      const host = hostRef.current;
      if (host === null) return;
      const rect = host.getBoundingClientRect();
      const geometry = geometriesRef.current.find((candidate) => candidate.id === hit.id);
      if (geometry === undefined) return;
      const width = Math.max(Math.abs(geometry.box.width), 24);
      const height = Math.max(Math.abs(geometry.box.height), 24);
      const scale = Math.min(USER_MAX_SCALE, Math.max(USER_MIN_SCALE,
        Math.min(rect.width / width, rect.height / height) * 0.8));
      const centre = sceneToScreen({ scale, x: 0, y: 0 }, renderedRef.current, {
        x: geometry.box.x + geometry.box.width / 2,
        y: geometry.box.y + geometry.box.height / 2,
      });
      setView({ scale, x: -centre.x, y: -centre.y });
      setSelection([hit.id]);
    }, [fit, onDoubleClick, pointOf]);

    /** Frame the current selection (Shift+2), like Excalidraw/Figma. */
    const zoomToSelection = useCallback(() => {
      const host = hostRef.current;
      const bounds = selectionBounds(geometriesRef.current, selectionRef.current);
      if (host === null || bounds === null) return;
      const rect = host.getBoundingClientRect();
      const width = Math.max(bounds.maxX - bounds.minX, 24);
      const height = Math.max(bounds.maxY - bounds.minY, 24);
      const scale = Math.min(USER_MAX_SCALE, Math.max(USER_MIN_SCALE,
        Math.min(rect.width / width, rect.height / height) * 0.8));
      const centre = sceneToScreen({ scale, x: 0, y: 0 }, renderedRef.current, {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2,
      });
      setView({ scale, x: -centre.x, y: -centre.y });
    }, []);

    const onKeyDown = useCallback((event) => {
      const key = event.key;
      const host = hostRef.current;
      if (host === null) return;
      const rect = host.getBoundingClientRect();
      const centre = { x: 0, y: 0 };
      if ((event.ctrlKey || event.metaKey) && (key === 'a' || key === 'A')) {
        event.preventDefault();
        setSelection(geometriesRef.current.map((geometry) => geometry.id));
        return;
      }
      if (key === 'Escape') {
        setSelection([]);
        setMarquee(null);
        return;
      }
      if (key === '+' || key === '=') {
        event.preventDefault();
        setView((current) => zoomAt(current, centre, ZOOM_STEP));
        return;
      }
      if (key === '-' || key === '_') {
        event.preventDefault();
        setView((current) => zoomAt(current, centre, 1 / ZOOM_STEP));
        return;
      }
      if (key === '0') {
        event.preventDefault();
        setView((current) => zoomAt(current, centre, 1 / current.scale));
        return;
      }
      if ((key === '1' && event.shiftKey) || key === 'Home') {
        event.preventDefault();
        fit();
        return;
      }
      if (key === '2' && event.shiftKey) {
        event.preventDefault();
        zoomToSelection();
        return;
      }
      const step = key === 'ArrowLeft' ? [-PAN_STEP, 0] : key === 'ArrowRight' ? [PAN_STEP, 0]
        : key === 'ArrowUp' ? [0, -PAN_STEP] : key === 'ArrowDown' ? [0, PAN_STEP] : null;
      if (step !== null) {
        event.preventDefault();
        setView((current) => panBy(current, step[0], step[1]));
      }
    }, [fit, zoomToSelection]);

    const zoomTo = useCallback((factor) => setView((current) => zoomAt(current, { x: 0, y: 0 }, factor)), []);
    const zoomTo100 = useCallback(() => setView((current) => zoomAt(current, { x: 0, y: 0 }, 1 / current.scale)), []);

    const selectionBoxes = useMemo(() => {
      if (selection.length === 0) return [];
      const wanted = new Set(selection);
      const screenView = view;
      return geometries
        .filter((geometry) => wanted.has(geometry.id))
        .map((geometry) => ({ id: geometry.id, box: geometryScreenBox(screenView, rendered, geometry) }));
    }, [geometries, rendered, selection, view]);

    const marqueeBox = marquee === null ? null : (() => {
      const a = sceneToScreen(view, rendered, marquee.a);
      const b = sceneToScreen(view, rendered, marquee.b);
      return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
    })();

    if (rendered === null) {
      const note = () => {
        if (error !== undefined && error !== null) return `${t('error')} — ${error}`;
        if (status === 'loading') return t('loading');
        if (status === 'error') return t('error');
        return `${t('empty')} ${t('emptyHint')}`;
      };
      return h('div', { className: 'dsh-xcal-canvas' },
        h('div', { className: `dsh-xcal-note${failed ? ' dsh-xcal-note-error' : ''}` }, note()));
    }
    if (rendered.svg === '') {
      return h('div', { className: 'dsh-xcal-canvas' },
        h('div', { className: 'dsh-xcal-note dsh-xcal-note-error' }, rendered.error ?? t('empty')));
    }

    const zoomLabel = `${Math.round(view.scale * 100)}%`;
    return h('div', {
      className: `dsh-xcal-canvas${dragging ? ' dragging' : ''}`,
      ref: hostRef,
      tabIndex: 0,
      role: 'application',
      'aria-label': t('canvasHint'),
      onPointerDown,
      onPointerMove,
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
      onDoubleClick: handleDoubleClick,
      onKeyDown,
    },
    h('div', { className: 'dsh-xcal-viewport' },
      h('div', {
        style: {
          width: rendered.width,
          height: rendered.height,
          marginLeft: -rendered.width / 2,
          marginTop: -rendered.height / 2,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
        },
        dangerouslySetInnerHTML: { __html: rendered.svg },
      }),),
    ...selectionBoxes.map((entry) => h('div', {
      key: `sel-${entry.id}`,
      className: 'dsh-xcal-sel',
      style: {
        left: entry.box.left,
        top: entry.box.top,
        width: entry.box.width,
        height: entry.box.height,
        transform: entry.box.rotate === 0 ? undefined : `rotate(${entry.box.rotate}rad)`,
      },
    })),
    marqueeBox === null ? null : h('div', {
      className: 'dsh-xcal-marquee',
      style: { left: marqueeBox.left, top: marqueeBox.top, width: marqueeBox.width, height: marqueeBox.height },
    }),
    h('div', { className: 'dsh-xcal-hint' },
      selection.length > 0 ? `${selection.length} ${t('selected')}` : t('canvasHint')),
    h('div', { className: 'dsh-xcal-zoom' },
      h('button', { type: 'button', className: 'dsh-xcal-zbtn', title: t('zoomOut'), 'aria-label': t('zoomOut'), 'data-no-pan': 'true', onMouseDown: (e) => e.stopPropagation(), onPointerDown: (e) => e.stopPropagation(), onClick: () => zoomTo(1 / ZOOM_STEP) }, '−'),
      h('button', { type: 'button', className: 'dsh-xcal-zbtn', title: t('resetZoom'), 'data-no-pan': 'true', onMouseDown: (e) => e.stopPropagation(), onPointerDown: (e) => e.stopPropagation(), onClick: zoomTo100 }, zoomLabel),
      h('button', { type: 'button', className: 'dsh-xcal-zbtn', title: t('zoomIn'), 'aria-label': t('zoomIn'), 'data-no-pan': 'true', onMouseDown: (e) => e.stopPropagation(), onPointerDown: (e) => e.stopPropagation(), onClick: () => zoomTo(ZOOM_STEP) }, '+'),
      h('button', { type: 'button', className: 'dsh-xcal-zbtn', title: t('fitToScreen'), 'aria-label': t('fitToScreen'), 'data-no-pan': 'true', onMouseDown: (e) => e.stopPropagation(), onPointerDown: (e) => e.stopPropagation(), onClick: fit }, '⤢')));
  }

  /* data hook                                                           */
  /* ------------------------------------------------------------------ */

  function useScene(api, scope, visible, intervalMs) {
    const [state, setState] = useState({
      status: 'idle', scene: null, slug: undefined, items: [], revision: undefined,
      updatedAt: undefined, error: null, refreshing: false, etag: undefined, at: null,
    });
    const etagRef = useRef(undefined);
    const revEtagRef = useRef(undefined);
    // Each load takes a ticket; only the newest one may apply its result. A
    // late poll answer must not overwrite a scene the reader just picked.
    const seqRef = useRef(0);
    // The ETag belongs to one workspace: reusing it after a session switch can
    // 304 a DIFFERENT scene into this tab.
    const etagSessionRef = useRef(undefined);
    const aliveRef = useRef(true);
    // True once the reader picked a scene themselves: a later agent refresh must
    // not yank them elsewhere. Cleared by a session switch or by following.
    const pinnedRef = useRef(false);
    const stateRef = useRef(state);
    useEffect(() => { stateRef.current = state; }, [state]);

    useEffect(() => {
      aliveRef.current = true;
      return () => { aliveRef.current = false; };
    }, []);

    const sessionId = scope?.sessionId;

    const load = useCallback(async (slug, { silent = false } = {}) => {
      if (sessionId === undefined) {
        setState((current) => ({ ...current, status: 'error', error: 'no-session' }));
        return;
      }
      if (etagSessionRef.current !== sessionId) {
        etagSessionRef.current = sessionId;
        pinnedRef.current = false;
        etagRef.current = undefined;
        setState((current) => ({ ...current, scene: null, slug: undefined, items: [], revision: undefined, updatedAt: undefined, error: null }));
      }
      if (!silent) setState((current) => ({ ...current, status: current.scene === null ? 'loading' : current.status }));
      const seq = seqRef.current + 1;
      seqRef.current = seq;
      const current_ = () => seq === seqRef.current && aliveRef.current;
      try {
        const listed = await api.scenes({ sessionId });
        const items = listed.payload?.items ?? [];
        const wanted = pickSceneSlug(items, slug);
        if (!current_()) return;
        const loaded = await api.scene({ sessionId, slug: wanted }, etagRef.current);
        if (!current_()) return;
        if (loaded.notModified === true) {
          setState((current) => ({ ...current, status: 'ready', error: null, at: new Date() }));
          return;
        }
        const scene = parseScene(loaded.payload?.scene ?? loaded.payload);
        if (scene === null) throw Object.assign(new Error('scene document is not an Excalidraw scene'), { code: 'bad-scene' });
        etagRef.current = loaded.etag;
        const meta = items.find((entry) => entry.slug === wanted);
        if (meta === undefined) pinnedRef.current = false;
        if (!current_()) return;
        setState((current) => ({
          ...current,
          status: 'ready',
          scene,
          slug: wanted,
          items,
          revision: Number(listed.payload?.revision ?? current.revision ?? 0),
          updatedAt: meta?.updatedAt,
          sceneId: meta?.sceneId,
          error: null,
          at: new Date(),
        }));
      } catch (error) {
        if (!aliveRef.current) return;
        if (error?.code === 'no-scene' || error?.status === 400 && /no-scene/.test(String(error?.code ?? ''))) {
          // The pinned scene is gone: unpin BEFORE any await/return so the tab
          // follows whatever exists next instead of wedging on a dead slug.
          pinnedRef.current = false;
          etagRef.current = undefined;
          setState((current) => ({ ...current, status: 'empty', scene: null, slug: undefined, items: [], error: null }));
          return;
        }
        // Keep the last good scene, but say so: a failure must be visible.
        setState((current) => ({ ...current, status: current.scene === null ? 'error' : 'ready', error: error?.message ?? String(error) }));
      }
    }, [api, sessionId]);

    useEffect(() => {
      if (sessionId === undefined) return undefined;
      load(undefined);
      return undefined;
    }, [load, sessionId]);

    useEffect(() => {
      if (sessionId === undefined || visible !== true) return undefined;
      let cancelled = false;
      let inFlight = false;
      const period = Math.min(POLL_CEIL, Math.max(POLL_FLOOR, Number(intervalMs) || 1500));
      const timer = setInterval(async () => {
        // A slow request must not stack new polls behind it.
        if (cancelled || inFlight || (typeof document !== 'undefined' && document.visibilityState !== 'visible')) return;
        inFlight = true;
        try {
          const rev = await api.rev({ sessionId }, revEtagRef.current);
          if (cancelled) return;
          const asked = Number(rev.payload?.pollMs);
          if (Number.isFinite(asked) && asked >= POLL_FLOOR && asked <= POLL_CEIL && asked !== hostPollMs) {
            hostPollMs = asked;
            setState((current) => ({ ...current }));
          }
          if (rev.notModified === true) return;
          revEtagRef.current = rev.etag;
          const next = Number(rev.payload?.revision ?? 0);
          const current = stateRef.current;
          if (current.revision !== undefined && next === Number(current.revision)) {
            // An unchanged revision is not enough if the last scene load failed:
            // retry it, or the view stays on a stale picture forever.
            if (current.error !== null && current.error !== undefined) await load(followTarget(pinnedRef.current, current.slug), { silent: true });
            return;
          }
          etagRef.current = undefined;
          // Not pinned: follow the scene that was just refreshed instead of
          // re-fetching whichever one this tab happened to show.
          await load(followTarget(pinnedRef.current, current.slug), { silent: true });
        } catch (error) {
          // A failed poll keeps the last good scene but says so, and it keeps
          // retrying the scene load instead of consuming the revision silently.
          if (!aliveRef.current) return;
          setState((current) => ({ ...current, error: error?.message ?? String(error) }));
        } finally {
          inFlight = false;
        }
      }, period);
      return () => { cancelled = true; clearInterval(timer); };
    }, [api, sessionId, visible, intervalMs, load]);

    const refresh = useCallback(async (slug) => {
      setState((current) => ({ ...current, refreshing: true, error: null }));
      try {
        // Only the slug: the host resolves the scene id this slug currently
        // holds, so a stale id in this tab can never overwrite a newer scene.
        const result = await api.refresh({ sessionId, slug });
        const payload = result.payload ?? {};
        if (payload.ok === false) throw Object.assign(new Error(payload.message ?? 'refresh failed'), { code: payload.error });
        etagRef.current = undefined;
        await load(payload.slug ?? slug, { silent: true });
      } catch (error) {
        if (aliveRef.current) setState((current) => ({ ...current, error: error?.message ?? String(error) }));
      } finally {
        if (aliveRef.current) setState((current) => ({ ...current, refreshing: false }));
      }
    }, [api, sessionId, load]);

    const pick = useCallback((slug) => {
      pinnedRef.current = true;
      return load(slug);
    }, [load]);

    /** Drop the pin and follow the newest scene again. */
    const unpin = useCallback(() => {
      pinnedRef.current = false;
      return load(undefined);
    }, [load]);

    return { ...state, refresh, load, pick, unpin };
  }

  /* ------------------------------------------------------------------ */
  /* the tab                                                             */
  /* ------------------------------------------------------------------ */

  function DesignTab({ ctx, store, scope, visible }) {
    const api = useMemo(() => createApi(ctx), [ctx]);
    const t = useMemo(() => createTranslate(ctx), [ctx]);
    // The two settings the descriptor declares are real: they live in the
    // sidebar's own prefs document under `pluginSettings[id]`.
    // The host owns the poll interval (config.pollIntervalMs) and the auto-open
    // decision (config.autoOpen); both reach the client through /rev and focus.
    const tab = useScene(api, scope, visible, hostPollMs);
    const rendered = useMemo(() => renderSafely(tab.scene), [tab.scene]);
    const [exportError, setExportError] = useState(null);
    const [exporting, setExporting] = useState(false);
    const canExport = rendered !== null && rendered.svg !== '' && !exporting;
    const fileName = tab.slug ?? 'excalidraw-scene';

    const doExport = useCallback(async (kind) => {
      if (!canExport) return;
      setExportError(null);
      setExporting(true);
      try {
        // Both formats go through the self-contained SVG: a downloaded file (and
        // the <img> the PNG path draws) is a separate document where the page's
        // @font-face rules do not apply, so the fonts have to be embedded.
        const artifacts = await exportArtifacts(ctx, tab.scene, rendered);
        if (kind === 'svg') await downloadSvg(fileName, artifacts.svg);
        else await downloadPng(fileName, artifacts.png);
      } catch (error) {
        setExportError(String(error?.message ?? error));
      } finally {
        setExporting(false);
      }
    }, [canExport, ctx, fileName, rendered, tab.scene]);

    const subtitle = tab.status === 'ready' && tab.scene !== null
      ? `${tab.slug ?? 'architecture'} · ${tab.scene.elements.length} ${t('elements')}`
      : tab.status === 'empty' ? t('noScene')
        : tab.status === 'error' ? t('error') : t('loading');

    const failed = tab.status === 'error' || (tab.error !== null && tab.error !== undefined) || exportError !== null;
    return h('div', { className: 'dsh-xcal' },
      h('div', { className: 'dsh-xcal-head' },
        h('div', { className: 'dsh-xcal-titles' },
          h('div', { className: 'dsh-xcal-title' }, t('title')),
          h('div', { className: 'dsh-xcal-sub' }, subtitle)),
        tab.revision === undefined ? null : h('span', { className: 'dsh-xcal-rev' }, `rev ${tab.revision}`)),
      h('div', { className: 'dsh-xcal-tools' },
        h('button', {
          type: 'button',
          className: 'dsh-xcal-btn dsh-xcal-btn-primary',
          title: tab.status === 'empty' ? t('emptyHint') : t('refreshTitle'),
          disabled: tab.refreshing || tab.status === 'empty',
          onClick: () => tab.refresh(tab.slug),
        }, t('refresh')),
        tab.items.length > 1
          ? h('select', {
            className: 'dsh-xcal-select',
            value: tab.slug ?? '',
            onChange: (event) => {
              tab.pick(event.target.value);
            },
          }, tab.items.map((entry) => h('option', { key: entry.slug, value: entry.slug }, entry.name ?? entry.slug)))
          : null,
        tab.status === 'empty'
          ? h('button', {
            type: 'button', className: 'dsh-xcal-btn', title: t('emptyHint'),
            onClick: () => tab.unpin(),
          }, t('follow'))
          : null,
        h('span', { className: 'dsh-xcal-grow' }),
        h('button', {
          type: 'button', className: 'dsh-xcal-btn', title: t('exportSvgTitle'),
          disabled: !canExport, onClick: () => doExport('svg'),
        }, t('exportSvg')),
        h('button', {
          type: 'button', className: 'dsh-xcal-btn', title: t('exportPngTitle'),
          disabled: !canExport, onClick: () => doExport('png'),
        }, t('exportPng')),
        h('span', { className: 'dsh-xcal-rev' }, t('readonly'))),
      h(SceneCanvas, { rendered, scene: tab.scene, t, error: tab.error, status: tab.status }),
      h('div', { className: 'dsh-xcal-foot' },
        h('span', { className: `dsh-xcal-dot${failed ? ' error' : ''}` }),
        h('span', { title: tab.error ?? exportError ?? '' }, tab.status === 'empty'
          ? t('noScene')
          : failed
          ? `${tab.error !== null && tab.error !== undefined ? t('error') : t('exportFailed')}: ${String(tab.error ?? exportError ?? '').slice(0, 60)}`
          : tab.updatedAt !== undefined
            ? `${t('updated')} ${formatClock(tab.updatedAt)}`
            : tab.status === 'ready' ? `${tab.scene?.elements.length ?? 0} ${t('elements')}` : t('loading'))));
  }

  /* ------------------------------------------------------------------ */
  /* the file viewer                                                     */
  /* ------------------------------------------------------------------ */

  function FileScene({ ctx, content, path, title }) {
    const t = useMemo(() => createTranslate(ctx), [ctx]);
    const scene = useMemo(() => parseScene(content ?? ''), [content]);
    const rendered = useMemo(() => renderSafely(scene), [scene]);
    const label = title ?? path?.split('/').pop() ?? 'scene';
    const [viewerError, setViewerError] = useState(null);
    const stem = (path?.split('/').pop() ?? 'scene').replace(/\.excalidraw(\.json)?$/i, '');
    return h('div', { className: 'dsh-xcal' },
      h('div', { className: 'dsh-xcal-head' },
        h('div', { className: 'dsh-xcal-titles' },
          h('div', { className: 'dsh-xcal-title' }, label),
          h('div', { className: 'dsh-xcal-sub' }, scene === null ? t('error') : `${scene.elements.length} ${t('elements')}`))),
      h('div', { className: 'dsh-xcal-tools' },
        h('span', { className: 'dsh-xcal-grow' }),
        h('button', {
          type: 'button', className: 'dsh-xcal-btn', title: t('exportSvgTitle'),
          disabled: rendered === null || rendered.svg === '',
          onClick: async () => {
            setViewerError(null);
            try {
              const artifacts = await exportArtifacts(ctx, scene, rendered);
              await downloadSvg(stem, artifacts.svg);
            } catch (error) {
              setViewerError(String(error?.message ?? error));
            }
          },
        }, t('exportSvg'))),
      h(SceneCanvas, {
        rendered,
        scene,
        t,
        error: viewerError,
        status: scene === null ? 'error' : 'ready',
      }),
      h('div', { className: 'dsh-xcal-foot' },
        h('span', { className: `dsh-xcal-dot${viewerError !== null ? ' error' : ''}` }),
        h('span', { title: viewerError ?? '' }, viewerError === null ? t('readonly') : `${t('exportFailed')}: ${viewerError.slice(0, 60)}`)));
  }

  /* ------------------------------------------------------------------ */
  /* wiring                                                              */
  /* ------------------------------------------------------------------ */

  const ICON = h('svg', {
    viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true,
  },
  h('rect', { x: 2.5, y: 4.5, width: 7, height: 5, rx: 1.4 }),
  h('rect', { x: 14.5, y: 14.5, width: 7, height: 5, rx: 1.4 }),
  h('path', { d: 'M9.5 7h2.8a2 2 0 0 1 2 2v5.6' }),
  h('path', { d: 'M13.4 12.9l1 1.6 1.6-1' }));

  function iconOf(size) {
    return h('svg', {
      viewBox: '0 0 24 24', width: size ?? 16, height: size ?? 16, fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true,
    },
    h('rect', { x: 2.5, y: 4.5, width: 7, height: 5, rx: 1.4 }),
    h('rect', { x: 14.5, y: 14.5, width: 7, height: 5, rx: 1.4 }),
    h('path', { d: 'M9.5 7h2.8a2 2 0 0 1 2 2v5.6' }),
    h('path', { d: 'M13.4 12.9l1 1.6 1.6-1' }));
  }

  /** Poll the workspace's scene pointer and open the tab when a refresh lands. */
  /**
   * DSH's `uiConversation.binding(session).activate(id)` only knows registered
   * *target builders* (chat, trajectory, tool history); a slot view id such as
   * `excalidraw` is not one of them, and the call silently does nothing. The
   * visible tab is driven by the Chat target's own store, which a plugin cannot
   * write, so on a stock DSH the Excalidraw view opens by clicking its tab. With
   * better-sidebar `openTab` does auto-open. Returns true only when such a
   * target genuinely exists, so a future DSH can light this path up again.
   */
  function activateNativeView(ctx, sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    try {
      const conversation = typeof ctx.get === 'function' ? ctx.get('uiConversation') : undefined;
      const known = conversation?.views?.get?.(TAB_TYPE);
      if (known === undefined) return false;
      const binding = conversation.binding?.(sessionId);
      if (typeof binding?.activate !== 'function') return false;
      binding.activate(TAB_TYPE);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Poll the durable focus pointer. `mode: 'tab'` opens the better-sidebar tab;
   * `mode: 'native'` activates the conversation view (stock DSH). Exactly one
   * watcher is installed per profile, so a refresh never opens two surfaces.
   */
  function watchFocus(ctx, service, t, options = {}) {
    if (typeof document === 'undefined' || typeof window === 'undefined') return () => {};
    let handled = Symbol('none');
    let timer = null;
    let stopped = false;
    const api = createApi(ctx);
    const tick = async () => {
      if (stopped) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      try {
        const response = await api.focus();
        const focus = response.payload?.focus;
        if (focus === undefined || focus === null || focus.sessionId === undefined) return;

        if (handled === focus.at) return;
        let opened = false;
        try {
          if (service !== undefined && typeof service.openTab === 'function') {
            service.openTab({ type: TAB_TYPE, title: t('title') }, { sessionId: focus.sessionId });
            opened = true;
          } else if (options.mode === 'native') {
            // Stock DSH: activate the registered conversation view instead.
            opened = activateNativeView(ctx, focus.sessionId);
          }
        } catch {
          opened = false;
        }
        // Consume the pointer only when a surface opened: a transient failure
        // must not swallow the one auto-open this refresh produced.
        if (opened) handled = focus.at;
      } catch {
        /* the watcher must never throw into the host */
      }
    };
    let visibilityListener = null;
    const kick = () => {
      tick();
      if (timer === null) timer = setInterval(tick, FOCUS_POLL);
    };
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      visibilityListener = () => {
        if (document.visibilityState === 'visible') {
          document.removeEventListener('visibilitychange', visibilityListener);
          visibilityListener = null;
          kick();
        }
      };
      document.addEventListener('visibilitychange', visibilityListener);
    } else {
      kick();
    }
    return () => {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (visibilityListener !== null) document.removeEventListener('visibilitychange', visibilityListener);
    };
  }

  return {
    inject: [],
    /** Test seam: pure helpers, exercised from Node with a stubbed loader. */
    __test: {
      parseScene, formatClock, createApi, createTranslate, pickSceneSlug, followTarget, renderSafely,
      withStyle, withMetadata, injectIntoRoot, rootTagEnd, base64Of, embeddedFontCss, exportFonts, fontCharacters,
      fetchExtraFonts, activateNativeView, nativeViewRequestAction, settleViewRequest,
      wheelZoomFactor, wheelIntent, zoomAt, panBy, screenToScene, sceneToScreen,
      marqueeRect, fitScaleFor, geometryScreenBox, selectionBounds,
      fontNotice, exportArtifacts, injectFontFaces, fontFaceRule, pngInput,
      matchesUnicodeRange, parseUnicodeRange,
      DICT, LITERAL_FALLBACK, TAB_TYPE, LOCALE_NS,
    },
    apply(ctx) {
      nativeCtx = ctx;
      const disposeStyles = ensureStyles();
      ctx.effect(() => disposeStyles, 'dsh-excalidraw: styles');
      if (pluginTranslate === null) pluginTranslate = createTranslate(ctx);
      const disposeFonts = injectFontFaces(ctx);
      ctx.effect(() => disposeFonts, 'dsh-excalidraw: font faces');

      // ── native DSH slot (no better-sidebar needed) ─────────────────────
      // `slots` is DSH's own UI registry (the reference plugin uses the same
      // service for its conversation tabs). Read it with ctx.get: a profile that
      // does not serve it must still get the better-sidebar tab below.
      const registerNativeView = () => {
        const slots = typeof ctx.get === 'function' ? ctx.get('slots') : undefined;
        if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return null;
        return slots.inject('conversation.view', () => slots.register({
          name: 'conversation.view',
          id: 'excalidraw',
          order: 42,
          // The UI calls this later, outside apply: resolve it through the
          // module-level translate seat, never a callback-local binding.
          label: () => (pluginTranslate !== null ? pluginTranslate('title') : 'Excalidraw'),
          inject: (sessionId) => ({ sessionId }),
        }, NativeDesignView)) ?? null;
      };
      let nativeDispose = null;
      let disposed = false;
      ctx.effect(() => () => { disposed = true; }, 'dsh-excalidraw: native view lifetime');
      try {
        nativeDispose = registerNativeView();
      } catch (error) {
        ctx.logger?.warn?.(`dsh-excalidraw: native conversation view not registered: ${error?.message ?? error}`);
      }
      // The slots service may arrive after this plugin in a lazy profile: retry
      // once shortly after, in a browser only, without holding the page open.
      if (nativeDispose === null && typeof navigator !== 'undefined') {
        const timer = setTimeout(() => {
          if (disposed) return;
          try {
            nativeDispose = registerNativeView();
            if (typeof nativeDispose === 'function' && !disposed) {
              ctx.effect(() => nativeDispose, 'dsh-excalidraw: native conversation view (late)');
              nativeDispose = null;
            }
          } catch {
            /* the better-sidebar path already covers the feature */
          }
        }, 1500);
        ctx.effect(() => () => clearTimeout(timer), 'dsh-excalidraw: native view retry');
      }
      if (typeof nativeDispose === 'function') {
        ctx.effect(() => nativeDispose, 'dsh-excalidraw: native conversation view');
      }

      // The watcher runs in every profile: with better-sidebar it opens the tab,
      // without it it activates the conversation view (round 16 — it used to be
      // registered only inside the better-sidebar callback and thus never ran).
      const sidebarService = typeof ctx.get === 'function' ? ctx.get('betterSidebar') : undefined;
      if (sidebarService === undefined) {
        // No better-sidebar: the conversation view is the only surface, so its
        // watcher is installed here (it used to be unreachable in this profile).
        ctx.effect(
          () => watchFocus(ctx, undefined, pluginTranslate ?? createTranslate(ctx), { mode: 'native' }),
          'dsh-excalidraw: focus watcher (native)',
        );
      }

      ctx.inject(['betterSidebar'], (bctx) => {
        const service = bctx.betterSidebar;
        if (service === undefined) {
          bctx.logger?.warn?.('dsh-excalidraw: dsh-better-sidebar is not mounted, so the Excalidraw tab cannot register');
          return;
        }
        const t = pluginTranslate ?? createTranslate(bctx);

        bctx.effect(() => service.registerTab({
          id: TAB_TYPE,
          title: () => t('title'),
          description: () => t('description'),
          icon: iconOf,
          order: 42,
          single: true,
          component: (props) => h(DesignTab, { ...props, key: props.scope?.sessionId ?? 'none' }),
        }), 'dsh-excalidraw: Excalidraw tab');

        bctx.effect(() => service.registerFileViewer({
          id: 'excalidraw:file',
          title: () => t('title'),
          description: () => t('readonly'),
          icon: iconOf,
          exts: ['excalidraw'],
          priority: 10,
          fetchStrategy: 'fsRead',
          detect: (path, head) => {
            if (/\.excalidraw\.json$/i.test(path)) return true;
            if (head === undefined || head === null) return false;
            const text = typeof head === 'string' ? head : new TextDecoder().decode(head);
            return /"type"\s*:\s*"excalidraw"/.test(text);
          },
          component: (props) => h(FileScene, { ctx: props.ctx, content: props.content, path: props.path, title: props.title }),
        }), 'dsh-excalidraw: file viewer');

        bctx.effect(() => service.registerFileIcon({
          id: 'excalidraw:icon',
          exts: ['excalidraw'],
          icon: () => iconOf(14),
        }), 'dsh-excalidraw: file icon');

        bctx.effect(() => watchFocus(bctx, service, t, { mode: 'tab' }), 'dsh-excalidraw: focus watcher');
      });
    },
  };
}

    return createPlugin(React);
  },
});

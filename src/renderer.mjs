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
export function escapeXml(value) {
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
export function fontStackOf(value) {
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
export function sceneBounds(elements) {
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
export function elementGeometries(elements) {
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
export function hitsGeometry(geometry, point, slop = 6) {
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
export function hitTestGeometry(geometries, point, slop = 6) {
  if (!Array.isArray(geometries)) return null;
  for (let index = geometries.length - 1; index >= 0; index -= 1) {
    if (hitsGeometry(geometries[index], point, slop)) return geometries[index];
  }
  return null;
}

/** Whether an element's (rotated) bounds intersect a marquee rectangle. */
export function intersectsRect(geometry, rect) {
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
export function elementsInRect(geometries, rect) {
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
export function arrowHeadPath(
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
export function renderScene(elements, options = {}) {
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

export { SUPPORTED_TYPES };

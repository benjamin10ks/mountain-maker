import type { Font } from 'opentype.js';

export type Vec2 = [number, number];
export type Contour = Vec2[];

// We place glyphs ourselves instead of calling font.getPath(): opentype.js 2.0's shaper
// throws on GSUB lookups it doesn't support (Oswald has some). Plaque text is plain
// Latin, so glyph advance + pair kerning is all the shaping we need.
function glyphRun(font: Font, text: string, size: number) {
  const scale = size / font.unitsPerEm;
  const glyphs = Array.from(text, (ch) => font.charToGlyph(ch));
  const xs: number[] = [];
  let x = 0;
  glyphs.forEach((g, i) => {
    xs.push(x);
    x += (g.advanceWidth ?? 0) * scale;
    if (i < glyphs.length - 1) x += font.getKerningValue(g, glyphs[i + 1]) * scale;
  });
  return { glyphs, xs, width: x };
}

export function advanceWidth(font: Font, text: string, size: number): number {
  return glyphRun(font, text, size).width;
}

/** Outline contours of `text` in mm, y up, baseline at y=0, starting at x=0. */
export function textContours(font: Font, text: string, size: number, curveSegments = 6): Contour[] {
  const run = glyphRun(font, text, size);
  const commands = run.glyphs.flatMap((g, i) => g.getPath(run.xs[i], 0, size).commands);
  const contours: Contour[] = [];
  let cur: Contour = [];
  let x = 0;
  let y = 0;
  const close = () => {
    if (cur.length > 2) contours.push(cur);
    cur = [];
  };
  // opentype paths are y-down; flip to y-up as we go.
  for (const c of commands) {
    switch (c.type) {
      case 'M':
        close();
        cur.push([c.x, -c.y]);
        break;
      case 'L':
        cur.push([c.x, -c.y]);
        break;
      case 'Q':
        for (let i = 1; i <= curveSegments; i++) {
          const t = i / curveSegments, u = 1 - t;
          cur.push([u * u * x + 2 * u * t * c.x1 + t * t * c.x, -(u * u * y + 2 * u * t * c.y1 + t * t * c.y)]);
        }
        break;
      case 'C':
        for (let i = 1; i <= curveSegments; i++) {
          const t = i / curveSegments, u = 1 - t;
          const a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
          cur.push([a * x + b * c.x1 + d * c.x2 + e * c.x, -(a * y + b * c.y1 + d * c.y2 + e * c.y)]);
        }
        break;
      case 'Z':
        close();
        continue;
    }
    x = c.x;
    y = c.y;
  }
  close();
  return contours;
}

export interface PlaqueLayout {
  contours: Contour[];
  /** Height of capital letters on each line, mm. */
  capHeights: number[];
}

/** Line 2 is set smaller than line 1, like a name and a subtitle. */
const LINE2_SCALE = 0.55;
const LINE_GAP = 0.35;

/**
 * Lay out one or two centered lines as large as possible inside a box, centered on
 * the origin. Heights are measured on capitals so the block looks centered.
 */
export function layoutPlaque(font: Font, lines: string[], maxWidth: number, maxHeight: number): PlaqueLayout {
  const text = lines.map((l) => l.trim()).filter(Boolean).slice(0, 2);
  if (!text.length) return { contours: [], capHeights: [] };

  const cap = (font.tables.os2?.sCapHeight || font.unitsPerEm * 0.7) / font.unitsPerEm;
  const scales = [1, LINE2_SCALE].slice(0, text.length);
  // Everything scales linearly with the line-1 font size, so solve for it directly.
  const widthPer1 = Math.max(...text.map((t, i) => advanceWidth(font, t, scales[i])));
  const heightPer1 = cap * scales.reduce((a, b) => a + b, 0) + (text.length - 1) * LINE_GAP;
  const size = Math.min(maxWidth / widthPer1, maxHeight / heightPer1);

  const capHeights = scales.map((s) => cap * s * size);
  const total = heightPer1 * size;
  let top = total / 2;
  const contours: Contour[] = [];
  text.forEach((t, i) => {
    const s = scales[i] * size;
    const baseline = top - capHeights[i];
    const dx = -advanceWidth(font, t, s) / 2;
    for (const c of textContours(font, t, s)) contours.push(c.map(([x, y]) => [x + dx, y + baseline]));
    top = baseline - LINE_GAP * size;
  });
  return { contours, capHeights };
}

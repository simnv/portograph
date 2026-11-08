/**
 * What the SVG renderer (`render/index.ts`) and the draw.io export (`render/drawio.ts`) both compute, stated once (R1;
 * drawio-export ticket 13, audit finding S-13). Each renderer reads these functions and keeps no private copy, so the two
 * cannot disagree on where a glyph sits in its tile, where a path breaks into runs, or what paint a class takes.
 */
import type { Rect } from '../model/geometry.js';
import type { PathSegment } from '../model/layout.js';
import { samePoint } from '../geometry/planar.js';
import type { ThemeMode } from '../profiles/network/theme.js';
import type { Theme } from '../profiles/network/themes.js';
import { paintRules } from './theme.js';
import type { PaintRule } from './theme.js';
import { classes } from './svg.js';

/** Inset of a scaled icon glyph inside its measured tile, so the tile keeps a visible border. */
export const ICON_INSET = 1.5;

/**
 * The box an icon glyph is drawn in: the tile pulled in by `inset` on every side, but by no more than a quarter of the
 * tile's width or height. A small positive tile therefore keeps a positive glyph box (half of each side) instead of
 * losing the glyph. A card tile states its own inset (ticket 159); every other tile takes `ICON_INSET`.
 */
export function iconGlyphBox(tile: Rect, inset: number = ICON_INSET): Rect {
  const by = Math.min(inset, tile.width / 4, tile.height / 4);
  return { x: tile.x + by, y: tile.y + by, width: tile.width - 2 * by, height: tile.height - 2 * by };
}

/** A run of a path: the segments `first` to `last`, inclusive, whose ends meet. */
export interface PathRun { first: number; last: number }

/**
 * The runs a path draws. A segment starts a new run when its start is not the end of the segment before it. "Is the
 * same point" is a question about published geometry, so it is asked at the planar tolerance (`samePoint`, `EPS` of
 * `geometry/planar.ts`), the owner of that question in the D-Q6 tolerance table. The SVG starts a subpath per run; the
 * draw.io export writes one connector per run.
 */
export function pathRuns(segments: readonly PathSegment[]): PathRun[] {
  const runs: PathRun[] = [];
  for (const [index, segment] of segments.entries()) {
    const current = runs[runs.length - 1];
    if (current !== undefined && samePoint(segments[current.last]!.to, segment.from)) current.last = index;
    else runs.push({ first: index, last: index });
  }
  return runs;
}

/**
 * The paint one element takes from the theme sheet, by property. The element carries every class given in `tokens`
 * (structural and author tokens, split on white space as the SVG writes them). The rules are those the SVG writes as CSS
 * (`paintRules`), and they resolve as the CSS cascade resolves them: a rule applies when the element carries its
 * structural class and all its further classes; for each property the more specific rule wins, and of two equally
 * specific rules the later one. A class inside `:where()` adds no specificity. So a token the theme does not know changes
 * nothing, and the order of the tokens on the element changes nothing.
 */
export function resolvePaint(rules: readonly PaintRule[], ...tokens: (string | undefined)[]): Map<string, string> {
  const carried = new Set(classes(...tokens).split(' '));
  const specificity = (paintRule: PaintRule): number => 1 + (paintRule.where ? 0 : paintRule.tokens.length);
  const applied = rules.filter(paintRule => carried.has(paintRule.element) && paintRule.tokens.every(name => carried.has(name)))
    .map((paintRule, order) => ({ paintRule, order }))
    // Last key: sheet order, the CSS tie-break between rules of equal specificity.
    .sort((a, b) => specificity(a.paintRule) - specificity(b.paintRule) || a.order - b.order);
  const paint = new Map<string, string>();
  for (const { paintRule } of applied) {
    for (const [property, value] of paintRule.declarations) paint.set(property, String(value));
  }
  return paint;
}

/** `resolvePaint` over one theme's sheet in a given mode; the sheet of each mode is built once. */
export type PaintLookup = (mode: ThemeMode, ...tokens: (string | undefined)[]) => Map<string, string>;

export function paintLookup(theme: Theme): PaintLookup {
  const sheets = new Map<ThemeMode, PaintRule[]>();
  return (mode, ...tokens) => {
    let rules = sheets.get(mode);
    if (rules === undefined) { rules = paintRules(mode, theme); sheets.set(mode, rules); }
    return resolvePaint(rules, ...tokens);
  };
}

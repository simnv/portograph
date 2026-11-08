/**
 * What the SVG renderer (`render/index.ts`) and the draw.io export (`render/drawio.ts`) both compute, stated once (R1;
 * drawio-export ticket 13, audit finding S-13). Each renderer reads these functions and keeps no private copy, so the two
 * cannot disagree on where a glyph sits in its tile, where a path breaks into runs, or what paint a class takes.
 */
import type { Rect } from '../model/geometry.js';
import type { PathSegment } from '../model/layout.js';
import { samePoint } from '../geometry/planar.js';
import type { Frame, LayoutLabel, LayoutLink, LayoutModel } from '../model/layout.js';
import { frameNodes } from '../layout/frames.js';
import type { GroupShape } from './frame-order.js';
import { LEGEND_DEFAULT_CLASS } from '../profiles/network/theme.js';
import type { ThemeMode } from '../profiles/network/theme.js';
import type { Theme } from '../profiles/network/themes.js';
import { authorRules } from './author-css.js';
import { HALO_CLASS, haloDepthClass, paintRules, washRules } from './theme.js';
import type { PaintRule } from './theme.js';
import { authorClass, classes } from './svg.js';

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

/** A link's authored class as a class token: an empty class is none, and the renderer's reserved prefix is removed. */
export function linkClassToken(model: LayoutModel, link: LayoutLink): string | undefined {
  const value = model.document.links[link.sourceIndex]?.class;
  return value === '' ? undefined : authorClass(value);
}

/** A group whose nodes all share one class reads as that class, as the approved target does. */
export function uniformNodeClass(model: LayoutModel, nodes: readonly string[]): string | undefined {
  const values = new Set(nodes.map(id => model.document.nodes[id]?.class ?? ''));
  const only = values.size === 1 ? [...values][0]! : '';
  return only === '' ? undefined : authorClass(only);
}

/** The classes of a group box: the group's or frame's own, and the class its nodes all share. */
export function boxClasses(model: LayoutModel, shape: GroupShape): { authored: string | undefined; uniform: string | undefined } {
  const frame = shape.frame ? model.frames!.find(item => item.id === shape.id)! : undefined;
  return {
    authored: authorClass(frame ? frame.class : model.document.groups[shape.id]!.class),
    uniform: uniformNodeClass(model, frame ? frameNodes(model, shape.id) : model.groups[shape.id]!.nodes),
  };
}

/** The frame a group title belongs to: the frame whose label band sits in the title's owning cell. */
export function frameTitled(model: LayoutModel, label: LayoutLabel): Frame | undefined {
  const id = label.owner.kind === 'group' ? label.owner.id : undefined;
  // A cell hosts a frame's band; a canton's band is held by the sub-tier, so its label is owned by the canton itself.
  const band = model.labelBands.find(item => item.host !== undefined ? item.host === id : item.group === id);
  return band ? model.frames?.find(item => item.id === band.group) : undefined;
}

/** The author classes a group title carries: its frame's or group's own class, and the class the nodes under it all share. */
export function groupLabelClasses(model: LayoutModel, label: LayoutLabel): string {
  // A frame's title is owned by the cell that hosts its label band; the frame gives the class.
  const group = label.owner.kind === 'group' ? model.groups[label.owner.id] : undefined;
  const frame = group || label.owner.kind === 'group' ? frameTitled(model, label) : undefined;
  const uniform = frame ? uniformNodeClass(model, frameNodes(model, frame.id)) : group ? uniformNodeClass(model, group.nodes) : undefined;
  return classes(frame ? authorClass(frame.class) : group ? authorClass(model.document.groups[group.id]!.class) : undefined, uniform);
}

/** The class a legend swatch carries for its key: a line keyed `default` (a link with no class) carries none. */
export const legendSwatchClass = (kind: 'symbol' | 'line' | 'port', key: string): string | undefined =>
  kind === 'line' && key === LEGEND_DEFAULT_CLASS ? undefined : authorClass(key);

/**
 * The class attribute of each element the SVG writes and the draw.io export paints, lock classes apart, and the path of class
 * attributes from the SVG root down to it. The SVG writes these attributes; the draw.io export resolves its paint on these paths
 * (`PaintSheet`), so a rule that names a container (`.node.router .pill`, `.links > .link`) reaches both renderers alike (R1).
 */
export const svgClass = {
  root: (profile: string | undefined): string => classes('portograph', authorClass(profile)),
  group: (groupClass: string | undefined): string => classes('group', groupClass),
  groupBox: (groupClass: string | undefined, uniform: string | undefined): string => classes('group-box', groupClass, uniform),
  node: (nodeClass: string | undefined): string => classes('node', nodeClass),
  nodeBody: (nodeClass: string | undefined, wash: string | undefined): string => classes('node-body', nodeClass, wash),
  port: (portClass: string | undefined): string => classes('port', portClass),
  pill: (portClass: string | undefined): string => classes('pill', portClass),
  link: (linkClass: string | undefined, overlay: boolean): string => classes('link', overlay ? 'overlay' : undefined, linkClass),
  linkLine: (linkClass: string | undefined, overlay: boolean, extra?: string): string =>
    classes('link-line', overlay ? 'overlay-line' : undefined, linkClass, extra),
  linkDot: (linkClass: string | undefined, overlay: boolean): string => classes('link-line', overlay ? 'overlay-line' : undefined, 'link-dot', linkClass),
  meshBus: (linkClass: string | undefined): string => classes('mesh-bus', 'overlay', linkClass),
  overlayEndpoint: (linkClass: string | undefined): string => classes('overlay-endpoint', linkClass),
  halo: (depth: number): string => classes(HALO_CLASS, haloDepthClass(depth)),
  legendEntry: (kind: string, key: string): string => classes('legend-entry', `legend-${kind}`, authorClass(key)),
} as const;

/** One element's path: the class attributes from the SVG root to it, root first. */
export type PaintPath = readonly string[];

export const paintPath = {
  canvas: (root: string): PaintPath => [root, 'pg-canvas'],
  groupBox: (root: string, groupClass: string | undefined, uniform: string | undefined): PaintPath =>
    [root, 'groups', svgClass.group(groupClass), svgClass.groupBox(groupClass, uniform)],
  /** A text of the labels layer: a group title, a link, multiplicity or bus label. */
  label: (root: string, text: string): PaintPath => [root, 'labels', text],
  /** An element of a node: its body, its name or description, its icon tile or glyph. */
  inNode: (root: string, nodeClass: string | undefined, leaf: string): PaintPath => [root, 'nodes', svgClass.node(nodeClass), leaf],
  /** An element of a port: its group (`leaf` absent), its pill or its pill label. `portClass` is the node class and the port's own. */
  inPort: (root: string, nodeClass: string | undefined, portClass: string | undefined, leaf?: string): PaintPath =>
    [root, 'nodes', svgClass.node(nodeClass), svgClass.port(portClass), ...(leaf === undefined ? [] : [leaf])],
  linkLine: (root: string, linkClass: string | undefined, overlay: boolean): PaintPath =>
    [root, overlay ? 'overlay-links' : 'links', svgClass.link(linkClass, overlay), svgClass.linkLine(linkClass, overlay)],
  busLine: (root: string, linkClass: string | undefined, extra?: string): PaintPath =>
    [root, 'overlay-links', svgClass.meshBus(linkClass), svgClass.linkLine(linkClass, true, extra)],
  linkDot: (root: string, linkClass: string | undefined, overlay: boolean): PaintPath =>
    [root, overlay ? 'overlay-marks' : 'link-dots', svgClass.linkDot(linkClass, overlay)],
  overlayEndpoint: (root: string, linkClass: string | undefined): PaintPath => [root, 'overlay-marks', svgClass.overlayEndpoint(linkClass)],
  inLegend: (root: string, kind: string, key: string, leaf: string): PaintPath => [root, 'legend', svgClass.legendEntry(kind, key), leaf],
} as const;

/** A computed property: its value and the rule that gave it (for an inherited value, the ancestor's rule). */
export interface Resolved { readonly value: string; readonly rule: PaintRule }

/** The properties an element takes from its parent when no rule states them for it (SVG 1.1, property index); `opacity` is not one. */
const INHERITED: ReadonlySet<string> = new Set(['fill', 'fill-opacity', 'stroke', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin']);

const subject = (paintRule: PaintRule): readonly string[] => paintRule.element === '*' ? paintRule.tokens : [paintRule.element, ...paintRule.tokens];
const specificity = (paintRule: PaintRule): number => (paintRule.element === '*' ? 0 : 1) + (paintRule.where ? 0 : paintRule.tokens.length)
  + (paintRule.context ?? []).reduce((sum, compound) => sum + compound.classes.length, 0);
const carries = (names: readonly string[], carried: ReadonlySet<string>): boolean => names.every(name => carried.has(name));

/** Whether the compounds left of a subject at `at` match its ancestors: a child compound its parent, any other compound an ancestor. */
function contextMatches(context: NonNullable<PaintRule['context']>, carried: readonly ReadonlySet<string>[], at: number): boolean {
  if (!context.length) return true;
  const nearest = context[context.length - 1]!, rest = context.slice(0, -1);
  for (let up = at - 1; up >= 0; up--) {
    if (carries(nearest.classes, carried[up]!) && contextMatches(rest, carried, up)) return true;
    if (nearest.child) return false;
  }
  return false;
}

/**
 * The computed paint of each element on `path`, root first, as the CSS cascade gives it. A rule applies to an element when the
 * element carries every class of the rule's subject and its ancestors match the rule's context. For each property an important
 * declaration beats a normal one, then the more specific rule wins, then the later one; a class inside `:where()` adds no
 * specificity. A property no rule states for the element takes its parent's computed value when it is inherited (every property
 * here except `opacity`), and `inherit` takes the parent's value of any property. So a token the theme does not know changes
 * nothing, and the order of the tokens on the element changes nothing.
 */
export function computePaint(rules: readonly PaintRule[], path: PaintPath): Map<string, Resolved>[] {
  const carried = path.map(attribute => new Set(classes(attribute).split(' ')));
  const computed: Map<string, Resolved>[] = [];
  let parent = new Map<string, Resolved>();
  for (let at = 0; at < path.length; at++) {
    const applied = rules.map((paintRule, order) => ({ paintRule, order }))
      .filter(({ paintRule }) => carries(subject(paintRule), carried[at]!) && contextMatches(paintRule.context ?? [], carried, at))
      // Last key: sheet order, the CSS tie-break between rules of equal importance and specificity.
      .sort((a, b) => Number(a.paintRule.important === true) - Number(b.paintRule.important === true)
        || specificity(a.paintRule) - specificity(b.paintRule) || a.order - b.order);
    const own = new Map<string, Resolved>([...parent].filter(([property]) => INHERITED.has(property)));
    for (const { paintRule } of applied) {
      for (const [property, value] of paintRule.declarations) {
        const text = String(value);
        if (text !== 'inherit') own.set(property, { value: text, rule: paintRule });
        else if (parent.has(property)) own.set(property, parent.get(property)!);
        else own.delete(property);
      }
    }
    computed.push(own);
    parent = own;
  }
  return computed;
}

/** The paint one element takes, by property: `computePaint` of an element with no ancestor that carries the classes in `tokens`. */
export function resolvePaint(rules: readonly PaintRule[], ...tokens: (string | undefined)[]): Map<string, string> {
  const leaf = computePaint(rules, [classes(...tokens)])[0]!;
  return new Map([...leaf].map(([property, resolved]) => [property, resolved.value]));
}

/** The `opacity` of every element on a computed path that states one, root first. */
const fadedBy = (chain: readonly ReadonlyMap<string, Resolved>[]): Resolved[] =>
  chain.flatMap(element => element.has('opacity') ? [element.get('opacity')!] : []);

/** The paint of one element as a draw.io cell reads it. */
export interface ElementPaint {
  /** The computed value of a property of the element, or `undefined` when no rule states it. */
  get(property: string): string | undefined;
  /** The opacity the element is seen at: the product of `opacity` along its path, as the SVG composites a faded group. */
  opacity(): number;
}

/**
 * The whole paint sheet of one document, as the draw.io export reads it: the theme rules, the wash rules of the sheet's own node
 * classes and the document's `css:` (`authorRules`), in the order the SVG's style sheet states them. A mode reads the light rules
 * and, for dark or print, that mode's rules on top, as a browser reads the unconditional rules and the matching `@media` blocks;
 * an author rule applies in the modes its media match.
 *
 * Every author rule a cell cannot carry is kept for one warning (`unmapped`): a rule outside the subset `authorRules` reads, and a
 * property an author rule gives an element whose cell does not read it (a stroke on a text, a fill on a glyph).
 */
export class PaintSheet {
  private readonly sheets = new Map<ThemeMode, PaintRule[]>();
  /** The computed chain of each mode and path, and what the cells have read of its element, over every read of it. */
  private readonly computed = new Map<string, { chain: Map<string, Resolved>[]; read: Set<string> | undefined }>();
  private readonly author: readonly PaintRule[];
  private readonly outside: readonly string[];

  constructor(private readonly theme: Theme, private readonly nodeClassAttrs: readonly (string | undefined)[], css: string | undefined) {
    const parsed = authorRules(css);
    this.author = parsed.rules;
    this.outside = parsed.unmapped;
  }

  /** The rules of one mode, in sheet order. */
  rules(mode: ThemeMode): PaintRule[] {
    let rules = this.sheets.get(mode);
    if (rules === undefined) {
      const over = (of: (at: ThemeMode) => PaintRule[]): PaintRule[] => [...of('light'), ...(mode === 'light' ? [] : of(mode))];
      rules = [...over(at => paintRules(at, this.theme)), ...over(at => washRules(at, this.nodeClassAttrs, this.theme)),
        ...this.author.filter(paintRule => paintRule.modes === undefined || paintRule.modes.includes(mode))];
      this.sheets.set(mode, rules);
    }
    return rules;
  }

  /** The paint of the element at the end of `path` in one mode; what the cell reads of it is marked as carried. */
  at(mode: ThemeMode, path: PaintPath): ElementPaint {
    return this.paint(mode, path, true);
  }

  /** The same paint, read without marking anything as carried: for a value the caller may leave out. */
  peek(mode: ThemeMode, path: PaintPath): ElementPaint {
    return this.paint(mode, path, false);
  }

  private paint(mode: ThemeMode, path: PaintPath, tracked: boolean): ElementPaint {
    const key = `${mode}\n${path.join('\n')}`;
    let entry = this.computed.get(key);
    if (entry === undefined) { entry = { chain: computePaint(this.rules(mode), path), read: undefined }; this.computed.set(key, entry); }
    // A peek reads nothing into the record: a value the caller leaves out stays unread.
    if (tracked) entry.read ??= new Set();
    const read = tracked ? entry.read! : new Set<string>();
    const leaf = entry.chain[entry.chain.length - 1]!;
    return {
      get: property => { read.add(property); return leaf.get(property)?.value; },
      opacity: () => { read.add('opacity'); return fadedBy(entry.chain).reduce((product, resolved) => product * Number(resolved.value), 1); },
    };
  }

  /** The author rules, or parts of them, that draw.io cannot carry, once each, as CSS text. */
  unmapped(): string[] {
    const notCarried = [...this.computed].flatMap(([key, { chain, read }]) => {
      if (read === undefined) return [];
      const element = classes(key.slice(key.lastIndexOf('\n') + 1)).split(' ')[0]!;
      const leaf = chain[chain.length - 1]!;
      // The element's own opacity is one factor of `opacity()`, so it is read when the product is.
      const unread = [...[...leaf].filter(([property]) => property !== 'opacity' && !read.has(property)),
        ...(read.has('opacity') ? [] : fadedBy(chain).map(resolved => ['opacity', resolved] as const))];
      return unread.filter(([, resolved]) => resolved.rule.source !== undefined)
        .map(([property, resolved]) => `${resolved.rule.source} { ${property}: ${resolved.value} } on ${element}`);
    });
    return [...new Set([...this.outside, ...notCarried])];
  }
}

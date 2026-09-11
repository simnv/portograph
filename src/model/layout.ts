import type { Endpoint, NormalisedDocument, PortRef, Route } from './document.js';
import type { Point, Rect, Side, Size } from './geometry.js';

/** Last completed stage; checked transactions enforce progression after sides-two. */
export type LayoutStage = 'normalised' | 'resolve' | 'sides-one' | 'size' | 'skeleton'
  | 'sides-two' | 'rows' | 'lanes' | 'flanks' | 'centre' | 'bars' | 'bundles'
  | 'bands' | 'route' | 'link-labels' | 'validate' | 'emit';

export type Layer = 'routed' | 'overlay';
export type Owner =
  | { kind: 'node' | 'group' | 'link' | 'group-link' | 'bundle' | 'shared-stem' | 'lane' | 'legend'; id: string }
  | { kind: 'barCross'; node: string; link: string };

export interface OwnedElement {
  owner: Owner;
  layer: Layer;
}

/**
 * The final path geometry a visible label was measured against. A link label names the one
 * supporting segment G3 exempts from its clearance zone; a multiplicity label names its counted
 * merge run and gets no segment exemption at all. A stale reference exempts nothing.
 */
export type LabelSupport =
  | { kind: 'link-segment'; link: string; segment: number }
  | { kind: 'merge-run'; bundle: string; run: string };

export interface LayoutLabel extends OwnedElement {
  id: string;
  text: string;
  /** A pill label's exact port; sharing a node owner does not exempt every pill collision. */
  port?: PortRef;
  role?: 'node' | 'description' | 'group' | 'link' | 'pill' | 'legend';
  support?: LabelSupport;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: 400 | 700;
  lineHeight?: number;
  lines?: string[];
  textRotation?: -90 | 0;
  tooltip?: string;
  bounds?: Rect;
  omitted?: boolean;
}

export interface PillGeometry extends OwnedElement {
  /** Measured pill size before rotation. */
  size: Size;
  bounds: Rect;
  textRotation: -90 | 0;
  radius: number;
}

export interface LayoutPort extends OwnedElement {
  ref: PortRef;
  side?: Side;
  /** Capacity estimate only; stage 5 chooses the final side from actual peer positions. */
  sizingSide?: Side;
  /** Stage 5 orders unused ports after linked ports unless authorOrder takes precedence. */
  unused?: boolean;
  authorOrder?: number;
  engineOrder?: number;
  anchor?: Point;
  /** Anonymous ports never receive visible pill geometry. */
  pill?: PillGeometry;
}

export interface LayoutNode extends OwnedElement {
  id: string;
  /** Overrides the shared theme default; zero explicitly means no visible stroke. */
  strokeWidth?: number;
  ports: LayoutPort[];
  /** Maximum of theme minimum, measured content and author size; excludes port capacity. */
  sizeFloor?: Size;
  contentSize?: Size;
  /** Content must fit within these asymmetric insets, clear of inward pill protrusions. */
  contentInsets?: Record<Side, number>;
  size?: Size;
  bounds?: Rect;
  sidePitch?: Partial<Record<Side, number>>;
  /** Final measured icon placement; inherits the node identity and layer. */
  icon?: { icon: string; bounds: Rect };
}

export interface LayoutGroup extends OwnedElement {
  id: string;
  nodes: string[];
  /** Effective tier, including the referenced tier of a flank after resolve. */
  tier?: number;
  bounds?: Rect;
  rowOrder?: string[];
  flank?: { align: 'left' | 'right'; of: string; proxyPeer?: string; primaryPeer?: string };
}

export interface TierBand {
  tier: number;
  groups: string[];
  bounds?: Rect;
}

export type Region =
  | { id: string; kind: 'tiers'; upperTier: number; lowerTier: number; bounds?: Rect }
  | { id: string; kind: 'flank'; flank: string; group: string; bounds?: Rect };

/** Segment order is source to target. Adjacent endpoints must coincide after routing. */
export interface PathSegment {
  from: Point;
  to: Point;
  owner: Owner;
  /** IDs of crossed bar nodes; these contacts are reported and exempt from G2/G6. */
  barCross?: string[];
  lane?: string;
}

export interface LayoutPath extends OwnedElement {
  segments: PathSegment[];
  fixed: boolean;
  strokeWidth?: number;
}

export interface LayoutLink {
  id: string;
  /** Zero-based index of the originating document link, also for expanded group links. */
  sourceIndex: number;
  owner: Owner;
  from: Endpoint;
  to: Endpoint;
  /** Class-derived family; an author route override can select a different effective layer. */
  family?: Layer;
  /** Effective drawing layer, authoritative after semantic resolution. */
  layer?: Layer;
  /** Effective drawing technique. M1 fallback requests remain on document.links[sourceIndex].route. */
  technique?: Route;
  /**
   * Effective stroke width, resolved in stage 1 from the author's `weight` multiplier and omitted
   * when it is the shared default. Placement reserves stroke-aware space from it before any path
   * exists; `score` and `render` read the same number through `linkStrokeWidth`.
   */
  strokeWidth?: number;
  bundle?: string;
  groupLink?: string;
  /** Routing must first resolve group endpoints to concrete port refs. */
  attachments?: { from: PortRef; to: PortRef };
  path?: LayoutPath;
  /**
   * Immutable reserved runs in source-to-target traversal order. Entries may be disconnected from
   * each other; routing completes the gaps and the attachment stems. `path` always means the
   * complete geometry, so an incomplete reservation is never stored there.
   */
  fixedSegments?: PathSegment[];
  /** Outward root-to-leaf shared runs; a pathless remainder must consume these in stage 13. */
  sharedRuns?: { from?: PathSegment[]; to?: PathSegment[] };
  stubCandidate?: boolean;
}

export interface Lane extends OwnedElement {
  id: string;
  group: string;
  tier: number;
  side: 'left' | 'right';
  /** Fixed lane centre x. Bounds record its width and reserved vertical run. */
  x: number;
  bounds: Rect;
}

export interface Bundle extends OwnedElement {
  id: string;
  nodes: [string, string];
  members: string[];
  /** Required visible clearance between strokes. */
  memberGap?: number;
  /** Minimum regular centreline pitch, including stroke width; fixed tracks may be wider. */
  memberPitch?: number;
  mergeRuns?: { id: string; members: string[]; count: number; path: LayoutPath }[];
  rows?: Rect;
  centreline?: LayoutPath;
  envelope?: Rect;
  /** Swept channel rectangles; consumers prefer these over the union for bent channels. */
  envelopeParts?: Rect[];
  inversions?: number;
}

export interface Junction extends OwnedElement {
  id: string;
  port: PortRef;
  /** Parent shared run at the same port; membership is a strict subset. */
  parent?: string;
  links: string[];
  point?: Point;
  stem?: PathSegment;
}

export interface LabelBand extends OwnedElement {
  id: string;
  group: string;
  bounds: Rect;
  /**
   * Reserved vertical gap between the band and the group's topmost node. It is the ordinary group
   * padding unless a routed outward stem or shared prefix at a top port needs more room to keep
   * its entry points outside the stroke-aware band obstacle.
   */
  clearance: number;
}

export interface BarDrop extends OwnedElement {
  /** One reservation per crossed bar, owned by that barCross; no crossing uses link ownership. */
  id: string;
  link: string;
  port: PortRef;
  source: PortRef;
  slotX: number;
  span: { min: number; max: number };
  hint?: Point[];
  barCross: string[];
}

/**
 * One generated legend row. `swatch` is the measured symbol tile or line sample; `label` names the
 * `role: 'legend'` label that describes it. Both are final geometry: stage 11 draws them and never
 * re-measures or reflows them, including when a render hides a layer.
 */
export interface LegendEntry {
  /** `symbol:<class>` or `line:<class>`; the rendered `data-id` and the acceptance key. */
  id: string;
  kind: 'symbol' | 'line';
  /** The document class this entry stands for; `LEGEND_DEFAULT_CLASS` for links without one. */
  key: string;
  /** Profile icon of a symbol entry, absent when the class resolves to none. */
  icon?: string;
  /** Effective stroke width of a line entry; identical to the width `score` measures. */
  strokeWidth?: number;
  swatch: Rect;
  label: string;
}

/**
 * The generated legend. It exists only when the document uses more than one symbol or more than one
 * line style, describes exactly the classes present, and occupies canvas space reserved below the
 * drawn diagram — it never moves frozen node, group, port, band or path geometry.
 */
export interface Legend extends OwnedElement {
  id: string;
  bounds: Rect;
  entries: LegendEntry[];
}

export interface GroupLink extends OwnedElement {
  id: string;
  groups: [string, string];
  /** Member IDs retain links, port attachments and document class via sourceIndex. */
  members: string[];
}

export interface Obstacle extends OwnedElement {
  id: string;
  bounds: Rect;
}

export interface Diagnostic {
  stage: 'parse' | 'model' | 'placement' | 'final-geometry';
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  owners?: Owner[];
}

export interface LayoutRuntime {
  totalMs?: number;
  stages: { stage: LayoutStage; durationMs: number }[];
}

/** Geometry remains optional until the stage that produces it has completed. */
export interface LayoutModel {
  freeze?: LayoutFreeze;
  document: NormalisedDocument;
  stage: LayoutStage;
  groups: Record<string, LayoutGroup>;
  nodes: Record<string, LayoutNode>;
  links: LayoutLink[];
  tierBands: TierBand[];
  regions: Region[];
  labels: LayoutLabel[];
  lanes: Lane[];
  bundles: Bundle[];
  junctions: Junction[];
  labelBands: LabelBand[];
  barDrops: BarDrop[];
  groupLinks: GroupLink[];
  obstacles: Obstacle[];
  diagnostics: Diagnostic[];
  runtime: LayoutRuntime;
  /** Measured by stage 9 inside the link-label transaction; absent when one variant or none. */
  legend?: Legend;
  canvas?: Rect;
  anchorTier?: number;
  fallbackUsed?: boolean;
  deadlineHit?: boolean;
}

export interface FrozenPort {
  ref: PortRef;
  side: Side;
  authorOrder?: number;
}
export interface PlacementSnapshot {
  sharedRuns: { link: string; runs: NonNullable<LayoutLink['sharedRuns']> }[];
  fixedSegments: { link: string; segments: PathSegment[] }[];
  nodes: Record<string, Pick<LayoutNode, 'bounds' | 'size' | 'sizeFloor' | 'contentSize' | 'contentInsets' | 'sidePitch' | 'ports' | 'icon'>>;
  groups: Record<string, Pick<LayoutGroup, 'bounds' | 'rowOrder' | 'nodes' | 'tier' | 'flank'>>;
  tierBands: TierBand[];
  regions: Region[];
  lanes: Lane[];
  labelBands: LabelBand[];
  labels: LayoutLabel[];
}
export interface LayoutFreeze {
  version: 1;
  topology: { node: string; ports: FrozenPort[] }[];
  floors: { node: string; size: Size }[];
  placement?: PlacementSnapshot;
}

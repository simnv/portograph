import type { Endpoint, NormalisedDocument, PortRef, Route } from './document.js';
import type { Point, Rect, Side, Size } from './geometry.js';

/** Last completed stage; checked transactions enforce progression after sides-two. */
export type LayoutStage = 'normalised' | 'resolve' | 'sides-one' | 'size' | 'skeleton'
  | 'sides-two' | 'rows' | 'lanes' | 'flanks' | 'centre' | 'bars' | 'bundles'
  | 'bands' | 'route' | 'link-labels' | 'validate' | 'emit';

export type Layer = 'routed' | 'overlay';
export type Owner =
  | { kind: 'node' | 'group' | 'link' | 'group-link' | 'bundle' | 'shared-stem' | 'lane' | 'legend' | 'mesh-bus' | 'bus-band'; id: string }
  | { kind: 'barCross'; node: string; link: string };

export interface OwnedElement {
  owner: Owner;
  layer: Layer;
}

/**
 * The final path geometry a visible label was measured against. A link label names the one
 * supporting segment G3 exempts from its clearance zone; a multiplicity label names its counted
 * merge run and gets no segment exemption at all. A stale reference exempts nothing.
 * `through` (ticket 142) ends a run of collinear consecutive pieces of one link, which the label
 * stands on whole: `segment` to `through` are all its supporting segments.
 */
export type LabelSupport =
  | { kind: 'link-segment'; link: string; segment: number; through?: number }
  | { kind: 'merge-run'; bundle: string; run: string };

export interface LayoutLabel extends OwnedElement {
  id: string;
  text: string;
  /** A pill label's exact port; sharing a node owner does not exempt every pill collision. */
  port?: PortRef;
  role?: 'node' | 'description' | 'group' | 'link' | 'pill' | 'legend' | 'mesh-bus';
  support?: LabelSupport;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: 400 | 700;
  lineHeight?: number;
  lines?: string[];
  /** Degrees, counter-clockwise negative; `-90` for a vertical run, any angle for a straight member. */
  textRotation?: number;
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
  /** The authored `class` tokens, verbatim; the renderer and the legend filter reserved ones. */
  class?: string;
  side?: Side;
  /** Capacity estimate only; stage 5 chooses the final side from actual peer positions. */
  sizingSide?: Side;
  /** Set only on a port a side hint moved (docs/design/side-faces.md, Section 3): `side` is the hinted lateral side. */
  sideHint?: true;
  /** With `sideHint`: the hint is for the routed L through a side lane (ticket 119), so the link never takes a chord and 7a reserves the lane. */
  laneHint?: true;
  /** With `sideHint`: the side stages 2 and 5 give this port without the hint. Bus edges and title edges read it. */
  naturalSide?: Side;
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
  /** A rank cell names the document group whose frame it belongs to; see `NormalisedFrame`. */
  frame?: string;
  bounds?: Rect;
  rowOrder?: string[];
  flank?: { align: 'left' | 'right'; of: string; proxyPeer?: string; primaryPeer?: string };
}

/**
 * The drawn box of a document group that stage 1 replaced by rank cells (ranked-groups spec, section
 * 2), derived from cell geometry by `rebuildFrames`. `cells` are its own cells in rank order; a child
 * frame names its `parent`, and the parent's box holds the child's box plus group padding.
 * `tier` is the sub-tier of the frame's top cell. Present only when `document.frames` is.
 */
export interface Frame {
  id: string;
  label: string;
  class?: string;
  /** `canton` for the frame of a canton: no cell of its own, its box holds its member frames. */
  kind?: 'canton';
  parent?: string;
  cells: string[];
  box: Rect;
  tier: number;
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
  /**
   * A straight bundle member (ADR-0017): the one diagonal between the two stems of a heavily
   * inverted bundle. G5 accepts it in place of an axis-aligned segment; G4 and G6 measure it by
   * distance like any segment, and the crossing counter counts each crossing pair once.
   */
  straight?: true;
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
  technique?: Route | 'mesh-bus';
  /**
   * Effective stroke width, resolved in stage 1 from the author's `weight` multiplier and omitted
   * when it is the shared default. Placement reserves stroke-aware space from it before any path
   * exists; `score` and `render` read the same number through `linkStrokeWidth`.
   */
  strokeWidth?: number;
  bundle?: string;
  groupLink?: string;
  /** The mesh bus (`meshBuses`) this overlay link is a member of (docs/design/mesh-bus.md); its ends sit on the bus ports. */
  meshBus?: string;
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
  /**
   * Stage 8 discarded this link's route because the router skipped a required checkpoint
   * (`ROUTE_CHECKPOINT_SKIPPED`). A removed link has no path and is not drawn; `LayoutModel.removedLinks` lists it.
   */
  removed?: true;
}

export interface Lane extends OwnedElement {
  id: string;
  /**
   * `transit` (absent reads `transit`, so an old layout restores): a full-band vertical run in a sub-tier the link crosses.
   * `side`: the run beside the lateral end's node from the band edge facing the far end to the lateral port's y, with the side run
   * to the port's face (docs/design/side-faces.md, Section 10). Its id is `side-lane:<link id>`.
   */
  kind?: 'transit' | 'side';
  /** A side lane only: the lateral port the lane serves. `tier` is that end's sub-tier, `side` the port's side, `group` its group. */
  port?: PortRef;
  /** A side lane only: 7a seated the lane on the far port's x (`chosen === farX`), so its part is a drop. A lane that centring (7c) seated is recorded by `SIDE_LANE_SEATED`. `SIDE_SHAPE_LOST` reads both. */
  aligned?: true;
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
  /** The group whose title this is; for a frame's title, the frame's id, and `host` is the cell that holds it. */
  group: string;
  /** The rank cell that holds a frame's band: its top cell for a top title, its bottom cell for a bottom one. */
  host?: string;
  /**
   * The horizontal group edge the title occupies: the one with fewer incident link ports, so a
   * group fed from above carries its title at the bottom and no link has to route around it.
   * Ties, including groups linked only sideways, keep the top.
   */
  side: 'top' | 'bottom';
  bounds: Rect;
  /**
   * Reserved vertical gap between the band and the group's nearest node on that side. It is the
   * ordinary group padding unless a routed outward stem or shared prefix at a port on that side
   * needs more room to keep its entry points outside the stroke-aware band obstacle.
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
  /** `symbol:<class>`, `line:<class>` or `port:<role>`; the rendered `data-id` and the acceptance key. */
  id: string;
  /** A `port` entry stands for one port role: its swatch is a pill drawn with `.pill.<role>`. */
  kind: 'symbol' | 'line' | 'port';
  /** The document class this entry stands for; `LEGEND_DEFAULT_CLASS` for links without one. */
  key: string;
  /** Profile icon of a symbol entry, absent when the class resolves to none. */
  icon?: string;
  /** Effective stroke width of a line entry; identical to the width `score` measures. */
  strokeWidth?: number;
  /** Corner radius of a port entry's pill swatch, the same as every drawn pill. */
  radius?: number;
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

/**
 * A full mesh of same-class overlay links among three or more nodes of one row, drawn as one bar
 * (docs/design/mesh-bus.md, Q105). Stage 1 decides it; it has no geometry until tickets 83 and 84.
 */
export interface MeshBus extends OwnedElement {
  id: string;
  class?: string;
  /** The row: the sub-tier its members stand on, in every frame and canton of the sheet. */
  row: number;
  /** `in-frame` when every member stands in one frame (a cell, a one-rank group or a `row` group), else `across-frames`. */
  placement: 'in-frame' | 'across-frames';
  /** The frames, or the one-rank groups with no frame, the members stand in, in order of first member. */
  frames: string[];
  /** Members in declaration order. */
  nodes: string[];
  /** The bus port of each member, same order as `nodes`. */
  ports: PortRef[];
  /** Member link ids. */
  members: string[];
  /** The group-links the bus dissolved (their former ids), whole or in part. */
  dissolved: string[];
  /** On both buses of a join (mesh-bus.md, section 11): the other bus. */
  joined?: string;
  /** On the upper bus of a join only: the cross link ids (links with `meshBus` equal to this bus, not members). */
  cross?: string[];
  /** On both buses of a join: the node count of the whole mesh (both buses), which the one label names. */
  meshNodes?: number;
  /**
   * On the upper bus of a join, from stage 7a (mesh-bus.md, section 11.5): the riser, a vertical at one immutable `x` that joins the two bars;
   * `lanes` are the riser lane ids in crossed sub-tier order (empty for adjacent rows); `from` and `to` are its ends on the upper and the lower bar, from 7f.
   */
  riser?: { x: number; lanes: string[]; from?: Point; to?: Point };
  /** The horizontal edge of the row the bar stands on; fixed by stage 5 (docs/design/mesh-bus.md, section 4). */
  side?: 'top' | 'bottom';
  /** From 7f on: the bar, from the first bus port's x to the last. */
  bar?: { from: Point; to: Point };
  /** From 7f on: one stub per member, from the port's outward face straight to the bar. */
  stubs?: { node: string; from: Point; to: Point }[];
  /** From 7f on: the x interval of the bar the label stands in (`undefined`: no interval holds it), for stage 9. */
  labelRoom?: { from: number; to: number };
  /** From stage 9 on: the id of the bus label (`label:bus:<id>`); the label is omitted, with its text as tooltip, where no room held it. */
  label?: string;
}

/** The bus band 7f reserves: `group` names the host of an in-frame band, and is absent across frames. */
export interface BusBand extends OwnedElement {
  id: string;
  bus: string;
  group?: string;
  side: 'top' | 'bottom';
  bounds: Rect;
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
  /** Absent when the document holds no mesh bus. */
  meshBuses?: MeshBus[];
  /** Absent when no bus has a band; 7f publishes them. */
  busBands?: BusBand[];
  /** The ids of the titles 7f moved to their other edge (`MESH_BUS_TITLE_MOVED`); absent when none. */
  titleMoves?: string[];
  obstacles: Obstacle[];
  diagnostics: Diagnostic[];
  runtime: LayoutRuntime;
  /** Measured by stage 9 inside the link-label transaction; absent when one variant or none. */
  legend?: Legend;
  canvas?: Rect;
  anchorTier?: number;
  fallbackUsed?: boolean;
  deadlineHit?: boolean;
  /** Ids of the links stage 8 removed, in model order; absent when none. The score report counts them. */
  removedLinks?: string[];
  /**
   * The links that hold a straight chord (ticket 34) when stage 7f begins. From then on the chord is a wall:
   * its geometry follows the ports, the decision is never re-taken, and a move that would put a body on it is refused.
   */
  frozenChords?: string[];
  /** One per `document.frames` entry, in document order; absent when no group was replaced by cells. */
  frames?: Frame[];
}

export interface FrozenPort {
  ref: PortRef;
  side: Side;
  authorOrder?: number;
  sideHint?: true;
  laneHint?: true;
  naturalSide?: Side;
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
  /** Present only when a run was given size floors for its hinted nodes (side-faces.md, Section 8): the stage-3 floor of each such node. */
  nodeFloors?: { node: string; size: Size }[];
  placement?: PlacementSnapshot;
}

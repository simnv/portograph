import type { Endpoint, NormalisedDocument, PortRef, Route } from './document.js';
import type { Point, Rect, Side, Size } from './geometry.js';

/** Last completed stage; checked transactions enforce progression after sides-two. */
export type LayoutStage = 'normalised' | 'resolve' | 'sides-one' | 'size' | 'skeleton'
  | 'sides-two' | 'rows' | 'lanes' | 'flanks' | 'centre' | 'bars' | 'bundles'
  | 'bands' | 'route' | 'link-labels' | 'validate' | 'emit';

export type Layer = 'routed' | 'overlay';
export type Owner =
  | { kind: 'node' | 'group' | 'link' | 'group-link' | 'bundle' | 'shared-stem' | 'lane'; id: string }
  | { kind: 'barCross'; node: string; link: string };

export interface OwnedElement {
  owner: Owner;
  layer: Layer;
}

export interface LayoutLabel extends OwnedElement {
  id: string;
  text: string;
  /** A pill label's exact port; sharing a node owner does not exempt every pill collision. */
  port?: PortRef;
  role?: 'node' | 'description' | 'group' | 'link' | 'pill' | 'legend';
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
  bundle?: string;
  groupLink?: string;
  /** Routing must first resolve group endpoints to concrete port refs. */
  attachments?: { from: PortRef; to: PortRef };
  path?: LayoutPath;
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
  memberGap?: number;
  rows?: Rect;
  centreline?: LayoutPath;
  envelope?: Rect;
  inversions?: number;
}

export interface Junction extends OwnedElement {
  id: string;
  port: PortRef;
  links: string[];
  point?: Point;
  stem?: PathSegment;
}

export interface LabelBand extends OwnedElement {
  id: string;
  group: string;
  bounds: Rect;
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

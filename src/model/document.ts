import type { Side, Size } from './geometry.js';

export type GroupShape = 'ranked' | 'row' | 'bar' | 'grid' | 'ring' | 'free';
export type Route = 'orthogonal' | 'straight' | 'bundle' | 'merge' | 'overlay' | 'stub' | 'group-link';

export interface NamedPortIdentity {
  name: string;
  ordinal: number;
  anonymous?: never;
}

/** Anonymous ordinals count anonymous ports within their node, starting at 1. */
export interface AnonymousPortIdentity {
  anonymous: true;
  ordinal: number;
  name?: never;
}

export type PortIdentity = NamedPortIdentity | AnonymousPortIdentity;
export type PortRef = PortIdentity & { node: string; group?: never };
export interface GroupRef {
  group: string;
  node?: never;
}
export type Endpoint = PortRef | GroupRef;

/**
 * Author metadata that the pipeline carries and never reads. The draw.io export writes each entry
 * as an attribute of the cell (docs/drawio-binding-contract.md). Present only when the author wrote `meta:`.
 */
export type Meta = Record<string, string | number | boolean>;

/** `class` is the port's author tokens: a profile role, a status, or anything a `css:` rule names. */
export type NormalisedPort = PortIdentity & { side?: Side; order?: number; class?: string; meta?: Meta };

export interface GroupContent {
  label: string;
  shape: GroupShape;
  class?: string;
  collapsed?: boolean;
  layout?: Record<string, string | number | boolean>;
  /** A child group names its parent; one level only. A child has no tier of its own and takes its parent's. */
  parent?: string;
  /** A member (a tier group) names its canton (docs/design/canton-groups.md, Section 1). Stage 1 turns it into `frames[member].parent`. */
  canton?: string;
  /** Set by stage 1 on a rank cell: the document group whose frame the cell is part of. */
  frame?: string;
  /** Set by stage 1 on an expanded document: the authored tier, which `tier` no longer is once a tier takes several sub-tiers (routed chords read it). */
  documentTier?: number;
}

export type NormalisedGroup = GroupContent & (
  | { tier: number; align?: never; of?: never; members?: never }
  | { align: 'left' | 'right'; of: string; tier?: never; members?: never }
  /** A canton entry: no tier, no flank. `members` are its valid member tier groups, in declaration order. */
  | { members: string[]; tier?: never; align?: never; of?: never }
);

/**
 * Stage 1 record of a document group that was replaced by rank cells (docs/design/ranked-groups.md,
 * section 2). The frame is the drawn box; it is derived after placement from its cells. `cells` are
 * the frame's own cells in rank order; the cells of a child frame are listed under the child, and a
 * child names its parent frame in `parent`. A cell `X#r` is rank `r` of the frame tree (`r` counts
 * from the top of the parent, so a child's cells carry the parent's rank numbers).
 */
export interface NormalisedFrame {
  label: string;
  class?: string;
  /** `canton`: the frame of a canton (docs/design/canton-groups.md, Section 3); it has no cell of its own, only member frames. */
  kind?: 'canton';
  parent?: string;
  cells: string[];
}

export interface NormalisedNode {
  group: string;
  label: string;
  ports: NormalisedPort[];
  class?: string;
  description?: string;
  icon?: string;
  size?: Size;
  meta?: Meta;
}

export interface NormalisedLink {
  /** The author's own link id. Without it, `linkIds` derives one from the two ends. */
  id?: string;
  from: Endpoint;
  to: Endpoint;
  class?: string;
  label?: string;
  route?: Route;
  weight?: number;
  meta?: Meta;
}

/** Stage 0 output. Explicit order metadata preserves integer-like ID declaration order. */
export interface NormalisedDocument {
  portograph: 2;
  profile: string;
  groups: Record<string, NormalisedGroup>;
  /** Emitted only when stage 1 replaced a group by rank cells. Keyed by the replaced group's id. */
  frames?: Record<string, NormalisedFrame>;
  nodes: Record<string, NormalisedNode>;
  links: NormalisedLink[];
  /** Emitted only when group declaration order differs from Object.keys(groups). */
  groupOrder?: string[];
  /** Emitted only when node declaration order differs from Object.keys(nodes). */
  nodeOrder?: string[];
  title?: string;
  css?: string;
  overlays?: Record<string, 'hidden' | 'visible'>;
  /** Document settings, present only when the author wrote `layout:` at the root (ticket 152). */
  layout?: {
    /** When true, an overlay link blocked only by node bodies is drawn as the straight chord over them. Default false. */
    overlayOverBodies?: boolean;
    /**
     * When false, every free row keeps the order the skeleton gave it, and the corridor row order (architecture-2 ticket 17) records
     * `author` for it. Default true: a free row takes the order that the corridors through it cross least.
     */
    corridorRowOrder?: boolean;
  };
  /** Document metadata, present only when the author wrote `meta:` at the root. No cell inherits it. */
  meta?: Meta;
}

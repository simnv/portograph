import type { Side, Size } from './geometry.js';

export type GroupShape = 'row' | 'bar' | 'grid' | 'ring' | 'free';
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

/** `class` is the port's author tokens: a profile role, a status, or anything a `css:` rule names. */
export type NormalisedPort = PortIdentity & { side?: Side; order?: number; class?: string };

export interface GroupContent {
  label: string;
  shape: GroupShape;
  class?: string;
  collapsed?: boolean;
  layout?: Record<string, string | number | boolean>;
}

export type NormalisedGroup = GroupContent & (
  | { tier: number; align?: never; of?: never }
  | { align: 'left' | 'right'; of: string; tier?: never }
);

export interface NormalisedNode {
  group: string;
  label: string;
  ports: NormalisedPort[];
  class?: string;
  description?: string;
  icon?: string;
  size?: Size;
}

export interface NormalisedLink {
  from: Endpoint;
  to: Endpoint;
  class?: string;
  label?: string;
  route?: Route;
  weight?: number;
}

/** Stage 0 output. Explicit order metadata preserves integer-like ID declaration order. */
export interface NormalisedDocument {
  portograph: 2;
  profile: string;
  groups: Record<string, NormalisedGroup>;
  nodes: Record<string, NormalisedNode>;
  links: NormalisedLink[];
  /** Emitted only when group declaration order differs from Object.keys(groups). */
  groupOrder?: string[];
  /** Emitted only when node declaration order differs from Object.keys(nodes). */
  nodeOrder?: string[];
  title?: string;
  css?: string;
  overlays?: Record<string, 'hidden' | 'visible'>;
}

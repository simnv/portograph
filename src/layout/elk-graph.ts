/**
 * The ELK JSON graph, as far as portograph writes and reads it: a structural subset of elkjs's
 * `ElkNode` (`elkjs/lib/elk-api.d.ts`). It is declared here so the published declarations name no
 * elkjs type and type-check in a strict consumer without `skipLibCheck`. elkjs's own `ElkNode` is
 * assignable to it.
 */
export interface ElkLayoutOptions { [key: string]: string }

/** A box ELK sizes and places; `x` and `y` are relative to the parent. */
export interface ElkShape {
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  labels?: ElkShape[];
  layoutOptions?: ElkLayoutOptions;
}

export interface ElkPort extends ElkShape { id: string }

/** A hyperedge between port ids; portograph reads no edge geometry back. */
export interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
  labels?: ElkShape[];
  layoutOptions?: ElkLayoutOptions;
}

export interface ElkNode extends ElkShape {
  id: string;
  children?: ElkNode[];
  ports?: ElkPort[];
  edges?: ElkEdge[];
}

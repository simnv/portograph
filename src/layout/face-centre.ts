import type { LayoutModel, LayoutNode } from '../model/layout.js';
import type { Side } from '../model/geometry.js';
import { findPort } from './row-paths.js';
import { PLACEMENT_EPS } from './tolerance.js';

const HORIZONTAL: readonly Side[] = ['top', 'bottom'];
/** A port is aligned with its peer when the two stand on one vertical within this distance. */
const ALIGNED = 1e-3;

/** The room before the first port and after the last port of a face, and where the first port stands. Undefined for a face with no port. */
function margins(node: LayoutNode, side: Side): { low: number; high: number; first: number } | undefined {
  const xs = node.ports.filter(port => port.side === side && port.anchor !== undefined).map(port => port.anchor!.x);
  if (!xs.length) return undefined;
  const box = node.bounds!, first = Math.min(...xs);
  return { low: first - box.x, high: box.x + box.width - Math.max(...xs), first };
}

/** A face whose port block stood centred on it when centring began, and the place and width it stood at. */
export interface SeatedFace { node: string; side: Side; width: number; first: number; low: number }

/**
 * The horizontal faces seated centred by stage 5 (`rebuildNodeGeometry`), read as centring begins (architecture ticket 10, defect D3). Centring
 * widens a body for an alignment and leaves the ports of every other face where they were, so an untouched face ends with its block bunched at one
 * end. A block that is not centred when centring begins was placed by an earlier rule (under its peers, behind a bundle, on a held chord) and is
 * not recorded.
 */
export function seatedFaces(model: LayoutModel): SeatedFace[] {
  const faces: SeatedFace[] = [];
  for (const node of Object.values(model.nodes)) {
    if (node.bounds === undefined) continue;
    for (const side of HORIZONTAL) {
      const m = margins(node, side);
      if (m !== undefined && Math.abs(m.low - m.high) <= PLACEMENT_EPS) faces.push({ node: node.id, side, width: node.bounds.width, first: m.first, low: m.low });
    }
  }
  return faces;
}

/** Whether any link at a port of the face runs straight down to a peer on the same vertical, or is a bus stub: those positions are not ours to move. */
function pinned(model: LayoutModel, node: LayoutNode, side: Side): boolean {
  const own = new Set(node.ports.filter(port => port.side === side).map(port => port.anchor));
  for (const link of model.links) {
    if (!link.attachments) continue;
    if (link.technique === 'mesh-bus') {
      if ([link.attachments.from, link.attachments.to].some(ref => ref.node === node.id)) return true;
      continue;
    }
    const one = findPort(model, link.attachments.from), two = findPort(model, link.attachments.to);
    if (!one?.anchor || !two?.anchor) continue;
    const mine = own.has(one.anchor) ? one : own.has(two.anchor) ? two : undefined;
    if (mine === undefined) continue;
    const peer = mine === one ? two : one;
    if (Math.abs(peer.anchor!.x - mine.anchor!.x) <= ALIGNED) return true;
  }
  return false;
}

/**
 * Centre again, once, the faces `seatedFaces` recorded that centring left alone but whose body it widened. A face is left alone when its first port
 * stands where it stood (in the drawing, or from the left edge of its body). The block keeps its pitch and its order and moves by half the difference
 * of its two margins; it writes no width and reads no feed, so it cannot feed back into the growth. A face with a port aligned to a peer, a bus
 * stub, or a node on a bar keeps its positions: they were set on purpose.
 */
export function recentreSeatedFaces(model: LayoutModel, faces: readonly SeatedFace[]): void {
  for (const face of faces) {
    const node = model.nodes[face.node]!, box = node.bounds;
    if (box === undefined || box.width <= face.width + PLACEMENT_EPS) continue;
    if (model.document.groups[model.document.nodes[face.node]!.group]?.shape === 'bar') continue;
    const m = margins(node, face.side);
    if (m === undefined) continue;
    if (Math.abs(m.first - face.first) > PLACEMENT_EPS && Math.abs(m.low - face.low) > PLACEMENT_EPS) continue;
    const shift = (m.high - m.low) / 2;
    if (Math.abs(shift) <= PLACEMENT_EPS || pinned(model, node, face.side)) continue;
    for (const port of node.ports) if (port.side === face.side && port.anchor !== undefined) port.anchor.x += shift;
  }
}

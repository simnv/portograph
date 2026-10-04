import type { LayoutModel } from '../../model/layout.js';
import { COLUMN_SLACK } from '../columns.js';
import { CELL_TO_CHILD_FRAME_GAP, FRAME_TO_FRAME_GAP, cellReach, isTransitKind } from '../frames.js';
import { GROUP_PADDING } from '../regions.js';
import { bandGap } from '../skeleton-graph.js';
import { ownerId, type Constraint, type ConstraintKind, type Term } from './types.js';

export interface CatalogueOptions {
  /** The layout the anchor tier must not move from. Without it the anchor entries are unsupported: against the layout itself they are vacuous. */
  reference?: LayoutModel;
  /**
   * The layout whose left-to-right order of siblings is the branch the separations hold (a reference layout, the ELK order). Without it the
   * order is read from the checked layout itself and every separation is marked conditional on that published order.
   */
  orderFrom?: LayoutModel;
}

interface Item { id: string; owner: string; frame: boolean; left: Term; right: Term; l: number; r: number; y0: number; y1: number }

/** Owners are keyed by kind and id, so a frame and a cell that share an id stay two owners. */
export const groupOwner = (id: string): string => `group:${id}`;
export const frameOwner = (id: string): string => `frame:${id}`;

const group = (owner: string, offset: number): Term => ({ at: 'group', owner, offset });
const frameLeft = (owner: string): Term => ({ at: 'frame-left', owner, offset: 0 });
const frameRight = (owner: string): Term => ({ at: 'frame-right', owner, offset: 0 });
const fixed = (offset: number): Term => ({ at: 'fixed', owner: '', offset });

/** Two extents overlap by more than a pixel: y is not a variable of an x solve, so this is a fixed input. */
const overlap = (a0: number, a1: number, b0: number, b1: number): boolean => Math.min(a1, b1) - Math.max(a0, b0) > 1;
const shareY = (a: Item, b: Item): boolean => overlap(a.y0, a.y1, b.y0, b.y1);

const HULL: ReadonlySet<ConstraintKind> = new Set(['containment-cell', 'containment-child-frame', 'containment-held-lane']);

/**
 * The x catalogue of a layout model. Each entry names its source rule, its anchor and the `basis` of its bound. The gaps come from named
 * constants; a published gap is never read back as a bound. What is read from the model is stated as a `branch` or an input: the order of
 * siblings (from `orderFrom`, else the published order, and then marked so), the vertical extents (y is fixed in an x solve), the
 * offsets of bodies and ports inside their group (a group is rigid), and the side of a lane a group stands on.
 *
 * Containment entries are `role: 'hull'`: `deriveFrames` builds frame boxes from the same terms (`cellReach`, child frames grown by
 * `GROUP_PADDING`, `transitLanes`), so they hold on pipeline output by construction. They are valid constraints for a solve and no evidence.
 * No non-circular containment check exists yet: no authored or reserved frame width is stored in the model for a member to be checked against.
 */
export function xCatalogue(model: LayoutModel, options: CatalogueOptions = {}): Constraint[] {
  const out: Constraint[] = [];
  const seen = new Map<string, number>();
  const groups = Object.values(model.groups).filter(item => item.bounds !== undefined);
  const frames = model.frames ?? [];
  const docFrames = model.document.frames ?? {};
  const bg = bandGap(model);
  const orderModel = options.orderFrom ?? model;
  const orderNote = options.orderFrom ? 'order from the reference layout' : 'conditional on the published order of the checked layout';

  const push = (entry: Omit<Constraint, 'id' | 'role'>): void => {
    const base = `${entry.kind}:${[...entry.owners].sort().join('|')}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push({ ...entry, id: n === 0 ? base : `${base}/${n}`, role: HULL.has(entry.kind) ? 'hull' : 'evidence' });
  };
  const hard = (kind: ConstraintKind, owners: string[], source: string, basis: string, anchor: Constraint['anchor'], a: Term, b: Term, bound: number,
    extra: Partial<Constraint> = {}): void => push({ kind, strength: 'hard', owners, source, basis, anchor, contract: 'known', support: 'difference', a, b, bound, ...extra });

  // --- anchor tier fixed (pipeline.md 7c, mutation permissions): the tier the author fixed does not move.
  const anchorSource = 'pipeline.md 7c; mutation.ts "Centring cannot move anchor tier or flanks"';
  for (const item of groups.filter(entry => entry.tier === model.anchorTier)) {
    const at = options.reference?.groups[item.id]?.bounds?.x;
    if (at === undefined) {
      push({ kind: 'anchor-tier-fixed', strength: 'hard', owners: [groupOwner(item.id)], source: anchorSource, basis: 'reference layout', anchor: 'author-intent',
        contract: 'known', support: 'unsupported', bound: 0, note: 'needs a reference layout; against itself the relation is vacuous' });
      continue;
    }
    for (const [from, to] of [[fixed(at), group(item.id, 0)], [group(item.id, 0), fixed(at)]] as const) {
      hard('anchor-tier-fixed', [groupOwner(item.id)], anchorSource, 'reference layout', 'author-intent', from, to, 0);
    }
  }

  // --- reach of a cell: its bodies grown by the documented padding (frames.ts `cellReach`), as an offset from the box x.
  const reach = new Map<string, { dl: number; dr: number }>();
  for (const item of groups) {
    const r = cellReach(model, item.id), b = item.bounds!;
    reach.set(item.id, { dl: r.x - b.x, dr: r.x + r.width - b.x });
  }
  const cellsDeep = (id: string): string[] => {
    const cells = [...docFrames[id]!.cells];
    for (const key of Object.keys(docFrames)) if (docFrames[key]!.parent === id) cells.push(...cellsDeep(key));
    return cells;
  };
  const nodesOf = (id: string): Set<string> => new Set(cellsDeep(id).flatMap(cell => model.groups[cell]!.nodes));

  // --- containment, role hull (see above).
  const cellSource = 'frames.ts cellReach (group padding + GROUP_PADDING); deriveFrames';
  const childSource = 'frames.ts deriveFrames: the parent holds the child grown by GROUP_PADDING';
  const laneSource = 'ADR-0010 (lane x fixed after 7a); frame-held-lanes; frames.ts transitLanes';
  for (const frame of frames) {
    const fo = frameOwner(frame.id);
    for (const cell of frame.cells) {
      if (!model.groups[cell]?.bounds) continue;
      const r = reach.get(cell)!;
      hard('containment-cell', [fo, groupOwner(cell)], cellSource, 'cellReach', 'documented-clearance', frameLeft(frame.id), group(cell, r.dl), 0);
      hard('containment-cell', [fo, groupOwner(cell)], cellSource, 'cellReach', 'documented-clearance', group(cell, r.dr), frameRight(frame.id), 0);
    }
    for (const child of frames.filter(item => item.parent === frame.id)) {
      hard('containment-child-frame', [fo, frameOwner(child.id)], childSource, 'GROUP_PADDING', 'documented-clearance', { ...frameLeft(frame.id), offset: GROUP_PADDING }, frameLeft(child.id), 0);
      hard('containment-child-frame', [fo, frameOwner(child.id)], childSource, 'GROUP_PADDING', 'documented-clearance', frameRight(child.id), { ...frameRight(frame.id), offset: -GROUP_PADDING }, 0);
    }
    // Held lanes: a transit or riser lane of a link that touches the frame stays inside it.
    const cells = new Set(cellsDeep(frame.id)), inside = nodesOf(frame.id);
    for (const lane of model.lanes) {
      if (!cells.has(lane.group) || !isTransitKind(lane)) continue;
      if (lane.owner.kind === 'mesh-bus') {
        const bus = model.meshBuses?.find(item => item.id === ownerId(lane.owner)), other = model.meshBuses?.find(item => item.id === bus?.joined);
        if (!bus || ![...bus.nodes, ...(other?.nodes ?? [])].some(node => inside.has(node))) continue;
      } else {
        const link = model.links.find(item => item.id === ownerId(lane.owner));
        if (!link?.attachments || ![link.attachments.from.node, link.attachments.to.node].some(node => inside.has(node))) continue;
      }
      const extra = { branch: 'the lane is owned by a link that touches the frame' };
      hard('containment-held-lane', [fo, `lane:${lane.id}`], laneSource, 'lane bounds', 'declared-reservation', frameLeft(frame.id), fixed(lane.bounds.x), 0, extra);
      hard('containment-held-lane', [fo, `lane:${lane.id}`], laneSource, 'lane bounds', 'declared-reservation', fixed(lane.bounds.x + lane.bounds.width), frameRight(frame.id), 0, extra);
    }
  }

  // --- separation per scope. Source rules: Q80 band gap, `runSpacing`, FRAME_TO_FRAME_GAP, CELL_TO_CHILD_FRAME_GAP, `placeFlanksAndPeers`.
  //     The order of the siblings is a conditional choice (`orderFrom`, else the published order), and so is the adjacency read from the fixed y extents.
  const frameBox = new Map(frames.map(item => [item.id, item.box]));
  const orderX = (item: Item): number => {
    if (item.frame) { const box = orderModel.frames?.find(f => f.id === item.id)?.box; return box ? box.x : item.l; }
    return orderModel.groups[item.id]?.bounds?.x !== undefined ? orderModel.groups[item.id]!.bounds!.x + (item.l - model.groups[item.id]!.bounds!.x) : item.l;
  };
  const frameItem = (id: string): Item => { const b = frameBox.get(id)!; return { id, owner: frameOwner(id), frame: true, left: frameLeft(id), right: frameRight(id), l: b.x, r: b.x + b.width, y0: b.y, y1: b.y + b.height }; };
  const cellItem = (id: string, whole: boolean): Item => {
    const g = model.groups[id]!, b = g.bounds!, r = reach.get(id)!, dl = whole ? 0 : r.dl, dr = whole ? b.width : r.dr;
    return { id, owner: groupOwner(id), frame: false, left: group(id, dl), right: group(id, dr), l: b.x + dl, r: b.x + dr, y0: b.y, y1: b.y + b.height };
  };
  const scopes = [
    { name: '(root)', root: true, items: [...frames.filter(item => item.parent === undefined).map(item => frameItem(item.id)), ...groups.filter(item => item.frame === undefined).map(item => cellItem(item.id, true))] },
    ...frames.map(frame => ({ name: frame.id, root: false,
      items: [...frame.cells.filter(cell => model.groups[cell]?.bounds).map(cell => cellItem(cell, false)), ...frames.filter(item => item.parent === frame.id).map(item => frameItem(item.id))] })),
  ];
  for (const scope of scopes) {
    const items = scope.items.slice().sort((p, q) => orderX(p) - orderX(q) || (p.id < q.id ? -1 : 1));
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!, b = items[j]!;
      if (!shareY(a, b)) continue;
      if (items.some((c, k) => k > i && k < j && shareY(a, c) && shareY(c, b))) continue;
      const flank = (item: Item): boolean => !item.frame && model.groups[item.id]?.flank !== undefined;
      let kind: ConstraintKind, gap: number, source: string, basis: string, contract: Constraint['contract'] = 'known', note: string | undefined;
      if (scope.root && a.frame && b.frame) { kind = 'separation-root-frames'; gap = bg; basis = 'bandGap'; source = 'Q80, Q102: sibling columns a band gap apart (bandGap)'; }
      else if (scope.root && (a.frame || b.frame)) { kind = 'separation-root-frame-group'; gap = bg + COLUMN_SLACK; basis = 'bandGap + COLUMN_SLACK'; source = 'Q80 bandGap + COLUMN_SLACK (columns.ts runSpacing: the frame keeps its margin beside a plain group)'; }
      else if (scope.root && (flank(a) || flank(b))) { kind = 'separation-flank'; gap = bg; basis = 'bandGap'; source = 'skeleton-geometry.ts placeFlanksAndPeers: a flank stands a bandGap from its core; centre.ts flank window keeps it'; }
      else if (scope.root) { kind = 'separation-root-groups'; gap = bg; basis = 'bandGap'; source = 'Q80 band gap between group boxes (bandGap)'; }
      else if (a.frame && b.frame) { kind = 'separation-frame-frames'; gap = FRAME_TO_FRAME_GAP; basis = 'FRAME_TO_FRAME_GAP'; source = 'FRAME_TO_FRAME_GAP (columns.ts packBesideRows)'; }
      else if (a.frame || b.frame) { kind = 'separation-cell-child-frame'; gap = CELL_TO_CHILD_FRAME_GAP; basis = 'CELL_TO_CHILD_FRAME_GAP'; source = 'CELL_TO_CHILD_FRAME_GAP, measured from cellReach (columns.ts packBesideRows)'; }
      else { kind = 'separation-frame-cells'; gap = 0; basis = 'zero (non-overlap)'; source = 'cellReach of two cells of one frame must not overlap (no named gap: the reach already holds GROUP_PADDING on each side)'; contract = 'translation'; note = 'the gap is this catalogue\'s reading: no code constant names a cell-to-cell gap inside a frame'; }
      hard(kind, [a.owner, b.owner], source, basis, 'documented-clearance', a.right, b.left, gap, { branch: `${a.id} before ${b.id} in scope ${scope.name}; ${orderNote}`, contract, note });
    }
  }

  // --- lane clearance (ADR-0010): a group of the lane's sub-tier keeps the side of the lane it stands on. One extent, the body extent,
  //     picks the side and is checked; the lane constrains only a group whose bodies share a y extent with the lane.
  for (const lane of model.lanes) for (const g of groups.filter(item => item.tier === lane.tier)) {
    const bodies = g.nodes.map(node => model.nodes[node]!.bounds!);
    if (!bodies.length) continue;
    const y0 = Math.min(...bodies.map(body => body.y)), y1 = Math.max(...bodies.map(body => body.y + body.height));
    if (!overlap(y0, y1, lane.bounds.y, lane.bounds.y + lane.bounds.height)) continue;
    const left = Math.min(...bodies.map(body => body.x)), right = Math.max(...bodies.map(body => body.x + body.width));
    const bl = left - g.bounds!.x, br = right - g.bounds!.x;
    const east = (left + right) / 2 >= lane.x;
    const entry = { branch: `${g.id} stands ${east ? 'right' : 'left'} of ${lane.id} (body extent)`, contract: 'translation' as const, note: 'body extent against the lane bounds; the lane keeps its published x (ADR-0010)' };
    const owners = [`lane:${lane.id}`, groupOwner(g.id)];
    if (east) hard('lane-clearance', owners, 'ADR-0010: lanes keep x and owner after 7a', 'lane bounds', 'declared-reservation', fixed(lane.bounds.x + lane.bounds.width), group(g.id, bl), 0, entry);
    else hard('lane-clearance', owners, 'ADR-0010: lanes keep x and owner after 7a', 'lane bounds', 'declared-reservation', group(g.id, br), fixed(lane.bounds.x), 0, entry);
  }

  // --- soft: port alignment. A vertical link between two groups wants its ports on one x (R2 feeds, R7 chords); the discrete choice is the published side.
  const nodeGroup = new Map<string, string>();
  for (const g of groups) for (const node of g.nodes) nodeGroup.set(node, g.id);
  const laneOwned = new Set(model.lanes.filter(lane => lane.owner.kind === 'link').map(lane => ownerId(lane.owner)));
  const portOffset = (node: string, ref: { ordinal?: number; name?: string }): { dx: number; side: string } | undefined => {
    const n = model.nodes[node]!;
    const port = n.ports.find(item => ref.name !== undefined ? item.ref.name === ref.name : item.ref.ordinal === ref.ordinal && item.ref.anonymous === true);
    const g = model.groups[nodeGroup.get(node)!];
    return port?.anchor && g?.bounds ? { dx: port.anchor.x - g.bounds.x, side: port.side ?? '' } : undefined;
  };
  for (const link of model.links) {
    if (link.technique === 'mesh-bus' || link.meshBus !== undefined || !link.attachments || !link.path) continue;
    const ends = link.attachments, ga = nodeGroup.get(ends.from.node), gb = nodeGroup.get(ends.to.node);
    if (!ga || !gb || ga === gb) continue;
    const pa = portOffset(ends.from.node, ends.from), pb = portOffset(ends.to.node, ends.to);
    if (!pa || !pb || !['top', 'bottom'].includes(pa.side) || !['top', 'bottom'].includes(pb.side)) continue;
    const overlay = link.layer === 'overlay';
    if (overlay) {
      push({ kind: 'chord-side', strength: 'hard', owners: [`link:${link.id}`], source: 'R8/R15: tiers between a frozen chord stay free of bodies (tickets 77, 80; ADR-0010 amendment)', basis: 'frozen chord', anchor: 'conditional-choice',
        branch: 'the bodies stand on the published side of the chord', contract: 'known', support: 'unsupported', bound: 0,
        note: 'a body against a chord at fixed y is (1-t)*x_a + t*x_b against x_body: three positions, not a difference constraint; a fixed-endpoint restriction holds only when both ends are fixed' });
    }
    const owned = !overlay && laneOwned.has(link.id);
    push({ kind: overlay ? 'chord-alignment' : 'port-feed-alignment', strength: 'soft', owners: [`link:${link.id}`, groupOwner(ga), groupOwner(gb)],
      source: overlay ? 'Q78, Q86, Q112 (R7): a chord prefers its ports on one x' : 'Q81, ADR-0010 (R2): a feed prefers its child port under the parent port', basis: 'author preference',
      anchor: 'author-intent', branch: `ports on the ${pa.side}/${pb.side} faces as published`, contract: 'known', support: owned ? 'unsupported' : 'difference',
      a: group(ga, pa.dx), b: group(gb, pb.dx), bound: 0, note: owned ? 'the link owns a lane: its segment is bent by design' : undefined });
  }
  return out;
}

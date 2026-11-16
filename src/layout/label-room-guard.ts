/**
 * The same-tier label room as a move reservation (decision review ticket DR-02; ADR-0014 r2: label room is reserved by the producer and the
 * tier-gap solve only). The producer reserves the room of a labelled link along its row once. A move that runs after it (the canton close-up, the
 * keep-out, the linkless step, the centring replay) moves one end of such a link and not the other, and the run shrinks below the label. No pass
 * reserves it again, so the move is held here (R2): a move that would take a row room below what its link reserved is not made. The check reads
 * the model as the move would leave it and asks the producer's own reading (`reserveLinkLabelRoom`, R1) for a row shortfall the model has not now.
 */
import type { LayoutGroup, LayoutModel, LayoutNode } from '../model/layout.js';
import type { Rect } from '../model/geometry.js';
import { reserveLinkLabelRoom, type LinkLabelShortfall } from './bands.js';
import { describedLink, overlayLabelsSuppressed } from './run-label-box.js';
import type { ProposedBox } from './frames.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const isRow = (item: LinkLabelShortfall): boolean => item.axis === 'row' || item.axis === 'row window';

/** The model with the proposed boxes and the bodies that move with them, as `spanBreaches` builds it; the model is not changed. */
function movedModel(model: LayoutModel, proposed: readonly ProposedBox[]): { moved: LayoutModel; shift: Map<string, number> } {
  const groups = { ...model.groups }, nodes = { ...model.nodes }, shift = new Map<string, number>();
  for (const { group, bounds, dx: bodies } of proposed) {
    const dx = bodies ?? bounds.x - group.bounds!.x, dy = bounds.y - group.bounds!.y;
    groups[group.id] = { ...group, bounds: { ...bounds } };
    if (!dx && !dy) continue;
    for (const id of group.nodes) {
      const node = model.nodes[id]!;
      shift.set(id, dx);
      nodes[id] = { ...node, bounds: { ...node.bounds!, x: node.bounds!.x + dx, y: node.bounds!.y + dy },
        ports: node.ports.map(port => ({ ...port, ...(port.anchor ? { anchor: { x: port.anchor.x + dx, y: port.anchor.y + dy } } : {}),
          ...(port.pill ? { pill: { ...port.pill, bounds: { ...port.pill.bounds, x: port.pill.bounds.x + dx, y: port.pill.bounds.y + dy } } } : {}) })) };
    }
  }
  return { moved: { ...model, groups, nodes }, shift };
}

/** The x of every vertical border of a group box that a change moves, before and after, with the tier of the group. */
interface MovedBorders { tier: number | undefined; edges: number[] }
function movedBorders(group: LayoutGroup, was: Rect, now: Rect): MovedBorders {
  const edges: number[] = [];
  if (now.x !== was.x) edges.push(was.x, now.x);
  if (now.x + now.width !== was.x + was.width) edges.push(was.x + was.width, now.x + now.width);
  return { tier: group.tier, edges };
}

/**
 * Whether a change can close a row room: a described link of one tier whose two ends it moves differently (`shift` keys each moved node by its
 * move: a translation by its dx, a resize by both edge moves; a node it does not hold stands still), or a group border of that tier that it moves
 * across the x span of such a link's two end bodies (a border beside or between the ends cuts the window the label rides; review 10b F1).
 * The move guard and the centring step guard read this one scope (R1).
 */
function closesRowRun(model: LayoutModel, shift: ReadonlyMap<string, number | string>, borders: readonly MovedBorders[]): boolean {
  const suppressed = overlayLabelsSuppressed(model);
  return model.links.some(link => {
    if (!link.attachments || !describedLink(model, link, suppressed)) return false;
    const from = link.attachments.from.node, to = link.attachments.to.node;
    const tier = model.groups[model.document.nodes[from]!.group]?.tier;
    if (from === to || tier !== model.groups[model.document.nodes[to]!.group]?.tier) return false;
    if ((shift.get(from) ?? 0) !== (shift.get(to) ?? 0)) return true;
    const a = model.nodes[from]!.bounds!, b = model.nodes[to]!.bounds!;
    const low = Math.min(a.x, b.x), high = Math.max(a.x + a.width, b.x + b.width);
    return borders.some(border => border.tier === tier && border.edges.some(x => x > low && x < high));
  });
}

/** The links with a row shortfall on `model`, by the producer's reading on a copy. */
function rowShort(model: LayoutModel): Set<string> {
  const shortfalls: LinkLabelShortfall[] = [];
  reserveLinkLabelRoom(clone(model), shortfalls);
  return new Set(shortfalls.filter(isRow).map(item => item.link));
}

/** The links with a row shortfall on `model` (the evidence of a resize), or `undefined` when no link carries a label. */
export function rowRoomShortOf(model: LayoutModel): string[] | undefined {
  return model.document.links.some(link => link.label !== undefined) ? [...rowShort(model)] : undefined;
}

/** The links whose row room is short before the move: a move may not add one. Absent when the move cannot close a row run (`closesRowRun`). */
export function rowRoomShortNow(model: LayoutModel, proposed: readonly ProposedBox[]): string[] | undefined {
  if (!model.document.links.some(link => link.label !== undefined)) return undefined;
  const { moved, shift } = movedModel(model, proposed);
  const borders = proposed.map(({ group, bounds }) => movedBorders(group, group.bounds!, bounds));
  return closesRowRun(moved, shift, borders) ? [...rowShort(model)] : undefined;
}

/** Whether the move leaves every row room that held; `allowed` is `rowRoomShortNow`. */
export function rowRoomHolds(model: LayoutModel, proposed: readonly ProposedBox[], allowed: readonly string[]): boolean {
  const { moved } = movedModel(model, proposed);
  const known = new Set(allowed);
  for (const id of rowShort(moved)) if (!known.has(id)) return false;
  return true;
}

/**
 * Whether a centring step kept every row room that held: the step rewrote one group and its nodes, and `before` holds them as the step found them.
 * A step that left them as they were changed nothing the producer reads, and a step that neither moves the ends of a described same-tier link
 * apart nor moves a group border across its span closes no row run (`closesRowRun`, the scope of the move guard). Otherwise the producer is replayed on the model now, and only when that finds a
 * shortfall on the model as the step found it too; the step may not add one (R1: the same replay as `rowRoomHolds`).
 */
export function rowRoomKeptByStep(model: LayoutModel, before: { group: LayoutGroup; nodes: readonly LayoutNode[] }, unchanged: boolean): boolean {
  if (unchanged || !model.document.links.some(link => link.label !== undefined)) return true;
  const shift = new Map<string, number | string>();
  for (const node of before.nodes) {
    const was = node.bounds!, now = model.nodes[node.id]!.bounds!;
    const left = now.x - was.x, right = now.x + now.width - was.x - was.width;
    if (left !== 0 || right !== 0) shift.set(node.id, left === right ? left : `${left}|${right}`);
  }
  if (!closesRowRun(model, shift, [movedBorders(model.groups[before.group.id]!, before.group.bounds!, model.groups[before.group.id]!.bounds!)])) return true;
  const now = rowShort(model);
  if (now.size === 0) return true;
  const found = rowShort({ ...model, groups: { ...model.groups, [before.group.id]: before.group },
    nodes: { ...model.nodes, ...Object.fromEntries(before.nodes.map(node => [node.id, node])) } });
  return [...now].every(id => found.has(id));
}

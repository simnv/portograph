/**
 * The same-tier label room as a move reservation (decision review ticket DR-02; ADR-0014 r2: label room is reserved by the producer and the
 * tier-gap solve only). The producer reserves the room of a labelled link along its row once. A move that runs after it (the canton close-up, the
 * keep-out, the linkless step, the centring replay) moves one end of such a link and not the other, and the run shrinks below the label. No pass
 * reserves it again, so the move is held here (R2): a move that would take a row room below what its link reserved is not made. The check reads
 * the model as the move would leave it and asks the producer's own reading (`reserveLinkLabelRoom`, R1) for a row shortfall the model has not now.
 */
import type { LayoutModel } from '../model/layout.js';
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

/** The described links of one tier whose two ends the move shifts by different amounts: the only runs it can shorten. */
function stretched(model: LayoutModel, shift: ReadonlyMap<string, number>): boolean {
  const suppressed = overlayLabelsSuppressed(model);
  return model.links.some(link => {
    if (!link.attachments || !describedLink(model, link, suppressed)) return false;
    const from = link.attachments.from.node, to = link.attachments.to.node;
    if (from === to || (shift.get(from) ?? 0) === (shift.get(to) ?? 0)) return false;
    return model.groups[model.document.nodes[from]!.group]?.tier === model.groups[model.document.nodes[to]!.group]?.tier;
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

/** The links whose row room is short before the move: a move may not add one. Absent when no described link of one tier has its ends shifted apart. */
export function rowRoomShortNow(model: LayoutModel, proposed: readonly ProposedBox[]): string[] | undefined {
  if (!model.document.links.some(link => link.label !== undefined)) return undefined;
  const { moved, shift } = movedModel(model, proposed);
  return stretched(moved, shift) ? [...rowShort(model)] : undefined;
}

/** Whether the move leaves every row room that held; `allowed` is `rowRoomShortNow`. */
export function rowRoomHolds(model: LayoutModel, proposed: readonly ProposedBox[], allowed: readonly string[]): boolean {
  const { moved } = movedModel(model, proposed);
  const known = new Set(allowed);
  for (const id of rowShort(moved)) if (!known.has(id)) return false;
  return true;
}

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
import type { ProposedBox } from './frames.js';
import { readCache } from '../model/read-cache.js';

const sameRect = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
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

/** The links with a row shortfall on the model `text` serialises, by the producer's reading on the copy that text parses to, in reading order. */
function readRows(text: string): string[] {
  const shortfalls: LinkLabelShortfall[] = [];
  reserveLinkLabelRoom(JSON.parse(text) as LayoutModel, shortfalls, undefined, 'rows');
  return [...new Set(shortfalls.filter(isRow).map(item => item.link))];
}

/**
 * The memo of the row reading (dense-16x9 ticket 21). The guards read the rows again for every proposed move of a step, on the model as the
 * step found it: the same model text many times. The reading runs on a copy parsed from `JSON.stringify(model)`, and on nothing else (the copy
 * shares no object with any cache or scope), so that text is its complete input and the key. A key is the whole content: no write to a model
 * can leave an entry stale, and no mutation boundary has to drop one. One map per document object: `resolve` parses a fresh document for every
 * placement, and the models of that placement share it. A copy restored from JSON (`restoreLayoutModel`) has its own document object, so it
 * misses the memo and reads again: a lost hit, never a wrong answer, because the key is the whole text. The memo is open while a command runs (`openRowReadingMemo`, called by
 * `layout`) and every map is dropped when the last running command ends, so a published model that keeps its document keeps no entry (review 1
 * of ticket 21); outside a command the reading runs directly. Bounded by count (R4): `ROW_READING_MEMO_LIMIT` keys per document, the least
 * recently used one dropped first.
 */
const ROW_READING_MEMO_LIMIT = 64;
let rowReadings = new WeakMap<object, Map<string, readonly string[]>>();
const rowReadingCache = readCache('rowRoomReading');
let commands = 0;

/** Opens the row reading memo for one command; the function returned closes it, and the last close drops every entry. */
export function openRowReadingMemo(): () => void {
  commands++;
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    if (--commands === 0) rowReadings = new WeakMap<object, Map<string, readonly string[]>>();
  };
}

/** The links with a row shortfall on `model`, by the producer's reading on a copy. */
function rowShort(model: LayoutModel): Set<string> {
  const text = JSON.stringify(model);
  if (commands === 0) return new Set(readRows(text));
  let memo = rowReadings.get(model.document);
  if (memo === undefined) rowReadings.set(model.document, memo = new Map());
  const cached = memo.get(text);
  if (cached !== undefined) {
    memo.delete(text);
    memo.set(text, cached);
    return new Set(rowReadingCache.hit(model, cached, () => readRows(text)));
  }
  rowReadingCache.miss();
  const read = readRows(text);
  if (memo.size >= ROW_READING_MEMO_LIMIT) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  memo.set(text, read);
  return new Set(read);
}

/** The links with a row shortfall on `model` (the evidence of a resize), or `undefined` when no link carries a label. */
export function rowRoomShortOf(model: LayoutModel): string[] | undefined {
  return model.document.links.some(link => link.label !== undefined) ? [...rowShort(model)] : undefined;
}

/**
 * The links whose row room is short before the move: a move may not add one. Absent when the move moves nothing. Any moved box or body can
 * close a window: a border of any tier (a frame takes its edges from cells of other tiers), a run's end, a reserved run (review 10b, F1 and
 * its follow-up), so the move is judged by the producer's own row reading and by no list of what can close one (R1).
 */
export function rowRoomShortNow(model: LayoutModel, proposed: readonly ProposedBox[]): string[] | undefined {
  if (!model.document.links.some(link => link.label !== undefined)) return undefined;
  const { shift } = movedModel(model, proposed);
  const moves = shift.size > 0 || proposed.some(({ group, bounds }) => !sameRect(group.bounds!, bounds));
  return moves ? [...rowShort(model)] : undefined;
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
 * A step that left them as they were changed nothing the producer reads. Otherwise the producer's row reading runs on the model now, and only
 * when that finds a shortfall on the model as the step found it too; the step may not add one (R1: the same reading as `rowRoomHolds`).
 */
export function rowRoomKeptByStep(model: LayoutModel, before: { group: LayoutGroup; nodes: readonly LayoutNode[] }, unchanged: boolean): boolean {
  if (unchanged || !model.document.links.some(link => link.label !== undefined)) return true;
  const now = rowShort(model);
  if (now.size === 0) return true;
  const found = rowShort({ ...model, groups: { ...model.groups, [before.group.id]: before.group },
    nodes: { ...model.nodes, ...Object.fromEntries(before.nodes.map(node => [node.id, node])) } });
  return [...now].every(id => found.has(id));
}

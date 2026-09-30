import type { LayoutGroup, LayoutLink, LayoutModel } from '../model/layout.js';
import type { Point } from '../model/geometry.js';
import { frameColumns, overlayFreeGroups, type FrameColumn } from './columns.js';
import { groupShape } from './grid.js';
import { optionalMoveHolds, occupiedOverhang, selectAnchorTier } from './lanes.js';
import { crosses, overlayBlockers, overlayPath, straightChord } from './overlay-paths.js';
import { saveGroups } from './overlay-order.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { orderedNodeIds } from '../model/model.js';
import { deriveFrames } from './frames.js';
import { GROUP_PADDING, groupInsets, placementWarning } from './regions.js';
import { rowGap } from './sides-two.js';
import { bandGap, compareId } from './skeleton-graph.js';
import { moveGroup } from './skeleton-geometry.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { drawn, overlayCrossings, portKey, windowTarget, type Drawn, type Window } from './overlay-window.js';

/** A free group stands where its overlay chords are straight and not at the mean of its partners (ticket 143, info). */
export const OVERLAY_WINDOW_TAKEN = 'OVERLAY_WINDOW_TAKEN';

/**
 * Overlay barycentre for the free (ranked-groups spec, section 3.1, ticket 05).
 *
 * A group with no routed link to any node outside itself has nothing that routed geometry could
 * ask of its position. The one thing that does ask is its overlay links, and an overlay link is
 * one straight segment from face to face, so the way to keep it straight is to stand the group
 * under its partners. This pass runs at the start of the centre rule, before any centring step:
 *
 * - **A free group** takes x = the mean of its overlay partners' centres, where a partner is the node
 *   at the other end of an overlay link of any member. The tier's free groups with a target are
 *   sorted by target and swept left to right with the band gap between them, pushing right on
 *   overlap; a run that was pushed as a whole is centred back (least squared displacement, the
 *   cluster rule of Abacus), so two groups with one target stand either side of it.
 * - **A free node** of a group in which no node has a routed link is ordered inside its group by the
 *   same key, and the row is repacked from its left edge with `rowGap`. Only the order changes; a
 *   group whose new row would not fit its old box keeps its order.
 *
 * Routed geometry never moves for it. A group that has any routed link to another group is a
 * fixed wall for the sweep, so are a flank, a bar, the column of a frame (a rank cell is walled by
 * the whole column it stands in, ranked-groups ticket 09), a group that has a child group or a
 * parent group, a group in the anchor tier (`mutation.ts` does not let centring move it), and every
 * lane of the tier. A free group never crosses a wall: it stays between the two walls that the
 * order by target puts it between, and when that interval cannot hold the run it goes back to the
 * interval it had.
 *
 * **Into the span** (ranked-groups ticket 22). A free group whose box stands outside the x-span of its
 * partners (the lowest and highest partner centre) is first moved to the nearest point of the span, by
 * the same sweep, and the move is kept when the total length of its overlay links falls. It is not
 * judged by the straight count: a move into the span often crosses a rank of bodies between the group
 * and its partners, and a chord that only looked straight from far away is not worth a canvas as wide
 * as the gap. The straight-count guard then judges only the fine placement (the mean of the partners)
 * from the place the group entered at, so a group ends inside its span even where the fine move is
 * refused.
 *
 * **The window rule** (ticket 143, Q112; ticket 147 made the objective crossings first, then straight chords). The mean is the target of a group only where no other x keeps more of its overlay chords
 * straight (`windowTarget`, `overlay-window.ts`). The candidates are the mean and the two ends of every x-interval in which a chord
 * enters a shape, at most `CHORD_WINDOW_TRIALS` of them, taken nearest the mean first. A plain group stays between its walls and inside the
 * x-extent of the settled groups, a member inside its canton wall, and both inside the x-span of the settled partners. The tier guard below
 * stays in a new form (ticket 147): a tier keeps its windows only where more of its overlay links are straight, or the same ones with no more crossings (`windowsHold`), and a window of an earlier run gives way to the means by the same test. The
 * windows are read once, at the end of `centreDraft`, where centring has left the partners (the passes call this with `windows = false`: a
 * window read earlier changes what the order rules of the later passes see). A run with windows is kept only where the whole sheet
 * gains (`sheetGains`: no more turns, fewer bent links or as many and fewer crossings), read on every overlay link; otherwise it goes back and places the means.
 *
 * A partner counts only when it is *settled*: a group that is not free, or a free group of a tier
 * nearer the anchor tier that this pass has already placed. Tiers are taken from the anchor tier
 * outward, in the order the centre steps take them. Because a target reads only settled positions
 * and the sweep reads only targets, widths and walls, a second run finds the same targets and
 * leaves every group where the first run put it.
 *
 * The routed groups of the tiers below the anchor are centred under their feeds after the first run
 * and may move, so `centreDraft` runs the pass again after each pass of its steps: the free groups
 * end at the mean of partners that stand where centring left them.
 */
export function placeOverlayFree(model: LayoutModel, columns: readonly FrameColumn[] = frameColumns(model), windows = true): void {
  if (!windows) { place(model, columns, false); return; }
  // The windows are kept only where the whole sheet gains: fewer bent overlay links and no more turns in all, read on every overlay link and
  // not only on the chords the rule counted (ticket 143, three-continents). A run that fails goes back to the state it began in and places
  // the means alone.
  const groups = Object.values(model.groups), diagnostics = [...model.diagnostics];
  const undo = saveGroups(model, groups), start = new Map(groups.map(group => [group.id, JSON.stringify(group.bounds)]));
  const before = overlayTurns(model), state = { windowed: false };
  place(model, columns, true, state);
  if (!state.windowed) return;
  if (sheetGains(overlayTurns(model), before)) return;
  const moved = groups.filter(group => JSON.stringify(group.bounds) !== start.get(group.id));
  // A run that moved no group and added no note has nothing to put back: the restore would only write the saved values over the same ones.
  if (moved.length || model.diagnostics.length !== diagnostics.length) {
    undo();
    model.diagnostics = [...diagnostics];
    rebuildNodeGeometry(model, moved.flatMap(group => group.nodes), 'current');
  }
  place(model, columns, false);
}

/** What the whole-sheet guard reads of the overlay links: how many bend, the turns of all, and how many times the drawn paths cross. */
export interface OverlayState { bent: number; turns: number; crossings: number }

/**
 * Whether a run with windows gains on the whole sheet, in the order of the objective (ticket 147): no more turns than before, and fewer
 * bent overlay links, or as many and fewer crossings. A tie keeps the means. The turns term is ticket 143's (three-continents: fewer bent
 * links with more turns ended with one more bent link after 7f). A rise in crossings is refused only where the bent links do not fall:
 * the straight links come first.
 */
export function sheetGains(windows: OverlayState, before: OverlayState): boolean {
  return windows.turns <= before.turns && (windows.bent < before.bent || (windows.bent === before.bent && windows.crossings < before.crossings));
}

/**
 * Whether the windows of a tier are kept, in the order of the objective: more of the tier's spanning overlay links are straight than the
 * tier had, or as many and the same ones (ticket 143: a swap of straight links is no gain) with no more crossings. The crossings after
 * are read only where the straight sets tie. A window of an earlier run gives way to the means by the same test.
 */
export function windowsHold(after: ReadonlySet<string>, before: ReadonlySet<string>, crossingsAfter: () => number, crossingsBefore: number): boolean {
  if (after.size > before.size) return true;
  return after.size === before.size && [...before].every(id => after.has(id)) && crossingsAfter() <= crossingsBefore;
}

/** The bent overlay links, the turns of all, and the crossings among the drawn overlay paths, as the overlay rule draws them now. A mesh bus member is no chord. */
function overlayTurns(model: LayoutModel): OverlayState {
  const blockers = overlayBlockers(model);
  let bent = 0, turns = 0;
  const paths: Drawn[] = [];
  for (const link of model.links) {
    if (link.layer !== 'overlay' || link.meshBus !== undefined || !link.attachments) continue;
    const { segments } = overlayPath(model, link, blockers);
    if (segments.length > 1) bent++;
    turns += segments.length - 1;
    paths.push(drawn([segments[0]!.from, ...segments.map(segment => segment.to)], [portKey(link.attachments.from), portKey(link.attachments.to)]));
  }
  return { bent, turns, crossings: overlayCrossings(paths) };
}

function place(model: LayoutModel, columns: readonly FrameColumn[], windows: boolean, state?: { windowed: boolean }): void {
  const anchor = selectAnchorTier(model);
  if (anchor === undefined) return;
  if (!model.links.some(link => link.layer === 'overlay')) {
    if (standLinklessBeside(model, model.tierBands.map(band => band.tier), overlayFreeGroups(model, anchor), columns)) rebuildNodeGeometry(model, orderedNodeIds(model.document), 'current');
    return;
  }
  const groupOf = (node: string): string => model.document.nodes[node]!.group;
  const routedAny = new Set<string>();
  for (const link of model.links) {
    if (link.layer !== 'routed' || !link.attachments) continue;
    for (const node of [link.attachments.from.node, link.attachments.to.node]) routedAny.add(node);
  }
  /** The groups this pass may move: no routed link out, and no other rule that owns the group's place. */
  const free = overlayFreeGroups(model, anchor);
  if (!free.size) return;

  const partners = new Map<string, string[]>();
  for (const link of model.links) {
    if (link.layer !== 'overlay' || !link.attachments) continue;
    const { from, to } = link.attachments;
    for (const [one, other] of [[from.node, to.node], [to.node, from.node]] as const) {
      partners.set(one, [...(partners.get(one) ?? []), other]);
    }
  }
  const settled = new Set(Object.keys(model.groups).filter(id => !free.has(id)));
  const centreOf = (node: string): number => model.nodes[node]!.bounds!.x + model.nodes[node]!.bounds!.width / 2;
  /**
   * The x of every settled partner of `nodes` that stands in another tier. A partner in the same tier
   * is left out: the side phases froze the order of a tier's groups and the sides of their overlay
   * ports, and a target at that partner's x could put the group on the wrong side of it and turn a
   * straight link into a detour.
   */
  const partnerXs = (nodes: string[], own: string): number[] => {
    const tier = model.groups[own]!.tier;
    return nodes.flatMap(node => partners.get(node) ?? [])
      .filter(other => model.groups[groupOf(other)]!.tier !== tier && settled.has(groupOf(other))).map(centreOf);
  };
  /** Mean of `partnerXs`, or undefined when there is none. */
  const keyOf = (nodes: string[], own: string): number | undefined => {
    const xs = partnerXs(nodes, own);
    return xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : undefined;
  };
  /**
   * Sum of the chord lengths (centre to centre) of the overlay links of `nodes` to the partners the
   * span is read from — settled, in another tier. A free partner still stands at ELK's raw x, the
   * very condition the into-span step corrects, and its chord would veto the move (ticket 22 review).
   */
  const overlayLength = (nodes: string[], tier: number): number => {
    let total = 0;
    for (const node of nodes) {
      for (const other of partners.get(node) ?? []) {
        if (model.groups[groupOf(other)]!.tier === tier || !settled.has(groupOf(other))) continue;
        total += Math.hypot(centreOf(node) - centreOf(other), model.nodes[node]!.bounds!.y - model.nodes[other]!.bounds!.y);
      }
    }
    return total;
  };

  const overlays = model.links.filter(link => link.layer === 'overlay' && link.meshBus === undefined && link.attachments);
  const tiers = model.tierBands.map(band => band.tier), at = tiers.indexOf(anchor);
  for (const tier of [...tiers.slice(at + 1), ...tiers.slice(0, at).reverse()]) {
    const groups = Object.values(model.groups).filter(group => group.tier === tier);
    const movers = groups.filter(group => free.has(group.id));
    // A member of a canton is moved as a frame inside its canton (ticket 56); the sweep below reads every column as a wall.
    const inner = (group: LayoutGroup): boolean => group.frame !== undefined;
    // The straight overlay links that touch or pass over this tier: a move is kept only where their
    // count, read by the real overlay decision, holds or rises (spec section 5). The mean of partners
    // in two tiers can put a body of the tier between the two ends of a link that was straight.
    const spanning = model.links.filter(link => link.layer === 'overlay' && link.meshBus === undefined && link.attachments).filter(link => {
      const ends = [link.attachments!.from.node, link.attachments!.to.node].map(node => model.groups[groupOf(node)]!.tier!);
      return Math.min(...ends) <= tier && tier <= Math.max(...ends);
    });
    const straightIds = (): Set<string> => {
      const blockers = overlayBlockers(model);
      return new Set(spanning.filter(link => overlayPath(model, link, blockers).segments.length === 1).map(link => link.id));
    };
    const nodesOfTier = groups.flatMap(group => group.nodes);
    const signature = (): string => JSON.stringify(groups.map(group => [group.bounds, group.rowOrder, group.nodes.map(node => model.nodes[node]!.bounds)]));
    // Into the span (ticket 22): a group outside the x-span of its partners is first moved into it and
    // the move is accepted on the total length of its overlay links, not on the straight count; the
    // straight count below judges only the fine placement that follows.
    const entering = new Map<string, number>();
    for (const group of movers.filter(group => !inner(group))) {
      const xs = partnerXs(group.nodes, group.id);
      if (!xs.length) continue;
      const low = Math.min(...xs), high = Math.max(...xs), box = group.bounds!;
      if (box.x + box.width < low - PLACEMENT_EPS || box.x > high + PLACEMENT_EPS) {
        entering.set(group.id, Math.min(Math.max(box.x + box.width / 2, low), high));
      }
    }
    if (entering.size) {
      const before = signature();
      const enterers = movers.filter(group => entering.has(group.id)), entered = enterers.flatMap(group => group.nodes);
      const length = overlayLength(entered, tier);
      const back = saveGroups(model, groups);
      sweep(model, tier, groups, entering, columns);
      if (signature() !== before) {
        rebuildNodeGeometry(model, nodesOfTier, 'current');
        if (overlayLength(entered, tier) >= length - PLACEMENT_EPS) { back(); rebuildNodeGeometry(model, nodesOfTier, 'current'); }
      }
    }
    const start = signature();
    const undo = saveGroups(model, groups);
    // A window stands in this tier from an earlier run: a run without windows gives it up only for a gain (ticket 147).
    const held = movers.some(group => model.diagnostics.some(item => item.code === OVERLAY_WINDOW_TAKEN && item.owners?.[0]?.kind === 'group' && item.owners[0].id === group.id));
    for (const group of movers) orderNodes(model, group, node => keyOf([node], group.id), routedAny);
    const noted = (group: LayoutGroup) => (item: { code: string; owners?: readonly { kind: string; id?: string }[] }): boolean =>
      item.code === OVERLAY_WINDOW_TAKEN && item.owners?.[0]?.kind === 'group' && item.owners[0].id === group.id;
    const means = new Map<string, number>();
    for (const group of movers) {
      const target = keyOf(group.nodes, group.id);
      if (target !== undefined) means.set(group.id, target);
    }
    // The window rule (ticket 143): a target is the x that keeps the most overlay chords straight, the mean where none is better.
    const chosen = new Map(means), taken: { group: LayoutGroup; mean: number; target: number; gained: number; saved: number }[] = [];
    if (windows && means.size && overlays.length) {
      const walls = tierWalls(model, tier, groups, new Set(means.keys()), columns);
      // A plain group stays inside the x-extent of the settled groups: an x past it is no wall the sweep knows, and would widen the canvas.
      const boxes = Object.values(model.groups).filter(item => settled.has(item.id) && item.bounds).map(item => item.bounds!);
      const extent = boxes.length ? { low: Math.min(...boxes.map(box => box.x)), high: Math.max(...boxes.map(box => box.x + box.width)) } : undefined;
      for (const group of movers) {
        const mean = means.get(group.id);
        const range = mean === undefined ? undefined : targetRange(model, tier, group, mean, walls, extent, [...means.keys()].filter(id => inner(model.groups[id]!)), columns);
        if (mean === undefined || range === undefined) continue;
        const pick = windowTarget(model, group, { mean, range, settled, overlays });
        if (pick.target !== mean) { chosen.set(group.id, pick.target); taken.push({ group, mean, target: pick.target, gained: pick.gained, saved: pick.saved }); }
      }
    }
    const apply = (targets: ReadonlyMap<string, number>): void => {
      if (!targets.size) return;
      const plain = new Map([...targets].filter(([id]) => !inner(model.groups[id]!)));
      if (plain.size) sweep(model, tier, groups, plain, columns);
      if (plain.size < targets.size) sweepMembers(model, tier, new Map([...targets].filter(([id]) => inner(model.groups[id]!))), columns);
    };
    apply(chosen);
    if (spanning.length && signature() !== start) {
      // `centre` moves groups with `moveGroup`, which leaves the pills behind. The count before the move
      // and the count after it must read the same kind of geometry, so the tier goes back, its pills
      // are refreshed and counted, then the move is redone and counted the same way.
      const redo = saveGroups(model, groups);
      undo();
      rebuildNodeGeometry(model, nodesOfTier, 'current');
      const before = straightIds(), crossBefore = taken.length || held ? overlayTurns(model).crossings : 0;
      redo();
      rebuildNodeGeometry(model, nodesOfTier, 'current');
      let after = straightIds(), windowed = taken.length > 0;
      // The windows are kept only where they bend no more overlay links and add no crossing, and save one of them (`windowsHold`).
      if (windowed && !windowsHold(after, before, () => overlayTurns(model).crossings, crossBefore)) {
        undo();
        rebuildNodeGeometry(model, nodesOfTier, 'current');
        apply(means);
        rebuildNodeGeometry(model, nodesOfTier, 'current');
        after = straightIds();
        windowed = false;
      }
      let restored = false;
      // The means replace a window of an earlier run unless the window is better: more straight links, or the same ones and fewer crossings (`windowsHold`).
      if (after.size < before.size || (held && !windowed && signature() !== start && !windowsHold(after, before, () => overlayTurns(model).crossings, crossBefore))) {
        undo(); rebuildNodeGeometry(model, nodesOfTier, 'current'); windowed = false; restored = true;
      }
      if (!restored) {
        // The note follows the place the group stands at: it is dropped when the group moves to the mean and is stated again when a window holds.
        model.diagnostics = model.diagnostics.filter(item => !movers.some(group => noted(group)(item)));
        if (windowed) for (const { group, mean, target, gained, saved } of taken) {
          const message = `Group ${group.id} stands at x ${target.toFixed(1)} and not at x ${mean.toFixed(1)}, the mean of its partners: ${Math.abs(saved)} ${saved < 0 ? 'more' : 'fewer'} overlay ${Math.abs(saved) === 1 ? 'crossing' : 'crossings'}, ${Math.abs(gained)} ${gained < 0 ? 'fewer' : 'more'} overlay ${Math.abs(gained) === 1 ? 'chord is' : 'chords are'} straight.`;
          model.diagnostics.push({ stage: 'placement', severity: 'info', code: OVERLAY_WINDOW_TAKEN, message, owners: [{ kind: 'group', id: group.id }] });
        }
      }
      if (windowed && state) state.windowed = true;
    } else if (state && taken.length && !spanning.length && signature() !== start) state.windowed = true;
    for (const group of movers) settled.add(group.id);
  }
  const stood = standLinklessBeside(model, tiers, free, columns);
  stepOutOfChords(model, tiers, free, columns);
  if (stood) rebuildNodeGeometry(model, orderedNodeIds(model.document), 'current');
}

/** The step of `placeOverlayFree` alone, for the 7f rounds that replay without a budget (ticket 76 review). */
export function stepLinklessOutOfChords(model: LayoutModel, columns: readonly FrameColumn[] = frameColumns(model)): boolean {
  const anchor = selectAnchorTier(model);
  if (anchor === undefined) return false;
  const before = JSON.stringify(Object.values(model.groups).map(group => group.bounds));
  const tiers = model.tierBands.map(band => band.tier), free = overlayFreeGroups(model, anchor);
  const stood = standLinklessBeside(model, tiers, free, columns);
  stepOutOfChords(model, tiers, free, columns);
  const moved = JSON.stringify(Object.values(model.groups).map(group => group.bounds)) !== before;
  // The steps rebuild the nodes of one group at a time, which moves their labels to the end of the list: the replays keep that order. A step that moves a group and a step that moves it back leave the bounds as they were and the labels not.
  if (stood) rebuildNodeGeometry(model, orderedNodeIds(model.document), 'current');
  return moved;
}

/**
 * The straight overlay chords that run through the rows of a group's box, without the group, and the x-intervals of the box's left
 * edge in which the box would touch one of them. Every chord that is straight without the group bans an interval, not only the
 * chords that cross the box now: the nearest edge of one chord may lie inside the next (ticket 76 review).
 */
function chordBans(model: LayoutModel, group: LayoutGroup, overlays: readonly LayoutLink[]): { rows: { from: Point; to: Point }[]; banned: { low: number; high: number }[] } {
  const box = group.bounds!, bare = overlayBlockers(model, new Set(group.nodes));
  const rows = overlays.flatMap(link => {
    const chord = straightChord(model, link, bare);
    return chord && Math.max(chord.from.y, chord.to.y) > box.y + PLACEMENT_EPS && Math.min(chord.from.y, chord.to.y) < box.y + box.height - PLACEMENT_EPS ? [chord] : [];
  });
  // The x-interval of the box's left edge in which the box touches a chord: the chord's x-extent within the box's rows, less the width.
  const banned = rows.map(({ from, to }) => {
    const dy = to.y - from.y, low = Math.min(from.y, to.y), high = Math.max(from.y, to.y);
    const at = (y: number): number => dy === 0 ? from.x : from.x + (to.x - from.x) * (y - from.y) / dy;
    const xs = dy === 0 ? [from.x, to.x] : [at(Math.min(Math.max(box.y, low), high)), at(Math.min(Math.max(box.y + box.height, low), high))];
    return { low: Math.min(...xs) - box.width, high: Math.max(...xs) };
  });
  return { rows, banned };
}

/**
 * A group with no link of any member stands beside the connected diagram of its tier (ticket 92). ELK puts it where the skeleton
 * has room, and the rules that shift the connected part later (centring, the 7f replays) leave it behind: a gap as wide as the
 * shift. Placement reserves its place instead. After every partner is settled, a linkless group that stands outside the x-extent
 * of the other groups of its tier, and further than one band gap from the nearest of them, moves to one band gap from the extent
 * on the side it stood on. If that side has no room (a column of a frame, a lane), it tries the other side; if neither has, it stays.
 * A group inside the extent stays. The step after this one (`stepOutOfChords`) moves it again where a straight chord crosses it.
 */
export function standLinklessBeside(model: LayoutModel, tiers: readonly number[], free: ReadonlySet<string>, columns: readonly FrameColumn[]): boolean {
  const linked = new Set<string>();
  for (const link of model.links) {
    if (!link.attachments) continue;
    for (const end of [link.attachments.from.node, link.attachments.to.node]) linked.add(model.document.nodes[end]!.group);
  }
  const gap = bandGap(model);
  let moved = false;
  for (const tier of tiers) {
    const groups = Object.values(model.groups).filter(group => group.tier === tier && group.bounds);
    const pending = groups.filter(group => free.has(group.id) && !linked.has(group.id) && group.frame === undefined && group.nodes.length > 0);
    if (!pending.length) continue;
    const span = (group: LayoutGroup): { low: number; high: number } => {
      const reach = occupiedOverhang(model, group);
      return { low: group.bounds!.x - reach.left, high: group.bounds!.x + group.bounds!.width + reach.right };
    };
    // The connected part of the tier; a tier with none has the extent of the whole connected diagram.
    const onTier = groups.filter(group => !pending.includes(group));
    const standing = onTier.length ? [...onTier] : Object.values(model.groups).filter(group => group.bounds && linked.has(group.id));
    if (!standing.length) continue;
    // The frames and lanes of the tier are part of the connected extent: the nearest connected frame is what the gap is read from. A tier
    // with no connected group takes every column, since the frame boxes are wider than their cells.
    const frames = columns.filter(column => !onTier.length || (column.from <= tier && tier <= column.to)).map(column => ({ low: column.x, high: column.x + column.width }));
    const lanes = model.lanes.filter(lane => lane.tier === tier && !pending.some(item => item.id === lane.group)).map(lane => ({ low: lane.bounds.x, high: lane.bounds.x + lane.bounds.width }));
    const walls = (other: readonly LayoutGroup[]) => [
      ...other.map(item => ({ ...span(item), gap })),
      ...columns.filter(column => column.from <= tier && tier <= column.to).map(column => ({ low: column.x, high: column.x + column.width, gap })),
      ...lanes.map(lane => ({ ...lane, gap: 0 })),
    ];
    const overlays = model.links.filter(link => link.layer === 'overlay' && link.meshBus === undefined && link.attachments);
    const rest = [...pending];
    while (rest.length) {
      const parts = [...standing.map(span), ...frames, ...lanes];
      const extent = { low: Math.min(...parts.map(part => part.low)), high: Math.max(...parts.map(part => part.high)) };
      // The pending group nearest the extent goes first, so a second one stands beside the first.
      const distance = (group: LayoutGroup): number => {
        const one = span(group);
        return Math.max(extent.low - one.high, one.low - extent.high);
      };
      rest.sort((a, b) => distance(a) - distance(b) || compareId(a.id, b.id));
      const group = rest.shift()!, one = span(group), reach = occupiedOverhang(model, group);
      standing.push(group);
      const away = distance(group);
      if (away <= gap + PLACEMENT_EPS) continue;
      const width = one.high - one.low, wall = walls(groups.filter(item => item !== group));
      const box = group.bounds!, { banned } = chordBans(model, group, overlays);
      // The chords and the lanes are read as `stepOutOfChords` reads them, so the two steps agree on where the group stands; the frozen
      // chords of 7f are read by `laneSidesHold`.
      const fits = (x: number): boolean => !banned.some(({ low, high }) => x > low + PLACEMENT_EPS && x < high - PLACEMENT_EPS)
        && !wall.some(item => x - reach.left < item.high + item.gap - PLACEMENT_EPS && x - reach.left + width > item.low - item.gap + PLACEMENT_EPS)
        && optionalMoveHolds(model, [{ group, bounds: { ...box, x } }], false);
      const left = extent.low - gap - width + reach.left, right = extent.high + gap + reach.left;
      const wasLeft = one.high <= extent.low;
      // From the point one gap off the extent, outward to the first x clear of the chords: the edges of the banned intervals are the only other candidates.
      const outward = (start: number, sign: 1 | -1): number | undefined => [start, ...banned.flatMap(({ low, high }) => [low, high])]
        .filter(x => sign * (x - start) > -PLACEMENT_EPS).sort((a, b) => sign * (a - b)).find(fits);
      const target = [wasLeft ? outward(left, -1) : outward(right, 1), wasLeft ? outward(right, 1) : outward(left, -1)].find(x => x !== undefined);
      if (target === undefined || Math.abs(target - box.x) < PLACEMENT_EPS) continue;
      moveGroup(model, group, target - box.x, 0);
      moved = true;
      // Only this group's nodes here (`span` reads its pills); the caller rebuilds every node in document order once.
      rebuildNodeGeometry(model, group.nodes, 'current');
    }
  }
  return moved;
}

/**
 * A group with no link of any member has nothing that asks for an x, and ELK's skeleton x is
 * arbitrary (ticket 76). It is a wall for the sweeps above, so an overlay chord that passes through
 * its tier can find the group in its way and the link takes the orthogonal branch. This step runs
 * after every partner is settled: each such group stands at the x nearest its own where its box
 * crosses no straight overlay chord, using the chords as drawn (face to face) and counting a chord
 * that is straight once the group's own nodes are taken away. The x must keep the band gap to the
 * other groups and the lanes of the tier and stay inside their span; if no x does, the group goes
 * past the tier's end. A move that bends an overlay link that was straight is refused, with a warning.
 */
export function stepOutOfChords(model: LayoutModel, tiers: readonly number[], free: ReadonlySet<string>, columns: readonly FrameColumn[]): void {
  const linked = new Set<string>();
  for (const link of model.links) {
    if (!link.attachments) continue;
    for (const end of [link.attachments.from.node, link.attachments.to.node]) linked.add(model.document.nodes[end]!.group);
  }
  // A bus member is neither straight nor bent and is no chord to step out of (mesh-bus.md, section 4).
  const overlays = model.links.filter(link => link.layer === 'overlay' && link.meshBus === undefined && link.attachments);
  if (!overlays.length) return;
  const gap = bandGap(model);
  for (const tier of tiers) {
    const groups = Object.values(model.groups).filter(group => group.tier === tier);
    for (const group of groups.filter(item => free.has(item.id) && !linked.has(item.id) && item.frame === undefined && item.bounds)) {
      const box = group.bounds!;
      const { rows, banned } = chordBans(model, group, overlays);
      if (!rows.some(({ from, to }) => crosses(from, to, box))) continue;
      const reach = occupiedOverhang(model, group);
      const others = [
        ...groups.filter(item => item !== group && item.bounds).map(item => {
          const one = occupiedOverhang(model, item);
          return { low: item.bounds!.x - one.left, high: item.bounds!.x + item.bounds!.width + one.right, gap };
        }),
        ...columns.filter(column => column.from <= tier && tier <= column.to).map(column => ({ low: column.x, high: column.x + column.width, gap })),
        ...model.lanes.filter(lane => lane.tier === tier).map(lane => ({ low: lane.bounds.x, high: lane.bounds.x + lane.bounds.width, gap: 0 })),
      ];
      const width = box.width + reach.left + reach.right;
      const fits = (x: number): boolean => !banned.some(({ low, high }) => x > low + PLACEMENT_EPS && x < high - PLACEMENT_EPS)
        && !others.some(wall => x - reach.left < wall.high + wall.gap - PLACEMENT_EPS && x - reach.left + width > wall.low - wall.gap + PLACEMENT_EPS);
      const candidates = [...banned.flatMap(({ low, high }) => [low, high]),
        ...others.flatMap(wall => [wall.high + wall.gap + reach.left, wall.low - wall.gap - width + reach.left])].filter(fits);
      if (!candidates.length) continue;
      const spanLow = Math.min(...others.map(wall => wall.low)), spanHigh = Math.max(...others.map(wall => wall.high));
      const inside = candidates.filter(x => !others.length || (x - reach.left >= spanLow - PLACEMENT_EPS && x - reach.left + width <= spanHigh + PLACEMENT_EPS));
      const pool = inside.length ? inside : candidates;
      const target = pool.reduce((best, x) => Math.abs(x - box.x) < Math.abs(best - box.x) - PLACEMENT_EPS ? x : best);
      const straight = (): Set<string> => {
        const blockers = overlayBlockers(model);
        return new Set(overlays.filter(link => overlayPath(model, link, blockers).segments.length === 1).map(link => link.id));
      };
      // A step out of a chord is optional: it is not made into the riser keep-out (mesh-bus.md, section 11.5).
      if (!optionalMoveHolds(model, [{ group, bounds: { ...box, x: target } }], false)) continue;
      const before = straight(), undo = saveGroups(model, [group]);
      moveGroup(model, group, target - box.x, 0);
      rebuildNodeGeometry(model, group.nodes, 'current');
      const after = straight();
      if ([...before].some(id => !after.has(id))) {
        undo();
        rebuildNodeGeometry(model, group.nodes, 'current');
        placementWarning(model, 'LINKLESS_GROUP_MOVE_REFUSED',
          `Group ${group.id} has no link and stands in the path of a straight overlay chord, but a step out of it would bend another straight overlay link.`, [group.id], 'group');
      }
    }
  }
}

/** Order the nodes of a group in which no node has a routed link by `key`; unkeyed nodes keep their slot. */
function orderNodes(model: LayoutModel, group: LayoutGroup, key: (node: string) => number | undefined, routed: ReadonlySet<string>): void {
  const order = group.rowOrder ?? group.nodes;
  if (order.length < 2 || groupShape(model, group.id) !== 'row' || order.some(node => routed.has(node))) return;
  const keys = new Map(order.map(node => [node, key(node)]));
  const keyed = order.filter(node => keys.get(node) !== undefined);
  if (keyed.length < 2) return;
  const sorted = [...keyed].sort((a, b) => keys.get(a)! - keys.get(b)! || order.indexOf(a) - order.indexOf(b));
  const queue = [...sorted];
  const next = order.map(node => keys.get(node) === undefined ? node : queue.shift()!);
  if (next.every((node, i) => node === order[i])) return;
  // Repack from the left edge of the row. The row must still fit the box it had.
  const bodies = order.map(node => model.nodes[node]!.bounds!);
  const start = Math.min(...bodies.map(body => body.x));
  const inset = groupInsets(model, group), box = group.bounds!;
  const placed: number[] = [];
  let x = start;
  for (const [i, node] of next.entries()) {
    if (i) x += rowGap(model, next[i - 1]!, node);
    placed.push(x);
    x += model.nodes[node]!.bounds!.width;
  }
  if (x + inset.right > box.x + box.width + PLACEMENT_EPS) return;
  for (const [i, node] of next.entries()) {
    const body = model.nodes[node]!, dx = placed[i]! - body.bounds!.x;
    body.bounds!.x += dx;
    for (const port of body.ports) if (port.anchor) port.anchor.x += dx;
  }
  group.rowOrder = next;
}

interface Wall { low: number; high: number; centre: number; gap: number }
interface Item { id: string; want: number; width: number }

/** The walls of one tier for the groups with a target: every group without one that no frame column holds, every column and every lane. */
function tierWalls(model: LayoutModel, tier: number, groups: readonly LayoutGroup[], targeted: ReadonlySet<string>, columns: readonly FrameColumn[]): Wall[] {
  const gap = bandGap(model);
  return [
    // A cell is walled by its frame's column, which is wider than the cell where a neighbour rank is wider.
    ...groups.filter(group => !targeted.has(group.id) && !columns.some(column => column.cells.has(group.id))).map(group => {
      const reach = occupiedOverhang(model, group), low = group.bounds!.x - reach.left, high = group.bounds!.x + group.bounds!.width + reach.right;
      return { low, high, centre: (low + high) / 2, gap };
    }),
    ...columns.filter(column => column.from <= tier && tier <= column.to).map((column): Wall => ({ low: column.x, high: column.x + column.width,
      centre: column.x + column.width / 2, gap })),
    ...model.lanes.filter(lane => lane.tier === tier).map((lane): Wall => ({ low: lane.bounds.x, high: lane.bounds.x + lane.bounds.width,
      centre: lane.bounds.x + lane.bounds.width / 2, gap: 0 })),
  ].sort((a, b) => a.low - b.low);
}

/**
 * The room a canton column leaves the members of one tier (ticket 56): the walls of the other members and the lanes, the low and high
 * edge of the canton wall less the margin, and the box of every member frame. `sweepMembers` packs inside it, and the window rule
 * (ticket 143) reads the same numbers, so a target it takes is a place the sweep allows.
 */
function memberSpace(model: LayoutModel, column: FrameColumn, tier: number, moverIds: readonly string[]) {
  const frames = model.document.frames!, derived = deriveFrames(model)!;
  const box = new Map(derived.map(frame => [frame.id, frame.box]));
  const gap = 2 * GROUP_PADDING;
  const cellsOf = (id: string): string[] => [...frames[id]!.cells, ...Object.keys(frames).filter(child => frames[child]!.parent === id).flatMap(cellsOf)];
  const own = new Set(moverIds.filter(id => column.cells.has(id)).map(id => model.groups[id]!.frame!));
  const walls = [
    ...Object.keys(frames).filter(id => frames[id]!.parent === column.id && !own.has(id) && cellsOf(id).some(cell => model.groups[cell]!.tier === tier))
      .map(id => ({ low: box.get(id)!.x, high: box.get(id)!.x + box.get(id)!.width, gap })),
    ...model.lanes.filter(lane => lane.tier === tier).map(lane => ({ low: lane.bounds.x, high: lane.bounds.x + lane.bounds.width, gap: 0 })),
  ].sort((a, b) => a.low - b.low);
  return { box, gap, walls, low: column.wall!.x + GROUP_PADDING, high: column.wall!.x + column.wall!.width - GROUP_PADDING };
}

/**
 * The centre x that `sweep` or `sweepMembers` allows a free group whose mean target is `mean`: inside the interval between two walls
 * that holds the mean (a plain group), or inside the canton wall less the margin and between the walls of the other members (a member).
 */
function targetRange(model: LayoutModel, tier: number, group: LayoutGroup, mean: number, walls: readonly Wall[], extent: Window | undefined, memberIds: readonly string[], columns: readonly FrameColumn[]): Window | undefined {
  const centre = group.bounds!.x + group.bounds!.width / 2;
  if (group.frame === undefined) {
    const k = walls.filter(wall => wall.centre < mean).length, before = walls[k - 1], after = walls[k], reach = occupiedOverhang(model, group);
    const half = group.bounds!.width / 2;
    return { low: Math.max(before ? before.high + before.gap : -Infinity, extent ? extent.low : -Infinity) + reach.left + half,
      high: Math.min(after ? after.low - after.gap : Infinity, extent ? extent.high : Infinity) - reach.right - half };
  }
  const column = columns.find(item => item.wall !== undefined && item.from <= tier && tier <= item.to && item.cells.has(group.id));
  if (!column || model.document.frames === undefined || deriveFrames(model) === undefined) return undefined;
  const space = memberSpace(model, column, tier, memberIds), frame = space.box.get(group.frame)!, offset = centre - frame.x;
  const k = space.walls.filter(wall => (wall.low + wall.high) / 2 < mean).length, before = space.walls[k - 1], after = space.walls[k];
  return { low: Math.max(space.low, before ? before.high + before.gap : -Infinity) + offset, high: Math.min(space.high, after ? after.low - after.gap : Infinity) - frame.width + offset };
}

/**
 * Place the free groups that have a target between the walls of one tier. Every group of the tier
 * that has no target, and every lane, is a wall. A group takes the interval its target falls in;
 * when an interval cannot hold what the targets put in it, every group goes back to the interval it
 * has now, and an interval that cannot hold its own groups is left alone.
 */
function sweep(model: LayoutModel, tier: number, groups: LayoutGroup[], targets: ReadonlyMap<string, number>, columns: readonly FrameColumn[]): void {
  const gap = bandGap(model);
  const reach = new Map(groups.map(group => [group.id, occupiedOverhang(model, group)]));
  const occupied = (group: LayoutGroup): { low: number; high: number } => ({
    low: group.bounds!.x - reach.get(group.id)!.left, high: group.bounds!.x + group.bounds!.width + reach.get(group.id)!.right });
  const walls = tierWalls(model, tier, groups, new Set(targets.keys()), columns);
  const movers = groups.filter(group => targets.has(group.id));
  const interval = (centre: number): number => walls.filter(wall => wall.centre < centre).length;
  const item = (group: LayoutGroup): Item => {
    const box = occupied(group);
    return { id: group.id, want: targets.get(group.id)! - group.bounds!.width / 2 - reach.get(group.id)!.left, width: box.high - box.low };
  };
  const place = (assignment: Map<string, number>): Map<string, number> | undefined => {
    const result = new Map<string, number>();
    for (let k = 0; k <= walls.length; k++) {
      const members = movers.filter(group => assignment.get(group.id) === k)
        .sort((a, b) => targets.get(a.id)! - targets.get(b.id)! || a.bounds!.x - b.bounds!.x || compareId(a.id, b.id));
      if (!members.length) continue;
      const before = walls[k - 1], after = walls[k];
      const solved = packRun(members.map(item), before ? before.high + before.gap : -Infinity, after ? after.low - after.gap : Infinity, gap);
      if (!solved) return undefined;
      for (const [id, x] of solved) result.set(id, x);
    }
    return result;
  };
  const wanted = new Map(movers.map(group => [group.id, interval(targets.get(group.id)!)]));
  const current = new Map(movers.map(group => [group.id, interval(group.bounds!.x + group.bounds!.width / 2)]));
  let result = place(wanted);
  if (!result) {
    // Interval by interval, so an interval that cannot hold its own groups leaves only those alone.
    result = new Map();
    for (let k = 0; k <= walls.length; k++) {
      const one = place(new Map([...current].filter(([, index]) => index === k)));
      if (one) for (const [id, x] of one) result.set(id, x);
    }
  }
  for (const group of movers) {
    const left = result.get(group.id);
    if (left === undefined) continue;
    const dx = left - occupied(group).low;
    if (Math.abs(dx) > PLACEMENT_EPS) moveGroup(model, group, dx, 0);
  }
}

/**
 * Place the free members of a canton on one tier (canton-groups ticket 56, Section 2b rule 3). A member is a frame of one
 * cell, and its target is the mean x of its settled partners as for any free group. It stands inside its canton: the canton
 * frame box, less the group margin, bounds the member's frame, and the other members that hold a cell on the tier are walls
 * `2 * GROUP_PADDING` away, the beside rule; the lanes held in the tier are walls with no gap, as in `sweep`. The same run packer as
 * `sweep` places what falls between two walls.
 */
function sweepMembers(model: LayoutModel, tier: number, targets: ReadonlyMap<string, number>, columns: readonly FrameColumn[]): void {
  if (model.document.frames === undefined || deriveFrames(model) === undefined) return;
  for (const column of columns.filter(item => item.wall !== undefined && item.from <= tier && tier <= item.to)) {
    const movers = [...targets.keys()].filter(id => column.cells.has(id)).map(id => model.groups[id]!);
    if (!movers.length) continue;
    const { box, gap, walls, low, high } = memberSpace(model, column, tier, movers.map(group => group.id));
    const item = (group: LayoutGroup): Item => {
      const frame = box.get(group.frame!)!;
      return { id: group.id, want: targets.get(group.id)! - (group.bounds!.x + group.bounds!.width / 2 - frame.x) - 0, width: frame.width };
    };
    const centre = (wall: { low: number; high: number; gap: number }): number => (wall.low + wall.high) / 2;
    const interval = (group: LayoutGroup): number => walls.filter(wall => centre(wall) < targets.get(group.id)!).length;
    const result = new Map<string, number>();
    for (let k = 0; k <= walls.length; k++) {
      const members = movers.filter(group => interval(group) === k).sort((a, b) => targets.get(a.id)! - targets.get(b.id)! || compareId(a.id, b.id));
      if (!members.length) continue;
      const before = walls[k - 1], after = walls[k];
      const solved = packRun(members.map(item), Math.max(low, before ? before.high + before.gap : -Infinity), Math.min(high, after ? after.low - after.gap : Infinity), gap);
      if (solved) for (const [id, x] of solved) result.set(id, x);
    }
    for (const group of movers) {
      const x = result.get(group.id);
      if (x === undefined) continue;
      const dx = x - box.get(group.frame!)!.x;
      if (Math.abs(dx) > PLACEMENT_EPS) moveGroup(model, group, dx, 0);
    }
  }
}

/**
 * Left edges for `items`, in order, inside `[low, high]` with `gap` between neighbours, at the least
 * squared distance from the edges they want: each item goes where it wants, an item that overlaps the
 * run before it joins that run, and a run that joined moves as a whole to the mean of what its members
 * want, then back inside the interval. Undefined when the run does not fit the interval.
 */
function packRun(items: Item[], low: number, high: number, gap: number): Map<string, number> | undefined {
  interface Cluster { first: number; last: number; weight: number; sum: number; width: number; x: number }
  const total = items.reduce((sum, one) => sum + one.width, 0) + gap * (items.length - 1);
  if (total > high - low + PLACEMENT_EPS) return undefined;
  const clusters: Cluster[] = [];
  const settle = (cluster: Cluster): void => {
    cluster.x = Math.min(Math.max(cluster.sum / cluster.weight, low), high - cluster.width);
  };
  for (const [index, one] of items.entries()) {
    let cluster: Cluster = { first: index, last: index, weight: 1, sum: one.want, width: one.width, x: 0 };
    settle(cluster);
    for (let previous = clusters[clusters.length - 1]; previous && previous.x + previous.width + gap > cluster.x; previous = clusters[clusters.length - 1]) {
      clusters.pop();
      previous.sum += cluster.sum - cluster.weight * (previous.width + gap);
      previous.weight += cluster.weight;
      previous.width += gap + cluster.width;
      previous.last = cluster.last;
      settle(previous);
      cluster = previous;
    }
    clusters.push(cluster);
  }
  const result = new Map<string, number>();
  for (const cluster of clusters) {
    let x = cluster.x;
    for (let i = cluster.first; i <= cluster.last; i++) {
      result.set(items[i]!.id, x);
      x += items[i]!.width + gap;
    }
  }
  return result;
}

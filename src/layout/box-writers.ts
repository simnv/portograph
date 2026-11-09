/**
 * The box writers: every `moveGroup` call site in `src/` (DR-11; audit P-06 table 3a, T-25). R2 says every write to a box after 7a asks a guard
 * and refuses whole, or works on a draft. Each entry names how its site keeps the reservations: a guard it asks, the reservations it keeps by
 * construction, or the withdrawal or replan path of the rule that owns the reservation it can break. `npm run lint`
 * (`scripts/check-box-writers.mjs`) fails when the `moveGroup` call sites of a function differ in number from its entries here: a new
 * `moveGroup` writer states its guard in this table first.
 *
 * The limit: the table and its lint hold the `moveGroup` calls only. A direct write to a node box or a port anchor is not in the table, and the
 * lint does not see it: `topUpBandClearance`, `insertRoomAt` (bands.ts), `stepOverChords` (chord-clear.ts, two sites), `moveSide`
 * (feed-split.ts), `shiftNode` (centre.ts), `seatBlockFollowers` (solid-blocks.ts, two sites), `moveNode` (rows.ts), and the nodes of a group
 * that W09 moves in part (bundle-geometry.ts). Each of these writes also lands in the net draft that the producer postconditions judge.
 *
 * The transient kinds are those of `move-reservations.ts`: riser keep-out (Ri), trunk extension (Tr), lane sides with the frozen chords (La),
 * side alignment (Si), span corridor (Sp), group exit (Ex). They are not active before 7a. Every write of 7e and 7f also lands in the net draft
 * that the producer postconditions judge before commit (`postconditions.ts`); publication and restore are the second boundary.
 *
 * Proof terms used below. "y-only band shift": every group of every tier at or below one line moves down by one amount, with nothing else
 * moving in x; Ri, Si and the lane-side half of La read x only (`lanes.ts`, `riserPenetrations`, `sideLanesHold`, `laneSidesHold`), so they
 * hold. Tr holds for a pair of boxes on one side of the line, and two boxes across the line only move apart. The frozen chords, the span
 * corridors and the exits are derived from the moved anchors: the replay that follows rebuilds the lane extents (a chord that leaves its band
 * throws `SpanRefusal`), re-derives the exits as held promises (`reserveGroupExits`: a replan before the final freeze), and the span and chord
 * findings end as `SPAN_CHORD_BLOCKED` and `STRAIGHT_LINK_BLOCKED`, which the span round reads to withdraw a trial.
 */
export type WriterGuard =
  /** Stages 4 to 6, before the transient kinds exist; the ledger kinds of those stages are checked at publication. */
  | { kind: 'pre-7a' }
  /** Asks a guard before or after the write and refuses or undoes the whole write. */
  | { kind: 'guarded'; by: string }
  /** A forced write: the reservations it keeps by construction, and the withdrawal or replan path of each one it does not. */
  | { kind: 'forced'; keeps: string; otherwise: string }
  /** No write to a published draft: a copy, a probe that always undoes, or the rollback of a guarded write. */
  | { kind: 'scratch'; why: string };

export interface BoxWriter {
  /** The P-06 id (W01 to W37), or `S` and an index for a site before 7a. */
  id: string;
  file: string;
  /** The top-level function that holds the call. */
  fn: string;
  guard: WriterGuard;
}

const REPLAY = 'Sp, the frozen chords of La and Ex by the replay that follows (see the proof terms above)';

export const BOX_WRITERS: readonly BoxWriter[] = [
  // Stages 4 to 6.
  { id: 'S01', file: 'src/layout/skeleton-geometry.ts', fn: 'packGridGroups', guard: { kind: 'pre-7a' } },
  { id: 'S02', file: 'src/layout/skeleton-geometry.ts', fn: 'placeFlanksAndPeers', guard: { kind: 'pre-7a' } },
  { id: 'S03', file: 'src/layout/skeleton-geometry.ts', fn: 'placeFlanksAndPeers', guard: { kind: 'pre-7a' } },
  { id: 'S04', file: 'src/layout/skeleton-geometry.ts', fn: 'stackBands', guard: { kind: 'pre-7a' } },
  { id: 'S05', file: 'src/layout/skeleton-geometry.ts', fn: 'stackBands', guard: { kind: 'pre-7a' } },
  { id: 'S06', file: 'src/layout/joint-order.ts', fn: 'seatPredicted7c', guard: { kind: 'pre-7a' } },
  { id: 'S07', file: 'src/layout/joint-order.ts', fn: 'seatRun', guard: { kind: 'pre-7a' } },
  { id: 'S08', file: 'src/layout/overlay-order.ts', fn: 'orderByOverlay', guard: { kind: 'pre-7a' } },
  { id: 'S09', file: 'src/layout/overlay-order.ts', fn: 'orderFramesByOverlay', guard: { kind: 'pre-7a' } },
  { id: 'S10', file: 'src/layout/solid-blocks.ts', fn: 'permuteGroupSlots', guard: { kind: 'pre-7a' } },
  { id: 'S11', file: 'src/layout/columns.ts', fn: 'packStep', guard: { kind: 'pre-7a' } },
  { id: 'S12', file: 'src/layout/columns.ts', fn: 'packStep', guard: { kind: 'pre-7a' } },
  { id: 'S13', file: 'src/layout/columns.ts', fn: 'packStep', guard: { kind: 'pre-7a' } },
  { id: 'S14', file: 'src/layout/sides-two.ts', fn: 'sweepTiers', guard: { kind: 'pre-7a' } },
  { id: 'S15', file: 'src/layout/stagger.ts', fn: 'seatStaggerRows', guard: { kind: 'pre-7a' } },
  { id: 'S16', file: 'src/layout/rows.ts', fn: 'reseatBands', guard: { kind: 'pre-7a' } },
  { id: 'S17', file: 'src/layout/stagger.ts', fn: 'standChain', guard: { kind: 'pre-7a' } },
  // The group lift (D-Q5, ticket 08): `seatLifts` stands a lifted component beside the units of the bands it shares, in stage 4 and again after a fan-wrap chain move in stage 5.
  { id: 'S18', file: 'src/layout/skeleton-geometry.ts', fn: 'placeFlanksAndPeers', guard: { kind: 'pre-7a' } },
  { id: 'S19', file: 'src/layout/stagger.ts', fn: 'seatStaggerRows', guard: { kind: 'pre-7a' } },
  // 7a and 7b: the rule checks of the transaction see these writes.
  { id: 'W01', file: 'src/layout/lanes.ts', fn: 'allocateLanes', guard: { kind: 'guarded', by: 'the lanes rule checks of mutate (whole-group x translation, occupied intermediate tiers, fixed transit sources); the kinds begin here' } },
  { id: 'W02', file: 'src/layout/flanks.ts', fn: 'alignFlanks', guard: { kind: 'guarded', by: 'the flanks rule checks of mutate (no x translation, a common y translation of the flank group)' } },
  // The forced writes (P-06 F3): each keeps some kinds by construction, and the rest by the path it names.
  { id: 'W03', file: 'src/layout/region-rebuild.ts', fn: 'reserveBarBandGrowth', guard: { kind: 'forced', keeps: 'a y-only band shift by the growth of a bar band: Ri, Si, lane sides, Tr; in the bars rule the x of every non-bar box is checked unchanged', otherwise: REPLAY } },
  { id: 'W04', file: 'src/layout/rows.ts', fn: 'repackOverlaps', guard: { kind: 'forced', keeps: 'nothing moves while no two row groups overlap; a push right ends an overlap that stage 8 refuses (rows.ts throws on one it cannot end)', otherwise: 'no proof for a push in a replay of 7e or 7f: the producer postconditions judge the net draft (a refusal withdraws a trial and fails the main line by name)' } },
  { id: 'W05', file: 'src/layout/bundle-geometry.ts', fn: 'prepareBundleGeometry', guard: { kind: 'forced', keeps: 'a y-only move of one flank group to its primary: Ri, Si, lane sides', otherwise: `Tr and ${REPLAY}; the restack of the bands below follows (W06)` } },
  { id: 'W06', file: 'src/layout/bundle-geometry.ts', fn: 'prepareBundleGeometry', guard: { kind: 'forced', keeps: 'a y-only band shift by the growth of a band after the bundle fit: Ri, Si, lane sides, Tr', otherwise: REPLAY } },
  { id: 'W07', file: 'src/layout/bundle-geometry.ts', fn: 'prepareBundleGeometry', guard: { kind: 'forced', keeps: 'a y-only band shift for the room of a fan stem: Ri, Si, lane sides, Tr', otherwise: REPLAY } },
  { id: 'W08', file: 'src/layout/bundle-geometry.ts', fn: 'prepareBundleGeometry', guard: { kind: 'forced', keeps: 'a y-only band shift for the room of a bundle join: Ri, Si, lane sides, Tr', otherwise: REPLAY } },
  { id: 'W09', file: 'src/layout/bundle-geometry.ts', fn: 'prepareBundleGeometry', guard: { kind: 'guarded', by: 'holdsMove on the whole groups it moves in x, and on the widened box and the moved nodes (holdsNodeMove) of a group it moves in part; refused, no crossover room is taken (BUNDLE_ROOM_HELD) and the bundle draws straight members or refuses by name (ADR-0017)' } },
  { id: 'W10', file: 'src/layout/bundle-geometry.ts', fn: 'prepareBundleGeometry', guard: { kind: 'forced', keeps: 'a y-only band shift for the need of a facing bundle: Ri, Si, lane sides, Tr', otherwise: REPLAY } },
  { id: 'W15', file: 'src/layout/bands.ts', fn: 'topUpBandClearance', guard: { kind: 'forced', keeps: 'a y-only band shift for the clearance of a label band: Ri, Si, lane sides, Tr', otherwise: `${REPLAY}; it runs after the chord freeze, so a chord it blocks ends as STRAIGHT_LINK_BLOCKED` } },
  { id: 'W18', file: 'src/layout/bands.ts', fn: 'insertRoomAt', guard: { kind: 'forced', keeps: 'an x shift of the half-plane right of the split in every tier, with every lane and riser right of it: Ri, Si, lane sides for every unit wholly on one side of the split', otherwise: `a node of a straddling group keeps its port where a lane or riser past the split moves (Si, Ri), and Tr, ${REPLAY}; label room wins over a lane beyond it (user, 2026-10-24); the producer postconditions judge the net draft` } },
  { id: 'W19', file: 'src/layout/bands.ts', fn: 'reserveAcrossRunRoom', guard: { kind: 'forced', keeps: 'a y-only shift of the tiers below (and, for a top edge, of the group alone): Ri, Si, lane sides', otherwise: `Tr and ${REPLAY}` } },
  { id: 'W20', file: 'src/layout/columns.ts', fn: 'separateFrameColumns', guard: { kind: 'forced', keeps: 'nothing moves while the frame columns stand apart; a move ends an overlap of two frame columns', otherwise: 'no proof for a move in a replay of 7e or 7f: the producer postconditions judge the net draft (a refusal withdraws a trial and fails the main line by name)' } },
  // `holdLifts` (D-Q5, ticket 08): a lifted component moves only away from the units and link corridors of its shared bands, by the least x that restores the beside gap a column pass took.
  { id: 'W38', file: 'src/layout/columns.ts', fn: 'separateFrameColumns', guard: { kind: 'forced', keeps: 'nothing moves while a lifted component keeps its beside gap; a move pushes the whole component away from the column that came nearer', otherwise: 'no proof for a move in a replay of 7e or 7f: the producer postconditions judge the net draft, and publication checks the recorded side (validateGroupLifts)' } },
  { id: 'W39', file: 'src/layout/columns.ts', fn: 'holdColumnAxes', guard: { kind: 'forced', keeps: 'nothing moves while a lifted component keeps its beside gap; a move pushes the whole component away from the column that came nearer', otherwise: 'no proof for a move in a replay of 7e or 7f: the producer postconditions judge the net draft, and publication checks the recorded side (validateGroupLifts)' } },
  { id: 'W37', file: 'src/layout/gap-room.ts', fn: 'moveBands', guard: { kind: 'forced', keeps: 'a y-only band shift by the room the tier gaps above gained, label and canton bands with it: Ri, Si, lane sides, Tr; a solid block refuses by SolidBlockRefusal', otherwise: `${REPLAY}; after the gap solve the linkless groups step out of held chords` } },
  // Guarded writes of 7c to 7f.
  { id: 'W12', file: 'src/layout/close-up.ts', fn: 'closeUpSiblings', guard: { kind: 'guarded', by: 'closeUpRefusal, check then undo (La by validateLanes and the chord sets; Si by construction; the stored ledger by holds); declined whole' } },
  { id: 'W13', file: 'src/layout/bands.ts', fn: 'settleKeepOut', guard: { kind: 'guarded', by: 'holdsMove before the move, then a straight-link check with rollback' } },
  { id: 'W14', file: 'src/layout/bands.ts', fn: 'settleKeepOut', guard: { kind: 'scratch', why: 'the rollback of W13' } },
  { id: 'W16', file: 'src/layout/bands.ts', fn: 'alignGrid', guard: { kind: 'guarded', by: 'holdsMove, growthHolds, separationsBrokenBy, widensIntoFrame, packOpens, gapsHoldGrowth; a refusal is recorded in gridRefusals' } },
  { id: 'W17', file: 'src/layout/bands.ts', fn: 'alignGrid', guard: { kind: 'scratch', why: 'the rollback of W16 when a span corridor cannot follow' } },
  { id: 'W21', file: 'src/layout/columns.ts', fn: 'closeUp', guard: { kind: 'guarded', by: 'holdsMove, then a straight-overlay check with exact undo' } },
  { id: 'W22', file: 'src/layout/columns.ts', fn: 'pullTier', guard: { kind: 'guarded', by: 'holdsMove, then a straight-overlay check and undo' } },
  { id: 'W23', file: 'src/layout/columns.ts', fn: 'pullTier', guard: { kind: 'scratch', why: 'a probe: moves a unit, reads whether a straight link bends, always undoes' } },
  { id: 'W24', file: 'src/layout/columns.ts', fn: 'packBesideRows', guard: { kind: 'guarded', by: 'holdsMove; a refusal names FRAME_PACK_HELD' } },
  { id: 'W25', file: 'src/layout/decide.ts', fn: 'chooseStep', guard: { kind: 'guarded', by: 'the caller asks holdsMove; then a profile judgment with undo' } },
  { id: 'W26', file: 'src/layout/chord-clear.ts', fn: 'stepOverChords', guard: { kind: 'guarded', by: 'decision.choose with holdsMove and chordsHold, saveGroups undo' } },
  { id: 'W27', file: 'src/layout/chord-clear.ts', fn: 'stepOverChords', guard: { kind: 'guarded', by: 'decision.choose with holdsMove and chordsHold, saveGroups undo' } },
  { id: 'W28', file: 'src/layout/centre.ts', fn: 'packClear', guard: { kind: 'guarded', by: 'laneSidesHold and the window bound; refused, CENTRE_TIER_PACK_INFEASIBLE' } },
  { id: 'W29', file: 'src/layout/centre.ts', fn: 'standNearFeed', guard: { kind: 'guarded', by: 'holdsMove' } },
  { id: 'W30', file: 'src/layout/centre.ts', fn: 'spreadParent', guard: { kind: 'guarded', by: 'resizeEvidence before, resizeHolds after, undo on refusal' } },
  { id: 'W31', file: 'src/layout/centre.ts', fn: 'centreGroupStepRaw', guard: { kind: 'guarded', by: 'the step window and a post-condition (riser, span, lane crossings, chord clearance); on failure the saved group is restored' } },
  { id: 'W32', file: 'src/layout/centre.ts', fn: 'centreGroupStepRaw', guard: { kind: 'guarded', by: 'the clamp into the window, inside the post-condition of W31' } },
  { id: 'W33', file: 'src/layout/centre.ts', fn: 'centreGroupStepRaw', guard: { kind: 'guarded', by: 'keptRefusal and the fewer-verticals test' } },
  { id: 'W34', file: 'src/layout/overlay-place.ts', fn: 'standLinklessBeside', guard: { kind: 'guarded', by: 'fits, with holdsMove, the chord bans and the walls' } },
  { id: 'W35', file: 'src/layout/overlay-place.ts', fn: 'sweep', guard: { kind: 'guarded', by: 'a window clamp between the walls of the tier (groups, frame columns, lanes); a free overlay group has no routed port' } },
  { id: 'W36', file: 'src/layout/overlay-place.ts', fn: 'sweepMembers', guard: { kind: 'guarded', by: 'a window clamp between the member walls' } },
  { id: 'W11', file: 'src/layout/end-trim.ts', fn: 'untrimmedModel', guard: { kind: 'scratch', why: 'rebuilds the pre-trim geometry on a copy' } },
];

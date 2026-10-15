import type { Lane } from '../model/layout.js';

/**
 * What a lane is, as a run (architecture ticket 15, phase 5): a full-band `transit` run, a `gap` run in a free column, or a `perimeter` run beyond every unit, or a `span` corridor of a spanning chord (architecture ticket 22), which is a reservation and no run.
 * The side lane of tickets 118 and 119 is the one-band case of a column-gap lane that serves a lateral port, so its stored kind `side` reads as `gap`; its id and
 * the layout JSON do not change. This module imports no layout code, so every reader of lanes can use it without a cycle.
 */
export const laneRunKind = (lane: Pick<Lane, 'kind'>): 'transit' | 'gap' | 'perimeter' | 'span' =>
  lane.kind === 'perimeter' ? 'perimeter' : lane.kind === 'gap' || lane.kind === 'side' ? 'gap' : lane.kind === 'span' ? 'span' : 'transit';

/** The id of the span corridor of a spanning chord in one sub-tier. A leaf, so the ledger can name a corridor without loading the span rules. */
export const spanLaneId = (link: string, tier: number): string => `span:${link}:${tier}`;

/** Whether a lane is a column-gap run: a gap lane of a course, or a side lane. */
export const isGapRun = (lane: Pick<Lane, 'kind'>): boolean => laneRunKind(lane) === 'gap';

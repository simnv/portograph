import type { PortRef } from '../model/document.js';
import type { Side } from '../model/geometry.js';
import type { Diagnostic, LayoutModel, LayoutPort } from '../model/layout.js';
import { busOfPort } from './bus.js';
import { authoredSide, groupShape } from './grid.js';
import { portKey, tiedPortComponents } from './sides-one.js';
import { PlacementRefusal, type RefusalCode, type RefusalDetail } from './placement-refusal.js';

/**
 * Side hints (docs/design/side-faces.md, Sections 3, 4 and 7): the lateral side an engine measure asks a port to take in the next placement
 * run, keyed by `portKey`. A hint ranks below an author `side:` and above the stage-2 rule. It is an input of placement (ADR-0022), never
 * written in the YAML.
 */
/** A placement run refused a side hint (not a candidate, a lateral vote, a floor below the content). The side round drops the offer; every other error is a bug. */
export class SideHintRefusal extends PlacementRefusal {
  constructor(message: string, detail: RefusalDetail & { code?: RefusalCode } = {}) { super(detail.code ?? 'side', message, detail); }
}

/** Stage 5 found a foreign unit beside a member row of a trunk join on both sides: the join is declined by one placement re-run (`trunk-blocked`, mesh-bus.md, section 12.4). */
export class TrunkBlocked extends SideHintRefusal {
  constructor(public readonly key: string, public readonly why: string) { super(`The trunk join ${key} is blocked: ${why}`, { code: 'trunk' }); }
}
export type SideHints = ReadonlyMap<string, 'left' | 'right'>;
export const NO_SIDE_HINTS: SideHints = new Map();

const describe = (ref: PortRef): string => `${ref.node}.${ref.anonymous === true ? `#${ref.ordinal}` : `${ref.name}#${ref.ordinal}`}`;

/**
 * Why the port `ref` is no hint candidate under spec Section 4, items 2 to 6, or `undefined` when it is one. Items 1 (the natural side is
 * `top` or `bottom`) and 7 (the link is bent now) are the caller's: item 1 needs the stage-5 side of an undecided port, item 7 a placed model.
 * The same reader serves stage 2 and `restoreLayoutModel`, so a hint is refused for the same reason in both.
 */
export function hintRefusal(model: LayoutModel, ref: PortRef): string | undefined {
  const key = portKey(ref);
  // A course owns the face of its ports (ticket 15): the side round offers no hint on one, as on an author side.
  if (model.nodes[ref.node]?.ports.some(port => portKey(port.ref) === key && port.courseHint === true)) return 'the port is owned by a course';
  const ends = (link: LayoutModel['links'][number]): PortRef[] => [link.attachments?.from ?? link.from, link.attachments?.to ?? link.to]
    .filter((end): end is PortRef => end.node !== undefined && 'ordinal' in end);
  const links = model.links.filter(link => ends(link).some(end => portKey(end) === key));
  const count = model.links.reduce((sum, link) => sum + ends(link).filter(end => portKey(end) === key).length, 0);
  if (busOfPort(model, ref) !== undefined) return 'the port is on a mesh bus';
  if (count !== 1) return count === 0 ? 'the port carries no link' : 'the port is shared by several links (a fan)';
  const link = links[0]!;
  if (link.bundle !== undefined || tiedPortComponents(model).has(key)) return 'the port belongs to a bundle';
  if (link.meshBus !== undefined) return 'the link is a mesh-bus link';
  const route = model.document.links[link.sourceIndex]?.route;
  if (link.technique === 'stub' || route === 'stub') return 'the link is a stub';
  if (link.groupLink !== undefined) return 'the link is a group-link collapse';
  if (route !== undefined && route !== 'straight') return `the link has an author route override (${route})`;
  if (authoredSide(model, ref) !== undefined) return 'the port has an author side';
  const group = model.document.nodes[ref.node]!.group;
  const shape = groupShape(model, group);
  if (shape === 'grid' || shape === 'bar') return `the node is in a ${shape} group`;
  if (model.groups[group]?.flank !== undefined) return 'the node is in a flank';
  const other = ends(link).map(end => end).find(end => portKey(end) !== key) ?? ref;
  const tiers = [ref.node, other.node].map(node => model.groups[model.document.nodes[node]!.group]!.tier!);
  // Only a routed link owns a transit lane (`transitTiers` is empty for any other layer): an overlay link may cross a sub-tier.
  if (link.layer === 'routed' && Object.values(model.groups).some(item => item.tier! > Math.min(...tiers) && item.tier! < Math.max(...tiers))) return 'the link owns a transit lane';
  return undefined;
}

/** Refuse a hint on a port that is no candidate (spec Section 4, items 2 to 6), or on a port the model does not have. */
export function checkSideHints(model: LayoutModel, hints: SideHints): void {
  for (const [key, side] of hints) {
    const [node] = JSON.parse(key) as [string];
    const port = model.nodes[node]?.ports.find(item => portKey(item.ref) === key);
    if (port === undefined) throw new SideHintRefusal(`Side hint names a port the document does not have: ${key}`);
    if (side !== 'left' && side !== 'right') throw new SideHintRefusal(`Side hint on ${describe(port.ref)} must be left or right`);
    const why = hintRefusal(model, port.ref);
    if (why !== undefined) throw new SideHintRefusal(`Side hint on ${describe(port.ref)} refused: ${why}`);
  }
}

/** The lateral side that faces a peer: `right` when the peer's centre is right of the node's centre, else `left` (spec Section 4). */
export const facingSide = (nodeCentreX: number, peerCentreX: number): Side => peerCentreX > nodeCentreX ? 'right' : 'left';

export const isHinted = (port: LayoutPort): boolean => port.sideHint === true;

/**
 * `SIDE_HINT_FACES_AWAY` (warning, placement), read at the end of 7f: a hinted port whose peer now stands on the side the port does not face.
 * The round drops a trial that fails this at 7e; 7f can still move a column. Restore does not refuse such a layout (ADR-0010: it accepts
 * every layout the pipeline publishes), so the published shape is named here and by `SIDE_SHAPE_LOST` (side-faces.md, Section 13).
 */
export function sideHintDiagnostics(model: LayoutModel): Diagnostic[] {
  return hintsFacingAway(model).map(({ link, own, peer }) => ({ stage: 'placement' as const, severity: 'warning' as const, code: 'SIDE_HINT_FACES_AWAY',
    message: `The side hint on ${describe(own)} faces away from its peer ${peer.node} after placement.`, owners: [{ kind: 'link' as const, id: link }] }));
}

/** Each hinted port whose peer stands on the side the port does not face, in link order (the round reads it at 7e, the pipeline after 7f). */
export function hintsFacingAway(model: LayoutModel): { key: string; link: string; own: PortRef; peer: PortRef }[] {
  const found: { key: string; link: string; own: PortRef; peer: PortRef }[] = [];
  for (const link of model.links) {
    const ends = link.attachments;
    if (ends === undefined) continue;
    for (const [own, peer] of [[ends.from, ends.to], [ends.to, ends.from]] as const) {
      const port = model.nodes[own.node]!.ports.find(item => portKey(item.ref) === portKey(own));
      const a = model.nodes[own.node]!.bounds, b = model.nodes[peer.node]!.bounds;
      if (port?.sideHint !== true || a === undefined || b === undefined) continue;
      if (facingSide(a.x + a.width / 2, b.x + b.width / 2) === port.side) continue;
      found.push({ key: portKey(own), link: link.id, own, peer });
    }
  }
  return found;
}

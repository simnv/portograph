import type { LayoutGroup, LayoutLink, LayoutModel, MeshBus } from '../model/layout.js';
import { FONT_FAMILY, measureText } from '../text/index.js';

/**
 * The room a mesh bus asks for, in a leaf module that reads the model and the text metrics only, so
 * `regions.ts` (which every placement stage imports) can ask it without a cycle
 * (docs/design/mesh-bus.md, section 4, *Bus band*).
 */

/** The bar stands this far beyond the row's outermost body or pill extent: the port-stem convention. */
export const BUS_STUB = 15;
/** The run clearance `k` of the routing rule (11.5 px): the room beyond a bar that has no label. */
export const BUS_RUN_CLEARANCE = 11.5;
/** The label's font, as a link label's: `FONT_FAMILY` at 9 px. */
export const BUS_LABEL_FONT = { fontFamily: FONT_FAMILY, fontSize: 9, fontWeight: 400 as const } as const;
/** The room above and below the label beyond the bar. */
export const BUS_LABEL_GAP = 4;

/** The text of a bus label: `<class> mesh (<n> nodes)`. */
export function busLabelText(bus: MeshBus): string {
  return `${bus.class ?? 'unclassed'} mesh (${bus.meshNodes ?? bus.nodes.length} nodes)`;
}

/** The label's measured box. */
export function busLabelSize(bus: MeshBus): { width: number; height: number } {
  return measureText(busLabelText(bus), { fontSize: BUS_LABEL_FONT.fontSize, weight: BUS_LABEL_FONT.fontWeight });
}

/**
 * Whether the bar of this bus carries the label. A joined mesh has one label, on the bar of the bus with more members (the upper bar on a
 * tie); the other bar has the stub, the bar and the run clearance only (mesh-bus.md, section 11.5, *The label*).
 */
export function busCarriesLabel(bus: MeshBus): boolean {
  if (bus.joined === undefined || bus.meshNodes === undefined) return true;
  const other = bus.meshNodes - bus.nodes.length;
  return bus.nodes.length > other || (bus.nodes.length === other && bus.cross !== undefined);
}

/** Whether `link` is a cross link of a join: it carries the upper bus's id and is no member (mesh-bus.md, section 11.6). */
export function isCrossLink(model: LayoutModel, link: LayoutLink): boolean {
  if (link.meshBus === undefined) return false;
  return (model.meshBuses ?? []).find(item => item.id === link.meshBus)?.cross?.includes(link.id) === true;
}

/** The bus band: from the row's outermost extent out to the bar, plus `4 px + label height + 4 px` beyond it. */
export function busBandHeight(bus: MeshBus): number {
  if (!busCarriesLabel(bus)) return BUS_STUB + BUS_RUN_CLEARANCE;
  return BUS_STUB + BUS_LABEL_GAP + busLabelSize(bus).height + BUS_LABEL_GAP;
}

/** The in-frame bus whose members stand in `group` (its cell, or the group itself), once the side is fixed. */
export function inFrameBusOf(model: LayoutModel, group: LayoutGroup): MeshBus | undefined {
  return (model.meshBuses ?? []).find(bus => bus.placement === 'in-frame' && bus.side !== undefined && group.nodes.includes(bus.nodes[0]!));
}

/** The room the group must hold on each horizontal edge for its in-frame bus, from the buses (zero without one). */
export function busRoom(model: LayoutModel, group: LayoutGroup): { top: number; bottom: number } {
  const room = { top: 0, bottom: 0 };
  const bus = inFrameBusOf(model, group);
  if (bus !== undefined) room[bus.side!] = busBandHeight(bus);
  return room;
}

/** The room the group holds now, from the bus bands 7f has published (zero before it reserves them). */
export function heldBusRoom(model: LayoutModel, group: LayoutGroup): { top: number; bottom: number } {
  const room = { top: 0, bottom: 0 };
  for (const band of model.busBands ?? []) if (band.group === group.id) room[band.side] = band.bounds.height;
  return room;
}

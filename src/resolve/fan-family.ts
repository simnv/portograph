import type { FanFamily, LayoutLink, LayoutModel, PortRef } from '../model/index.js';
import { groupShape } from '../layout/grid.js';
import { faintLinkClass } from '../profiles/network/theme.js';

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/**
 * Stage 1, after the mesh bus: find the fan families (architecture-2 ticket 40; CONTEXT.md, *fan family*; user rulings Q124 to Q126).
 *
 * A **candidate** is a routed link of a faint class (dashed or dotted, `faintLinkClass`) with no bundle, stub, group-link or mesh bus, no
 * authored route but `straight`, two different end nodes, no flank and no bar end, each port on no other routed link, whose two ends stand on
 * consecutive document tiers in two different **units** (the outermost frame, canton or free group that holds an end). One end is the **hub
 * end**: its tier group (the document group that holds it) and the link's class key the cohort. The other end's unit is a **far unit**.
 *
 * A cohort is a family when it has two hubs or more, three far units or more, and every hub reaches every far unit (complete incidence). The
 * trigger counts per tier group, never per node, so one hub with a wide fan is no family. A link two families claim joins neither: both are
 * declined (`FAN_FAMILY_DECLINED`). The function reads the document and the resolved links only, so resolving `model.document` reproduces it
 * (`mutation.ts` compares the records). Absent `fanFamilies` = the sheet has none.
 */

/** The fewest hubs, and the fewest far units, of a fan family (user ruling Q124: two hubs or more, three far frames or more). */
export const FAN_MIN_HUBS = 2;
export const FAN_MIN_UNITS = 3;

const portKey = (ref: PortRef): string => JSON.stringify([ref.node, ref.anonymous === true, ref.name ?? null, ref.ordinal]);

/** The document group (frame) that holds a layout group: a rank cell reads its frame. */
function frameOf(model: LayoutModel, group: string): string {
  return model.groups[group]?.frame ?? group;
}

/** The authored tier of a document group: a cell reads its own `documentTier`, a child group its parent's. Undefined for a canton or a group with none. */
function documentTier(model: LayoutModel, group: string): number | undefined {
  let id = group;
  for (let depth = 0; depth < 4; depth++) {
    const source = model.document.groups[id];
    if (source === undefined) return undefined;
    if (source.documentTier !== undefined || source.tier !== undefined) return source.documentTier ?? source.tier;
    if (source.parent === undefined) return undefined;
    id = source.parent;
  }
  return undefined;
}

/** The outermost unit that holds a node: its frame, then each parent frame and the canton above it. */
function unitOf(model: LayoutModel, node: string): string | undefined {
  const group = model.document.nodes[node]?.group;
  if (group === undefined) return undefined;
  let unit = frameOf(model, group);
  for (let depth = 0; depth < 6; depth++) {
    const parent = model.document.frames?.[unit]?.parent ?? model.document.groups[unit]?.parent ?? model.document.groups[unit]?.canton;
    if (parent === undefined) return unit;
    unit = frameOf(model, parent);
  }
  return unit;
}

interface Cohort { group: string; klass: string; links: { link: LayoutLink; hub: string; unit: string }[] }

/** Whether the link is a candidate, apart from its orientation: what the two ends must both satisfy. */
function candidate(model: LayoutModel, link: LayoutLink, shared: ReadonlyMap<string, number>): boolean {
  if (link.layer !== 'routed' || link.family !== 'routed' || !link.attachments || link.bundle !== undefined || link.groupLink !== undefined || link.meshBus !== undefined) return false;
  const source = model.document.links[link.sourceIndex];
  if (source === undefined || !faintLinkClass(source.class)) return false;
  if (source.route !== undefined && source.route !== 'straight') return false;
  const { from, to } = link.attachments;
  if (from.node === to.node) return false;
  for (const ref of [from, to]) {
    if ((shared.get(portKey(ref)) ?? 0) > 1) return false;
    const group = model.document.nodes[ref.node]?.group;
    if (group === undefined || model.groups[group]?.flank !== undefined || groupShape(model, group) === 'bar') return false;
  }
  return true;
}

/** Decide the fan families of the model (stage 1) and mark their member links. Writes nothing when there is none. */
export function detectFanFamilies(model: LayoutModel): void {
  const shared = new Map<string, number>();
  for (const link of model.links) {
    if (link.layer !== 'routed' || !link.attachments) continue;
    for (const ref of [link.attachments.from, link.attachments.to]) shared.set(portKey(ref), (shared.get(portKey(ref)) ?? 0) + 1);
  }
  const cohorts = new Map<string, Cohort>();
  for (const link of model.links) {
    if (!candidate(model, link, shared)) continue;
    const ends = [link.attachments!.from.node, link.attachments!.to.node];
    const cells = ends.map(node => model.document.nodes[node]!.group);
    const units = ends.map(node => unitOf(model, node)), groups = cells.map(cell => frameOf(model, cell));
    // The authored tier is read on the node's own layout group: an expanded document keeps it on each cell, and its frame is no document group.
    const tiers = cells.map(cell => documentTier(model, cell));
    if (units.some(unit => unit === undefined) || units[0] === units[1] || tiers.some(tier => tier === undefined) || Math.abs(tiers[0]! - tiers[1]!) !== 1) continue;
    const klass = model.document.links[link.sourceIndex]!.class!;
    // Either end may be the hub end: the link joins the cohort of each end's tier group, and only a cohort that qualifies keeps it.
    for (const [hub, far] of [[0, 1], [1, 0]] as const) {
      const key = JSON.stringify([groups[hub], klass]);
      const cohort = cohorts.get(key) ?? { group: groups[hub]!, klass, links: [] };
      cohort.links.push({ link, hub: ends[hub]!, unit: units[far]! });
      cohorts.set(key, cohort);
    }
  }
  const families: FanFamily[] = [];
  for (const cohort of cohorts.values()) {
    const hubs = [...new Set(cohort.links.map(item => item.hub))].sort();
    const units = [...new Set(cohort.links.map(item => item.unit))].sort();
    if (hubs.length < FAN_MIN_HUBS || units.length < FAN_MIN_UNITS) continue;
    const reached = new Set(cohort.links.map(item => JSON.stringify([item.hub, item.unit])));
    if (!hubs.every(hub => units.every(unit => reached.has(JSON.stringify([hub, unit]))))) continue;
    // The last key of the member order is the link id, which is unique (R3).
    const members = cohort.links.map(item => ({ link: item.link.id, hub: item.hub, unit: item.unit }))
      // By content: hub, then unit; the link id is the last key (R3), for two links of one hub into one unit.
      .sort((a, b) => compare(a.hub, b.hub) || compare(a.unit, b.unit) || compare(a.link, b.link));
    families.push({ id: `fan:${cohort.group}:${cohort.klass}`, group: cohort.group, class: cohort.klass, hubs, units, members });
  }
  if (!families.length) return;
  families.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // A link two families claim joins neither: the families are decided per tier group, and one link drawn by two rules is no drawing.
  const claims = new Map<string, string[]>();
  for (const family of families) for (const member of family.members) claims.set(member.link, [...(claims.get(member.link) ?? []), family.id]);
  const declined = new Set([...claims.values()].filter(ids => ids.length > 1).flat());
  for (const id of [...declined].sort()) {
    model.diagnostics.push({ stage: 'model', severity: 'warning', code: 'FAN_FAMILY_DECLINED',
      message: `The fan family ${id} is declined: a member link belongs to another fan family too.`, owners: [] });
  }
  const kept = families.filter(family => !declined.has(family.id));
  if (!kept.length) return;
  const byId = new Map(model.links.map(link => [link.id, link]));
  for (const family of kept) {
    for (const member of family.members) byId.get(member.link)!.fanFamily = family.id;
    model.diagnostics.push({ stage: 'model', severity: 'info', code: 'FAN_FAMILY',
      message: `The fan family ${family.id}: ${family.hubs.length} hubs (${family.hubs.join(', ')}) to ${family.units.length} units (${family.units.join(', ')}), ${family.members.length} members.`,
      owners: family.members.map(member => ({ kind: 'link' as const, id: member.link })) });
  }
  model.fanFamilies = kept;
}

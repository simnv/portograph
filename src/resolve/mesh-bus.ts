import { orderedNodeIds, type Diagnostic, type LayoutLink, type LayoutModel, type MeshBus, type Owner, type PortRef } from '../model/index.js';
import { groupShape } from '../layout/grid.js';
import { classDrawsArrowhead } from '../model/classes.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';

/**
 * Stage 1, after aggregation: find the mesh buses (docs/design/mesh-bus.md, section 3; Q105).
 *
 * A bus is the maximum clique of three or more nodes in the graph of the overlay links of one class
 * that join two nodes of one row. The member links get `meshBus` and `technique: 'mesh-bus'`, their
 * ends move to one bus port per node, and the anonymous ports that only those ends used are removed.
 * The bus has no geometry yet. The function reads the document and the resolved links only, in
 * declaration order, so the same document gives the same buses. It changes `attachments` and ports
 * and never the document, so resolving `model.document` reproduces the model (`mutation.ts`).
 */

const MISSING_PAIR_LIMIT = 8;

interface Edge { a: number; b: number; links: LayoutLink[] }
interface Mesh { klass: string; classIndex: number; nodes: number[]; adjacency: Map<number, Set<number>>; edges: Map<string, Edge> }

const edgeKey = (a: number, b: number): string => a < b ? `${a}:${b}` : `${b}:${a}`;

/** The most maximal cliques read for one row and class; a graph with more is declined (`too-many-cliques`). */
export const CLIQUE_LIMIT = 4096;

/**
 * The maximal cliques (Bron-Kerbosch with pivoting), or `undefined` past `CLIQUE_LIMIT`. The degree limit does not
 * bound the work: a row of 28 nodes can hold 16,384 maximal cliques, and their number grows exponentially.
 */
function maximalCliques(adjacency: Map<number, Set<number>>): number[][] | undefined {
  const result: number[][] = [];
  let exceeded = false;
  const expand = (clique: number[], candidates: Set<number>, excluded: Set<number>): void => {
    if (exceeded) return;
    if (!candidates.size && !excluded.size) {
      if (result.length >= CLIQUE_LIMIT) exceeded = true; else result.push([...clique].sort((x, y) => x - y));
      return;
    }
    let pivot = -1, best = -1;
    for (const u of [...candidates, ...excluded]) {
      let shared = 0;
      for (const v of candidates) if (adjacency.get(u)!.has(v)) shared++;
      if (shared > best) { best = shared; pivot = u; }
    }
    for (const v of [...candidates]) {
      if (adjacency.get(pivot)!.has(v)) continue;
      const near = adjacency.get(v)!;
      expand([...clique, v], new Set([...candidates].filter(u => near.has(u))), new Set([...excluded].filter(u => near.has(u))));
      candidates.delete(v);
      excluded.add(v);
    }
  };
  expand([], new Set(adjacency.keys()), new Set());
  return exceeded ? undefined : result;
}

/** Lexicographic order of two sorted declaration-index lists. */
function compareIndices(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

const sameRef = (a: PortRef, b: PortRef): boolean => a.node === b.node && a.ordinal === b.ordinal
  && (a.name ?? undefined) === (b.name ?? undefined) && (a.anonymous ?? false) === (b.anonymous ?? false);

export function detectMeshBuses(model: LayoutModel): void {
  const nodeIds = orderedNodeIds(model.document);
  const order = new Map(nodeIds.map((id, index) => [id, index]));
  const linkIndex = new Map(model.links.map((link, index) => [link, index]));
  const report = (code: string, severity: Diagnostic['severity'], message: string, links: LayoutLink[]): void => {
    model.diagnostics.push({ stage: 'model', severity, code, message, owners: links.map((link): Owner => link.owner) });
  };

  // The layout group that holds each node: a rank cell for a ranked group, the group itself otherwise.
  const holder = new Map<string, string>();
  for (const [id, group] of Object.entries(model.groups)) for (const node of group.nodes) holder.set(node, id);
  const groupLinkLayer = new Map(model.groupLinks.map(record => [record.id, record.layer]));
  // The sub-tier of a node's row; a node of a group with no tier stands on no row.
  const rowOf = (node: string): number | undefined => model.groups[holder.get(node) ?? '']?.tier;
  // A grid, a bar and a flank are on no row: a clique that holds one of their nodes is declined (`shape`).
  const offRow = (node: string): string | undefined => {
    const id = holder.get(node);
    if (id === undefined) return undefined;
    const shape = groupShape(model, id);
    return model.groups[id]!.flank !== undefined ? 'flank' : shape === 'grid' || shape === 'bar' ? shape : undefined;
  };
  const frameOf = (node: string): string => model.groups[holder.get(node)!]!.frame ?? holder.get(node)!;

  // Candidates: overlay family, no authored route, both ends on one sub-tier. A member of an overlay
  // group-link is a candidate: the bus is the stronger aggregation of the same links.
  const isCandidate = (link: LayoutLink): boolean => link.layer === 'overlay' && link.family === 'overlay'
    && model.document.links[link.sourceIndex]!.route === undefined
    && !(link.groupLink !== undefined && groupLinkLayer.get(link.groupLink) !== 'overlay')
    && link.removed !== true && link.attachments !== undefined;
  const rows = new Map<number, Map<string, Mesh>>();
  // The nodes of each row and class that stand in a clique of three or more: the nodes a bus can hold.
  const busable = new Map<string, Set<number>>();
  const canBeBus = (row: number, klass: string, node: number): boolean => {
    const key = `${row}\0${klass}`;
    if (!busable.has(key)) {
      const mesh = rows.get(row)?.get(klass);
      const cliques = mesh === undefined ? undefined : maximalCliques(mesh.adjacency);
      busable.set(key, new Set((cliques ?? []).filter(clique => clique.length >= 3).flat()));
    }
    return busable.get(key)!.has(node);
  };
  // A link of the mesh's class whose far end can be a node of a bus on another row may be a cross link of a join, which shares the bus port
  // (section 11.3): it is not a foreign link. Any other link on the port is (`shared-port`).
  const mayCross = (link: LayoutLink, klass: string, names: string[]): boolean => {
    if (!isCandidate(link) || (model.document.links[link.sourceIndex]!.class ?? '') !== klass) return false;
    const ends = [link.attachments!.from.node, link.attachments!.to.node];
    const far = ends.find(node => !names.includes(node));
    if (far === undefined || ends.filter(node => names.includes(node)).length !== 1) return false;
    const row = rowOf(far);
    return row !== undefined && row !== rowOf(ends.find(node => names.includes(node))!) && canBeBus(row, klass, order.get(far)!);
  };
  for (const link of model.links) {
    const authored = model.document.links[link.sourceIndex]!;
    if (!isCandidate(link)) continue;
    const from = link.attachments!.from.node, to = link.attachments!.to.node;
    if (from === to) continue;
    const row = rowOf(from);
    if (row === undefined || row !== rowOf(to)) continue;
    const klass = authored.class ?? '';
    const classes = rows.get(row) ?? new Map<string, Mesh>();
    rows.set(row, classes);
    const mesh: Mesh = classes.get(klass) ?? { klass, classIndex: classes.size, nodes: [], adjacency: new Map(), edges: new Map() };
    classes.set(klass, mesh);
    const a = order.get(from)!, b = order.get(to)!;
    for (const [x, y] of [[a, b], [b, a]] as const) {
      if (!mesh.adjacency.has(x)) { mesh.adjacency.set(x, new Set()); mesh.nodes.push(x); }
      mesh.adjacency.get(x)!.add(y);
    }
    const key = edgeKey(a, b);
    const edge = mesh.edges.get(key) ?? { a: Math.min(a, b), b: Math.max(a, b), links: [] };
    edge.links.push(link);
    mesh.edges.set(key, edge);
  }

  const linksAmong = (mesh: Mesh, clique: number[]): LayoutLink[] => {
    const inside = new Set(clique);
    return [...mesh.edges.values()].filter(edge => inside.has(edge.a) && inside.has(edge.b)).flatMap(edge => edge.links)
      .sort((x, y) => linkIndex.get(x)! - linkIndex.get(y)!);
  };
  const label = (mesh: Mesh): string => mesh.klass === '' ? 'unclassed' : mesh.klass;
  const buses: MeshBus[] = [];

  function partial(mesh: Mesh, clique: number[], names: string[], members: LayoutLink[], row: number): void {
    const inside = new Set(clique);
    // A node the bus left out but that joins two or more members is part of the mesh the author drew.
    const left = [...mesh.nodes].sort((x, y) => x - y).filter(node => !inside.has(node)
      && [...mesh.adjacency.get(node)!].filter(other => inside.has(other)).length >= 2);
    if (!left.length) return;
    const considered = [...clique, ...left].sort((x, y) => x - y);
    const missing: string[] = [];
    for (let i = 0; i < considered.length; i++) for (let j = i + 1; j < considered.length; j++) {
      if (!mesh.adjacency.get(considered[i]!)?.has(considered[j]!)) missing.push(`${nodeIds[considered[i]!]}-${nodeIds[considered[j]!]}`);
    }
    const shown = missing.slice(0, MISSING_PAIR_LIMIT).join(', ') + (missing.length > MISSING_PAIR_LIMIT ? `, and ${missing.length - MISSING_PAIR_LIMIT} more` : '');
    const leftNames = left.map(node => nodeIds[node]).join(', ');
    const extra = [...mesh.edges.values()].filter(edge => left.includes(edge.a) || left.includes(edge.b)).flatMap(edge => edge.links);
    report('MESH_BUS_PARTIAL', 'info',
      `The ${label(mesh)} mesh in ${row} is not complete: ${leftNames} stay out of the bus of ${names.length} nodes; missing pairs: ${shown}`,
      [...members, ...extra.filter(link => !members.includes(link))]);
  }

  for (const row of [...rows.keys()].sort((a, b) => a - b)) {
    const classes = rows.get(row)!;
    // Every maximal clique of three or more, per class, of the whole graph: the checks read them all,
    // and only the clique taken as the bus removes edges, so a declined clique hides no other one.
    const found: { mesh: Mesh; clique: number[] }[] = [];
    for (const mesh of classes.values()) {
      const cliques = maximalCliques(mesh.adjacency);
      if (cliques === undefined) {
        const all = [...mesh.edges.values()].flatMap(edge => edge.links);
        report('MESH_BUS_DECLINED', 'warning', `The ${label(mesh)} links in ${row} draw as plain overlay links, too-many-cliques: more than ${CLIQUE_LIMIT} maximal cliques`, all);
        continue;
      }
      for (const clique of cliques) if (clique.length >= 3) found.push({ mesh, clique });
    }
    found.sort((a, b) => b.clique.length - a.clique.length || compareIndices(a.clique, b.clique) || a.mesh.classIndex - b.mesh.classIndex);
    let bus: Set<number> | undefined, busMesh: Mesh | undefined;
    const reported: number[][] = [];
    // Cliques declined for identity: a later clique of the same mesh that shares two or more nodes with one is skipped,
    // so a mesh whose links differ never becomes a smaller bus (mesh-bus.md, section 3, *Identity*).
    const differing: { mesh: Mesh; clique: number[] }[] = [];
    for (const { mesh, clique } of found) {
      if (differing.some(other => other.mesh === mesh && clique.filter(node => other.clique.includes(node)).length >= 2)) continue;
      const names = clique.map(index => nodeIds[index]!);
      if (bus !== undefined) {
        // A clique of the bus's class whose nodes outside the bus each touch two or more bus nodes is a part of the
        // partial mesh (the nodes MESH_BUS_PARTIAL names). Any other clique is a second mesh; one that shares
        // an edge with a mesh already reported is the same mesh.
        const partOfBus = mesh === busMesh && clique.every(node => bus!.has(node)
          || [...mesh.adjacency.get(node)!].filter(other => bus!.has(other)).length >= 2);
        if (partOfBus || reported.some(other => clique.filter(node => other.includes(node)).length >= 2)) continue;
      }
      const members = linksAmong(mesh, clique);
      const decline = (reason: string, detail: string): void => report('MESH_BUS_DECLINED', 'warning',
        `Mesh of ${names.join(', ')} (${label(mesh)}) in ${row} draws as plain overlay links, ${reason}: ${detail}`, members);
      if (bus !== undefined) {
        reported.push(clique);
        decline('second-mesh', 'a row holds one bus in this version');
        continue;
      }
      const off = names.map(name => ({ name, kind: offRow(name) })).find(item => item.kind !== undefined);
      if (off !== undefined) { decline('shape', `${off.name} stands in a ${off.kind}, which is on no row`); continue; }
      const two = namedPorts(names, members);
      if (two !== undefined) { decline('named-ports', two); continue; }
      const different = identityDifference(model, mesh.klass, members);
      if (different !== undefined) { differing.push({ mesh, clique }); decline(different.reason, different.detail); continue; }
      const taken = busPorts(model, names, members, link => mayCross(link, mesh.klass, names));
      if ('reason' in taken) { decline(taken.reason, taken.detail); continue; }
      const chosen = taken.ports;
      bus = new Set(clique);
      busMesh = mesh;
      const id = `mesh-bus-${buses.length + 1}`;
      attach(model, id, chosen, members);
      const frames = [...new Set(names.map(frameOf))];
      const dissolved = dissolve(model, new Set(members.map(link => link.id)));
      buses.push({
        id, owner: { kind: 'mesh-bus', id }, layer: 'overlay', row, nodes: names,
        placement: frames.length === 1 ? 'in-frame' : 'across-frames', frames,
        ports: names.map(name => ({ ...chosen.get(name)! })), members: members.map(link => link.id),
        dissolved: dissolved.map(item => item.id),
        ...(mesh.klass === '' ? {} : { class: mesh.klass }),
      });
      const named = dissolved.length ? `; dissolved ${dissolved.map(item => item.id).join(', ')}` : '';
      report('MESH_BUS', 'info', `Mesh bus ${id}: ${names.length} nodes and ${members.length} ${label(mesh)} links on sub-tier ${row}, ${frames.length === 1 ? 'in' : 'across'} ${frames.join(', ')}${named}`, members);
      for (const item of dissolved) if (item.left.length) {
        report('MESH_BUS_PARTIAL', 'info', `${item.id} lost ${item.taken} of its ${item.taken + item.left.length} members to ${id}; ${item.left.length} stay plain overlay links`, item.left);
      }
      partial(mesh, clique, names, members, row);
    }
  }
  joinBuses(model, buses, model.links.filter(isCandidate), report, rowOf, linkIndex, nodeIds);
  if (buses.length) model.meshBuses = buses;
  dropBusSharedPortWarnings(model);
}

/**
 * The bus port of each member node, or the reason the mesh cannot take one (mesh-bus.md, section 3), read after
 * `namedPorts` and `identityDifference` (so a node has anonymous ends only, or one named port only):
 * `shared-port` (the named port a member would use also carries a link that is not
 * a member: the bus port stands on the bus edge, and that link would be cut off from its own side) and `side` (an authored `left` or
 * `right` on a bus port, or authored `top` and `bottom` on two of them: a bus stands on a horizontal edge, and an authored `top` or
 * `bottom` fixes it).
 */
function busPorts(model: LayoutModel, names: string[], members: LayoutLink[], mayCross: (link: LayoutLink) => boolean): { ports: Map<string, PortRef> } | { reason: 'shared-port' | 'side'; detail: string } {
  const ports = new Map<string, PortRef>();
  const ends = members.flatMap(link => [link.attachments!.from, link.attachments!.to]);
  const authored = new Set<string>();
  for (const name of names) {
    const mine = ends.filter(ref => ref.node === name);
    const named = new Map<string, PortRef>();
    for (const ref of mine) if (ref.anonymous !== true) named.set(ref.name!, ref);
    const anonymous = mine.filter(ref => ref.anonymous === true).sort((a, b) => a.ordinal - b.ordinal)[0];
    const chosen = named.size ? [...named.values()][0]! : anonymous!;
    if (named.size) {
      const other = model.links.find(link => !members.includes(link) && !mayCross(link) && link.attachments !== undefined
        && [link.attachments.from, link.attachments.to].some(ref => sameRef(ref, chosen)));
      if (other !== undefined) return { reason: 'shared-port', detail: `${name}.${chosen.name} also carries ${other.id}, which is not a member` };
      const side = model.document.nodes[name]?.ports.find(port => port.name === chosen.name && port.ordinal === chosen.ordinal)?.side;
      if (side === 'left' || side === 'right') return { reason: 'side', detail: `${name}.${chosen.name} states side ${side}, and a bus stands on a horizontal edge` };
      if (side !== undefined) authored.add(side);
    }
    ports.set(name, chosen);
  }
  if (authored.size > 1) return { reason: 'side', detail: 'the bus ports state both top and bottom' };
  return { ports };
}

/** The first member node whose links name two or more different authored ports (`named-ports`), as a detail. */
function namedPorts(names: string[], members: LayoutLink[]): string | undefined {
  const ends = members.flatMap(link => [link.attachments!.from, link.attachments!.to]);
  for (const name of names) {
    const named = new Set(ends.filter(ref => ref.node === name && ref.anonymous !== true).map(ref => ref.name));
    if (named.size > 1) return `${name} has two or more authored ports on the member links`;
  }
  return undefined;
}

/** The attributes of a link that its drawing shows and a bus would hide (mesh-bus.md, section 11.3, check 2). */
export function drawnSignature(model: LayoutModel, link: LayoutLink): { label: string | undefined; weight: number } {
  return { label: model.document.links[link.sourceIndex]!.label, weight: link.strokeWidth ?? DEFAULT_STROKE_WIDTHS.path };
}

export interface IdentityDifference { reason: 'label' | 'weight' | 'port' | 'arrow'; detail: string }

/** The first item whose key is not the most common key (a tie goes to the first item's key), or `undefined` when all agree. */
function firstOdd<T extends { key: string }>(items: T[]): { item: T; usual: T } | undefined {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.key, (counts.get(item.key) ?? 0) + 1);
  if (counts.size < 2) return undefined;
  let best = items[0]!.key;
  for (const item of items) if (counts.get(item.key)! > counts.get(best)!) best = item.key;
  const item = items.find(other => other.key !== best)!;
  return { item, usual: items.find(other => other.key === best)! };
}

/**
 * Whether the links of one mesh draw alike: the reason of the first difference, in the order `label`, `weight`,
 * `port`, `arrow`, naming the first link that differs and the value (mesh-bus.md, section 3, *Identity*, and section 11.3).
 * `links` are in declaration order. The port check reads the ends as they stand: an anonymous end, or the named port.
 */
export function identityDifference(model: LayoutModel, klass: string, links: LayoutLink[]): IdentityDifference | undefined {
  const signatures = links.map(link => ({ link, ...drawnSignature(model, link) }));
  const shown = (label: string | undefined): string => label === undefined ? 'no label' : `label "${label}"`;
  const label = firstOdd(signatures.map(item => ({ ...item, key: item.label === undefined ? '-' : `+${item.label}` })));
  if (label) return { reason: 'label', detail: `${label.item.link.id} has ${shown(label.item.label)} where ${label.usual.link.id} has ${shown(label.usual.label)}` };
  const weight = firstOdd(signatures.map(item => ({ ...item, key: String(item.weight) })));
  if (weight) return { reason: 'weight', detail: `${weight.item.link.id} draws ${weight.item.weight} px where ${weight.usual.link.id} draws ${weight.usual.weight} px` };
  const nodes: string[] = [];
  for (const link of links) for (const ref of [link.attachments!.from, link.attachments!.to]) if (!nodes.includes(ref.node)) nodes.push(ref.node);
  for (const node of nodes) {
    const ends = links.flatMap(link => [link.attachments!.from, link.attachments!.to].filter(ref => ref.node === node)
      .map(ref => ({ link, ref, key: ref.anonymous === true ? '' : `:${ref.name}` })));
    const port = firstOdd(ends);
    const text = (ref: PortRef): string => ref.anonymous === true ? 'no port' : `port ${ref.name}`;
    if (port) return { reason: 'port', detail: `${port.item.link.id} has ${text(port.item.ref)} at ${node} where ${port.usual.link.id} has ${text(port.usual.ref)}` };
  }
  if (classDrawsArrowhead(klass)) return { reason: 'arrow', detail: `the ${klass === '' ? 'unclassed' : klass} class draws an arrowhead on ${links[0]!.id}, and a bus cannot show which way a link points` };
  return undefined;
}

/** The side an author stated on a named bus port, or `undefined`. */
function statedSide(model: LayoutModel, ref: PortRef): string | undefined {
  if (ref.anonymous === true) return undefined;
  return model.document.nodes[ref.node]?.ports.find(port => port.name === ref.name && port.ordinal === ref.ordinal)?.side;
}

/**
 * Join the buses of one class on two rows that a complete set of cross links makes one mesh (mesh-bus.md, section 11.3):
 * checks `incomplete`, identity, `side`, then `three-rows`; `small-row` for a row of one or two nodes.
 */
function joinBuses(model: LayoutModel, buses: MeshBus[], candidates: LayoutLink[], report: (code: string, severity: Diagnostic['severity'], message: string, links: LayoutLink[]) => void,
  rowOf: (node: string) => number | undefined, linkIndex: Map<LayoutLink, number>, nodeIds: string[]): void {
  if (!buses.length) return;
  const klassOf = (link: LayoutLink): string => model.document.links[link.sourceIndex]!.class ?? '';
  const nameOf = (bus: MeshBus): string => bus.class === undefined ? 'unclassed' : bus.class;
  const busOfNode = new Map<string, MeshBus>();
  for (const bus of buses) for (const node of bus.nodes) busOfNode.set(node, bus);
  const ends = (link: LayoutLink): [string, string] => [link.attachments!.from.node, link.attachments!.to.node];
  const byIndex = (a: LayoutLink, b: LayoutLink): number => linkIndex.get(a)! - linkIndex.get(b)!;
  const linkedAmong = (a: string, b: string, klass: string): boolean => candidates.some(link => klassOf(link) === klass && ends(link).includes(a) && ends(link).includes(b));

  // The cross candidates of each pair of buses of one class, keyed `upper|lower`.
  const pairs = new Map<string, { upper: MeshBus; lower: MeshBus; cross: LayoutLink[] }>();
  for (const link of candidates) {
    const [x, y] = ends(link).map(node => busOfNode.get(node));
    if (x === undefined || y === undefined || x === y || x.row === y.row) continue;
    const klass = klassOf(link);
    if ((x.class ?? '') !== klass || (y.class ?? '') !== klass) continue;
    const [upper, lower] = x.row < y.row ? [x, y] : [y, x];
    const key = `${upper.id}|${lower.id}`;
    const pair = pairs.get(key) ?? { upper, lower, cross: [] };
    pairs.set(key, pair);
    pair.cross.push(link);
  }
  const order = [...pairs.values()].sort((a, b) => buses.indexOf(a.upper) - buses.indexOf(b.upper) || buses.indexOf(a.lower) - buses.indexOf(b.lower));
  const passed: typeof order = [];
  for (const pair of order) {
    const { upper, lower } = pair;
    pair.cross.sort(byIndex);
    const klass = upper.class ?? '';
    const named = `${upper.id} (row ${upper.row}) and ${lower.id} (row ${lower.row}), class ${nameOf(upper)}`;
    // Reported only where each node of both buses has a cross link of the class to the other bus.
    const reported = [...upper.nodes, ...lower.nodes].every(node => pair.cross.some(link => ends(link).includes(node)));
    const decline = (reason: string, detail: string): void => {
      if (reported) report('MESH_BUS_JOIN_DECLINED', 'info', `${named} stay two buses, ${reason}: ${detail}`, pair.cross);
    };
    const missing: string[] = [];
    for (const a of upper.nodes) for (const b of lower.nodes) {
      if (pair.cross.some(link => ends(link).includes(a) && ends(link).includes(b))) continue;
      const other = model.links.find(link => link.removed !== true && link.attachments !== undefined && klassOf(link) !== klass
        && [link.from.node, link.to.node].includes(a) && [link.from.node, link.to.node].includes(b));
      missing.push(`${a}-${b}${other ? ` (a ${klassOf(other) === '' ? 'unclassed' : klassOf(other)} link joins it)` : ''}`);
    }
    if (missing.length) {
      decline('incomplete', `missing pairs: ${missing.slice(0, MISSING_PAIR_LIMIT).join(', ')}${missing.length > MISSING_PAIR_LIMIT ? `, and ${missing.length - MISSING_PAIR_LIMIT} more` : ''}`);
      continue;
    }
    const inside = new Set([...upper.members, ...lower.members]);
    const links = [...model.links.filter(link => inside.has(link.id)), ...pair.cross].sort(byIndex);
    const different = identityDifference(model, klass, links);
    if (different !== undefined) { decline(different.reason, different.detail); continue; }
    const top = upper.ports.find(ref => statedSide(model, ref) === 'top');
    const bottom = lower.ports.find(ref => statedSide(model, ref) === 'bottom');
    if (top !== undefined || bottom !== undefined) {
      const ref = (top ?? bottom)!;
      decline('side', `${ref.node}.${ref.name} states side ${top !== undefined ? 'top' : 'bottom'}, and a joined bar stands on the edge that faces the other row`);
      continue;
    }
    passed.push(pair);
  }

  // The graph of the pairs that pass: two buses are joined; three or more (a complete graph over three rows) are refused.
  const part = new Map<MeshBus, Set<MeshBus>>();
  for (const { upper, lower } of passed) {
    const merged = new Set([...(part.get(upper) ?? [upper]), ...(part.get(lower) ?? [lower])]);
    for (const bus of merged) part.set(bus, merged);
  }
  for (const pair of passed) {
    const { upper, lower } = pair;
    if (part.get(upper)!.size > 2) {
      report('MESH_BUS_JOIN_DECLINED', 'info', `${upper.id} (row ${upper.row}) and ${lower.id} (row ${lower.row}), class ${nameOf(upper)} stay two buses, three-rows: `
        + `${[...part.get(upper)!].map(bus => bus.id).join(', ')} join three rows or more, and a riser joins two rows only`, pair.cross);
      continue;
    }
    const ports = new Map<string, PortRef>();
    for (const bus of [upper, lower]) bus.nodes.forEach((node, index) => ports.set(node, bus.ports[index]!));
    attach(model, upper.id, ports, pair.cross);
    const dissolved = dissolve(model, new Set(pair.cross.map(link => link.id)));
    upper.joined = lower.id;
    lower.joined = upper.id;
    upper.cross = pair.cross.map(link => link.id);
    upper.dissolved.push(...dissolved.map(item => item.id));
    const named = dissolved.length ? `; dissolved ${dissolved.map(item => item.id).join(', ')}` : '';
    for (const item of dissolved) if (item.left.length) {
      report('MESH_BUS_PARTIAL', 'info', `${item.id} lost ${item.taken} of its ${item.taken + item.left.length} members to the join of ${upper.id} and ${lower.id}; ${item.left.length} stay plain overlay links`, item.left);
    }
    report('MESH_BUS_JOIN', 'info', `Mesh buses ${upper.id} (row ${upper.row}) and ${lower.id} (row ${lower.row}) joined: ${nameOf(upper)} mesh of ${upper.nodes.length + lower.nodes.length} nodes and ${pair.cross.length} cross links${named}`, pair.cross);
  }

  // A row of one or two nodes has no bus to join: report it where it links a bus completely.
  for (const bus of buses) {
    const klass = bus.class ?? '';
    const outside = new Map<number, Set<string>>();
    for (const link of candidates) {
      if (klassOf(link) !== klass) continue;
      const [x, y] = ends(link);
      const [inBus, other] = bus.nodes.includes(x) ? [x, y] : bus.nodes.includes(y) ? [y, x] : [undefined, undefined];
      const row = other === undefined ? undefined : rowOf(other);
      if (inBus === undefined || other === undefined || row === undefined || row === bus.row || busOfNode.has(other)
        || buses.some(item => item.row === row && (item.class ?? '') === klass)) continue;
      outside.set(row, (outside.get(row) ?? new Set()).add(other));
    }
    for (const [row, set] of [...outside].sort((a, b) => a[0] - b[0])) {
      const small = [...set].sort((a, b) => nodeIds.indexOf(a) - nodeIds.indexOf(b));
      if (small.length > 2 || !small.every((a, i) => small.slice(i + 1).every(b => linkedAmong(a, b, klass)))) continue;
      if (!small.every(a => bus.nodes.every(b => linkedAmong(a, b, klass)))) continue;
      const cross = candidates.filter(link => klassOf(link) === klass && ends(link).some(node => small.includes(node)) && ends(link).some(node => bus.nodes.includes(node)));
      report('MESH_BUS_JOIN_DECLINED', 'info', `${bus.id} (row ${bus.row}) and the ${small.length} nodes ${small.join(', ')} of row ${row}, class ${nameOf(bus)}, stay apart, small-row: `
        + 'a row part of one or two nodes has no bus to join in this version', cross);
    }
  }
}

/** Re-attach every member end to its bus port, then remove the anonymous ports nothing else uses. */
function attach(model: LayoutModel, id: string, ports: Map<string, PortRef>, members: LayoutLink[]): void {
  const former: PortRef[] = [];
  for (const link of members) {
    link.meshBus = id;
    link.technique = 'mesh-bus';
    const ends = link.attachments!;
    for (const key of ['from', 'to'] as const) {
      const bus = ports.get(ends[key].node)!;
      if (!sameRef(ends[key], bus)) former.push(ends[key]);
      ends[key] = { ...bus };
    }
  }
  const used = model.links.flatMap(link => link.attachments ? [link.attachments.from, link.attachments.to] : []);
  for (const ref of former) {
    if (ref.anonymous !== true || used.some(other => sameRef(other, ref))) continue;
    const node = model.nodes[ref.node]!;
    const index = node.ports.findIndex(port => sameRef(port.ref, ref));
    if (index >= 0) node.ports.splice(index, 1);
  }
}

/** `SHARED_PORT` does not warn on a bus port: sharing it is what a bus is. */
function dropBusSharedPortWarnings(model: LayoutModel): void {
  if (!model.meshBuses?.length) return;
  const members = new Set(model.links.filter(link => link.meshBus !== undefined).map(link => link.id));
  model.diagnostics = model.diagnostics.filter(diagnostic => {
    if (diagnostic.code !== 'SHARED_PORT') return true;
    if ('path' in diagnostic && typeof diagnostic.path === 'string') {
      const match = /^\$\.links\[(\d+)\]\.(from|to)$/.exec(diagnostic.path);
      const end = match ? model.document.links[Number(match[1])]?.[match[2] as 'from' | 'to'] : undefined;
      if (end?.node === undefined) return true;
      // Keep the warning when any link that is not a member uses the port.
      const users = model.links.filter(link => [link.attachments!.from, link.attachments!.to].some(ref => sameRef(ref, end as PortRef)));
      return !(users.length && users.every(link => link.meshBus !== undefined));
    }
    const owners = diagnostic.owners ?? [];
    return !(owners.length && owners.every(owner => owner.kind === 'link' && members.has(owner.id)));
  });
}

/**
 * A group-link the bus takes members from is dissolved, whole or in part: a near-complete set is
 * drawn as its members, and the bus is the stronger aggregation of the same links. The record
 * leaves `groupLinks`, its members lose `groupLink`, and the `ROUTE_UNSUPPORTED` warning that
 * `recordAggregations` gave an inferred group-link goes with it.
 */
function dissolve(model: LayoutModel, taken: Set<string>): { id: string; taken: number; left: LayoutLink[] }[] {
  const result: { id: string; taken: number; left: LayoutLink[] }[] = [];
  for (const record of model.groupLinks.filter(item => item.members.some(id => taken.has(id)))) {
    const links = model.links.filter(link => record.members.includes(link.id));
    result.push({ id: record.id, taken: links.filter(link => taken.has(link.id)).length, left: links.filter(link => !taken.has(link.id)) });
    for (const link of links) delete link.groupLink;
    const ids = new Set(record.members);
    model.diagnostics = model.diagnostics.filter(diagnostic => !(diagnostic.code === 'ROUTE_UNSUPPORTED'
      && diagnostic.owners?.length === ids.size && diagnostic.owners.every(owner => owner.kind === 'link' && ids.has(owner.id))));
  }
  model.groupLinks = model.groupLinks.filter(item => !result.some(done => done.id === item.id));
  return result;
}

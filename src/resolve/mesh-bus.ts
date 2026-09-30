import { orderedNodeIds, type Diagnostic, type LayoutLink, type LayoutModel, type MeshBus, type Owner, type PortRef } from '../model/index.js';
import { groupShape } from '../layout/grid.js';

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
  const rows = new Map<number, Map<string, Mesh>>();
  for (const link of model.links) {
    const authored = model.document.links[link.sourceIndex]!;
    if (link.layer !== 'overlay' || link.family !== 'overlay' || authored.route !== undefined
      || (link.groupLink !== undefined && groupLinkLayer.get(link.groupLink) !== 'overlay')
      || link.removed === true || !link.attachments) continue;
    const from = link.attachments.from.node, to = link.attachments.to.node;
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
    for (const { mesh, clique } of found) {
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
      const found = busPorts(model, names, members);
      if ('reason' in found) { decline(found.reason, found.detail); continue; }
      const chosen = found.ports;
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
  if (buses.length) model.meshBuses = buses;
  dropBusSharedPortWarnings(model);
}

/**
 * The bus port of each member node, or the reason the mesh cannot take one (mesh-bus.md, section 3):
 * `named-ports` (two or more authored ports at a member), `shared-port` (the named port a member would use also carries a link that is not
 * a member: the bus port stands on the bus edge, and that link would be cut off from its own side) and `side` (an authored `left` or
 * `right` on a bus port, or authored `top` and `bottom` on two of them: a bus stands on a horizontal edge, and an authored `top` or
 * `bottom` fixes it).
 */
function busPorts(model: LayoutModel, names: string[], members: LayoutLink[]): { ports: Map<string, PortRef> } | { reason: 'named-ports' | 'shared-port' | 'side'; detail: string } {
  const ports = new Map<string, PortRef>();
  const ends = members.flatMap(link => [link.attachments!.from, link.attachments!.to]);
  const authored = new Set<string>();
  for (const name of names) {
    const mine = ends.filter(ref => ref.node === name);
    const named = new Map<string, PortRef>();
    for (const ref of mine) if (ref.anonymous !== true) named.set(ref.name!, ref);
    if (named.size > 1) return { reason: 'named-ports', detail: `${name} has two or more authored ports on the member links` };
    const anonymous = mine.filter(ref => ref.anonymous === true).sort((a, b) => a.ordinal - b.ordinal)[0];
    const chosen = named.size ? [...named.values()][0]! : anonymous!;
    if (named.size) {
      const other = model.links.find(link => !members.includes(link) && link.attachments !== undefined
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

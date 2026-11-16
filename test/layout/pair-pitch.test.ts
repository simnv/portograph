import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, LayoutNode, LayoutPort } from '../../src/index.js';
import type { PairPitch } from '../../src/model/layout.js';
import { layout, parse, score } from '../../src/index.js';
import { blockReservationsFault } from '../../src/layout/block-checks.js';
import { endPitch, faceExcess, faceOffsets, neighbourPitch, pairExcess, pairPitchFault } from '../../src/layout/pair-pitch.js';
import { portSideCapacity } from '../../src/layout/port-insets.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { readDraft } from '../../src/layout/overlay-order.js';
import { prepareBundleGeometry } from '../../src/layout/bundle-geometry.js';
import { addPairPitch, addPairPitches } from '../../src/layout/pair-pitch.js';
import { sizeNodes } from '../../src/layout/size.js';
import { skeleton } from '../../src/layout/skeleton.js';
import { sidesTwo } from '../../src/layout/sides-two.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { resolve } from '../../src/resolve/index.js';
import { floorFailure, pairFloorsOf, pairGrowth, reservation, validateReservations } from '../../src/layout/reservations.js';
import { portId } from '../../src/layout/skeleton-graph.js';
import { NODE_CONTENT_GEOMETRY } from '../../src/theme/content.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { reversed } from '../../scripts/r3-lib.mjs';

/**
 * Dense-16x9 ticket 04, slice 1: the pitch of a face is set per neighbour pair of ports, and the capacity of the face is the sum of its pair
 * pitches, never the largest one times the gaps. The fixture puts two members of a complete solid block and four plain uplinks on one face.
 */
const FIXTURE = 'a-block-face-sums-its-neighbour-pair-pitches';
const text = readFileSync(new URL(`../../goldens/synthetic/${FIXTURE}.yaml`, import.meta.url), 'utf8');
const lay = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const withSeats = text.replace('layout: { autoArrange: false }', 'layout: { autoArrange: false, moveBeforeGrow: true }');
const bottom = (node: LayoutNode): LayoutPort[] => node.ports.filter(port => port.side === 'bottom').sort((a, b) => a.anchor!.x - b.anchor!.x);

/** A node of `count` anonymous bottom ports at a 12 px face pitch, with the given pair pitches. */
function face(count: number, entries: LayoutNode['pairPitch']): LayoutNode {
  const ports = Array.from({ length: count }, (_, ordinal) => ({ ref: { node: 'n', anonymous: true, ordinal } as LayoutPort['ref'], side: 'bottom' as const, engineOrder: ordinal }));
  return { id: 'n', owner: { kind: 'node', id: 'n' }, layer: 'routed', ports, sidePitch: { bottom: 12, top: 12, left: 12, right: 12 }, ...(entries ? { pairPitch: entries } : {}) } as unknown as LayoutNode;
}
const key = (ordinal: number): string => portId({ node: 'n', anonymous: true, ordinal } as LayoutPort['ref']);
const permutations = <T>(items: readonly T[]): T[][] => items.length <= 1 ? [[...items]]
  : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest]));

describe('the neighbour-pair pitch of a face', () => {
  it('keeps the face pitch where no entry binds a pair, with the exact offsets of the scalar pitch', () => {
    const node = face(4, undefined);
    expect(faceOffsets(node, 'bottom', node.ports)).toEqual([0, 12, 24, 36]);
    expect(faceExcess(node, 'bottom', node.ports)).toEqual([0, 0, 0, 0]);
    expect(pairExcess(node, 'bottom', 4)).toBe(0);
    expect(endPitch(node, 'bottom')).toBe(12);
  });

  it('binds a block port to both neighbours and a fan pair to its own two ports only', () => {
    const node = face(4, { bottom: [{ rule: 'block', ports: [key(1)], min: 21 }, { rule: 'fan', ports: [key(2), key(3)].sort(), min: 30 }] });
    const [a, b, c, d] = node.ports;
    expect(neighbourPitch(node, 'bottom', a!.ref, b!.ref)).toBe(21);
    expect(neighbourPitch(node, 'bottom', b!.ref, c!.ref)).toBe(21);
    expect(neighbourPitch(node, 'bottom', c!.ref, d!.ref)).toBe(30);
    expect(neighbourPitch(node, 'bottom', a!.ref, d!.ref)).toBe(12);
    // The capacity is the sum of the pairs, not the largest pair times the gaps.
    expect(faceOffsets(node, 'bottom', node.ports)).toEqual([0, 21, 42, 72]);
    // A lateral face carries no pair pitch.
    expect(neighbourPitch(node, 'left', a!.ref, b!.ref)).toBe(12);
  });

  it('bounds the sum of every order of the face, and is exact where one order holds the most', () => {
    const cases: LayoutNode['pairPitch'][] = [
      { bottom: [{ rule: 'block', ports: [key(0)], min: 21 }, { rule: 'block', ports: [key(1)], min: 21 }] },
      { bottom: [{ rule: 'block', ports: [key(0)], min: 21 }] },
      { bottom: [{ rule: 'fan', ports: [key(0), key(1)].sort(), min: 40 }, { rule: 'fan', ports: [key(1), key(2)].sort(), min: 20 }] },
      { bottom: [{ rule: 'fan', ports: [key(0), key(1)].sort(), min: 40 }, { rule: 'block', ports: [key(4)], min: 21 }, { rule: 'block', ports: [key(3)], min: 30 }] },
    ];
    for (const entries of cases) {
      const node = face(6, entries);
      const most = Math.max(...permutations(node.ports).map(order => faceOffsets(node, 'bottom', order).at(-1)! - 5 * 12));
      expect(pairExcess(node, 'bottom', 6)).toBeGreaterThanOrEqual(most - 1e-9);
    }
    // Two block ports of six: four block gaps at most, one gap at the face pitch.
    expect(pairExcess(face(6, cases[0]), 'bottom', 6)).toBe(4 * 9);
    expect(pairExcess(face(6, cases[1]), 'bottom', 6)).toBe(2 * 9);
  });

  it('refuses a pair pitch it cannot read (R6)', () => {
    expect(pairPitchFault(face(2, { bottom: [{ rule: 'fan', ports: [key(0)], min: 20 }] }))).toContain('unreadable');
    expect(pairPitchFault(face(2, { bottom: [{ rule: 'block', ports: [key(7)], min: 20 }] }))).toContain('unreadable');
    expect(pairPitchFault(face(2, { bottom: [{ rule: 'block', ports: [key(0)], min: Number.NaN }] }))).toContain('unreadable');
    expect(pairPitchFault(face(2, { left: [{ rule: 'block', ports: [key(0)], min: 20 }] } as unknown as LayoutNode['pairPitch']))).toContain('pair pitches on left');
    expect(pairPitchFault(face(2, { bottom: [{ rule: 'block', ports: [key(0)], min: 20 }] }))).toBeUndefined();
  });
});

describe('a block face sums its neighbour-pair pitches', () => {
  for (const [mode, yaml] of [['default', text], ['moveBeforeGrow', withSeats]] as const) {
    it(`stores the block pitch per member port and holds the face as the sum (${mode})`, async () => {
      const model = await lay(yaml);
      const record = model.blockReservations?.[0];
      expect(model.fanFamilies?.filter(family => family.kind === 'solid')).toHaveLength(1);
      expect(record?.pitch).toBe(21);
      const core = model.nodes['core-1']!;
      // The face pitch stays the base pitch; each member port of the block keeps the block pitch.
      expect(core.sidePitch!.bottom).toBe(12);
      const members = model.links.filter(link => link.solidBlock && link.attachments!.from.node === 'core-1').map(link => portId(link.attachments!.from)).sort();
      expect(core.pairPitch?.bottom?.map(entry => [entry.rule, entry.ports, entry.min])).toEqual(members.map(port => ['block', [port], 21]));
      // Every two neighbours keep their pair pitch.
      const ports = bottom(core);
      for (let i = 1; i < ports.length; i++) {
        expect(ports[i]!.anchor!.x - ports[i - 1]!.anchor!.x).toBeGreaterThanOrEqual(neighbourPitch(core, 'bottom', ports[i - 1]!.ref, ports[i]!.ref) - 1e-6);
      }
      // Six ports at 12 px, four block gaps at most (9 px more each), and the ends at half the block pitch: 9 px less than 21 px on every gap.
      const capacity = portSideCapacity(core, 'bottom', 6);
      expect(capacity).toBe(2 * NODE_CONTENT_GEOMETRY.padding + 6 * 12 + 4 * 9 + 9);
      expect(capacity).toBe(2 * NODE_CONTENT_GEOMETRY.padding + 6 * 21 - 9);
      expect(core.bounds!.width).toBeGreaterThanOrEqual(capacity - 1e-6);
      for (const link of model.links.filter(item => item.solidBlock)) expect(link.path!.segments, link.id).toHaveLength(1);
      expect(model.removedLinks ?? []).toEqual([]);
      for (const [id, gate] of Object.entries(score(model).snapshot.gates)) expect([id, gate.violations]).toEqual([id, []]);
      expect(blockReservationsFault(model)).toBeUndefined();
      expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
    });
  }

  it('lays out the same with links or nodes reversed (R3)', async () => {
    const one = await lay(text);
    for (const order of ['links', 'nodes'] as const) {
      const two = await lay(reversed(text, order));
      expect(two.nodes['core-1']!.pairPitch).toEqual(one.nodes['core-1']!.pairPitch);
      // Node order is document order (the row order), so only reversed links keep the same box.
      if (order === 'links') expect(two.nodes['core-1']!.bounds).toEqual(one.nodes['core-1']!.bounds);
    }
  });

  it('refuses a model whose member port lost its block pitch, or whose neighbours stand closer than their pair pitch (R5)', async () => {
    const model = await lay(text);
    const lost = structuredClone(model);
    lost.nodes['core-1']!.pairPitch!.bottom!.pop();
    expect(blockReservationsFault(lost)).toContain('lost its block pitch');
    expect(() => restoreLayoutModel(JSON.stringify(lost))).toThrow();
    const close = structuredClone(model);
    const core = close.nodes['core-1']!;
    const members = new Set(core.pairPitch!.bottom!.map(entry => entry.ports[0]));
    const ports = bottom(core), at = ports.findIndex((port, i) => i > 0 && members.has(portId(port.ref)));
    // Stand the member port one face pitch from its left neighbour: the face pitch holds, the pair pitch does not.
    ports[at]!.anchor = { ...ports[at]!.anchor!, x: ports[at - 1]!.anchor!.x + 12 };
    expect(() => restoreLayoutModel(JSON.stringify(close))).toThrow(/violates pitch/);
  });
});

describe('the pair floor of the fan round', () => {
  const ports = [key(0), key(1)].sort() as [string, string];
  it('raises a held floor only, and is read back as the node stores it', () => {
    const one = pairGrowth([], [{ node: 'n', side: 'bottom', ports, min: 20 }], 'fan', 1);
    expect(one).toHaveLength(1);
    expect(pairGrowth(one, [{ node: 'n', side: 'bottom', ports, min: 20 }], 'fan', 2)).toEqual([]);
    expect(pairGrowth(one, [{ node: 'n', side: 'bottom', ports, min: 24 }], 'fan', 2)).toHaveLength(1);
    expect([...pairFloorsOf(one)]).toEqual([['n', { bottom: [{ rule: 'fan', ports, min: 20 }] }]]);
  });

  it('holds only while the node stores the pair at its floor', () => {
    const [entry] = pairGrowth([], [{ node: 'n', side: 'bottom', ports, min: 20 }], 'fan', 1);
    const model = { nodes: { n: face(2, { bottom: [{ rule: 'fan', ports, min: 20 }] }) } } as unknown as LayoutModel;
    expect(floorFailure(entry!, model)).toBeUndefined();
    model.nodes['n']!.pairPitch!.bottom![0]!.min = 16;
    expect(floorFailure(entry!, model)).toContain('is under 20');
  });

  it('refuses a stored pair floor of the wrong shape', () => {
    const bad = reservation('pairFloor', { kind: 'node', id: 'n' }, 'bottom:x', 'fan', 0, { node: 'n', side: 'bottom', ports: [ports[1], ports[0]], min: 20 });
    const model = { reservations: [bad], nodes: {}, links: [] } as unknown as LayoutModel;
    expect(() => validateReservations(model)).toThrow(/wrong shape/);
  });
});

/**
 * Review 1 of slice 1: every reader of a face pitch reads the pitch of each pair (the draft of the overlay order, the bundle planners), and a
 * model restored before stage 5 keeps its pair pitches readable, its floors held and its faces within capacity.
 */
describe('the readers of slice 1 read the pair pitch (review 1)', () => {
  const fan = readFileSync(new URL('../../goldens/synthetic/a-fan-spreads-its-ports-so-its-chords-hold-clearance.yaml', import.meta.url), 'utf8');

  it('stands the ports of the overlay draft at their pair pitches', async () => {
    const model = await lay(text), node = model.nodes['core-1']!;
    const draft = (at: LayoutModel): ((port: LayoutPort) => number) => { const read = readDraft(at)!; return port => read.portX(port.ref); };
    const order = node.ports.filter(port => port.side === 'bottom').sort((a, b) => draft(model)(a) - draft(model)(b));
    const forged = structuredClone(model), held = forged.nodes['core-1']!;
    held.pairPitch = { bottom: [{ rule: 'fan', ports: [portId(order[1]!.ref), portId(order[2]!.ref)].sort(), min: 60 }] };
    const x = order.map(draft(forged));
    const gaps = x.slice(1).map((at, index) => at - x[index]!);
    expect(gaps[1]).toBeCloseTo(60, 6);
    order.slice(1).forEach((port, index) => expect(gaps[index]).toBeGreaterThanOrEqual(neighbourPitch(held, 'bottom', order[index]!.ref, port.ref) - 1e-6));
  });

  it('keeps the crossings of a face that holds a fan and a bundle, as the scalar pitch did', async () => {
    const model = await lay(`${fan}\n  - [core-1, edge-1]\n  - [core-1, edge-1]\n`);
    expect(model.bundles.length).toBeGreaterThan(0);
    // 6 since slice 2 added the spare core-rank node to the fan fixture (5 before); main draws the new input with 6 too.
    expect(score(model).snapshot.counts.routed.crossings).toBe(6);
  }, 180_000);

  it('refuses a stage-3 model whose pair pitch is unreadable, over capacity or under its floor (R5, R6)', () => {
    const base = sizeNodes(sidesOne(resolve(parse(fan))));
    expect(base.stage).toBe('size');
    expect(() => restoreLayoutModel(JSON.stringify(base))).not.toThrow();
    const node = Object.values(base.nodes).find(item => item.ports.filter(port => (port.side ?? port.sizingSide) === 'bottom').length >= 2)!;
    const keys = node.ports.filter(port => (port.side ?? port.sizingSide) === 'bottom').slice(0, 2).map(port => portId(port.ref)).sort() as [string, string];
    const forge = (ports: string[], min: number, floor: number): string => {
      const model = structuredClone(base);
      model.nodes[node.id]!.pairPitch = { bottom: [{ rule: 'fan', ports, min }] };
      model.reservations = pairGrowth([], [{ node: node.id, side: 'bottom', ports: keys, min: floor }], 'fan', 1);
      return JSON.stringify(model);
    };
    expect(() => restoreLayoutModel(forge(keys, 12, 12))).not.toThrow();
    expect(() => restoreLayoutModel(forge([keys[0], 'missing'], 12, 12))).toThrow(/unreadable pair pitch/);
    expect(() => restoreLayoutModel(forge(keys, 100_000, 12))).toThrow(/Port capacity exceeds/);
    expect(() => restoreLayoutModel(forge(keys, 12, 60))).toThrow(/does not hold/);
  });
});

/**
 * Review 2 of slice 1: bundle planning reads the pairs of the bundle that stand side by side on the face as it stands now. A pair pitch of a
 * member with a port outside the bundle, or with a port that has left the face, does not widen the bundle or raise the face pitch.
 */
describe('a bundle reads only its own neighbour pairs (review 2)', () => {
  const bundleText = readFileSync(new URL('../../goldens/synthetic/a-bundle-of-three-ports-agrees-at-both-ends.yaml', import.meta.url), 'utf8');
  const gaps = (ports: LayoutPort[]): number[] => ports.slice(1).map((port, index) => port.anchor!.x - ports[index]!.anchor!.x);
  /** The bundle model with the three bottom ports of `edge`, and a fourth port of `edge` on `extra` when it is given. */
  async function planned(entries: (node: LayoutNode, members: LayoutPort[], fourth?: LayoutPort) => void, extra?: 'top' | 'bottom') {
    const model = structuredClone(await lay(bundleText)), node = model.nodes['edge']!;
    const members = bottom(node), base = node.sidePitch!.bottom!;
    let fourth: LayoutPort | undefined;
    if (extra) {
      fourth = { ...structuredClone(members[0]!), ref: { node: 'edge', anonymous: true, ordinal: 999 } as LayoutPort['ref'], side: extra, engineOrder: 3 };
      node.ports.push(fourth);
    }
    entries(node, members, fourth);
    prepareBundleGeometry(model);
    return { node, base, members: bottom(node) };
  }
  const fan = (a: LayoutPort, b: LayoutPort, min: number) => ({ rule: 'fan' as const, ports: [portId(a.ref), portId(b.ref)].sort(), min });

  it('keeps a wide pair and a narrow pair of its members apart, without raising the face pitch', async () => {
    // A 60 px round over two members, then a 30 px round over all three: the ledger keeps the one pair at 60 and the others at 30.
    const { node, base, members } = await planned((item, ports) => {
      item.pairPitch = { bottom: [fan(ports[0]!, ports[1]!, 60)] };
      for (const [a, b] of [[0, 1], [0, 2], [1, 2]] as const) addPairPitch(item, 'bottom', fan(ports[a]!, ports[b]!, 30));
    });
    expect(gaps(members)).toEqual([60, 30]);
    expect(node.sidePitch!.bottom).toBe(base);
  }, 180_000);

  it('reads no pair pitch of a member with a port that has left the face', async () => {
    const { node, base, members } = await planned((item, ports, fourth) => { item.pairPitch = { bottom: [fan(ports[1]!, fourth!, 60)] }; }, 'top');
    expect(gaps(members)).toEqual([base, base]);
    expect(node.sidePitch!.bottom).toBe(base);
  }, 180_000);

  it('reads no pair pitch of a member with a port outside the bundle', async () => {
    const { node, base, members } = await planned((item, ports, fourth) => { item.pairPitch = { bottom: [fan(ports[1]!, fourth!, 60)] }; }, 'bottom');
    const own = members.filter(port => port.ref.ordinal !== 999);
    expect(gaps(own)).toEqual([base, base]);
    expect(node.sidePitch!.bottom).toBe(base);
  }, 180_000);
});

describe('the install merges a face in one pass (ticket 04, last step)', () => {
  /** The install of slice 1, one entry at a time: copy the face, find the entry, sort the face. The reference the bulk merge must equal. */
  function oneAtATime(node: LayoutNode, side: 'top' | 'bottom', entry: PairPitch): void {
    const ports = entry.rule === 'fan' ? [...entry.ports].sort() : [...entry.ports];
    const list = [...(node.pairPitch?.[side] ?? [])];
    const at = list.findIndex(item => item.rule === entry.rule && item.ports.join('|') === ports.join('|'));
    if (at >= 0) list[at] = { ...list[at]!, min: Math.max(list[at]!.min, entry.min) };
    else list.push({ rule: entry.rule, ports, min: entry.min });
    list.sort((a, b) => a.rule.localeCompare(b.rule) || a.ports.join('|').localeCompare(b.ports.join('|')));
    node.pairPitch = { ...node.pairPitch, [side]: list };
  }

  it('gives the record and the offsets of the install one entry at a time on a 28-port face', () => {
    const keys = face(28, undefined).ports.map(port => portId(port.ref));
    // Two fan rounds over overlapping ports (every pair at 30, then the first ten at 50, given in reverse with unsorted pairs), and two block ports.
    const pairs = (from: number, to: number, min: number) => keys.slice(from, to).flatMap((one, k) => keys.slice(from + k + 1, to).map(two => ({ rule: 'fan' as const, ports: [one, two], min })));
    const entries = [...pairs(0, 28, 30), ...pairs(0, 10, 50).map(entry => ({ ...entry, ports: [...entry.ports].reverse() })).reverse(),
      { rule: 'block' as const, ports: [keys[3]!], min: 40 }, { rule: 'block' as const, ports: [keys[3]!], min: 45 }, { rule: 'block' as const, ports: [keys[20]!], min: 35 }];
    const old = face(28, undefined), bulk = face(28, undefined), single = face(28, undefined);
    for (const entry of entries) oneAtATime(old, 'bottom', entry);
    addPairPitches(bulk, 'bottom', entries);
    for (const entry of entries) addPairPitch(single, 'bottom', entry);
    expect(old.pairPitch!.bottom!.length).toBe(28 * 27 / 2 + 2);
    expect(bulk.pairPitch).toEqual(old.pairPitch);
    expect(single.pairPitch).toEqual(old.pairPitch);
    expect(faceOffsets(bulk, 'bottom', bulk.ports)).toEqual(faceOffsets(old, 'bottom', old.ports));
    expect(pairExcess(bulk, 'bottom', 28)).toBe(pairExcess(old, 'bottom', 28));
  });

  it('checks every pair floor of a 28-port face as the search over the face did', () => {
    const node = face(28, undefined), keys = node.ports.map(port => portId(port.ref)), model = { nodes: { n: node } } as unknown as LayoutModel;
    const wanted = keys.flatMap((one, k) => keys.slice(k + 1).map(two => ({ node: 'n', side: 'bottom' as const, ports: [one, two].sort() as [string, string], min: 30 })));
    const ledger = pairGrowth([], wanted, 'fan', 1);
    addPairPitches(node, 'bottom', pairFloorsOf(ledger).get('n')!.bottom!);
    expect(ledger.every(item => floorFailure(item, model) === undefined)).toBe(true);
    // A floor above the stored pair, and a pair the face does not store, fail; a pair the record gains later is found.
    const over = pairGrowth([], [{ ...wanted[5]!, min: 31 }], 'fan', 2)[0]!;
    expect(floorFailure(over, model)).toMatch(/is under 31/);
    node.pairPitch!.bottom = node.pairPitch!.bottom!.filter(entry => entry.ports.join('|') !== wanted[7]!.ports.join('|'));
    expect(floorFailure(ledger[7]!, model)).toMatch(/is under 30/);
    addPairPitches(node, 'bottom', [{ rule: 'fan', ports: [...wanted[7]!.ports], min: 30 }]);
    expect(floorFailure(ledger[7]!, model)).toBeUndefined();
  });
});

/**
 * Review 3 of slice 1: stage 5 keeps the pair-specific gaps of a bundle and reserves them at its other end, and a face record holds one
 * entry for each pair, so every reading of it is the same.
 */
describe('stage 5 and the record keep each pair (review 3)', () => {
  const bundleText = readFileSync(new URL('../../goldens/synthetic/a-bundle-of-three-ports-agrees-at-both-ends.yaml', import.meta.url), 'utf8');

  it('keeps unequal pair pitches of a bundle through stage 5 and reserves them at the other end', async () => {
    // A 60 px round over two members, then a 30 px round over all three.
    const model = sidesOne(resolve(parse(bundleText))), edge = model.nodes['edge']!;
    const ports = edge.ports.filter(port => (port.side ?? port.sizingSide) === 'bottom'), keys = ports.map(port => portId(port.ref));
    expect(ports).toHaveLength(3);
    const fan = (a: number, b: number, min: number) => ({ rule: 'fan' as const, ports: [keys[a]!, keys[b]!].sort(), min });
    edge.pairPitch = { bottom: [fan(0, 1, 60), fan(0, 2, 30), fan(1, 2, 30)] };
    sizeNodes(model);
    await skeleton(model, { createAttempt });
    const out = sidesTwo(model), node = out.nodes['edge']!;
    expect(faceOffsets(node, 'bottom', node.ports.filter(port => port.side === 'bottom'))).toEqual([0, 60, 90]);
    expect(node.sidePitch!.bottom).toBeLessThan(30);
    // Each two members keep one pair pitch at both ends, so the tracks stay parallel.
    const links = out.links.filter(link => link.bundle !== undefined);
    expect(links).toHaveLength(3);
    const end = (link: typeof links[number], id: string) => (link.attachments!.from.node === id ? link.attachments!.from : link.attachments!.to);
    for (const [i, one] of links.entries()) for (const two of links.slice(i + 1)) for (const [a, b] of [['edge', 'r1'], ['r1', 'edge']] as const) {
      const side = (id: string, link: typeof one) => out.nodes[id]!.ports.find(port => portId(port.ref) === portId(end(link, id)))!.side!;
      expect(neighbourPitch(out.nodes[a]!, side(a, one), end(one, a), end(two, a))).toBe(neighbourPitch(out.nodes[b]!, side(b, one), end(one, b), end(two, b)));
    }
  }, 180_000);

  it('refuses a face record with two entries for one pair at restore (R5, R6)', () => {
    const model = sidesOne(resolve(parse(bundleText))), node = model.nodes['edge']!, keys = node.ports.slice(0, 2).map(port => portId(port.ref)).sort();
    node.pairPitch = { bottom: [{ rule: 'fan', ports: keys, min: 60 }, { rule: 'fan', ports: keys, min: 12 }] };
    expect(() => restoreLayoutModel(JSON.stringify(model))).toThrow(/two pair pitches for one pair/);
    node.pairPitch = { bottom: [{ rule: 'fan', ports: [...keys].reverse(), min: 60 }] };
    expect(() => restoreLayoutModel(JSON.stringify(model))).toThrow(/two pair pitches for one pair/);
    node.pairPitch = { bottom: [{ rule: 'fan', ports: keys, min: 60 }] };
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
  });
});

/**
 * Review 4 of slice 1: the common scalar pitch of a bundle is computed from intrinsic member pitches only, and a carried pair is stored only as
 * a pair entry of a horizontal face. The matrix: the end faces horizontal or lateral, the pair needs on one end, the other, or both; and an
 * unrelated pair on a shared face. Each case enters before stage 5 (real `sizeNodes`, `skeleton`, `sidesTwo`) and is compared with the same
 * model without the injected pairs.
 */
describe('a bundle pair floor never becomes a face-wide minimum (review 4)', () => {
  const sheet = (edge: string, r1: string, extra = ''): string => `portograph: 2
profile: network
groups:
  top: {tier: 0}
  mid: {tier: 1}
nodes:
  edge: {group: top${edge}}
  r1: {group: mid${r1}}${extra ? '\n  r2: {group: mid}' : ''}
links:
- [r1${r1 ? '.p1' : ''}, edge${edge ? '.p1' : ''}, {id: l1}]
- [r1${r1 ? '.p2' : ''}, edge${edge ? '.p2' : ''}, {id: l2}]
- [r1${r1 ? '.p3' : ''}, edge${edge ? '.p3' : ''}, {id: l3}]
${extra}`;
  const lateral = (side: string): string => `, ports: [{name: p1, side: ${side}}, {name: p2, side: ${side}}, {name: p3, side: ${side}}]`;
  type Needs = readonly [number, number, number];
  const PAIRS = [[0, 1], [0, 2], [1, 2]] as const;
  const members = (model: LayoutModel) => model.links.filter(link => link.bundle !== undefined).sort((a, b) => a.id.localeCompare(b.id));
  const end = (link: LayoutModel['links'][number], id: string) => (link.attachments!.from.node === id ? link.attachments!.from : link.attachments!.to);
  const portOf = (model: LayoutModel, link: LayoutModel['links'][number], id: string) => model.nodes[id]!.ports.find(port => portId(port.ref) === portId(end(link, id)))!;
  /** Stage 5 on `yaml`, with the pair needs `needs` written on the face of each named node before sizing. */
  async function stage5(yaml: string, needs: Record<string, Needs> = {}, extra?: (model: LayoutModel) => void): Promise<LayoutModel> {
    const model = sidesOne(resolve(parse(yaml))), links = members(model);
    expect(links).toHaveLength(3);
    for (const [id, values] of Object.entries(needs)) {
      const side = (portOf(model, links[0]!, id).side ?? portOf(model, links[0]!, id).sizingSide) as 'top' | 'bottom';
      addPairPitches(model.nodes[id]!, side, PAIRS.map(([a, b], k) => ({ rule: 'fan' as const, ports: [portId(end(links[a]!, id)), portId(end(links[b]!, id))].sort(), min: values[k]! })));
    }
    extra?.(model);
    sizeNodes(model);
    await skeleton(model, { createAttempt });
    return sidesTwo(model);
  }
  /** The pitch of each two members at node `id`, and the scalar of the member face. */
  const read = (model: LayoutModel, id: string) => {
    const links = members(model), side = portOf(model, links[0]!, id).side!;
    return { side, scalar: model.nodes[id]!.sidePitch![side]!, pairs: PAIRS.map(([a, b]) => neighbourPitch(model.nodes[id]!, side, end(links[a]!, id), end(links[b]!, id))),
      offsets: faceOffsets(model.nodes[id]!, side, links.map(link => portOf(model, link, id))) };
  };
  const cases: { name: string; yaml: string; sides: [string, string]; needs: Record<string, Needs>; want: Record<string, Needs | 'base'> }[] = [
    { name: 'horizontal to horizontal, needs on the source', yaml: sheet('', ''), sides: ['bottom', 'top'], needs: { edge: [60, 30, 30] }, want: { edge: [60, 30, 30], r1: [60, 30, 30] } },
    { name: 'horizontal to horizontal, needs on the destination', yaml: sheet('', ''), sides: ['bottom', 'top'], needs: { r1: [60, 30, 30] }, want: { edge: [60, 30, 30], r1: [60, 30, 30] } },
    { name: 'horizontal to horizontal, unequal needs on both', yaml: sheet('', ''), sides: ['bottom', 'top'], needs: { edge: [60, 30, 30], r1: [30, 45, 50] }, want: { edge: [60, 45, 50], r1: [60, 45, 50] } },
    { name: 'horizontal to lateral, needs on the horizontal end', yaml: sheet('', lateral('left')), sides: ['bottom', 'left'], needs: { edge: [60, 30, 30] }, want: { edge: [60, 30, 30], r1: 'base' } },
    { name: 'lateral to horizontal, needs on the horizontal end', yaml: sheet(lateral('right'), ''), sides: ['right', 'top'], needs: { r1: [60, 30, 30] }, want: { edge: 'base', r1: [60, 30, 30] } },
    { name: 'lateral to lateral, no pair record on either end', yaml: sheet(lateral('right'), lateral('left')), sides: ['right', 'left'], needs: {}, want: { edge: 'base', r1: 'base' } },
  ];
  for (const item of cases) it(item.name, async () => {
    const base = await stage5(item.yaml), out = await stage5(item.yaml, item.needs);
    expect([read(out, 'edge').side, read(out, 'r1').side]).toEqual(item.sides);
    for (const id of ['edge', 'r1'] as const) {
      const now = read(out, id), was = read(base, id), want = item.want[id]!;
      // The scalar of each member face is the intrinsic one, with or without pair needs.
      expect(now.scalar).toBe(was.scalar);
      if (want === 'base') expect(now.offsets).toEqual(was.offsets);
      else {
        expect(now.pairs).toEqual(want);
        // Members in link order stand at the pair pitches of their two neighbour pairs.
        expect(now.offsets).toEqual([0, want[0], want[0] + want[2]]);
      }
    }
  }, 180_000);

  it('does not widen a bundle for an unrelated pair on a shared face', async () => {
    const yaml = sheet('', '', '- [r2, edge, {id: l4}]\n');
    const unrelated = (model: LayoutModel): void => {
      const edge = model.nodes['edge']!, links = members(model), other = model.links.find(link => link.bundle === undefined && link.attachments?.from.node === 'r2')!;
      addPairPitches(edge, 'bottom', [0, 1, 2].map(k => ({ rule: 'fan' as const, ports: [portId(end(links[k]!, 'edge')), portId(end(other, 'edge'))].sort(), min: 60 })));
    };
    const base = await stage5(yaml), out = await stage5(yaml, {}, unrelated);
    for (const id of ['edge', 'r1'] as const) {
      expect(read(out, id).side).toBe(id === 'edge' ? 'bottom' : 'top');
      expect(read(out, id).scalar).toBe(read(base, id).scalar);
      expect(read(out, id).pairs).toEqual(read(base, id).pairs);
    }
  }, 180_000);
});

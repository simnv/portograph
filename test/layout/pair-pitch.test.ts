import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, LayoutNode, LayoutPort } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { blockReservationsFault } from '../../src/layout/block-checks.js';
import { endPitch, faceExcess, faceOffsets, neighbourPitch, pairExcess, pairPitchFault } from '../../src/layout/pair-pitch.js';
import { portSideCapacity } from '../../src/layout/port-insets.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { readDraft } from '../../src/layout/overlay-order.js';
import { sizeNodes } from '../../src/layout/size.js';
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
    expect(score(model).snapshot.counts.routed.crossings).toBe(5);
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

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score, serializeLayoutModel } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/internal.js';
import type { LayoutModel } from '../../src/index.js';
import { resolve } from '../../src/resolve/index.js';
import { aspectGap, floatComponents, LIFT_AREA_TOLERANCE, LIFT_TRIALS, validateGroupLifts } from '../../src/layout/lift.js';
import { judgeLift } from '../../src/layout/lift-judge.js';
import { pathBends } from '../../src/layout/objective.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Group lift (decision review 2026-11, D-Q5, ticket 08): a float component rises as a whole by whole bands, up and in beside the wide block
// below; a routed feed from above becomes a level side entry, and the units below a hanging component move down. Decided on whole command
// runs and kept only when the published result passes the judge; recorded as `groupLifts`, the document tier never rewritten.
const NAME = 'a-float-component-rises-beside-a-tall-block';
const KEY = 'a-chain-of-tiers-packs-over-its-feeds-final-x';
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const withLayout = (yaml: string, layoutLine: string): string => yaml.replace('\ngroups:', `\nlayout: ${layoutLine}\ngroups:`);
const resolved = (yaml: string): LayoutModel => resolve(parse(yaml));
const gates = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id);
const area = (model: LayoutModel): number => model.canvas!.width * model.canvas!.height;
// The key sheet is laid out once for the tests that read it (each layout is up to 1 + LIFT_TRIALS command runs).
const traces: { entry: unknown; reason: string | undefined }[] = [];
let keyModel: Promise<LayoutModel> | undefined;
const keyRun = (): Promise<LayoutModel> => keyModel ??= layout(parse(fixture(KEY)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
  testLiftTrace: event => traces.push({ entry: event.entry, reason: event.reason }) });

// Three tiers: `top` feeds `mid`; `float` (tier 1) feeds `low` (tier 2) and has an overlay link down to `mid2` (tier 2).
const OVERLAY_BELOW = `portograph: 2
groups:
  top: { tier: 0 }
  mid: { tier: 1 }
  float: { tier: 1 }
  low: { tier: 2 }
  mid2: { tier: 2 }
nodes:
  t: { group: top, class: router }
  m: { group: mid, class: router }
  f: { group: float, class: router }
  l: { group: low, class: switch }
  n: { group: mid2, class: switch }
links:
  - [t, m]
  - [m, n]
  - [f, l]
  - [f, n, { route: overlay }]
`;

describe('group lift: eligibility (D-Q5)', () => {
  it('bounds a side entry by the feeder node: on the key sheet East and West may rise one band, until the fed gateway stands in the band of Dist', () => {
    // The user's ruling (2026-11-08) withdraws the first reading "East is no component": East rises beside Dist through a level side entry.
    const components = floatComponents(resolved(fixture(KEY)));
    expect(components.map(item => [item.units, item.bound, item.plainBound])).toEqual([[['east'], 1, 0], [['mid', 'side'], 3, 3], [['west'], 1, 0]]);
    expect(components[1]!.groups).toEqual(['mid#0', 'mid-zone#1', 'mid-zone#2', 'side']);
  });

  it('reads the links of both layers: an overlay link to a lower tier joins the closure', () => {
    // `float` reaches `mid2` over the overlay link, and `mid2` has the routed feeder `mid` directly above it: it may rise only through a level
    // side entry, until `n` stands in the band of `m`, which is a band `float` does not have below it.
    const components = floatComponents(resolved(OVERLAY_BELOW));
    expect(components.every(item => !item.units.includes('float') || item.units.includes('mid2'))).toBe(true);
  });

  it('lets a lone group fed from directly above rise only through a level side entry: plain bound 0, side-entry bound 1', () => {
    // The user's ruling (2026-11-08, "a side entry is level") replaces the first slice's "a lone group stops below its feeder": each leaf
    // group fed from directly above may rise one band, until its node stands in its feeder's band. Its trial is judged like any other.
    const chain = OVERLAY_BELOW.replace('  - [f, n, { route: overlay }]\n', '').replace('  - [f, l]\n', '  - [f, l]\n  - [t, f]\n');
    expect(floatComponents(resolved(chain)).map(item => [item.units, item.bound, item.plainBound])).toEqual([[['low'], 1, 0], [['mid2'], 1, 0]]);
  });

  it('leaves a component that holds a flank out of the first slice: it is found, with its scope', () => {
    const flanked = OVERLAY_BELOW.replace('  - [f, n, { route: overlay }]\n', '').replace('  mid2: { tier: 2 }\n', '  mid2: { tier: 2 }\n  side: { align: left, of: low }\n')
      .replace('  n: { group: mid2, class: switch }\n', '  n: { group: mid2, class: switch }\n  s: { group: side, class: switch }\n').replace('  - [f, l]\n', '  - [f, l]\n  - [s, l]\n');
    const components = floatComponents(resolved(flanked));
    // `mid2` (fed from directly above by `mid`) is a side-entry component of its own and holds no flank.
    expect(components.map(item => [item.units, item.scope])).toEqual([[['float', 'low', 'side'], 'beside a flank'], [['mid2'], undefined]]);
  });
});

describe('group lift: the fixture and the key sheet', () => {
  it('lifts the fixture component one whole band; every straight link stays straight, the canvas area drops, the document tiers stay', async () => {
    const lifted = await run(fixture(NAME));
    const plain = await layout(parse(fixture(NAME)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testLiftOff: true });
    // The campus frame is a side-entry component too (fed from directly above by `dist`); its trial is declined on area, so it stays.
    expect(lifted.groupLifts).toEqual([expect.objectContaining({ units: ['lab', 'lab-floor'], members: ['lab', 'lab-floor'], tiers: [1, 2], from: [1, 2], to: [0, 1], offset: 1, side: 'left' }),
      expect.objectContaining({ units: ['campus'], offset: 0 })]);
    expect(lifted.groups.lab!.tier).toBe(0);
    expect(lifted.groups['lab-floor']!.tier).toBe(1);
    // The document keeps the author's tiers: only the band moved.
    expect(lifted.document.groups.lab!.tier).toBe(1);
    expect(lifted.document.groups['lab-floor']!.tier).toBe(2);
    expect(area(lifted)).toBeLessThan(area(plain));
    for (const link of plain.links) if (pathBends(link) === 0) expect(pathBends(lifted.links.find(item => item.id === link.id)!), link.id).toBe(0);
    expect(gates(lifted)).toEqual([]);
    expect(lifted.diagnostics.filter(note => note.code === 'GROUP_LIFT_TAKEN')).toHaveLength(1);
  }, 120000);

});

describe('group lift: the record (absent and empty)', () => {
  it('is absent under layout.autoArrange: false and on a sheet with no float component, and lists a component when one is found', async () => {
    const off = await run(withLayout(fixture(NAME), '{ autoArrange: false }'));
    expect(off.groupLifts).toBeUndefined();
    // Under autoArrange: false nothing is decided, so even an empty record is refused.
    expect(() => restoreLayoutModel(JSON.stringify({ ...JSON.parse(serializeLayoutModel(off)) as object, groupLifts: [] }))).toThrow(/autoArrange is false/);
    expect(off.groups.lab!.tier).toBe(1);
    // Two groups of one tier joined by a link: the closure of either is the whole sheet, so no float component exists.
    const none = await run(`portograph: 2
groups:
  a: { tier: 0 }
  b: { tier: 0 }
nodes:
  x: { group: a, class: router }
  y: { group: b, class: switch }
links:
  - [x, y]
`);
    // Nothing to decide: one run and no record, as `groupArrangements` when stage 5 has nothing to choose.
    expect(none.groupLifts).toBeUndefined();
    // `[]` (decided, none) restores like the absent record: no member, no band moved.
    expect(() => restoreLayoutModel(JSON.stringify({ ...JSON.parse(serializeLayoutModel(none)) as object, groupLifts: [] }))).not.toThrow();
  }, 120000);
});

describe('group lift: the judge keeps straight links', () => {
  it('refuses a trial that bends a link the baseline draws straight, and one whose canvas is not smaller', async () => {
    const base = await run(fixture(NAME));
    const forged = JSON.parse(JSON.stringify(base)) as LayoutModel;
    const link = forged.links.find(item => pathBends(item) === 0 && item.path!.segments.length === 1 && item.path!.segments[0]!.from.x === item.path!.segments[0]!.to.x)!;
    const [segment] = link.path!.segments;
    const mid = (segment!.from.y + segment!.to.y) / 2;
    link.path!.segments = [{ ...segment!, to: { x: segment!.from.x, y: mid } }, { ...segment!, from: { x: segment!.from.x, y: mid }, to: { x: segment!.from.x + 5, y: mid } },
      { ...segment!, from: { x: segment!.from.x + 5, y: mid }, to: { x: segment!.from.x + 5, y: segment!.to.y } }];
    forged.canvas = { ...forged.canvas!, width: forged.canvas!.width - 10 };
    const tolerance = { noLift: base, smallest: base, T: LIFT_AREA_TOLERANCE };
    expect(judgeLift(base, forged, new Set(), tolerance).reason).toBe(`the link ${link.id} is straight without the lift and not with it`);
    expect(judgeLift(base, base, new Set(), tolerance).reason).toMatch(/^the canvas area is \d+ px² with the lift, not less than \d+ px² with no lift$/);
  }, 120000);
});

describe('group lift: restore validates the record', () => {
  it('restores the published record, and refuses a forged offset, a forged start band, a unit cut in two and a member with a link below', async () => {
    const model = await run(fixture(NAME));
    const json = serializeLayoutModel(model);
    expect(() => restoreLayoutModel(json)).not.toThrow();
    const forge = (edit: (copy: LayoutModel) => void): string => { const copy = JSON.parse(json) as LayoutModel; edit(copy); return JSON.stringify(copy); };
    // Two bands up instead of one: the document puts `lab` in band 1, and two bands up from it is no band.
    expect(() => restoreLayoutModel(forge(copy => { copy.groupLifts![0]!.offset = 2; }))).toThrow();
    // A start band the document does not give.
    expect(() => restoreLayoutModel(forge(copy => { copy.groupLifts![0]!.from = [2, 2]; }))).toThrow(/starts in band/);
    // A component that is not whole: `lab` alone, with its feed to `lab-floor` left below it.
    expect(() => restoreLayoutModel(forge(copy => {
      const entry = copy.groupLifts![0]!;
      copy.groupLifts = [{ ...entry, units: ['lab'], members: ['lab'], tiers: [1], from: [1], to: [0] }];
    }))).toThrow();
    // A declined entry whose member does not stand in its start band.
    expect(() => validateGroupLifts({ ...model, groupLifts: [{ ...model.groupLifts![0]!, offset: 0, to: [1, 2] }] } as LayoutModel)).toThrow(/not in its recorded band/);
    // A member with a link below it: `dist` feeds the campus frame, so a record that lifts `dist` names a component that is not one.
    expect(() => validateGroupLifts({ ...model, groupLifts: [{ ...model.groupLifts![0]!, units: ['dist'], members: ['dist'], tiers: [1], from: [1], to: [0], straight: [] }],
      groups: { ...model.groups, dist: { ...model.groups.dist!, tier: 0 } } } as LayoutModel)).toThrow(/leaves the component to a unit of the same or a lower tier/);
  }, 120000);
});

// D-Q5 revised (user draw.io edit 2026-11-08): a lifted unit moves up and in, and a vertical feed into it may become a level side entry.
// The record names the feed (`sideEntry`); the group keeps all its members.
const SIDE = 'a-lifted-group-takes-its-feed-on-its-side';
const frameBox = (model: LayoutModel, id: string) => model.frames!.find(frame => frame.id === id)!.box;

describe('group lift: up and in, a level side entry', () => {
  it('lifts the fixture group beside its feeder, inside the span of the wide frame below, with its feed as one straight segment into its side', async () => {
    const model = await run(fixture(SIDE));
    const plain = await layout(parse(fixture(SIDE)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testLiftOff: true });
    const entry = model.groupLifts!.find(item => item.units.includes('branch'))!;
    // The gateway rises only to the band of Dist two (one band), and the campus frame moves down one band.
    expect(entry).toMatchObject({ units: ['branch'], members: ['branch#0', 'branch-zone#1'], offset: 1, side: 'right', sideEntry: ['link-4'], push: { at: 1, by: 1 } });
    const feed = model.links.find(link => link.id === 'link-4')!;
    expect(feed.path!.segments).toHaveLength(1);
    expect(feed.path!.segments[0]!.from.y).toBeCloseTo(feed.path!.segments[0]!.to.y, 6);
    expect(model.nodes['dist-2']!.ports.find(port => port.side === 'right')).toBeDefined();
    expect(model.nodes['branch-gw']!.ports.find(port => port.side === 'left')).toBeDefined();
    // The group keeps its members, gateway on top; it stands inside the horizontal span of the campus frame.
    expect(model.document.nodes['branch-gw']!.group.startsWith('branch')).toBe(true);
    expect(model.document.nodes['branch-1']!.group.startsWith('branch-zone')).toBe(true);
    expect(model.nodes['branch-gw']!.bounds!.y).toBeLessThan(model.nodes['branch-1']!.bounds!.y);
    const campus = frameBox(model, 'campus'), branch = frameBox(model, 'branch');
    expect(branch.x).toBeGreaterThanOrEqual(campus.x);
    expect(branch.x + branch.width).toBeLessThanOrEqual(campus.x + campus.width);
    expect(area(model)).toBeLessThan(area(plain));
    for (const link of plain.links) expect(pathBends(model.links.find(item => item.id === link.id)!), link.id).toBeLessThanOrEqual(pathBends(link) ?? 0);
    expect(gates(model)).toEqual([]);
  }, 120000);

  it('restores the side entry record, and refuses a forged one', async () => {
    const model = await run(fixture(SIDE));
    const json = serializeLayoutModel(model);
    expect(() => restoreLayoutModel(json)).not.toThrow();
    const copy = JSON.parse(json) as LayoutModel;
    copy.groupLifts!.find(item => item.units.includes('branch'))!.sideEntry = ['link-1'];
    expect(() => restoreLayoutModel(JSON.stringify(copy))).toThrow();
  }, 120000);
});

describe('group lift: the units below a hanging component move down', () => {
  it('on the key sheet, East gateway stands level with Dist two, the feed is one horizontal segment, West moves down two bands, and the narrower form is kept', async () => {
    expect(LIFT_AREA_TOLERANCE).toBe(0.05);
    const model = await keyRun();
    // Side and Middle rise as one component; East rises one band beside Dist and pushes West down two bands; at most LIFT_TRIALS trials.
    expect(model.groupLifts!.find(item => item.units.includes('mid'))).toMatchObject({ units: ['mid', 'side'], offset: 3, side: 'left' });
    expect(traces.length).toBeLessThanOrEqual(LIFT_TRIALS);
    // The two trials are spent on Side/Middle and East, so West (a side-entry component the estimate also admits) is capped, by name (R4).
    expect(traces).toHaveLength(LIFT_TRIALS);
    expect(model.groupLifts!.find(item => item.units.includes('west'))).toMatchObject({ offset: 0, reason: `capped: the sheet has made its ${LIFT_TRIALS} lift trials` });
    expect(model.diagnostics.filter(note => note.code === 'GROUP_LIFT_CAPPED').map(note => note.owners)).toEqual([[{ kind: 'group', id: 'west' }]]);
    const east = model.groupLifts!.find(item => item.units.includes('east'))!;
    expect(east).toMatchObject({ units: ['east'], offset: 1, from: [4, 5, 6], to: [3, 4, 5], side: 'right', sideEntry: ['link-8'], push: { at: 3, by: 2 } });
    expect(east.reason).toMatch(/tolerated/);
    const centre = (id: string): number => model.nodes[id]!.bounds!.y + model.nodes[id]!.bounds!.height / 2;
    expect(centre('east-gw')).toBeCloseTo(centre('dist-2'), 6);
    const feed = model.links.find(link => link.id === 'link-8')!.path!.segments;
    expect(feed).toHaveLength(1);
    expect(feed[0]!.from.y).toBeCloseTo(feed[0]!.to.y, 6);
    // The fed node never stands above its feeder; the whole East group (gateway on top) stands above West, which moved down.
    expect(model.nodes['east-gw']!.bounds!.y).toBeLessThan(model.nodes['east-1']!.bounds!.y);
    const west = frameBox(model, 'west'), eastBox = frameBox(model, 'east');
    expect(eastBox.y + eastBox.height).toBeLessThan(west.y);
    expect(model.groups['west#0']!.tier).toBe(6);
    // A vertical feed across the pushed bands stays vertical (the centre rule reads the band past the lifted ones).
    const drop = model.links.find(link => link.id === 'link-6')!.path!.segments;
    expect(drop).toHaveLength(1);
    expect(drop[0]!.from.x).toBeCloseTo(drop[0]!.to.x, 6);
    expect(model.canvas!.width).toBeLessThan(1400);
    expect(aspectGap(model.canvas!.width, model.canvas!.height)).toBeLessThan(0.1);
    expect(score(model).snapshot.counts.routed.turns).toBe(0);
    expect(gates(model)).toEqual([]);
  }, 180000);

  it('restores the push, and refuses a forged push and a side entry that stands above its feeder', async () => {
    const model = await keyRun();
    const json = serializeLayoutModel(model);
    expect(() => restoreLayoutModel(json)).not.toThrow();
    const forge = (edit: (entry: NonNullable<LayoutModel['groupLifts']>[number]) => void): string => {
      const copy = JSON.parse(json) as LayoutModel;
      edit(copy.groupLifts!.find(item => item.units.includes('east'))!);
      return JSON.stringify(copy);
    };
    expect(() => restoreLayoutModel(forge(entry => { entry.push = { at: 3, by: 1 }; }))).toThrow(/pushes/);
    expect(() => restoreLayoutModel(forge(entry => { delete entry.push; }))).toThrow();
    expect(() => restoreLayoutModel(forge(entry => { entry.offset = 2; entry.to = [2, 3, 4]; entry.push = { at: 3, by: 1 }; }))).toThrow();
    // A side the geometry does not show, and a declined entry that keeps a push or a side entry.
    expect(() => restoreLayoutModel(forge(entry => { entry.side = 'left'; }))).toThrow(/not on its recorded left/);
    const declined = (edit: (entry: NonNullable<LayoutModel['groupLifts']>[number]) => void): string => {
      const copy = JSON.parse(json) as LayoutModel;
      edit(copy.groupLifts!.find(item => item.units.includes('west'))!);
      return JSON.stringify(copy);
    };
    expect(() => restoreLayoutModel(declined(entry => { entry.push = { at: 3, by: 1 }; }))).toThrow(/declined entry/);
    expect(() => restoreLayoutModel(declined(entry => { entry.sideEntry = ['link-6']; }))).toThrow(/declined entry/);
  }, 180000);
});


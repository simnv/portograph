import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import type { FanFallbackReason } from '../../src/model/index.js';
import { admitFanFamilies, fanAdmissionsFault, refuseFanMembers, refuseStemCrowded, titleCrowdedFanMembers } from '../../src/layout/fan-admission.js';
import { blockedChords, freezeChords, orthogonalLeg, siblingStemCrowded } from '../../src/layout/frame-paths.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture-2 ticket 40 (user rulings Q124 to Q126): the dashed links of two hubs to four sites are one fan family. Its members draw
 * straight where the joint admission holds them; the member that would pass the vault falls back alone, orthogonal, and names `body`; members
 * cross each other faintly; the Site D title may stand over the chord that enters on its edge (ticket 162).
 */
const FIXTURE = 'a-hub-tiers-fan-draws-straight-and-crosses-itself';
const text = readFileSync(new URL(`../../goldens/synthetic/${FIXTURE}.yaml`, import.meta.url), 'utf8');
const lay = (source: string): Promise<LayoutModel> => layout(parse(source), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const ends = (model: LayoutModel, id: string): string => {
  const link = model.links.find(other => other.id === id)!;
  return [link.from.node, link.to.node].sort().join('|');
};
/**
 * The admission of each member keyed by where its path starts and ends, so a run with the links and nodes in another order compares by the
 * drawing: the reversed node order mirrors the names in each group (declaration order is meaningful), not the picture.
 */
const modes = (model: LayoutModel): string[] => (model.fanAdmissions ?? []).map(item => {
  const segments = model.links.find(link => link.id === item.link)!.path!.segments;
  const at = (point: { x: number; y: number }): string => `${Math.round(point.x)},${Math.round(point.y)}`;
  return `${[at(segments[0]!.from), at(segments[segments.length - 1]!.to)].sort().join(' ')} ${item.mode} ${item.reason ?? ''}`;
}).sort();
const clone = (model: LayoutModel): LayoutModel => structuredClone(model);

describe('a fan family draws straight and crosses itself faintly', () => {
  let model: LayoutModel;

  it('admits the members jointly: straight on one chord, and the member that passes the vault falls back alone with `body`', async () => {
    model = await lay(text);
    const record = model.fanAdmissions!;
    expect(record).toHaveLength(8);
    expect(fanAdmissionsFault(model)).toBeUndefined();
    const fallen = record.filter(item => item.mode === 'orthogonal');
    expect(fallen.map(item => [ends(model, item.link), item.reason])).toEqual([['d-1|hub-a', 'body']]);
    // Every member but the one the vault refuses: seven straight.
    const straight = record.filter(item => item.mode === 'straight');
    expect(straight).toHaveLength(7);
    for (const item of straight) {
      const link = model.links.find(other => other.id === item.link)!;
      expect(link.path!.segments, item.link).toHaveLength(1);
    }
    const fallback = model.links.find(other => other.id === fallen[0]!.link)!;
    expect(fallback.path!.segments.length).toBeGreaterThan(1);
    expect(fallback.path!.segments.every(segment => segment.from.x === segment.to.x || segment.from.y === segment.to.y)).toBe(true);
  }, 120000);

  it('counts the crossings of members faint, keeps them out of X, and passes every gate', () => {
    const report = score(model);
    const crossings = report.snapshot.metrics.crossings;
    // Two member pairs cross as an X (a-1 to Hub A with b-2 to Hub B, and the fallback Hub A to D 1 with Hub B to C 2); the fallback also
    // crosses the solid drop from the vault to C 3, which is no member: X 1.
    expect(crossings.faint).toBe(2);
    expect(crossings.count).toBe(3);
    expect(model.diagnostics.filter(item => item.code === 'FAN_SEARCH_TRUNCATED')).toEqual([]);
    // The crossings metric is 1 - c / m over the routed links, with each faint crossing weighed 0.09 in c.
    const weighted = crossings.count - crossings.faint! + 0.09 * crossings.faint!;
    expect(crossings.value).toBeCloseTo(1 - Math.min(1, weighted / crossings.routedLinks), 9);
    const failed = Object.entries(report.snapshot.gates).filter(([, gate]) => gate.violations.length).map(([id]) => id);
    expect(failed).toEqual([]);
  });

  it('lets the Site D title stand over the member that enters on its edge: a diagonal may cross a title (ticket 162)', () => {
    const chord = model.links.find(link => ends(model, link.id) === 'd-1|hub-b')!;
    expect(chord.path!.segments).toHaveLength(1);
    const segment = chord.path!.segments[0]!;
    expect(segment.from.x !== segment.to.x && segment.from.y !== segment.to.y).toBe(true);
    expect(score(model).snapshot.gates['G3']!.violations).toEqual([]);
  });

  it('refuses a forged admission record (R5)', () => {
    const straight = model.fanAdmissions!.find(item => item.mode === 'straight')!;
    const asOrthogonal = clone(model);
    asOrthogonal.fanAdmissions!.find(item => item.link === straight.link)!.mode = 'orthogonal';
    expect(fanAdmissionsFault(asOrthogonal)).toMatch(/holds a chord its admission refused/);
    // A box that holds an end of the member is no foreign box: the record may not name it.
    const fromSiteA = model.fanAdmissions!.find(item => ends(model, item.link) === 'a-1|hub-a')!;
    expect(fromSiteA.mode).toBe('straight');
    const ownBox = clone(model);
    ownBox.fanAdmissions!.find(item => item.link === fromSiteA.link)!.crosses = ['site-a'];
    expect(fanAdmissionsFault(ownBox)).toMatch(/no foreign box/);
    const reordered = clone(model);
    reordered.fanAdmissions!.reverse();
    expect(fanAdmissionsFault(reordered)).toMatch(/in order/);
  });

  it('refuses at the end of 7f a member that passes the stem of a sibling fallback, and one on an axis a placed title still meets', () => {
    // Nothing is crowded as drawn.
    const straight = model.fanAdmissions!.filter(item => item.mode === 'straight').map(item => model.links.find(link => link.id === item.link)!);
    expect(straight.filter(link => siblingStemCrowded(model, link)).map(link => link.id)).toEqual([]);
    expect(titleCrowdedFanMembers(model)).toEqual([]);
    // The member from Hub B to D 1 led to 3 px beside the port of the fallback from Hub A to D 1 passes its stem.
    const fallback = model.links.find(link => ends(model, link.id) === 'd-1|hub-a')!;
    const leg = orthogonalLeg(model, fallback, fallback.attachments!.from.node === 'd-1' ? 'from' : 'to')!;
    const forged = clone(model);
    const chord = forged.links.find(link => ends(model, link.id) === 'd-1|hub-b')!;
    const segment = chord.path!.segments[0]!;
    const far = segment.to.y > segment.from.y ? 'to' : 'from';
    segment[far] = { x: leg.from.x + 3, y: leg.from.y };
    expect(siblingStemCrowded(forged, chord)).toBe(true);
    // At the freeze (`attemptBody`: `refuseStemCrowded`, then `freezeChords` with the reasons) the member falls back as `stem`, and the record holds.
    delete forged.frozenChords;
    delete forged.fanAdmissions;
    const reasons = refuseStemCrowded(forged);
    expect([...reasons]).toEqual([[chord.id, 'stem']]);
    freezeChords(forged, reasons);
    expect(forged.fanAdmissions!.find(item => item.link === chord.id)).toMatchObject({ mode: 'orthogonal', reason: 'stem' });
    expect(forged.fanAdmissions!.filter(item => item.mode === 'straight')).toHaveLength(6);
    expect(fanAdmissionsFault(forged)).toBeUndefined();
    // The Site D title moved onto the same member's chord: a diagonal may cross a title (ticket 162), so nothing is crowded.
    const titled = clone(model);
    const target = titled.links.find(link => ends(model, link.id) === 'd-1|hub-b')!, member = target.path!.segments[0]!;
    const title = titled.labels.find(label => label.role === 'group' && label.owner.kind === 'group' && label.owner.id === 'site-d')!;
    const middle = { x: (member.from.x + member.to.x) / 2, y: (member.from.y + member.to.y) / 2 };
    title.bounds = { ...title.bounds!, x: middle.x - title.bounds!.width / 2, y: middle.y - title.bounds!.height / 2 };
    expect(titleCrowdedFanMembers(titled)).toEqual([]);
    // The same member forged onto an axis keeps the rule: the title crowds it.
    member.to = { ...member.to, x: member.from.x };
    title.bounds = { ...title.bounds!, x: member.from.x - title.bounds!.width / 2 };
    expect(titleCrowdedFanMembers(titled)).toContain(target.id);
  });

  it('lets G2 excuse a straight member only in the boxes its admission names', () => {
    // A foreign group grown over the middle of a straight member: G2 fails until the record names that group.
    const straight = model.fanAdmissions!.find(item => item.mode === 'straight' && ends(model, item.link) === 'd-1|hub-b')!;
    const grown = clone(model);
    const segment = grown.links.find(link => link.id === straight.link)!.path!.segments[0]!;
    const middle = { x: (segment.from.x + segment.to.x) / 2, y: (segment.from.y + segment.to.y) / 2 };
    const box = grown.groups['site-c']!.bounds!;
    const right = Math.max(box.x + box.width, middle.x + 2), bottom = Math.max(box.y + box.height, middle.y + 2);
    grown.groups['site-c']!.bounds = { x: Math.min(box.x, middle.x - 2), y: Math.min(box.y, middle.y - 2), width: 0, height: 0 };
    const bounds = grown.groups['site-c']!.bounds!;
    bounds.width = right - bounds.x;
    bounds.height = bottom - bounds.y;
    const through = (candidate: LayoutModel): boolean => score(candidate).snapshot.gates.G2!.violations
      .some(violation => violation.code === 'through-group' && violation.elements.includes(straight.link) && violation.elements.includes('site-c'));
    expect(through(grown)).toBe(true);
    // The validator refuses the record that leaves the box out; after the freeze the chord is blocked (`fanBoxRefusal`, read by `blockedChords`).
    expect(fanAdmissionsFault(grown)).toMatch(/crosses site-c, which its record does not name/);
    expect(blockedChords(grown)).toContain(straight.link);
    grown.fanAdmissions!.find(item => item.link === straight.link)!.crosses = ['site-c'];
    expect(through(grown)).toBe(false);
    expect(fanAdmissionsFault(grown)).toBeUndefined();
    expect(blockedChords(grown)).not.toContain(straight.link);
  });

  it('names a search the budget cut short (FAN_SEARCH_TRUNCATED, R4)', () => {
    const draft = clone(model);
    const members = draft.links.filter(link => link.fanFamily !== undefined && link.path?.segments.length === 1);
    admitFanFamilies(draft, members, 1);
    const named = draft.diagnostics.filter(item => item.code === 'FAN_SEARCH_TRUNCATED');
    expect(named).toHaveLength(1);
    expect(named[0]!.message).toMatch(/stopped at 1 tested configurations/);
  });

  it('drops the cascade of a refusal round by round, whatever the order of the links (R3)', () => {
    // Hub B's bottom face holds the ports of the members to C 2 (refused here) and to D 1. The member to D 1 is led 4 px beside the leg of the
    // member to C 2, so it falls back in the first round; the member from B 2 to Hub B is led 5 px beside the leg of the member to D 1 at its
    // hub port, so it falls back in the second round only.
    const run = (reverse: boolean): { reasons: [string, FanFallbackReason][]; chords: string[] } => {
      const draft = clone(model);
      const link = (key: string) => draft.links.find(item => ends(model, item.id) === key)!;
      const toC = link('c-2|hub-b'), toD = link('d-1|hub-b'), fromB = link('b-2|hub-b');
      const legC = orthogonalLeg(draft, toC, toC.attachments!.from.node === 'hub-b' ? 'from' : 'to')!;
      const hubD = toD.attachments!.from.node === 'hub-b' ? toD.attachments!.from : toD.attachments!.to;
      const portD = draft.nodes['hub-b']!.ports.find(port => port.ref.ordinal === hubD.ordinal)!.anchor!;
      const low = Math.max(legC.from.y, legC.to.y);
      toD.path!.segments[0] = { ...toD.path!.segments[0]!, from: { x: legC.from.x + 4, y: legC.from.y }, to: { x: legC.from.x + 4, y: low } };
      fromB.path!.segments[0] = { ...fromB.path!.segments[0]!, from: { x: portD.x + 5, y: portD.y }, to: { x: portD.x + 5, y: portD.y + 40 } };
      if (reverse) draft.links.reverse();
      const reasons = [...refuseFanMembers(draft, new Map([[toC.id, 'title' as const]]))].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      const chords = draft.links.filter(item => item.fanFamily !== undefined && item.path?.segments.length === 1).map(item => item.id).sort();
      return { reasons, chords };
    };
    const forward = run(false);
    expect(forward.reasons.map(([id]) => ends(model, id)).sort()).toEqual(['b-2|hub-b', 'c-2|hub-b', 'd-1|hub-b']);
    expect(forward.reasons.find(([id]) => ends(model, id) === 'c-2|hub-b')![1]).toBe('title');
    for (const [id, reason] of forward.reasons) if (ends(model, id) !== 'c-2|hub-b') expect(['leg', 'chord'], id).toContain(reason);
    expect(run(true)).toEqual(forward);
  });

  it('draws the same admissions with the links and the nodes in reverse order (R3)', async () => {
    const lines = text.split('\n');
    const at = (key: string): number => lines.indexOf(`${key}:`);
    const block = (from: number, to: number): string[] => lines.slice(from + 1, to).filter(line => line.trim() !== '');
    const nodes = block(at('nodes'), at('links')), links = block(at('links'), lines.length);
    const reversed = [...lines.slice(0, at('nodes') + 1), ...nodes.reverse(), 'links:', ...links.reverse()].join('\n');
    expect(modes(await lay(reversed))).toEqual(modes(model));
  }, 120000);
});

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { isDiagonal } from '../../src/layout/diagonal-text.js';
import { refuseChords, titleCrowdedChords } from '../../src/layout/fan-admission.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Ticket 162, the re-read of its rule: a diagonal may cross a group title (ADR-0023), but a chord is held on the geometry of 7e and published on
 * the geometry 7f leaves. A held chord that 7f turns within `DIAGONAL_MIN_DEGREES` of an axis, under a title with no room beside it, is refused
 * on a retry of 7f (`title`), so the published geometry satisfies the one predicate. The title reader and the refusal before the freeze are
 * wrapped: they run as built, and a test reads the chord each attempt of 7f starts from, or turns the re-read off to show the premise.
 */
vi.mock('../../src/layout/fan-admission.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/layout/fan-admission.js')>();
  return { ...actual, titleCrowdedChords: vi.fn(actual.titleCrowdedChords), refuseChords: vi.fn(actual.refuseChords) };
});

const FIXTURE = 'a-chord-that-turns-onto-an-axis-meets-a-title';
const text = readFileSync(new URL(`../../goldens/synthetic/${FIXTURE}.yaml`, import.meta.url), 'utf8');
const layOf = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const lay = (): Promise<LayoutModel> => layOf(text);
const sheet = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
/** The re-read as built, with these held chords named too whenever they are held (a title is forged onto them). */
const forge = async (ids: readonly string[]): Promise<void> => {
  const actual = await vi.importActual<typeof import('../../src/layout/fan-admission.js')>('../../src/layout/fan-admission.js');
  vi.mocked(titleCrowdedChords).mockImplementation(model => [...new Set([...actual.titleCrowdedChords(model), ...ids.filter(id => model.frozenChords?.includes(id))])].sort());
};
const warned = (model: LayoutModel): string[] => model.diagnostics.filter(item => item.code === 'STRAIGHT_LINK_TITLE').flatMap(item => (item.owners ?? []).map(owner => (owner as { id: string }).id));
const failed = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id);
/** The feed from `w2` to `wb1`. */
const feed = (model: LayoutModel) => model.links.find(link => link.from.node === 'w2' && link.to.node === 'wb1');
/** At the start of each attempt of 7f (the end of 7e): the feed's chord, and the reason the attempt refuses it with. */
let starts: { chord: { from: { x: number; y: number }; to: { x: number; y: number } } | undefined; refused: string | undefined }[] = [];

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('../../src/layout/fan-admission.js')>('../../src/layout/fan-admission.js');
  vi.mocked(titleCrowdedChords).mockImplementation(actual.titleCrowdedChords);
  starts = [];
  vi.mocked(refuseChords).mockImplementation((draft, refused) => {
    const link = feed(draft);
    if (link !== undefined) starts.push({ chord: link.path?.segments.length === 1 ? { ...link.path.segments[0]! } : undefined, refused: refused.get(link.id) });
    return actual.refuseChords(draft, refused);
  });
});

describe('a held chord whose angle class 7f changes is judged again on the published geometry', () => {
  it('holds the feed as a diagonal at the freeze, refuses it as `title` on the retry, and passes every gate', async () => {
    const model = await lay();
    // At the end of 7e the feed is a chord, and a diagonal, which no title strip refuses: the first attempt holds it.
    expect(starts[0]!.refused).toBeUndefined();
    expect(isDiagonal(starts[0]!.chord!)).toBe(true);
    // The retry refuses it before the freeze, which names the reason.
    expect(starts).toHaveLength(2);
    expect(starts[1]!.refused).toBe('title');
    const link = feed(model)!;
    expect(model.frozenChords).not.toContain(link.id);
    expect(link.path!.segments.length).toBeGreaterThan(1);
    expect(model.diagnostics.some(item => item.code === 'ROUTED_CHORD_REFUSED' && item.message === `The link ${link.id} keeps the orthogonal route between frames: title.`)).toBe(true);
    // The published geometry satisfies the predicate: no held chord stands on an axis within a title's margin.
    expect(titleCrowdedChords(model)).toEqual([]);
    expect(failed(model)).toEqual([]);
  }, 120000);

  it('publishes the feed on an axis across the title, and G3 fails, when the class is not read again (the premise)', async () => {
    vi.mocked(titleCrowdedChords).mockImplementation(() => []);
    const model = await lay();
    const link = feed(model)!;
    expect(model.frozenChords).toContain(link.id);
    expect(link.path!.segments).toHaveLength(1);
    expect(isDiagonal(link.path!.segments[0]!)).toBe(false);
    const g3 = score(model).snapshot.gates.G3!;
    expect(g3.violations.map(item => item.elements)).toEqual([['label:group:w-site-b#0', link.id]]);
  }, 120000);
});

describe('the re-read names what it refuses and what it keeps (review of the re-read)', () => {
  it('refuses a frame chord a title meets on an axis, and the freeze names it as kept inside its frame', async () => {
    // `link-2` runs from WB1 to WB2 inside `w-site-b`: a frame chord.
    await forge(['link-2']);
    const model = await lay();
    expect(model.frozenChords).not.toContain('link-2');
    expect(model.diagnostics.some(item => item.code === 'ROUTED_CHORD_REFUSED' && item.message === 'The link link-2 keeps the orthogonal route inside its frame: title.')).toBe(true);
    expect(warned(model)).toEqual([]);
  }, 120000);

  it('names a held chord a title still meets after the retries run out', async () => {
    // Each attempt names the first held chord: the two retries refuse two, and the third attempt still names one, which stays.
    const actual = await vi.importActual<typeof import('../../src/layout/fan-admission.js')>('../../src/layout/fan-admission.js');
    vi.mocked(titleCrowdedChords).mockImplementation(model => [...new Set([...actual.titleCrowdedChords(model), ...(model.frozenChords ?? []).slice(0, 1)])].sort());
    const model = await lay();
    const kept = warned(model);
    expect(kept).toHaveLength(1);
    expect(model.frozenChords).toContain(kept[0]);
    expect(model.diagnostics.filter(item => item.code === 'ROUTED_CHORD_REFUSED' && item.message.endsWith(': title.'))).toHaveLength(2);
  }, 120000);

  it('keeps a spanning chord a title meets, since 7a reserved no transit lanes for it, and names it', async () => {
    // `link-4` takes a spanning chord (`SPAN_CHORD_TAKEN`).
    await forge(['link-4']);
    const model = await layOf(sheet('a-span-corridor-passes-a-lane-beside-a-unit-it-does-not-move'));
    expect(model.links.find(link => link.id === 'link-4')!.spanHint).toBe(true);
    expect(model.frozenChords).toContain('link-4');
    expect(warned(model)).toEqual(['link-4']);
    expect(model.diagnostics.some(item => item.code === 'ROUTED_CHORD_REFUSED' && item.message.startsWith('The link link-4 '))).toBe(false);
  }, 120000);

  it('refuses a direct member through its family, which records `title`', async () => {
    // `link-6` is the one direct member of its family.
    await forge(['link-6']);
    const model = await layOf(sheet('a-port-facing-away-from-a-tier-gap-is-left-to-the-router'));
    expect(model.frozenChords).not.toContain('link-6');
    const member = model.directFamilies!.flatMap(family => family.members).find(item => item.link === 'link-6');
    expect(member).toEqual({ link: 'link-6', mode: 'orthogonal', reason: 'title' });
    expect(warned(model)).toEqual([]);
  }, 120000);
});


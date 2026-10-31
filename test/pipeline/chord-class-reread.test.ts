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
const lay = (): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const failed = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id);
/** The feed from `w2` to `wb1`. */
const feed = (model: LayoutModel) => model.links.find(link => link.from.node === 'w2' && link.to.node === 'wb1')!;
/** At the start of each attempt of 7f (the end of 7e): the feed's chord, and the reason the attempt refuses it with. */
let starts: { chord: { from: { x: number; y: number }; to: { x: number; y: number } } | undefined; refused: string | undefined }[] = [];

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('../../src/layout/fan-admission.js')>('../../src/layout/fan-admission.js');
  vi.mocked(titleCrowdedChords).mockImplementation(actual.titleCrowdedChords);
  starts = [];
  vi.mocked(refuseChords).mockImplementation((draft, refused) => {
    const link = feed(draft);
    starts.push({ chord: link.path?.segments.length === 1 ? { ...link.path.segments[0]! } : undefined, refused: refused.get(link.id) });
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
    const link = feed(model);
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
    const link = feed(model);
    expect(model.frozenChords).toContain(link.id);
    expect(link.path!.segments).toHaveLength(1);
    expect(isDiagonal(link.path!.segments[0]!)).toBe(false);
    const g3 = score(model).snapshot.gates.G3!;
    expect(g3.violations.map(item => item.elements)).toEqual([['label:group:w-site-b#0', link.id]]);
  }, 120000);
});

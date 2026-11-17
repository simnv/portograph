import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { BOX_WRITERS } from '../../src/layout/box-writers.js';
import { moveTrace } from '../../src/layout/skeleton-geometry.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 33: every mover after the chord freeze of 7f goes through the one judge of a move after the freeze (`blockMoveRefusal`),
// or states in the box writer table (`afterFreeze`) why a required move cannot be refused and what its last resort is. The movers are found,
// not listed: the test runs sheets with solid and flat blocks, records every `moveGroup` after the freeze, and reads on the call stack whether
// a judge is on its path. The judges are found too: each top-level function of `src/` that calls `blockMoveRefusal`.
// Coverage evidence, not a proof (33 review 1): it sees `moveGroup` only, on four sheets, and a judge on the stack does not show that the
// judge's before and after readings enclose the move. A new unjudged `moveGroup` writer after the freeze on these sheets fails it.
const root = fileURLToPath(new URL('../..', import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir).sort().flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
});

/** The top-level functions of `src/` that call `blockMoveRefusal`, read as the box writer lint reads its call sites. */
function judges(): Set<string> {
  const found = new Set<string>();
  for (const file of walk(join(root, 'src'))) {
    let fn = '';
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const head = /^(?:export )?(?:async )?function\*? ?(\w+)/.exec(line) ?? /^(?:export )?const (\w+)\s*(?::[^=]*)?=/.exec(line);
      if (head) fn = head[1]!;
      if (/\bblockMoveRefusal\(/.test(line) && !/function blockMoveRefusal\(/.test(line)) found.add(fn);
    }
  }
  return found;
}

const SHEETS = [
  'goldens/synthetic/a-centring-step-after-the-freeze-keeps-a-solid-block-on-its-angle.yaml',
  'goldens/synthetic/a-flat-block-member-pushed-past-its-box-falls-back.yaml',
  'goldens/synthetic/a-two-by-seven-block-past-the-cap-stays-straight.yaml',
  'test/fixtures/staged/two-cores-reach-seven-pairs-through-hubs-on-the-last-rank.yaml',
];

describe('every mover after the chord freeze is judged or states its last resort (dense-16x9 ticket 33)', () => {
  it('finds no unjudged writer after the freeze that the box writer table does not explain', async () => {
    const judged = judges(), writers = new Set(BOX_WRITERS.map(writer => writer.fn));
    expect([...judged]).toEqual(expect.arrayContaining(['judgedMove', 'centreGroupStepChecked']));
    const limit = Error.stackTraceLimit, seen = new Map<string, boolean>();
    Error.stackTraceLimit = Infinity;
    moveTrace.hook = (model, _group, dx, dy) => {
      if (model.frozenChords === undefined || !model.blockReservations?.length || dx === 0 && dy === 0) return;
      const frames = (new Error().stack ?? '').split('\n').slice(2).map(line => /at (?:\S+\.)?(\w+) \(/.exec(line)?.[1]).filter((name): name is string => name !== undefined);
      const writer = frames.find(name => writers.has(name)) ?? frames[0] ?? '(unknown)';
      seen.set(writer, (seen.get(writer) ?? false) || !frames.some(name => judged.has(name)));
    };
    try {
      for (const sheet of SHEETS) await layout(parse(readFileSync(join(root, sheet), 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    } finally {
      delete moveTrace.hook;
      Error.stackTraceLimit = limit;
    }
    expect(seen.size, 'the sheets move boxes after the freeze').toBeGreaterThan(0);
    const unjudged = [...seen].filter(([, open]) => open).map(([writer]) => writer);
    const unexplained = unjudged.filter(writer => !BOX_WRITERS.some(entry => entry.fn === writer && entry.afterFreeze !== undefined));
    expect(unexplained, 'a writer after the freeze with no judge on its path and no afterFreeze entry').toEqual([]);
  }, 600000);
});

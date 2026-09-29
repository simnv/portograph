import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, render, serializeLayoutSnapshot } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = readFileSync(new URL('../../goldens/synthetic/a-canton-group-frames-two-tiers.yaml', import.meta.url), 'utf8');
const plain = fixture.replace(/^#.*\n/gm, '').replace(/^ {2}west:.*\n/m, '').replace(/, canton: west/g, '');
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };

describe('the layout ignores canton until ticket 54 (canton-groups ticket 1)', () => {
  it('a document with a canton lays out and renders as the same document without it', async () => {
    expect(plain).not.toContain('canton');
    const withCanton = await layout(parse(fixture), options);
    const without = await layout(parse(plain), options);
    expect(withCanton.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    expect(serializeLayoutSnapshot(withCanton)).toBe(serializeLayoutSnapshot(without));
    expect(render(withCanton)).toBe(render(without));
  }, 60000);
});

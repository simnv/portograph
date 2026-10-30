import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Rect } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import { GROUP_LABEL_GEOMETRY, titleRoom } from '../../src/layout/title-room.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const yaml = readFileSync(new URL('../../goldens/synthetic/a-group-is-as-wide-as-its-title-before-its-lanes.yaml', import.meta.url), 'utf8');
const right = (box: Rect): number => box.x + box.width;

describe('a group is as wide as its title before its lanes (snack-theme ticket 157)', () => {
  it('reserves the title width in sizing, so 7f refuses no widening and the title stands inside its insets', async () => {
    const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    const relay = model.groups.relay!.bounds!, label = model.labels.find(item => item.id === 'label:group:relay')!.bounds!;
    const inset = GROUP_LABEL_GEOMETRY.horizontalInset;
    // The premise: lanes pass the tier of `relay`, and its title is wider than its two nodes and their padding.
    const lanes = model.lanes.filter(lane => lane.tier === model.groups.relay!.tier);
    expect(lanes.length).toBeGreaterThan(0);
    const nodes = model.groups.relay!.nodes.map(id => model.nodes[id]!.bounds!);
    expect(titleRoom(model.document.groups.relay!.label)).toBeGreaterThan(Math.max(...nodes.map(right)) - Math.min(...nodes.map(box => box.x)) + 40);
    // The rule: the box holds the title and both insets, and every lane stands beside that box.
    expect(relay.width).toBeGreaterThanOrEqual(titleRoom(model.document.groups.relay!.label) - 1e-6);
    for (const lane of lanes) expect(lane.bounds.x >= right(relay) - 1e-6 || right(lane.bounds) <= relay.x + 1e-6, lane.id).toBe(true);
    expect(model.diagnostics.filter(item => item.code === 'GROUP_LABEL_GAP_INFEASIBLE')).toEqual([]);
    expect(label.x).toBeGreaterThanOrEqual(relay.x + inset - 1e-6);
    expect(right(label)).toBeLessThanOrEqual(right(relay) - inset + 1e-6);
  }, 60000);
});

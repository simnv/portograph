import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('elkjs 0.12 option effects', () => {
  it('proves metadata, partitioning, minimum/port sizing, semiInteractive ordering and ROOT shape/edge offsets', () => {
    const output = execFileSync(process.execPath, ['scripts/elk-options.cjs'], { encoding: 'utf8' });
    const observations = JSON.parse(output);
    expect(observations.elkjs).toBe('0.12.0');
    expect(observations.nodeSize.minimumAndPorts[0]).toBeGreaterThan(observations.nodeSize.minimumOnly[0]);
    expect(observations.semiInteractive.on).toEqual(['b', 'c', 'a']);
    expect(observations.edgeCoords.root).not.toEqual(observations.edgeCoords.container);
  });
});

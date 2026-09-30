import { readFileSync } from 'node:fs';

/**
 * The M1 golden with its two provider links authored `route: orthogonal`. Q108 (ranked-groups ticket 100) gives them their chord through the title band, so
 * the golden itself has no remainder for stage 8. The tests of the plan and the route for those two links read them on this variant; the golden takes
 * the chords (`test/pipeline/golden-snapshot.test.ts`).
 */
export function goldenWithRemainders(): string {
  const yaml = readFileSync(new URL('../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8');
  const bent = yaml.replace('- [provider-1.100G, EAC-01.*]', '- [provider-1.100G, EAC-01.*, { route: orthogonal }]')
    .replace('- [provider-2.100G, EAC-02.*]', '- [provider-2.100G, EAC-02.*, { route: orthogonal }]');
  if (bent === yaml) throw new Error('goldenWithRemainders changed nothing: the golden text moved');
  return bent;
}

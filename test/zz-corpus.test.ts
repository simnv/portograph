import { readFileSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { it } from 'vitest';
import { layout, parse, score } from '../src/index.js';
import { createAttempt } from './layout/phase-two-fixture.js';
import { createAvoidAttempt } from './route/fixture.js';

const out = process.env.CORPUS_OUT!;
it('corpus', async () => {
  const files = execSync('find goldens -name "*.yaml"').toString().trim().split('\n').sort();
  for (const f of files) {
    try {
      const m: any = await layout(parse(readFileSync(f, 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
      const s: any = score(m).snapshot;
      const failing = Object.keys(s.gates).filter(k => s.gates[k].violations?.length).join(',') || '-';
      const routed = m.links.filter((l: any) => l.family === 'routed' && !l.removed);
      const straight = routed.filter((l: any) => l.path?.segments?.length === 1).length;
      const fb = m.diagnostics.filter((d: any) => d.code === 'FAN_BRANCH_THROUGH_GROUP').length;
      const ov = m.links.filter((l: any) => l.family === 'overlay' && l.technique !== 'mesh-bus' && !l.removed);
      const obent = ov.filter((l: any) => (l.path?.segments?.length ?? 1) > 1).length;
      const bends = m.links.filter((l: any) => !l.removed && l.technique !== 'mesh-bus').reduce((a: number, l: any) => a + Math.max(0, (l.path?.segments?.length ?? 1) - 1), 0);
      const side = m.diagnostics.filter((d: any) => d.code === 'SIDE_HINT_TAKEN').length;
      const edge = m.diagnostics.filter((d: any) => d.code === 'STRAIGHT_LINK_EDGE').length;
      appendFileSync(out, `${f}\tQ=${s.Q.toFixed(4)}\tX=${s.metrics.crossings.count}\tW=${Math.round(m.canvas.width)}x${Math.round(m.canvas.height)}\tgates=${failing}\trouted=${straight}/${routed.length}\tfb=${fb}\tedge=${edge}\tob=${obent}/${ov.length}\tbends=${bends}\tside=${side}\tremoved=${(m.removedLinks ?? []).length}\n`);
    } catch (e) { appendFileSync(out, `${f}\tERROR ${(e as Error).message.slice(0, 80)}\n`); }
  }
}, 6000000);

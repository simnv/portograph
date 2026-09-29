import { readFileSync } from 'node:fs';
import { it } from 'vitest';
import { allocateGapRuns, bands, bars, bundles, centre, flanks, lanes, rows } from '../src/index.js';
import { tierGapPlans } from '../src/layout/gap-plan.js';
import { placed } from './layout/phase-two-fixture.js';

for (const name of (process.env.FIX ?? '').split(',').filter(Boolean)) {
  it(name, async () => {
    const path = name.startsWith('m1') ? `../goldens/${name}` : `../goldens/synthetic/${name}.yaml`;
    const text = readFileSync(new URL(path, import.meta.url), 'utf8');
    const model = bands(bundles(bars(centre(flanks(lanes(rows(await placed(text))))))));
    console.log('F ' + name + ' GROWN ' + model.diagnostics.filter(d => d.code === 'TIER_GAP_GROWN').map(d => d.message).join(' | '));
    for (const { gap, plan } of tierGapPlans(model)) {
      if (!plan.parts.length && !plan.residual.length) continue;
      console.log(`F   GAP ${gap.above}-${gap.below} low ${gap.low} high ${gap.high} H ${plan.height} order ${plan.order.join(' ')} res ${plan.residual.map(r => r.id + ':' + r.reason).join(',')}`);
      console.log('F   EDGES ' + plan.edges.map(e => `${e.above}>${e.below}:${e.kind}`).join(' '));
      console.log('F   CROSS ' + plan.crossings.map(c => `${c.run}x${c.vertical}:${c.kind}`).join(' '));
      for (const p of plan.parts) console.log(`F     ${p.id} ${p.shape} rows ${p.rows.map(r => r.toFixed(2)).join('/')} mid ${p.middle ?? ''} ${p.upper.x.toFixed(1)}@${p.upper.y.toFixed(1)}${p.upper.kind[0]} > ${p.lower.x.toFixed(1)}@${p.lower.y.toFixed(1)}${p.lower.kind[0]}`);
    }
    if (process.env.RUNS) for (const run of allocateGapRuns(model)) console.log(`F   RUN ${run.link}#${run.index} ${run.planned ? 'P' : 'R'} cross=${run.crossers.join('|')} grants=${(run.grants ?? []).join('|')} ${run.segments.map(s => `${s.from.x.toFixed(1)},${s.from.y.toFixed(1)}>${s.to.x.toFixed(1)},${s.to.y.toFixed(1)}`).join(' ')}`);
  }, 120000);
}

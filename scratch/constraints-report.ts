// npx vite-node scratch/constraints-report.ts [sheet.yaml ...]
// Per sheet: catalogue size, counts by kind and class, soft residual totals, and every finding.
// Default sheets: goldens/m1-sip-edge.yaml, every goldens/synthetic/*.yaml, /tmp/ntp-diag/ntp-signal.yaml.
// CONSTRAINTS_FINDINGS=1 prints each finding; CONSTRAINTS_ONLY=<substring> filters the default list.
import { readdirSync, readFileSync } from 'node:fs';
import { layout, parse } from '../src/index.js';
import { evaluate, summarise, xCatalogue } from '../src/layout/constraints/index.js';
import { createAttempt } from '../test/layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../test/route/fixture.js';
import { CONSTRAINT_SHEETS } from '../test/layout/constraints-sheets.js';

// Default: the curated sheets of the test. CONSTRAINTS_ALL=1 sweeps every synthetic golden (CPU heavy: run it alone).
const synthetic = process.env.CONSTRAINTS_ALL
  ? readdirSync('goldens/synthetic').filter(name => name.endsWith('.yaml')).sort().map(name => `goldens/synthetic/${name}`)
  : CONSTRAINT_SHEETS.map(name => `goldens/synthetic/${name}.yaml`);
const only = process.env.CONSTRAINTS_ONLY;
const defaults = ['goldens/m1-sip-edge.yaml', ...synthetic, '/tmp/ntp-diag/ntp-signal.yaml'].filter(file => only === undefined || file.includes(only));
const files = process.argv.length > 2 ? process.argv.slice(2) : defaults;
const totals: Record<string, number> = {};

for (const file of files) {
  const name = file.split('/').pop()!.replace('.yaml', '');
  try {
    const model = await layout(parse(readFileSync(file, 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    const catalogue = xCatalogue(model);
    const residuals = evaluate(model, catalogue);
    const summary = summarise(residuals);
    const kinds = Object.entries(summary.byKind).map(([kind, row]) => `${kind}[${Object.entries(row).map(([label, n]) => `${label}:${n}`).join(' ')}]`).join(' ');
    const soft = Object.entries(summary.soft).map(([kind, s]) => `${kind} ${s.straight}/${s.entries} straight, ${s.total.toFixed(1)} px`).join('; ');
    console.log(`${name}: ${catalogue.length} entries | ${kinds} | soft: ${soft || '-'}`);
    for (const item of residuals) {
      if (item.class === undefined || (item.class === 'unsupported' && item.residual === undefined)) {
        if (item.class === 'unsupported') totals['unsupported'] = (totals['unsupported'] ?? 0) + 1;
        continue;
      }
      totals[item.class] = (totals[item.class] ?? 0) + 1;
      if (process.env.CONSTRAINTS_FINDINGS) console.log(`  ${item.class} ${item.constraint.kind} ${item.constraint.owners.join(' | ')} residual ${item.residual?.toFixed(2)} px (${item.constraint.source})`);
    }
  } catch (error) {
    console.log(`${name}: layout failed: ${(error as Error).message}`);
  }
}
console.log('TOTAL findings by class', JSON.stringify(totals));

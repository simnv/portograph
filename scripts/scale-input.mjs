/**
 * Deterministic scale inputs for the full-pipeline benchmark (ticket 17).
 *
 * The shape is chosen to exercise the parts of the pipeline that cost, not just node count:
 *
 * - a **hub** in the middle tier with many ports, so sides, pitch, bundling and port ordering all
 *   have real work to do;
 * - a **wide tier**, so row packing, centring and the group box have a long row to repack;
 * - **long transit links** that skip at least one tier, so stage 7a really allocates lanes and
 *   stage 8 really has a remainder to route around them;
 * - optional same-pair multiplicity, so bundles form beside the fan. The default isolates large
 *   remainder demand; `multiplicity: 3` is also covered by the bundle integration regressions.
 *
 * Every count is derived from `nodes`, and no randomness is used: the same `nodes` always produces
 * the same YAML, so a benchmark result is reproducible and a failure is investigable.
 *
 * It is plain JavaScript with a sibling `.d.mts`, because both the benchmark script and the
 * TypeScript tests import it.
 */

const pad = (index, total) => String(index).padStart(String(total - 1).length, '0');

/**
 * Two shapes:
 *
 * - `hub` (default) is the one ticket 17 names: a hub tier, a wide tier and long transits.
 * - `chain` distributes links cyclically between neighbouring tiers. It is an additional shape,
 *   not a substitute for the required hub workload; unequal tier sizes still create fan incidence.
 *
 * @param {{ nodes: number, degree?: number, transits?: number, multiplicity?: number,
 *           shape?: 'hub' | 'chain' }} options
 * @returns {{ yaml: string, nodes: number, links: number, tiers: number, shape: string }}
 */
export function generateScaleYaml(options) {
  const total = options.nodes;
  if (!Number.isInteger(total) || total < 12) throw new Error('A scale input needs at least 12 nodes');
  // Degree stays under the 64 the parse budget names. The port count per hub does cross the 20 that
  // budget names, which is deliberate: at scale the tool warns and continues, and the benchmark
  // measures that path rather than an artificially small one.
  const degree = options.degree ?? 24;
  const transits = options.transits ?? Math.max(4, Math.round(total / 25));
  const multiplicity = options.multiplicity ?? 0;
  const shape = options.shape ?? 'hub';
  if (shape !== 'hub' && shape !== 'chain') throw new Error(`Unknown scale shape ${shape}`);

  // Four tiers: a thin source tier, the hub tier, the wide tier, and a sink tier.
  const sources = Math.max(2, Math.round(total * 0.15));
  const hubs = Math.max(1, Math.round(total * 0.05));
  const sinks = Math.max(2, Math.round(total * 0.15));
  const wide = total - sources - hubs - sinks;
  if (wide < 2) throw new Error('A scale input needs a wide tier');

  const name = (prefix, index, count) => `${prefix}${pad(index, count)}`;
  const lines = [
    'portograph: 2',
    'profile: network',
    'groups:',
    '  sources: { tier: 0 }',
    '  hubs: { tier: 1 }',
    '  access: { tier: 2 }',
    '  sinks: { tier: 3 }',
    'nodes:',
  ];
  const nodes = [];
  const add = (id, group, cls) => { nodes.push(id); lines.push(`  ${id}: { group: ${group}, class: ${cls}, ports: [] }`); };
  for (let i = 0; i < sources; i++) add(name('src', i, sources), 'sources', 'router');
  for (let i = 0; i < hubs; i++) add(name('hub', i, hubs), 'hubs', 'rr');
  for (let i = 0; i < wide; i++) add(name('acc', i, wide), 'access', 'switch');
  for (let i = 0; i < sinks; i++) add(name('snk', i, sinks), 'sinks', 'server');

  const links = [];
  const link = (from, to, extra) => links.push(`  - [${from}, ${to}${extra ? `, ${extra}` : ''}]`);
  const hubId = (i) => name('hub', i % hubs, hubs);
  const accId = (i) => name('acc', i % wide, wide);

  if (shape === 'hub') {
    // The hub tier: each hub takes `degree` access nodes, which is where the port and bundle work is.
    for (let i = 0; i < hubs; i++) for (let j = 0; j < degree; j++) link(hubId(i), accId(i * degree + j));
    // Same-pair multiplicity, so real bundles form beside the fan. Off by default; the integration regression enables it.
    for (let i = 0; i < hubs; i++) for (let j = 0; j < multiplicity; j++) link(hubId(i), accId(i * degree), '{ class: dotted }');
    // Sources feed the hubs; each access node feeds a sink.
    for (let i = 0; i < sources; i++) link(name('src', i, sources), hubId(i));
    for (let i = 0; i < wide; i++) link(name('acc', i, wide), name('snk', i % sinks, sinks));
  } else {
    // Cyclic distribution between neighbouring tiers; smaller tiers still collect fans.
    for (let i = 0; i < hubs; i++) link(name('src', i % sources, sources), hubId(i));
    for (let i = 0; i < wide; i++) link(hubId(i), accId(i));
    for (let i = 0; i < wide; i++) link(accId(i), name('snk', i % sinks, sinks));
  }
  // Long transits: tier 0 straight to tier 3, skipping two tiers, which is what reserves lanes.
  for (let i = 0; i < transits; i++) link(name('src', i % sources, sources), name('snk', i % sinks, sinks), '{ class: transit }');

  lines.push('links:', ...links);
  return { yaml: `${lines.join('\n')}\n`, nodes: total, links: links.length, tiers: 4, shape };
}

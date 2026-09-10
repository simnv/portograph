import ELK from 'elkjs/lib/elk.bundled.js';
function synth(N, G, E, seed = 1, opts = {}) {
  let s = seed; const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const groups = Array.from({ length: G }, (_, i) => ({ id: `g${i}`, tier: i % 4, children: [], layoutOptions: { 'elk.partitioning.partition': String(i % 4), 'elk.padding': '[top=24,left=10,bottom=10,right=10]' } }));
  const nodes = [];
  for (let i = 0; i < N; i++) {
    const g = groups[i % G];
    const n = { id: `n${i}`, width: 80, height: 40, group: g, ports: [{ id: `n${i}.a`, width: 10, height: 10 }, { id: `n${i}.b`, width: 10, height: 10 }], layoutOptions: { 'elk.portConstraints': 'FREE' } };
    g.children.push(n); nodes.push(n);
  }
  const edges = []; let k = 0;
  while (edges.length < E) {
    const a = nodes[Math.floor(rnd() * N)]; let b;
    if (rnd() < 0.8) { const c = a.group.children; b = c[Math.floor(rnd() * c.length)]; }
    else b = nodes[Math.floor(rnd() * N)];
    if (a === b) continue;
    const [s_, t_] = a.group.tier <= b.group.tier ? [a, b] : [b, a];
    edges.push({ id: `e${k++}`, sources: [s_.ports[rnd() < .5 ? 0 : 1].id], targets: [t_.ports[rnd() < .5 ? 0 : 1].id] });
  }
  for (const n of nodes) delete n.group;
  const lo = { 'elk.algorithm': 'layered', 'elk.direction': 'DOWN', 'elk.edgeRouting': 'ORTHOGONAL', 'elk.layered.thoroughness': '7', 'elk.separateConnectedComponents': 'false' };
  if (opts.hier) lo['elk.hierarchyHandling'] = 'INCLUDE_CHILDREN';
  if (opts.part) lo['elk.partitioning.activate'] = 'true';
  if (!opts.part) for (const g of groups) delete g.layoutOptions['elk.partitioning.partition'];
  if (!opts.hier) { for (const n of nodes) if (opts.part) n.layoutOptions['elk.partitioning.partition'] = String(groups[+n.id.slice(1) % G].tier); return { id: 'root', layoutOptions: lo, children: nodes, edges }; }
  return { id: 'root', layoutOptions: lo, children: groups, edges };
}
const elk = new ELK();
const cfg = process.argv[2] || 'hier+part';
const opts = { hier: cfg.includes('hier'), part: cfg.includes('part') };
for (const [N, G, E] of [[100, 4, 300], [1000, 40, 3000]]) {
  const g = synth(N, G, E, 1, opts);
  const t0 = performance.now();
  try { const out = await elk.layout(g); console.log(`[${cfg}] N=${N} G=${G} E=${E}: ${(performance.now() - t0).toFixed(0)} ms, size ${Math.round(out.width)}x${Math.round(out.height)}`); }
  catch (err) { console.log(`[${cfg}] N=${N} G=${G} E=${E}: FAILED after ${(performance.now() - t0).toFixed(0)} ms: ${String(err).slice(0, 200)}`); }
}

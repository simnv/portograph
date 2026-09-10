import type { Bundle, LayoutModel, LayoutPort } from '../model/index.js';
import { axis, coordinate, members } from './bundle-geometry.js';
import { portId } from './skeleton-graph.js';

export interface BundleOrderResult { inversions: number; proved: boolean; examined: number; orders: [LayoutPort[], LayoutPort[]] }
/** Bounded exact enumeration for shared incidence. The result states whether the search completed. */
export function optimizeBundleOrder(model: LayoutModel, bundle: Bundle, limit = 4096): BundleOrderResult {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Bundle order search needs a positive integer budget');
  const list = members(model, bundle);
  const ports = (['a', 'b'] as const).map(end => [...new Set(list.map(m => m[end]))].sort((a, b) => coordinate(a) - coordinate(b))) as [LayoutPort[], LayoutPort[]];
  const count = (a: LayoutPort[], b: LayoutPort[]): number => {
    let result = 0;
    for (let i = 0; i < list.length; i++) for (const other of list.slice(i + 1)) {
      const item = list[i]!;
      if ((a.indexOf(item.a) - a.indexOf(other.a)) * (b.indexOf(item.b) - b.indexOf(other.b)) < 0) result++;
    }
    return result;
  };
  let best = count(...ports), orders: [LayoutPort[], LayoutPort[]] = ports, examined = 0, stopped = false;
  function* permutations(items: LayoutPort[], prefix: LayoutPort[] = []): Generator<LayoutPort[]> {
    if (!items.length) { yield prefix; return; }
    for (const item of items) {
      if (item.authorOrder !== undefined && items.some(other => other.authorOrder !== undefined && other.authorOrder < item.authorOrder!)) continue;
      yield* permutations(items.filter(p => p !== item), [...prefix, item]);
    }
  }
  outer: for (const a of permutations(ports[0])) for (const b of permutations(ports[1])) {
    if (examined >= limit) { stopped = true; break outer; }
    examined++;
    const inversions = count(a, b);
    if (inversions < best) { best = inversions; orders = [a, b]; }
    if (best === 0) break outer; // Zero is the universal lower bound.
  }
  return { inversions: best, proved: best === 0 || !stopped, examined, orders };
}
export function applyBundleOrder(model: LayoutModel, bundle: Bundle): void {
  const list = members(model, bundle);
  if ((['a', 'b'] as const).every(end => new Set(list.map(m => portId(m[end].ref))).size === list.length)) return;
  const result = optimizeBundleOrder(model, bundle);
  for (const order of result.orders) {
    if (new Set(order.map(p => p.side)).size !== 1) continue;
    const node = model.nodes[order[0]!.ref.node]!, side = order[0]!.side;
    const all = node.ports.filter(p => p.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
    const slots = all.filter(p => order.includes(p)).map(p => p.engineOrder!);
    const proposed = [...all]; order.forEach((p, i) => { proposed[slots[i]!] = p; });
    const authored = proposed.filter(p => p.authorOrder !== undefined);
    if (authored.some((p, i) => i > 0 && p.authorOrder! < authored[i - 1]!.authorOrder!)) continue;
    const coords = all.map(coordinate);
    proposed.forEach((p, i) => { p.engineOrder = i; p.anchor![axis(p.side!)] = coords[i]!; });
  }
  if (!result.proved && !model.diagnostics.some(d => d.code === 'BUNDLE_ORDER_OPTIMIZATION_LIMIT' && d.owners?.some(o => o.kind === 'bundle' && o.id === bundle.id))) {
    model.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'BUNDLE_ORDER_OPTIMIZATION_LIMIT', owners: [bundle.owner],
      message: `${bundle.id}: examined ${result.examined} admissible endpoint orders; retained ${result.inversions} strict inversions without a proof of optimality.` });
  }
}

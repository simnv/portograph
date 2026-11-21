/**
 * The order of a list of items under "a goes before b" edges, as stage 7a reserves its transit lanes (field-2026-11 ticket 05).
 * Items are indices into a base order. The edges can hold cycles, so the order is read on the strongly connected components:
 * the items inside a component keep the base order, and a component moves only as early as an edge needs (pull forward):
 * the components go in the base order of their first item, and each one first places the components it waits on, in the same
 * order, then its own items. With no edge against the base order, the result is the base order.
 *
 * Both walks use explicit stacks, so the depth of the graph is no limit (R4: a finite traversal needs no cap). Each keeps the visit
 * order of the recursive form it replaces.
 */
export function pullForwardOrder(after: readonly (readonly number[])[]): number[] {
  const count = after.length;
  // Tarjan's strongly connected components, iterative. `cursor[at]` is the next edge of `at` to visit.
  const component = new Array<number>(count).fill(-1), seen = new Array<number>(count).fill(-1), low = new Array<number>(count).fill(0);
  const cursor = new Array<number>(count).fill(0), stack: number[] = [], members: number[][] = [];
  let clock = 0;
  for (let root = 0; root < count; root++) {
    if (seen[root] !== -1) continue;
    const path: number[] = [root];
    seen[root] = low[root] = clock++;
    stack.push(root);
    while (path.length) {
      const at = path.at(-1)!, edges = after[at]!;
      if (cursor[at]! < edges.length) {
        const next = edges[cursor[at]!++]!;
        if (seen[next] === -1) { seen[next] = low[next] = clock++; stack.push(next); path.push(next); }
        else if (component[next] === -1) low[at] = Math.min(low[at]!, seen[next]!);
        continue;
      }
      path.pop();
      const parent = path.at(-1);
      if (parent !== undefined) low[parent] = Math.min(low[parent]!, low[at]!);
      if (low[at] !== seen[at]) continue;
      const part: number[] = [];
      for (let top = stack.pop()!; ; top = stack.pop()!) { component[top] = members.length; part.push(top); if (top === at) break; }
      members.push(part.sort((a, b) => a - b));
    }
  }
  // The components each component waits on, in base order of their first items.
  const waits = members.map(() => new Set<number>());
  for (const [at, edges] of after.entries()) for (const next of edges) if (component[next] !== component[at]) waits[component[next]!]!.add(component[at]!);
  const first = (id: number): number => members[id]![0]!;
  const prior = waits.map(set => [...set].sort((a, b) => first(a) - first(b)));
  // Pull forward, iterative: a component is marked when entered, places its prior components in order, then its own items.
  const order: number[] = [], placed = new Array<boolean>(members.length).fill(false), next = new Array<number>(members.length).fill(0);
  for (const root of members.map((_, id) => id).sort((a, b) => first(a) - first(b))) {
    if (placed[root]) continue;
    placed[root] = true;
    const path = [root];
    while (path.length) {
      const id = path.at(-1)!;
      if (next[id]! < prior[id]!.length) {
        const wait = prior[id]![next[id]!++]!;
        if (!placed[wait]) { placed[wait] = true; path.push(wait); }
        continue;
      }
      path.pop();
      order.push(...members[id]!);
    }
  }
  return order;
}

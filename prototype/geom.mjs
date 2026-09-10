// Shared: absolute positions for nodes/ports, absolute polylines for edges.
export function absolutize(g) {
  const nodes = new Map(); // id -> {id,x,y,w,h,depth,parent,label,isLoc}
  const ports = new Map(); // id -> {id,x,y,w,h,node,label}
  const abs = { root: { x: 0, y: 0 } };
  (function walk(n, ox, oy, depth, parent) {
    for (const c of n.children || []) {
      const x = ox + c.x, y = oy + c.y;
      abs[c.id] = { x, y };
      nodes.set(c.id, { id: c.id, x, y, w: c.width, h: c.height, depth, parent, label: c.labels?.[0]?.text, isLoc: !!(c.children?.length), bar: !!c.bar });
      for (const p of c.ports || []) {
        const px = x + p.x, py = y + p.y;
        // derive side by position relative to node
        const cx = px + p.width / 2, cy = py + p.height / 2;
        let side = 'UNK';
        if (cy <= y + 1) side = 'NORTH'; else if (cy >= y + c.height - 1) side = 'SOUTH'; else if (cx <= x + 1) side = 'WEST'; else if (cx >= x + c.width - 1) side = 'EAST';
        ports.set(p.id, { id: p.id, x: px, y: py, w: p.width, h: p.height, node: c.id, label: p.labels?.[0]?.text, side });
      }
      walk(c, x, y, depth + 1, c.id);
    }
  })(g, 0, 0, 0, 'root');
  const edges = [];
  const collect = (n) => {
    for (const e of n.edges || []) {
      const o = abs[e.container || n.id] || { x: 0, y: 0 };
      const pts = [];
      for (const s of e.sections || []) {
        pts.push({ x: o.x + s.startPoint.x, y: o.y + s.startPoint.y });
        for (const b of s.bendPoints || []) pts.push({ x: o.x + b.x, y: o.y + b.y });
        pts.push({ x: o.x + s.endPoint.x, y: o.y + s.endPoint.y });
      }
      edges.push({ id: e.id, cls: e.cls || '', src: e.sources[0], tgt: e.targets[0], pts, bends: (e.sections || []).reduce((a, s) => a + (s.bendPoints?.length || 0), 0) });
    }
    for (const c of n.children || []) collect(c);
  };
  collect(g);
  return { nodes, ports, edges, width: g.width, height: g.height };
}

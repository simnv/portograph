import fs from 'node:fs';
import { absolutize } from './geom.mjs';
const V = process.argv[2];
const g = JSON.parse(fs.readFileSync(`/tmp/elk-proto/out-${V}.json`, 'utf8'));
const { nodes, ports, edges, width, height } = absolutize(g);
const fill = id => /^EAC|^EBR|^EBB/.test(id) ? '#d64545' : /^TBR/.test(id) ? '#7cb342' : /^RR/.test(id) ? '#f9a825' : /^provider/.test(id) ? '#e0e0e0' : 'none';
let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${width + 20}" height="${height + 20}" viewBox="-10 -10 ${width + 20} ${height + 20}" font-family="Helvetica,Arial" font-size="11">
<rect x="-10" y="-10" width="100%" height="100%" fill="#f4f4f6"/>`;
if (g._groups) for (const [id, grp] of Object.entries(g._groups)) {
  const ms = grp.members.map(m => nodes.get(m)); const P = 14;
  const b = g._groupBoxes?.[id];
  const x0 = b ? b.x0 : Math.min(...ms.map(m => m.x)) - P, y0 = b ? b.y0 : Math.min(...ms.map(m => m.y)) - P - 14, x1 = b ? b.x1 : Math.max(...ms.map(m => m.x + m.w)) + P, y1 = b ? b.y1 : Math.max(...ms.map(m => m.y + m.h)) + P;
  s += `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="rgba(255,255,255,0.5)" stroke="#888" stroke-dasharray="6,4" rx="8"/>`;
  const l = g._labels?.[id];
  s += l ? `<text x="${l.x + l.w / 2}" y="${l.y + l.h - 3}" text-anchor="middle" font-size="12" fill="#333">${grp.label}</text>` : `<text x="${x0 + 8}" y="${y0 + 14}" font-size="12" fill="#333">${grp.label}</text>`;
}
for (const n of nodes.values()) {
  if (n.isLoc) s += `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" fill="rgba(255,255,255,0.5)" stroke="#888" stroke-dasharray="6,4" rx="8"/><text x="${n.x + 8}" y="${n.y + 16}" font-size="12" fill="#333">${n.label}</text>`;
  else s += `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" fill="${fill(n.id)}" stroke="#333" rx="4"/><text x="${n.x + n.w / 2}" y="${n.y + n.h / 2 + 4}" text-anchor="middle" font-weight="bold" fill="#000">${n.id}</text>`;
}
for (const p of ports.values()) s += `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" fill="#d1c4e9" stroke="#9575cd"/><text x="${p.x + p.w / 2}" y="${p.y + p.h - 3}" text-anchor="middle" font-size="8" fill="#333">${p.label}</text>`;
for (const e of edges) s += `<polyline points="${e.pts.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${e.cls === 'link-dashed' ? '#757575' : '#222'}" stroke-width="1.2" ${e.cls === 'link-dashed' ? 'stroke-dasharray="4,4"' : ''}/>`;
s += '</svg>';
fs.writeFileSync(`/tmp/elk-proto/out-${V}.svg`, s);
fs.writeFileSync(`/tmp/elk-proto/out-${V}.html`, `<!doctype html><html><body style="margin:0;background:#fff"><img src="out-${V}.svg" style="max-width:1980px;max-height:1380px"></body></html>`);
console.log(`rendered out-${V}.svg (${edges.length} edges, ${nodes.size} nodes)`);

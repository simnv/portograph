import { createLayoutModel } from '../../src/model/index.js';
import type { Layer, LayoutLabel, LayoutModel, Point, Rect, Route, Side } from '../../src/model/index.js';

export interface BenchNode { id: string; bounds: Rect }
export interface BenchLink {
  id: string;
  from: string;
  to: string;
  points: Point[];
  label?: string;
  sides?: [Side, Side];
  layer?: Layer;
  technique?: Route;
}

const right = (box: Rect): number => box.x + box.width;
const bottom = (box: Rect): number => box.y + box.height;

/**
 * A minimal stage-9 entry model: one row group holding every node, one tier band and explicit final
 * paths. It installs geometry the way `goldens/README.md` describes a stage precondition, so a
 * ladder branch can be forced exactly. It is not a whole-diagram layout snapshot.
 */
export function bench(nodes: BenchNode[], links: BenchLink[], labels: LayoutLabel[] = []): LayoutModel {
  const model = createLayoutModel({ portograph: 2, profile: 'network', groups: {}, nodes: {}, links: [] });
  model.document.groups['row-group'] = { label: 'row-group', shape: 'row', tier: 0 };
  model.groups['row-group'] = { id: 'row-group', owner: { kind: 'group', id: 'row-group' }, layer: 'routed',
    nodes: nodes.map(item => item.id), tier: 0, rowOrder: nodes.map(item => item.id) };
  for (const item of nodes) {
    model.document.nodes[item.id] = { group: 'row-group', label: item.id, ports: [] };
    model.nodes[item.id] = { id: item.id, owner: { kind: 'node', id: item.id }, layer: 'routed',
      ports: [], bounds: { ...item.bounds }, size: { width: item.bounds.width, height: item.bounds.height } };
  }
  for (const item of links) {
    const sides = item.sides ?? (['bottom', 'top'] as [Side, Side]);
    const refs = [item.from, item.to].map((name, index) => {
      const node = model.nodes[name]!, ref = { node: name, name: item.id, ordinal: node.ports.length + 1 };
      node.ports.push({ ref, side: sides[index]!, owner: { kind: 'node', id: name }, layer: 'routed',
        anchor: { ...(index === 0 ? item.points[0]! : item.points.at(-1)!) } });
      model.document.nodes[name]!.ports.push({ name: item.id, ordinal: ref.ordinal, side: sides[index]! });
      return ref;
    });
    const owner = { kind: 'link' as const, id: item.id }, layer = item.layer ?? 'routed';
    model.document.links.push({ from: refs[0]!, to: refs[1]!, ...(item.label === undefined ? {} : { label: item.label }) });
    model.links.push({ id: item.id, sourceIndex: model.links.length, owner, from: refs[0]!, to: refs[1]!,
      family: layer, layer, technique: item.technique ?? (layer === 'overlay' ? 'overlay' : 'orthogonal'),
      attachments: { from: refs[0]!, to: refs[1]! },
      path: { owner, layer, fixed: true, segments: item.points.slice(1).map((to, index) => ({
        from: { ...item.points[index]! }, to: { ...to }, owner })) } });
  }
  model.labels.push(...labels.map(label => ({ ...label })));
  const boxes = nodes.map(item => item.bounds);
  const x = Math.min(...boxes.map(box => box.x)) - 10, y = Math.min(...boxes.map(box => box.y)) - 10;
  const width = Math.max(...boxes.map(right)) + 10 - x, height = Math.max(...boxes.map(bottom)) + 10 - y;
  model.groups['row-group']!.bounds = { x, y, width, height };
  model.tierBands.push({ tier: 0, groups: ['row-group'], bounds: { x, y, width, height } });
  // Wide enough that a candidate is never rejected for leaving the canvas; stage 9 only expands it.
  model.canvas = { x: x - 2000, y: y - 2000, width: width + 4000, height: height + 4000 };
  model.stage = 'route';
  return model;
}

export const nodeLabel = (id: string, bounds: Rect, owner: string): LayoutLabel =>
  ({ id, text: id, role: 'node', owner: { kind: 'node', id: owner }, layer: 'routed', bounds: { ...bounds } });

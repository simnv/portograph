import { createLayoutModel } from '../../src/model/index.js';
import type {
  Bundle, Layer, LayoutLabel, LayoutModel, Point, Rect, Route, Side,
} from '../../src/model/index.js';

export interface SceneNode {
  id: string;
  bounds: Rect;
  class?: string;
  icon?: string;
  iconBounds?: Rect;
  label?: string;
  strokeWidth?: number;
}
export interface ScenePort {
  node: string;
  name: string;
  side: Side;
  anchor: Point;
  /** Named ports get a pill; an anonymous port sets this false and renders nothing. */
  pill?: boolean;
  textRotation?: -90 | 0;
  /** Author tokens of the port: a profile role, a status, or free text. */
  class?: string;
}
export interface SceneLink {
  id: string;
  from: string;
  to: string;
  points: Point[];
  class?: string;
  layer?: Layer;
  technique?: Route;
  label?: string;
  strokeWidth?: number;
  bundle?: string;
}
export interface Scene {
  nodes: SceneNode[];
  ports?: ScenePort[];
  links?: SceneLink[];
  labels?: LayoutLabel[];
  bundles?: Bundle[];
  title?: string;
  css?: string;
  overlays?: Record<string, 'hidden' | 'visible'>;
}

const right = (box: Rect): number => box.x + box.width;
const bottom = (box: Rect): number => box.y + box.height;

/**
 * A hand-built final model for renderer tests: explicit bounds, anchors, pills and paths, exactly as
 * `goldens/README.md` describes a stage precondition. It is not a layout snapshot and claims nothing
 * about placement rules; it exists so one rendering branch can be exercised on its own.
 */
export function scene(input: Scene): LayoutModel {
  const model = createLayoutModel({ portograph: 2, profile: 'network', groups: {}, nodes: {}, links: [] });
  if (input.title !== undefined) model.document.title = input.title;
  if (input.css !== undefined) model.document.css = input.css;
  if (input.overlays !== undefined) model.document.overlays = input.overlays;
  model.document.groups['row-group'] = { label: 'Row group', shape: 'row', tier: 0 };
  model.groups['row-group'] = { id: 'row-group', owner: { kind: 'group', id: 'row-group' }, layer: 'routed',
    nodes: input.nodes.map(node => node.id), tier: 0, rowOrder: input.nodes.map(node => node.id) };
  for (const node of input.nodes) {
    model.document.nodes[node.id] = { group: 'row-group', label: node.label ?? node.id, ports: [],
      ...(node.class === undefined ? {} : { class: node.class }), ...(node.icon === undefined ? {} : { icon: node.icon }) };
    model.nodes[node.id] = { id: node.id, owner: { kind: 'node', id: node.id }, layer: 'routed', ports: [],
      bounds: { ...node.bounds }, size: { width: node.bounds.width, height: node.bounds.height },
      ...(node.strokeWidth === undefined ? {} : { strokeWidth: node.strokeWidth }),
      ...(node.icon && node.iconBounds ? { icon: { icon: node.icon, bounds: { ...node.iconBounds } } } : {}) };
  }
  for (const port of input.ports ?? []) {
    const node = model.nodes[port.node]!;
    const ref = { node: port.node, name: port.name, ordinal: node.ports.filter(item => item.ref.name === port.name).length + 1 };
    const rotation = port.textRotation ?? (port.side === 'top' || port.side === 'bottom' ? -90 : 0);
    const size = { width: 26, height: 10 };
    const width = rotation === -90 ? size.height : size.width, height = rotation === -90 ? size.width : size.height;
    node.ports.push({ ref, side: port.side, owner: { kind: 'node', id: port.node }, layer: 'routed',
      ...(port.class === undefined ? {} : { class: port.class }),
      anchor: { ...port.anchor },
      ...(port.pill === false ? {} : { pill: { owner: { kind: 'node', id: port.node }, layer: 'routed', size,
        bounds: { x: port.anchor.x - width / 2, y: port.anchor.y - height / 2, width, height },
        textRotation: rotation, radius: 3 } }) });
    model.document.nodes[port.node]!.ports.push({ name: port.name, ordinal: ref.ordinal, side: port.side,
      ...(port.class === undefined ? {} : { class: port.class }) });
  }
  for (const link of input.links ?? []) {
    const owner = { kind: 'link' as const, id: link.id }, layer = link.layer ?? 'routed';
    const ends = [link.from, link.to].map((node, index) => {
      const port = model.nodes[node]!.ports.find(item => item.anchor!.x === link.points[index === 0 ? 0 : link.points.length - 1]!.x
        && item.anchor!.y === link.points[index === 0 ? 0 : link.points.length - 1]!.y);
      if (!port) throw new Error(`Scene link ${link.id} has no port at its ${index === 0 ? 'source' : 'target'} point`);
      return port.ref;
    });
    model.document.links.push({ from: ends[0]!, to: ends[1]!,
      ...(link.class === undefined ? {} : { class: link.class }),
      ...(link.label === undefined ? {} : { label: link.label }) });
    model.links.push({ id: link.id, sourceIndex: model.links.length, owner, from: ends[0]!, to: ends[1]!,
      family: layer, layer, technique: link.technique ?? (layer === 'overlay' ? 'overlay' : 'orthogonal'),
      ...(link.bundle === undefined ? {} : { bundle: link.bundle }),
      attachments: { from: ends[0]!, to: ends[1]! },
      path: { owner, layer, fixed: true, ...(link.strokeWidth === undefined ? {} : { strokeWidth: link.strokeWidth }),
        segments: link.points.slice(1).map((to, index) => ({ from: { ...link.points[index]! }, to: { ...to }, owner })) } });
  }
  model.labels.push(...(input.labels ?? []).map(label => ({ ...label })));
  model.bundles.push(...(input.bundles ?? []).map(bundle => ({ ...bundle })));
  const boxes = input.nodes.map(node => node.bounds);
  const x = Math.min(...boxes.map(box => box.x)) - 20, y = Math.min(...boxes.map(box => box.y)) - 20;
  const width = Math.max(...boxes.map(right)) + 20 - x, height = Math.max(...boxes.map(bottom)) + 20 - y;
  model.groups['row-group']!.bounds = { x, y, width, height };
  model.tierBands.push({ tier: 0, groups: ['row-group'], bounds: { x, y, width, height } });
  model.canvas = { x, y, width, height };
  model.stage = 'link-labels';
  return model;
}

export const pillLabel = (node: string, name: string, ordinal: number, bounds: Rect, rotation: -90 | 0): LayoutLabel => ({
  id: `pill:${JSON.stringify({ node, name, ordinal })}`, owner: { kind: 'node', id: node }, layer: 'routed',
  role: 'pill', port: { node, name, ordinal }, text: name, fontFamily: 'Arial, Helvetica, sans-serif',
  fontSize: 8, fontWeight: 400, lineHeight: 10, lines: [name], textRotation: rotation, bounds: { ...bounds },
});

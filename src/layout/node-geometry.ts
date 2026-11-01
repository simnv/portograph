import { placePortPill, portAnchor } from '../geometry/index.js';
import type { LayoutModel, LayoutLabel } from '../model/layout.js';
import { FONT_FAMILY, measurePortPill } from '../text/index.js';
import { measureNodeContent, placeNodeContent } from './size.js';
import { SIDE_TIE_ORDER } from './sides-one.js';
import { PLACEMENT_EPS } from './tolerance.js';

/** Replace final content and pill geometry. Current anchors remain authoritative for region rules. */
export function rebuildNodeGeometry(draft: LayoutModel, nodeIds: readonly string[], anchors: 'from-slots' | 'current'): void {
  const ids = new Set(nodeIds);
  draft.labels = draft.labels.filter(label => !(label.owner.kind === 'node' && ids.has(label.owner.id)
    && (label.role === 'node' || label.role === 'description' || label.role === 'pill')));
  for (const id of nodeIds) {
    const node = draft.nodes[id]!, box = node.bounds!, insets = node.contentInsets!;
    if (!box || !insets) throw new Error(`Missing node geometry for ${id}`);
    const owner = { kind: 'node', id } as const;
    const content = measureNodeContent(draft.document.nodes[id]!, draft.document, insets);
    if (content.width > box.width + PLACEMENT_EPS || content.height > box.height + PLACEMENT_EPS) throw new Error(`Content exceeds node ${id}`);
    delete node.icon;
    for (const { block, bounds } of placeNodeContent(content, box, insets)) {
      if (block.kind === 'icon') {
        node.icon = { icon: block.icon, bounds, ...(block.inset === undefined ? {} : { inset: block.inset }),
          ...(block.radius === undefined ? {} : { radius: block.radius }) };
      } else {
        const { kind, width: _width, height: _height, ...text } = block;
        void _width; void _height;
        draft.labels.push({ id: `node:${JSON.stringify(id)}:${kind}`, owner, layer: node.layer, role: kind, bounds, ...text });
      }
    }
    // The ports of a face are centred over the whole box at the face's pitch, in engine order. A face that lost a port to a side hint (ADR-0022)
    // keeps the box width its size floor holds, so the ports left on it keep their order and their pitch, with an equal margin at both ends.
    for (const side of SIDE_TIE_ORDER) {
      const ports = node.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
      const horizontal = side === 'top' || side === 'bottom';
      const length = horizontal ? box.width : box.height;
      const pitch = node.sidePitch?.[side];
      if (pitch === undefined) throw new Error(`Missing pitch for ${id}.${side}`);
      for (const [index, port] of ports.entries()) {
        if (anchors === 'from-slots') port.anchor = portAnchor(box, side, (length - (ports.length - 1) * pitch) / 2 + index * pitch);
        const point = port.anchor;
        if (!point) throw new Error(`Missing anchor for ${id}`);
        const offset = horizontal ? point.x - box.x : point.y - box.y;
        // Name the port when an earlier rule has left its anchor off the node: the bare range error
        // from `portAnchor` says only that some offset is out of range, which is unusable evidence
        // at scale, where a single stage moved one anchor among thousands.
        if (offset < 0 || offset > length) {
          throw new RangeError(`Anchor for ${id}.${port.ref.name ?? '#'}#${port.ref.ordinal} on ${side} is ${offset} `
            + `along a ${length} px side; a rule moved it off its node ${JSON.stringify(box)}`);
        }
        const expected = portAnchor(box, side, offset);
        if (Math.abs(point.x - expected.x) > PLACEMENT_EPS || Math.abs(point.y - expected.y) > PLACEMENT_EPS) throw new Error(`Anchor is off ${id}.${side}`);
        delete port.pill;
        if (port.ref.anonymous === true) continue;
        const measured = measurePortPill(port.ref.name);
        const { anchor: _anchor, ...pill } = placePortPill(box, side, offset, measured);
        void _anchor;
        port.pill = { ...pill, owner, layer: port.layer };
        const width = horizontal ? measured.text.height : measured.text.width;
        const height = horizontal ? measured.text.width : measured.text.height;
        const label: LayoutLabel = { id: `pill:${JSON.stringify(port.ref)}`, owner, layer: port.layer,
          role: 'pill', port: { ...port.ref }, text: port.ref.name, fontFamily: FONT_FAMILY, fontSize: 9,
          fontWeight: 400, lineHeight: measured.text.lineHeight, lines: measured.text.lines, textRotation: pill.textRotation,
          bounds: { x: point.x - width / 2, y: point.y - height / 2, width, height } };
        draft.labels.push(label);
      }
    }
  }
}

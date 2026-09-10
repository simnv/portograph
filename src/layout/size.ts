import { portPitch } from '../geometry/index.js';
import type { NormalisedNode } from '../model/document.js';
import type { Side, Size } from '../model/geometry.js';
import type { LayoutModel } from '../model/layout.js';
import { orderedNodeIds } from '../model/model.js';
import { resolveNodeIcon } from '../profiles/network/icons.js';
import { FONT_FAMILY, measurePortPill, measureText } from '../text/index.js';
import { NODE_CONTENT_GEOMETRY as theme } from '../theme/content.js';
import { SIDE_TIE_ORDER } from './sides-one.js';

export type NodeContentBlock =
  | (Size & { kind: 'icon'; icon: string })
  | (Size & { kind: 'node' | 'description'; text: string; lines: string[]; fontFamily: string;
    fontSize: number; fontWeight: 400 | 700; lineHeight: number });

export interface NodeContentMeasurement extends Size {
  /** Stack in this order with contentGap; centre in the interior defined by contentInsets. */
  blocks: NodeContentBlock[];
}

/** Padded bounds and renderable blocks; placement supplies absolute coordinates later. */
export function measureNodeContent(node: NormalisedNode,
  insets: Record<Side, number> = { top: theme.padding, right: theme.padding, bottom: theme.padding, left: theme.padding },
): NodeContentMeasurement {
  const blocks: NodeContentBlock[] = [];
  const icon = resolveNodeIcon(node);
  if (icon !== undefined) blocks.push({ kind: 'icon', icon, width: theme.iconWidth, height: theme.iconHeight });
  const appendText = (kind: 'node' | 'description', text: string, fontSize: number, fontWeight: 400 | 700): void => {
    const measured = measureText(text, { fontSize, weight: fontWeight });
    if (measured.height > 0) blocks.push({ kind, text, lines: measured.lines, fontFamily: FONT_FAMILY,
      fontSize, fontWeight, lineHeight: measured.lineHeight, width: measured.width, height: measured.height });
  };
  appendText('node', node.label, theme.labelFontSize, theme.labelFontWeight);
  appendText('description', node.description ?? '', theme.descriptionFontSize, theme.descriptionFontWeight);
  return {
    width: Math.max(0, ...blocks.map(block => block.width)) + insets.left + insets.right,
    height: blocks.reduce((sum, block) => sum + block.height, 0)
      + Math.max(0, blocks.length - 1) * theme.contentGap + insets.top + insets.bottom,
    blocks,
  };
}

/** Measure stage-3 floors and capacity in place; later resize passes may only grow sizes. */
export function sizeNodes(model: LayoutModel): LayoutModel {
  for (const id of orderedNodeIds(model.document)) {
    const node = model.nodes[id]!;
    const authored = model.document.nodes[id]!;
    const sides: Record<Side, { count: number; pills: Size[] }> = {
      bottom: { count: 0, pills: [] }, right: { count: 0, pills: [] },
      top: { count: 0, pills: [] }, left: { count: 0, pills: [] },
    };
    const insets: Record<Side, number> = { top: theme.padding, right: theme.padding, bottom: theme.padding, left: theme.padding };
    for (const port of node.ports) {
      const side = port.side ?? port.sizingSide;
      if (side === undefined) throw new Error(`Node ${id} has a port without a side or capacity estimate`);
      sides[side].count++;
      if (port.ref.anonymous !== true) {
        const pill = measurePortPill(port.ref.name);
        sides[side].pills.push(pill);
        // Pill width follows the normal on all four sides after top/bottom rotation.
        insets[side] = Math.max(insets[side], pill.width / 2 + theme.contentGap);
      }
    }
    const pitch: Record<Side, number> = { bottom: 12, right: 12, top: 12, left: 12 };
    for (const side of SIDE_TIE_ORDER) pitch[side] = portPitch(sides[side].pills);
    node.sidePitch = pitch;
    node.contentInsets = insets;
    const content = measureNodeContent(authored, insets);
    node.contentSize = { width: content.width, height: content.height };
    node.sizeFloor = {
      width: Math.max(theme.minWidth, node.contentSize.width, authored.size?.width ?? 0, node.sizeFloor?.width ?? 0),
      height: Math.max(theme.minHeight, node.contentSize.height, authored.size?.height ?? 0, node.sizeFloor?.height ?? 0),
    };
    const capacity = (side: Side): number => sides[side].count * pitch[side] + 2 * theme.padding;
    node.size = {
      width: Math.max(node.sizeFloor.width, node.size?.width ?? 0, capacity('top'), capacity('bottom')),
      height: Math.max(node.sizeFloor.height, node.size?.height ?? 0, capacity('left'), capacity('right')),
    };
  }
  if (model.stage === 'sides-one') model.stage = 'size';
  return model;
}

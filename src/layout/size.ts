import { portPitch } from '../geometry/index.js';
import type { NormalisedNode } from '../model/document.js';
import type { Side, Size } from '../model/geometry.js';
import type { LayoutModel, LayoutNode } from '../model/layout.js';
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

/**
 * How much wider than itself a body may be made to seat a port under a coordinate another node
 * owns. Stage 7c centres a child under its parents by widening it — nodes never move inside their
 * row, so the widening is how a port travels — and nothing bounded that but a sibling, a reserved
 * lane and a flank. On a wide sheet a node with a 99.5 px content floor was drawn 5 219 px wide to
 * reach a feed at the other edge, and a four-node fixture walked a 50 px body to 3 014 px in eight
 * passes (ticket 29).
 *
 * The same shape of decision as ADR-0012's linked-group grid, which grows one group box onto
 * another's extent and refuses when the smaller box would be inflated to a much larger partner. Its
 * constant stays its own: the grid measures two group boxes against their union, this measures one
 * node body against what the node itself is.
 *
 * **12, measured.** The widths a working diagram needs: the approved golden's two providers, 50 px
 * nodes drawn 166.75 px wide to sit under their feeds (3.34); and two inputs of the geometry corpus
 * whose route loses a checkpoint when the widening is declined — `hub-t5-p3-f2-s3`, whose `n3_0` is
 * 273 px against 50 (5.46), and `wide-t4-p2-f2-s3`, whose own `n3_0` is 450 px against 50 (9.0).
 * Against them, the widths this rule was filed for: 52.4 and 74.4 times their own on the Enterprise
 * NTP sheet, 60.3 in `bar-fan`. The NTP sheet answers the same at every bound from 1 to 16, so
 * nothing on it chose this number; the corpus did, and the margin is thin. Of its 649 publishing
 * inputs, 17 sit in [9.01, 12), **none** in [12, 16), and 3 above it — the highest the bound leaves
 * untouched is `author-ordered-bundle` at **11.36**, a committed fixture, so there is 5.6 % of room
 * under this number and none over it. It binds on exactly three inputs corpus-wide: `bar-fan`
 * 60.28 → 10.75, the defect, and the fixtures `a-claimed-run-owns-only-its-pins` 18.00 → 11.57 and
 * `a-claimed-run-clears-a-shared-run` 16.32 → 11.81, both of which still publish with their tests
 * green — evidence that 16–18 was slack rather than need. At 8 the sheet's widest body falls further,
 * to 637 px from 924, and `wide-t4-p2-f2-s3` stops publishing.
 */
export const ALIGNMENT_MAX_GROWTH = 12;

/**
 * The width a node needs for itself on **one** side: the larger of its measured content and author
 * floor, and the room the ports of that side take at their reserved pitch — the same
 * `2 × padding + count × pitch` the port installers hold. It is the reference every alignment
 * growth is measured against, so a body grown to reach a distant peer stays a body a reader can
 * still read as the node.
 *
 * One side, not the node: `sizeNodes` gives a body the larger of its two horizontal capacities, so a
 * node whose other side holds more ports finishes above the multiple its own side allows. On the
 * Enterprise NTP sheet `na-server4` ends 815.1 px wide — 12.07 × the 67.5 its bottom side needs,
 * because its four top ports need 68.0 and the bound is read there. The bound is per side because
 * the widening is: `alignSide` moves the ports of one side and grows the body around them.
 */
export function ownSideWidth(node: LayoutNode, side: Side): number {
  return Math.max(node.sizeFloor?.width ?? 0, node.contentSize?.width ?? 0,
    2 * theme.padding + node.ports.filter(port => port.side === side).length * (node.sidePitch?.[side] ?? 0));
}

/**
 * The widest an alignment rule may leave this body. A body already wider than the allowance — one a
 * bar span, a group grid or an earlier pass made wide — keeps that width and may align inside it;
 * alignment may never be the reason it grows past the allowance. Reading the current width as a
 * floor rather than as the reference is what keeps repeated passes from ratcheting: the allowance
 * is a property of the node, not of how many times a rule has looked at it.
 *
 * That floor makes the bound depend on when it is read, which matters in one place: `centreViolations`
 * replays a 7c step from a later stage, where a body a bar span or the group grid has since widened
 * carries a larger allowance than the producer had, so the replay could keep a target the producer
 * declined and report a violation the drawing does not have. Its `isBar` and bundled-port exclusions
 * cover the rules that widen a body after 7c, and nothing reaches it across the suite or the
 * geometry corpus; if anything ever does, it throws where it is read rather than drawing something
 * wrong.
 */
export function alignmentAllowance(node: LayoutNode, side: Side): number {
  return Math.max(node.bounds?.width ?? 0, ALIGNMENT_MAX_GROWTH * ownSideWidth(node, side));
}

/**
 * Room a bar keeps either side of its text and of its outer ports (7d). The width its label and its ports need at least is known when phase two resizes the nodes
 * (the second call, once the sides are decided; stage 3's estimate does not carry it, so ELK's input stays as it was), so the sweeps that follow seat the neighbours
 * a band gap from the bar 7d will shape and no gap is found short later (ticket 19).
 */
export const BAR_PADDING = 30;

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
    for (const side of SIDE_TIE_ORDER) pitch[side] = Math.max(portPitch(sides[side].pills), node.sidePitch?.[side] ?? 0);
    node.sidePitch = pitch;
    node.contentInsets = insets;
    const content = measureNodeContent(authored, insets);
    node.contentSize = { width: content.width, height: content.height };
    node.sizeFloor = {
      width: Math.max(theme.minWidth, node.contentSize.width, authored.size?.width ?? 0, node.sizeFloor?.width ?? 0),
      height: Math.max(theme.minHeight, node.contentSize.height, authored.size?.height ?? 0, node.sizeFloor?.height ?? 0),
    };
    const capacity = (side: Side): number => sides[side].count * pitch[side] + 2 * theme.padding;
    // From phase two on, a bar is as wide as its text and padding, and as its ports at their pitch with the padding beyond the outer two (7d reads the same floors); a bar
    // with no ports reads the group label.
    const bar = model.stage !== 'sides-one' && model.document.groups[authored.group]?.shape === 'bar'
      ? Math.max(measureText(node.ports.length ? authored.label : model.document.groups[authored.group]!.label, { fontSize: theme.labelFontSize, weight: theme.labelFontWeight }).width,
        ...(['top', 'bottom'] as const).map(side => Math.max(0, sides[side].count - 1) * pitch[side])) + 2 * BAR_PADDING : 0;
    node.size = {
      width: Math.max(node.sizeFloor.width, node.size?.width ?? 0, capacity('top'), capacity('bottom'), bar),
      height: Math.max(node.sizeFloor.height, node.size?.height ?? 0, capacity('left'), capacity('right')),
    };
  }
  if (model.stage === 'sides-one') model.stage = 'size';
  return model;
}

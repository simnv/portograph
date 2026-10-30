import type { NormalisedGroup, NormalisedNode } from '../../model/document.js';
import { nodeClassStyle, washToken } from './theme.js';
import type { NodeClassStyle } from './theme.js';

/**
 * How a node's icon, title and description sit inside its body (ticket 159).
 *
 * - `card`: the icon tile stands left, the title and the description stand right of it as one left-aligned block. The tile and the
 *   block are centred together.
 * - `stacked`: the icon, the title and the description stand in one centred column.
 */
export type NodeContentStyle = 'card' | 'stacked';

/** The network profile's default for every node, also a node with no description. A class may override it (`NodeClassStyle.content`). */
export const NETWORK_NODE_CONTENT_DEFAULT: NodeContentStyle = 'card';

/**
 * The one resolver of a node's content style (R1). Stage 3 and stage 5 both reach it through `measureNodeContent`, so the size that
 * placement reserves and the blocks that placement draws come from one decision.
 *
 * A node of a `bar` group is `stacked`, whatever its class: a bar is a line-like shape that its own drops cross (a drop may cross
 * an upper bar to reach a lower one), so its label stays one centred column between them, as before cards. Any other node takes
 * the class that paints the body (`washToken`): the profile class declared last. A node of a sheet class, or of no class, takes
 * the profile default. `lookup` stands for the profile's class table and is replaced only by a test.
 */
export function resolveNodeContentStyle(node: Pick<NormalisedNode, 'class' | 'group'>,
  groups: Readonly<Record<string, Pick<NormalisedGroup, 'shape'>>>,
  lookup: (token: string | undefined) => Pick<NodeClassStyle, 'content'> | undefined = nodeClassStyle): NodeContentStyle {
  if (groups[node.group]?.shape === 'bar') return 'stacked';
  return lookup(washToken(node.class))?.content ?? NETWORK_NODE_CONTENT_DEFAULT;
}

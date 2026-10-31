import type { NodeContentStyle, NormalisedDocument, NormalisedGroup, NormalisedNode } from '../../model/document.js';
import { nodeClassStyle, washToken } from './theme.js';
import type { NodeClassStyle } from './theme.js';

/**
 * How a node's icon, title and description sit inside its body (ticket 159).
 *
 * - `card`: the icon tile stands left, the title and the description stand right of it as one left-aligned block. The tile and the
 *   block are centred together.
 * - `stacked`: the icon, the title and the description stand in one centred column.
 */
export type { NodeContentStyle };

/** The values `layout.nodeContent` takes, in the order the parse error lists them. */
export const NODE_CONTENT_STYLES: readonly NodeContentStyle[] = ['stacked', 'card'];

/** What a document without `layout.nodeContent` gets. A class may override it (`NodeClassStyle.content`); a bar group's nodes never take `card`. */
export const DEFAULT_NODE_CONTENT: NodeContentStyle = 'stacked';

/** The part of a document the resolver reads: the groups (a bar group) and the layout settings (`nodeContent`). */
export interface NodeContentDocument {
  groups: Readonly<Record<string, Pick<NormalisedGroup, 'shape'>>>;
  layout?: Pick<NonNullable<NormalisedDocument['layout']>, 'nodeContent'>;
}

/**
 * The one resolver of a node's content style (R1). Stage 3 and stage 5 both reach it through `measureNodeContent`, so the size that
 * placement reserves and the blocks that placement draws come from one decision.
 *
 * A node of a `bar` group is `stacked`, whatever its class: a bar is a line-like shape that its own drops cross (a drop may cross
 * an upper bar to reach a lower one), so its label stays one centred column between them, as before cards. Any other node takes
 * the class that paints the body (`washToken`): the profile class declared last, when that class states a style. Any other node
 * (a sheet class, no class, or a profile class with no style) takes the document's `layout.nodeContent`, `stacked` when unset. `lookup` stands for the profile's class table and is replaced only by a test.
 */
export function resolveNodeContentStyle(node: Pick<NormalisedNode, 'class' | 'group'>,
  document: NodeContentDocument,
  lookup: (token: string | undefined) => Pick<NodeClassStyle, 'content'> | undefined = nodeClassStyle): NodeContentStyle {
  if (document.groups[node.group]?.shape === 'bar') return 'stacked';
  return lookup(washToken(node.class))?.content ?? document.layout?.nodeContent ?? DEFAULT_NODE_CONTENT;
}

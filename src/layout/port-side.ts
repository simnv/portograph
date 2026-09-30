import type { Side } from '../model/geometry.js';
import type { LayoutPort } from '../model/layout.js';

/**
 * The side a port has without its side hint (docs/design/side-faces.md, Section 7, *What a hint changes in the new run*): the side
 * the ELK input, the mesh-bus edge and the ADR-0011 title edge read, so a hint never moves a title, a bus or the skeleton.
 * A port with no hint reads as it always has: `side`, or the stage-2 capacity estimate before stage 5.
 */
export const naturalSideOf = (port: LayoutPort): Side | undefined => port.naturalSide ?? port.side ?? port.sizingSide;

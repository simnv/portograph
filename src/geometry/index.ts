import type { Point, Rect, Side, Size } from '../model/geometry.js';

function checkSize(size: Size): void {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) {
    throw new RangeError('Geometry dimensions must be positive and finite');
  }
}

/** Offset is measured from the left on top/bottom, and from the top on left/right. */
export function portAnchor(node: Rect, side: Side, offset: number): Point {
  checkSize(node);
  const length = side === 'top' || side === 'bottom' ? node.width : node.height;
  if (!Number.isFinite(node.x) || !Number.isFinite(node.y) || !Number.isFinite(offset) || offset < 0 || offset > length) {
    throw new RangeError('Port offset must lie on a finite node boundary');
  }
  switch (side) {
    case 'top': return { x: node.x + offset, y: node.y };
    case 'bottom': return { x: node.x + offset, y: node.y + node.height };
    case 'left': return { x: node.x, y: node.y + offset };
    case 'right': return { x: node.x + node.width, y: node.y + offset };
  }
}

export interface PortPillPlacement {
  anchor: Point;
  /** Unrotated size; add owner/layer when inserting the pill into LayoutModel. */
  size: Size;
  bounds: Rect;
  textRotation: -90 | 0;
  radius: number;
}

export function placePortPill(node: Rect, side: Side, offset: number, size: Size): PortPillPlacement {
  checkSize(size);
  const anchor = portAnchor(node, side, offset);
  const rotated = side === 'top' || side === 'bottom';
  const width = rotated ? size.height : size.width;
  const height = rotated ? size.width : size.height;
  return { anchor, size: { width: size.width, height: size.height },
    bounds: { x: anchor.x - width / 2, y: anchor.y - height / 2, width, height },
    textRotation: rotated ? -90 : 0, radius: Math.min(3, width / 2, height / 2) };
}

/** Pills face along the outward normal, so their unrotated height runs along every side. */
export function portPitch(pills: readonly Size[]): number {
  let pitch = 12;
  for (const pill of pills) {
    checkSize(pill);
    pitch = Math.max(pitch, pill.height + 4);
  }
  return pitch;
}

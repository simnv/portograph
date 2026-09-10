/** All geometry uses absolute coordinates in pixels at scale 1. */
export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

export type Side = 'top' | 'right' | 'bottom' | 'left';

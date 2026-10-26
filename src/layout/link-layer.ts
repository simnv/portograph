import type { LayoutLink } from '../model/layout.js';

/**
 * The layer a link is drawn on: its own `layer`, else its family, else routed. One function for the readers of placement, the overlay
 * rule and the route plan (R1); `route/plan.ts` exports it as `effectiveLayer`.
 */
export const linkLayer = (link: LayoutLink): 'routed' | 'overlay' => link.layer ?? link.family ?? 'routed';

import type { Layer } from '../model/index.js';

/**
 * The one check of the layer selection, shared by the SVG renderer, the draw.io renderer and the
 * CLI. It is a leaf module (no layout import), so the CLI can use it without an import cycle.
 */
export function checkOptions(options: { readonly layers?: readonly Layer[] }): void {
  if (options.layers === undefined) return;
  if (!options.layers.length) throw new Error('Layer selection must name at least one of routed, overlay');
  for (const layer of options.layers) {
    if (layer !== 'routed' && layer !== 'overlay') throw new Error(`Unknown link layer ${String(layer)}`);
  }
}

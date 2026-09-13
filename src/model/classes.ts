/**
 * Author class policy, shared by the layout (which lists drawn classes in the legend) and the
 * renderer (which emits them). A class is accepted free text; the one reservation is the generated
 * prefix, so that no author token can impersonate a geometry lock or a mask class.
 */

/** Prefix of every class the renderer generates: geometry locks (`pg-w-…`, `pg-f-…`) and mask classes. */
export const RESERVED_CLASS_PREFIX = 'pg-';

/**
 * An author-supplied class string, with any token claiming the reserved prefix removed. A class
 * named after a generated geometry lock — `pg-w-2` on a 3 px link — would otherwise put a second
 * `stroke-width` rule on the element and win by source order, drawing a width `score` never
 * measured. Every author-controlled token passes through here before it becomes a class.
 */
export function authorClass(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const kept = value.split(/\s+/).filter(part => part && !part.startsWith(RESERVED_CLASS_PREFIX));
  return kept.length ? kept.join(' ') : undefined;
}

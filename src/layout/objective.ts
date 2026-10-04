/**
 * One reading of a candidate and one comparison of two readings (architecture ticket 04).
 */

/** Test only: a sink for every verdict a judge gives, in order. Unset in production; the layout never reads it. */
export const verdictTap: { sink?: (name: string, value: string) => void } = {};

/** Gives a judge's verdict to the test sink, when there is one. `value` is built only then. */
export function tapVerdict(name: string, value: () => string): void {
  if (verdictTap.sink !== undefined) verdictTap.sink(name, value());
}

/**
 * Add `entry` (for example `autoArrange: false`) to the `layout:` setting of a sheet: into its flow `layout: { ... }` line, or as a new
 * line after `portograph: 2` when it has none. A block `layout:` is refused (no fixture writes one).
 */
export function withLayoutEntry(yaml: string, entry: string): string {
  if (/^layout:\s*$/m.test(yaml)) throw new Error('withLayoutEntry reads a flow `layout: { ... }` line or none');
  const flow = /^layout: \{ (.*) \}$/m;
  if (flow.test(yaml)) return yaml.replace(flow, (_, rest: string) => `layout: { ${rest}, ${entry} }`);
  return yaml.replace(/^portograph: 2$/m, `portograph: 2\nlayout: { ${entry} }`);
}

/**
 * A sheet that states `layout.aspect` (ADR-0025). A test whose subject is not the aim pins the aim it was written under (`"1:1"`, the
 * square of ADR-0024) this way, so a change of the default aim does not move what it checks. `ratio` is the quoted `"W:H"` string.
 */
export const withAspect = (yaml: string, ratio: string): string => withLayoutEntry(yaml, `aspect: "${ratio}"`);

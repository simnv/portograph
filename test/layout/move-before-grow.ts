/**
 * The YAML of a sheet with `layout.moveBeforeGrow: true` (ADR-0027, an opt-in until ticket 15): the tests of the seat read a sheet of the corpus
 * with the option, so the sheet itself stays a test of the default.
 */
export function withMoveBeforeGrow(yaml: string): string {
  if (/moveBeforeGrow:\s*true/.test(yaml)) return yaml;
  if (/^layout:\s*\{/m.test(yaml)) return yaml.replace(/^layout:\s*\{/m, 'layout: { moveBeforeGrow: true,');
  if (/^layout:\s*$/m.test(yaml)) return yaml.replace(/^layout:\s*$/m, 'layout:\n  moveBeforeGrow: true');
  return yaml.replace(/^portograph: 2\n/m, 'portograph: 2\nlayout: { moveBeforeGrow: true }\n');
}

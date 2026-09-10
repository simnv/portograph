/**
 * The CLI contract: verbs, exit codes and help text.
 *
 * `bin/portograph` reads this from the built library so the two never disagree.
 * The verbs themselves are wired end to end in ticket 17; until then every verb
 * is a stub that exits with `EXIT.notImplemented`.
 */

export const VERBS = [
  { name: 'layout', summary: 'YAML in, layout JSON out' },
  { name: 'render', summary: 'YAML in, SVG plus layout JSON and score out' },
  { name: 'score', summary: 'layout JSON in, gates and soft score out' },
  { name: 'migrate', summary: 'd3-fd YAML in, schema v2 YAML out' },
] as const;

export type Verb = (typeof VERBS)[number]['name'];

/** Process exit codes (ticket 17). `notImplemented` is the stub value of ticket 01. */
export const EXIT = {
  ok: 0,
  gateFailure: 1,
  inputError: 2,
  notImplemented: 2,
} as const;

export function isVerb(value: string): value is Verb {
  return VERBS.some((verb) => verb.name === value);
}

export function helpText(): string {
  const width = Math.max(...VERBS.map((verb) => verb.name.length));
  const lines = [
    'Usage: portograph <verb> [options] <file>',
    '',
    'Verbs:',
    ...VERBS.map((verb) => `  ${verb.name.padEnd(width)}  ${verb.summary}`),
    '',
    'Options:',
    '  -h, --help     Show this help and exit',
    '  -V, --version  Print the version and exit',
    '',
    'Exit codes:',
    `  ${EXIT.ok}  ok`,
    `  ${EXIT.gateFailure}  a hard gate failed (unless --allow-gate-failures)`,
    `  ${EXIT.inputError}  input error, or the verb is not implemented yet`,
  ];
  return lines.join('\n') + '\n';
}

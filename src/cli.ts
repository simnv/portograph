/**
 * The CLI contract: verbs, options, exit codes, help text, argument parsing and the one-line form
 * of a diagnostic.
 *
 * Everything here is pure and portable. `bin/cli.mjs` reads it from the built library so the two
 * can never disagree, and `bin/compute.mjs` uses the same parsed command inside the child process
 * that owns the real work. Nothing in this file touches the file system, the process or a worker.
 */
import type { Diagnostic, Layer, Owner } from './model/index.js';
import type { ThemeMode } from './profiles/network/theme.js';

export const VERBS = [
  { name: 'layout', summary: 'YAML in, layout JSON out' },
  { name: 'render', summary: 'YAML in, SVG plus layout JSON and score out' },
  { name: 'score', summary: 'layout JSON in, gates and soft score out' },
  { name: 'migrate', summary: 'd3-fd YAML in, schema v2 YAML out' },
] as const;

export type Verb = (typeof VERBS)[number]['name'];

/**
 * Process exit codes.
 *
 * `gateFailure` means a *complete* score report says an enforced gate or assertion failed — the
 * artifacts are still written, because a failing report is the useful output. `inputError` covers
 * usage, unreadable files, invalid YAML or JSON, and the node-count refusal. `processingFailure`
 * covers a command deadline, a missing packaged worker asset and any internal pipeline failure:
 * calling one of those an input error would blame the author for the tool's own limit.
 */
export const EXIT = {
  ok: 0,
  gateFailure: 1,
  inputError: 2,
  processingFailure: 3,
} as const;

/** Wall milliseconds a whole command may take before its compute boundary is terminated. */
export const COMMAND_DEADLINE_MS = 60000;

export function isVerb(value: string): value is Verb {
  return VERBS.some((verb) => verb.name === value);
}

export class UsageError extends Error {
  constructor(message: string) { super(message); this.name = 'UsageError'; }
}

/** How diagnostics and status lines reach stderr: a text line each, or one JSON object per line. */
export const DIAGNOSTIC_FORMATS = ['text', 'json'] as const;
export type DiagnosticFormat = (typeof DIAGNOSTIC_FORMATS)[number];

export interface Command {
  verb: Verb;
  /** A path, or `-` for stdin. */
  input: string;
  /** Absent means the primary artifact goes to stdout; so does `-`, which parsing drops. */
  output?: string;
  /** Absent means `text`. */
  diagnostics?: DiagnosticFormat;
  force: boolean;
  allowGateFailures: boolean;
  /** Keep the wall-clock stage timings in the layout and score JSON. Absent means they are left out, so two runs write the same bytes. */
  timings: boolean;
  /** `render` only. Absent means both families draw and `document.overlays` applies. */
  layers?: Layer[];
  /** `render` only. Absent means SVG. */
  format?: Format;
  /** `render --format drawio` only. Absent means `auto`: every colour as a light/dark pair. */
  theme?: ThemeMode | 'auto';
  /** `render --format drawio` only. Absent means `on-run`. */
  labels?: LabelPlacement;
  /** `render --format drawio` only. Absent means `cisco19`. */
  icons?: IconSet;
}

interface OptionSpec {
  /** Verbs that accept it; every verb when omitted. */
  verbs?: readonly Verb[];
  value: boolean;
  summary: string;
}

const OPTIONS: Record<string, OptionSpec> = {
  '--output': { value: true, summary: 'Write the primary artifact to this path instead of stdout (- means stdout)' },
  '--diagnostics': { value: true, summary: 'Diagnostics and status lines on stderr: text (default) or json, one object per line' },
  '--force': { value: false, summary: 'Lay out and score more than 1,000 nodes' },
  '--allow-gate-failures': { verbs: ['render', 'score'], value: false, summary: 'Report a failed gate but exit 0' },
  '--timings': { verbs: ['layout', 'render', 'score'], value: false, summary: 'Keep the wall-clock stage timings in the layout and score JSON (default: left out, so two runs write the same bytes)' },
  '--layers': { verbs: ['render'], value: true, summary: 'Draw only these link families: routed, overlay (comma separated)' },
  '--format': { verbs: ['render'], value: true, summary: 'Primary artifact format: svg (default) or drawio' },
  '--theme': { verbs: ['render'], value: true, summary: 'draw.io palette: auto (default, light and dark in one file), light, dark or print' },
  '--labels': { verbs: ['render'], value: true, summary: 'draw.io link labels: on-run (default) or measured, the box the layout placed' },
  '--icons': { verbs: ['render'], value: true, summary: "draw.io glyphs: cisco19 (default), draw.io's own Cisco shapes, which follow its dark appearance, or profile, an embedded image that cannot" },
};

/** Both spellings of `-o X`, `--output X` and `--output=X`, in the order a user would try them. */
const ALIASES: Record<string, string> = { '-o': '--output', '-f': '--force' };

export function helpText(): string {
  const width = Math.max(...VERBS.map((verb) => verb.name.length));
  const names = Object.keys(OPTIONS);
  const optionWidth = Math.max(...names.map((name) => name.length + (OPTIONS[name]!.value ? 6 : 0)), '-V, --version'.length);
  const option = (name: string): string => {
    const spec = OPTIONS[name]!;
    const label = `${name}${spec.value ? ' <arg>' : ''}`;
    const verbs = spec.verbs ? ` (${spec.verbs.join(', ')} only)` : '';
    return `  ${label.padEnd(optionWidth)}  ${spec.summary}${verbs}`;
  };
  return [
    'Usage: portograph <verb> [options] <file>',
    '',
    'Verbs:',
    ...VERBS.map((verb) => `  ${verb.name.padEnd(width)}  ${verb.summary}`),
    '',
    'Options may come before or after the file. Exactly one file is required; - reads stdin.',
    '',
    'Options:',
    ...names.map(option),
    `  ${'-h, --help'.padEnd(optionWidth)}  Show this help and exit`,
    `  ${'-V, --version'.padEnd(optionWidth)}  Print the version and exit`,
    '',
    'Output:',
    '  Without --output the primary artifact is the only thing on stdout: layout JSON, SVG,',
    '  a draw.io document, score JSON or schema-v2 YAML. Diagnostics and progress always go',
    '  to stderr. With --output the artifact goes to that path and stdout stays empty. For',
    '  `render --output X.svg` or `X.drawio` the layout and the score are written beside it',
    '  as X.layout.json and X.score.json; any other output path gets .layout.json and',
    '  .score.json appended.',
    '',
    'Exit codes:',
    `  ${EXIT.ok}  ok`,
    `  ${EXIT.gateFailure}  a hard gate failed (unless --allow-gate-failures)`,
    `  ${EXIT.inputError}  input error: usage, unreadable file, invalid YAML or JSON, node limit`,
    `  ${EXIT.processingFailure}  processing failure: command deadline, missing worker asset, internal error`,
    '',
  ].join('\n');
}

const LAYERS: readonly Layer[] = ['routed', 'overlay'];

/** The formats `render` can write. The SVG carries all three palettes; a draw.io file carries one. */
export const FORMATS = ['svg', 'drawio'] as const;
export type Format = (typeof FORMATS)[number];
const THEMES: readonly (ThemeMode | 'auto')[] = ['auto', 'light', 'dark', 'print'];

/** Where a draw.io link label sits; see `DrawioOptions.labels`. */
export const LABEL_PLACEMENTS = ['on-run', 'measured'] as const;
export type LabelPlacement = (typeof LABEL_PLACEMENTS)[number];

/** Which glyphs a draw.io export draws; see `DrawioOptions.icons`. */
export const ICON_SETS = ['cisco19', 'profile'] as const;
export type IconSet = (typeof ICON_SETS)[number];

function parseIcons(value: string): IconSet {
  if (!ICON_SETS.includes(value as IconSet)) throw new UsageError(`--icons does not know '${value}'; use cisco19 or profile`);
  return value as IconSet;
}

function parseLabels(value: string): LabelPlacement {
  if (!LABEL_PLACEMENTS.includes(value as LabelPlacement)) throw new UsageError(`--labels does not know '${value}'; use on-run or measured`);
  return value as LabelPlacement;
}

function parseFormat(value: string): Format {
  if (!FORMATS.includes(value as Format)) throw new UsageError(`--format does not know '${value}'; use svg or drawio`);
  return value as Format;
}

function parseTheme(value: string): ThemeMode | 'auto' {
  if (!THEMES.includes(value as ThemeMode)) throw new UsageError(`--theme does not know '${value}'; use auto, light, dark or print`);
  return value as ThemeMode | 'auto';
}

function parseLayers(value: string): Layer[] {
  const names = value.split(',').map((name) => name.trim());
  if (!names.length || names.some((name) => name === '')) throw new UsageError('--layers needs a comma separated list of routed, overlay');
  for (const name of names) {
    if (!LAYERS.includes(name as Layer)) throw new UsageError(`--layers does not know '${name}'; use routed, overlay or both`);
  }
  return names as Layer[];
}

/**
 * Parse one already-validated verb's arguments. Options and the single input path may come in any
 * order, each option at most once, and an option a verb does not accept is a usage error rather
 * than something quietly ignored.
 */
export function parseCommand(verb: Verb, args: readonly string[]): Command {
  const seen = new Set<string>();
  const values = new Map<string, string>();
  const inputs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--') { inputs.push(...args.slice(index + 1)); break; }
    if (!argument.startsWith('-') || argument === '-') { inputs.push(argument); continue; }
    const split = argument.indexOf('=');
    const raw = split === -1 ? argument : argument.slice(0, split);
    const name = ALIASES[raw] ?? raw;
    const spec = OPTIONS[name];
    if (!spec) throw new UsageError(`unknown option '${raw}'`);
    if (spec.verbs && !spec.verbs.includes(verb)) throw new UsageError(`${verb} does not accept ${name}`);
    if (seen.has(name)) throw new UsageError(`${name} was given more than once`);
    seen.add(name);
    if (!spec.value) {
      if (split !== -1) throw new UsageError(`${name} takes no value`);
      continue;
    }
    const value = split === -1 ? args[index += 1] : argument.slice(split + 1);
    if (value === undefined) throw new UsageError(`${name} needs a value`);
    values.set(name, value);
  }
  if (!inputs.length) throw new UsageError(`${verb} needs one input file`);
  if (inputs.length > 1) throw new UsageError(`${verb} takes exactly one input file; got ${inputs.length}`);
  const rawOutput = values.get('--output');
  if (rawOutput !== undefined && rawOutput === '') throw new UsageError('--output needs a path');
  // `-` is stdout, which is where the artifact goes without --output; there are no sidecars then.
  const output = rawOutput === '-' ? undefined : rawOutput;
  const diagnostics = values.get('--diagnostics');
  if (diagnostics !== undefined && !DIAGNOSTIC_FORMATS.includes(diagnostics as DiagnosticFormat)) {
    throw new UsageError(`--diagnostics does not know '${diagnostics}'; use text or json`);
  }
  const layers = values.get('--layers');
  const format = values.get('--format');
  const theme = values.get('--theme');
  const labels = values.get('--labels');
  if (labels !== undefined && (format === undefined || parseFormat(format) === 'svg')) {
    throw new UsageError('--labels applies to --format drawio; an SVG draws the label box the layout measured');
  }
  const icons = values.get('--icons');
  if (icons !== undefined && (format === undefined || parseFormat(format) === 'svg')) {
    throw new UsageError("--icons applies to --format drawio; an SVG draws the profile's own glyphs");
  }
  // An SVG carries every palette behind `prefers-color-scheme`, so choosing one at the command line
  // would state something the artifact cannot hold; the option belongs to the formats that can.
  if (theme !== undefined && (format === undefined || parseFormat(format) === 'svg')) {
    throw new UsageError('--theme applies to --format drawio; an SVG carries light, dark and print at once');
  }
  return {
    verb,
    input: inputs[0]!,
    ...(output === undefined ? {} : { output }),
    ...(diagnostics === undefined || diagnostics === 'text' ? {} : { diagnostics: diagnostics as DiagnosticFormat }),
    force: seen.has('--force'),
    allowGateFailures: seen.has('--allow-gate-failures'),
    timings: seen.has('--timings'),
    ...(layers === undefined ? {} : { layers: parseLayers(layers) }),
    ...(format === undefined ? {} : { format: parseFormat(format) }),
    ...(theme === undefined ? {} : { theme: parseTheme(theme) }),
    ...(labels === undefined ? {} : { labels: parseLabels(labels) }),
    ...(icons === undefined ? {} : { icons: parseIcons(icons) }),
  };
}

/**
 * The two sidecar paths `render --output` publishes beside the primary artifact. A known artifact
 * suffix is replaced so `diagram.svg` and `diagram.drawio` both give `diagram.layout.json`; any
 * other path keeps its full name, because silently dropping an author's extension would be worse
 * than a long file name.
 */
const ARTIFACT_SUFFIXES: readonly string[] = ['.svg', '.drawio'];

export function sidecarPaths(output: string): { layout: string; score: string } {
  const lower = output.toLowerCase();
  const suffix = ARTIFACT_SUFFIXES.find((known) => lower.endsWith(known));
  const stem = suffix === undefined ? output : output.slice(0, -suffix.length);
  return { layout: `${stem}.layout.json`, score: `${stem}.score.json` };
}

const ownerText = (owner: Owner): string =>
  owner.kind === 'barCross' ? `barCross ${owner.node}/${owner.link}` : `${owner.kind} ${owner.id}`;

/** Where a diagnostic points in the authored text, as `parseWithDiagnostics` reports it. */
export interface DiagnosticPlace { source: string; line: number; column: number }

/**
 * One diagnostic, one stderr line, built from its structured fields. A parse diagnostic keeps its
 * exact JSONPath and, when the place in the text is known, adds `file:line:col` before it; a later
 * stage names the objects it is about, because those have no source path.
 */
export function formatDiagnostic(diagnostic: Diagnostic & { path?: string }, place?: DiagnosticPlace): string {
  const path = 'path' in diagnostic && typeof diagnostic.path === 'string' ? diagnostic.path : undefined;
  const owners = diagnostic.owners?.length ? diagnostic.owners.map(ownerText).join(', ') : undefined;
  const at = place === undefined ? undefined : `${place.source}:${place.line}:${place.column}`;
  const where = at !== undefined ? (path === undefined || path === '$' ? at : `${at} (${path})`) : path ?? owners;
  return `portograph: ${diagnostic.severity}: ${diagnostic.code}${where === undefined ? '' : ` at ${where}`}: ${diagnostic.message}`;
}

/**
 * The same diagnostic as one JSON object, for `--diagnostics json`. The structured fields stay as
 * they are; a place in the authored text is added as `source`, `line` and `column`.
 */
export function formatDiagnosticJson(diagnostic: Diagnostic & { path?: string }, place?: DiagnosticPlace): string {
  return JSON.stringify({ ...diagnostic, ...(place === undefined ? {} : { source: place.source, line: place.line, column: place.column }) });
}

/**
 * A status line of the command itself (not a diagnostic of the document) in the chosen format.
 * The text form names severity and code only when `showCode` is set, as the coded failures do.
 */
export function formatStatus(format: DiagnosticFormat | undefined, severity: 'info' | 'warning' | 'error', code: string, message: string, showCode = false): string {
  return format === 'json' ? JSON.stringify({ severity, code, message }) : `portograph: ${showCode ? `${severity}: ${code}: ` : ''}${message}`;
}

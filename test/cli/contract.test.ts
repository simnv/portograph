import { describe, expect, it } from 'vitest';
import { COMMAND_DEADLINE_MS, EXIT, UsageError, VERBS, formatDiagnostic, formatDiagnosticJson, formatStatus, helpText, isVerb, parseCommand, sidecarPaths } from '../../src/internal.js';

describe('CLI contract', () => {
  it('help lists the four verbs in pipeline order and each one is a recognised verb', () => {
    const help = helpText();
    const names = VERBS.map((verb) => verb.name);
    expect(names).toEqual(['layout', 'render', 'score', 'migrate']);

    const positions = names.map((name) => help.indexOf(`  ${name} `));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    expect(names.every(isVerb)).toBe(true);
    expect(isVerb('parse')).toBe(false);
  });

  it('help documents every option, the file position rule and all four exit codes', () => {
    const help = helpText();
    for (const option of ['--output', '--force', '--allow-gate-failures', '--layers', '--format',
      '--theme', '--labels', '--icons', '-h, --help', '-V, --version']) {
      expect(help).toContain(option);
    }
    expect(help).toContain('Options may come before or after the file');
    expect(help).toContain('- reads stdin');
    expect(help).toContain('X.layout.json');
    expect(help).toContain('X.score.json');
    expect(help).toContain(`${EXIT.ok}  ok`);
    expect(help).toContain(`${EXIT.gateFailure}  a hard gate failed`);
    expect(help).toContain(`${EXIT.inputError}  input error`);
    expect(help).toContain(`${EXIT.processingFailure}  processing failure`);
  });

  it('keeps the four exit codes distinct and the command deadline at 60 seconds', () => {
    expect(Object.values(EXIT)).toEqual([0, 1, 2, 3]);
    expect(new Set(Object.values(EXIT)).size).toBe(4);
    expect(COMMAND_DEADLINE_MS).toBe(60000);
  });
});

describe('parseCommand', () => {
  it('accepts options before and after the file, in both spellings', () => {
    const after = parseCommand('render', ['a.yaml', '--output', 'b.svg', '--force']);
    const before = parseCommand('render', ['--force', '--output=b.svg', 'a.yaml']);
    const short = parseCommand('render', ['-f', '-o', 'b.svg', 'a.yaml']);
    for (const command of [after, before, short]) {
      expect(command).toEqual({ verb: 'render', input: 'a.yaml', output: 'b.svg', force: true, allowGateFailures: false, timings: false });
    }
  });

  it('defaults to stdout with no option set', () => {
    expect(parseCommand('layout', ['a.yaml'])).toEqual({ verb: 'layout', input: 'a.yaml', force: false, allowGateFailures: false, timings: false });
  });

  it('requires exactly one input path and reads no stdin', () => {
    expect(() => parseCommand('layout', [])).toThrow(UsageError);
    expect(() => parseCommand('layout', [])).toThrow(/needs one input file/);
    expect(() => parseCommand('layout', ['a.yaml', 'b.yaml'])).toThrow(/exactly one input file; got 2/);
    // A bare `-` is the request to read stdin.
    expect(parseCommand('layout', ['-']).input).toBe('-');
    expect(parseCommand('layout', ['--', '--weird.yaml']).input).toBe('--weird.yaml');
  });

  it('refuses an unknown option, a repeated option and a value where none is taken', () => {
    expect(() => parseCommand('layout', ['--nope', 'a.yaml'])).toThrow(/unknown option '--nope'/);
    expect(() => parseCommand('layout', ['--output', 'x', '--output', 'y', 'a.yaml'])).toThrow(/--output was given more than once/);
    expect(() => parseCommand('render', ['-o', 'x', '--output=y', 'a.yaml'])).toThrow(/more than once/);
    expect(() => parseCommand('layout', ['--force=yes', 'a.yaml'])).toThrow(/--force takes no value/);
    expect(() => parseCommand('layout', ['a.yaml', '--output'])).toThrow(/--output needs a value/);
    expect(() => parseCommand('layout', ['a.yaml', '--output='])).toThrow(/--output needs a path/);
  });

  it('limits an option to the verbs that have it', () => {
    expect(() => parseCommand('layout', ['--layers', 'routed', 'a.yaml'])).toThrow(/layout does not accept --layers/);
    expect(() => parseCommand('migrate', ['--allow-gate-failures', 'a.yaml'])).toThrow(/migrate does not accept --allow-gate-failures/);
    expect(parseCommand('score', ['--allow-gate-failures', 'a.json']).allowGateFailures).toBe(true);
    expect(parseCommand('render', ['--layers', 'overlay', 'a.yaml']).layers).toEqual(['overlay']);
  });

  it('reads --layers as a nonempty list of the two link families', () => {
    expect(parseCommand('render', ['--layers', 'routed,overlay', 'a.yaml']).layers).toEqual(['routed', 'overlay']);
    expect(parseCommand('render', ['--layers', ' routed , overlay ', 'a.yaml']).layers).toEqual(['routed', 'overlay']);
    for (const value of ['', 'nope', 'routed,', ',overlay', 'routed,nope']) {
      expect(() => parseCommand('render', ['--layers', value, 'a.yaml'])).toThrow(UsageError);
    }
  });
});

describe('stdin, stdout and diagnostics options', () => {
  it('takes - as stdout for --output, which is the same as no --output', () => {
    expect(parseCommand('layout', ['a.yaml', '-o', '-'])).toEqual(parseCommand('layout', ['a.yaml']));
    expect(parseCommand('render', ['-', '--output=-']).output).toBeUndefined();
    expect(helpText()).toContain('- reads stdin');
  });

  it('knows two diagnostic formats, text being the default', () => {
    expect(parseCommand('layout', ['a.yaml', '--diagnostics', 'json']).diagnostics).toBe('json');
    expect(parseCommand('layout', ['a.yaml', '--diagnostics=text']).diagnostics).toBeUndefined();
    expect(() => parseCommand('layout', ['a.yaml', '--diagnostics', 'xml'])).toThrow(UsageError);
    expect(JSON.parse(formatDiagnosticJson({ stage: 'parse', severity: 'error', code: 'UNKNOWN_KEY', path: '$.a', message: 'm' }, { source: 'x.yaml', line: 2, column: 3 })))
      .toEqual({ kind: 'diagnostic', stage: 'parse', severity: 'error', code: 'UNKNOWN_KEY', path: '$.a', message: 'm', source: 'x.yaml', line: 2, column: 3 });
    expect(formatStatus(undefined, 'info', 'WROTE', 'wrote x')).toBe('portograph: wrote x');
    expect(formatStatus(undefined, 'error', 'COMMAND_DEADLINE', 'too slow', true)).toBe('portograph: error: COMMAND_DEADLINE: too slow');
    expect(JSON.parse(formatStatus('json', 'error', 'GATE_FAILED', 'g'))).toEqual({ kind: 'status', severity: 'error', code: 'GATE_FAILED', message: 'g' });
  });
});

describe('render formats', () => {
  it('takes a known format and refuses one it cannot write', () => {
    expect(parseCommand('render', ['a.yaml', '--format', 'drawio']).format).toBe('drawio');
    expect(parseCommand('render', ['a.yaml', '--format', 'svg']).format).toBe('svg');
    expect(parseCommand('render', ['a.yaml']).format).toBeUndefined();
    expect(() => parseCommand('render', ['a.yaml', '--format', 'pdf'])).toThrow(UsageError);
    expect(() => parseCommand('layout', ['a.yaml', '--format', 'drawio'])).toThrow(UsageError);
  });

  it('names cisco19 as the icon default, and takes the option only where it can apply', () => {
    // The claim: a draw.io export defaults to draw.io's own `mxgraph.cisco19.*` stencils. They
    // resolve from the style string and take paired `light-dark()` colours, so they follow the
    // reader's dark appearance; the `profile` set is an embedded `shape=image` data URI, which
    // cannot adapt by any means. The help says so, and `DrawioOptions.icons` holds the same
    // default, so a library caller and a CLI caller get the same file.
    expect(helpText()).toContain('cisco19 (default)');
    expect(parseCommand('render', ['a.yaml', '--format', 'drawio', '--icons', 'profile']).icons).toBe('profile');
    // Absent means the exporter's own default; the CLI states no second opinion about it.
    expect(parseCommand('render', ['a.yaml', '--format', 'drawio']).icons).toBeUndefined();
    expect(() => parseCommand('render', ['a.yaml', '--icons', 'cisco19'])).toThrow(UsageError);
    expect(() => parseCommand('render', ['a.yaml', '--format', 'svg', '--icons', 'cisco19'])).toThrow(UsageError);
    expect(() => parseCommand('render', ['a.yaml', '--format', 'drawio', '--icons', 'aws'])).toThrow(UsageError);
  });

  it('refuses a theme for a format that carries every palette at once', () => {
    // The claim: `--theme` is not a global preference but a property of the artifact. An SVG ships
    // light, dark behind `prefers-color-scheme` and print in one file, so naming one there would
    // state something the file cannot hold; a draw.io file holds exactly one.
    expect(parseCommand('render', ['a.yaml', '--format', 'drawio', '--theme', 'dark']).theme).toBe('dark');
    expect(() => parseCommand('render', ['a.yaml', '--theme', 'dark'])).toThrow(UsageError);
    expect(() => parseCommand('render', ['a.yaml', '--format', 'svg', '--theme', 'dark'])).toThrow(UsageError);
    expect(() => parseCommand('render', ['a.yaml', '--format', 'drawio', '--theme', 'sepia'])).toThrow(UsageError);
  });
});

describe('sidecarPaths', () => {
  it('replaces a .svg suffix and otherwise appends, so no author extension is dropped', () => {
    expect(sidecarPaths('out/diagram.svg')).toEqual({ layout: 'out/diagram.layout.json', score: 'out/diagram.score.json' });
    expect(sidecarPaths('out/diagram.SVG')).toEqual({ layout: 'out/diagram.layout.json', score: 'out/diagram.score.json' });
    expect(sidecarPaths('out/diagram')).toEqual({ layout: 'out/diagram.layout.json', score: 'out/diagram.score.json' });
    expect(sidecarPaths('out/diagram.svgz')).toEqual({ layout: 'out/diagram.svgz.layout.json', score: 'out/diagram.svgz.score.json' });
    expect(sidecarPaths('out/diagram.drawio')).toEqual({ layout: 'out/diagram.layout.json', score: 'out/diagram.score.json' });
    expect(sidecarPaths('out/diagram.DRAWIO')).toEqual({ layout: 'out/diagram.layout.json', score: 'out/diagram.score.json' });
  });
});

describe('formatDiagnostic', () => {
  it('keeps a source path, names owners when there is none, and always states code and severity', () => {
    expect(formatDiagnostic({ stage: 'parse', severity: 'error', code: 'INVALID_TYPE', path: '$.nodes.a.ports', message: 'Expected a list' }))
      .toBe('portograph: error: INVALID_TYPE at $.nodes.a.ports: Expected a list');
    expect(formatDiagnostic({ stage: 'placement', severity: 'warning', code: 'ELK_FALLBACK', message: 'Partitioned skeleton failed', owners: [{ kind: 'group', id: 'core' }] }))
      .toBe('portograph: warning: ELK_FALLBACK at group core: Partitioned skeleton failed');
    expect(formatDiagnostic({ stage: 'final-geometry', severity: 'info', code: 'X', message: 'y' }))
      .toBe('portograph: info: X: y');
    expect(formatDiagnostic({ stage: 'model', severity: 'warning', code: 'B', message: 'c', owners: [{ kind: 'barCross', node: 'bar', link: 'link-1' }] }))
      .toBe('portograph: warning: B at barCross bar/link-1: c');
    expect(formatDiagnostic({ stage: 'parse', severity: 'error', code: 'UNKNOWN_KEY', path: '$.nodes.a.colour', message: 'Unknown key colour' }, { source: 'net.yaml', line: 7, column: 5 }))
      .toBe('portograph: error: UNKNOWN_KEY at net.yaml:7:5 ($.nodes.a.colour): Unknown key colour');
    expect(formatDiagnostic({ stage: 'parse', severity: 'error', code: 'INVALID_YAML', path: '$', message: 'bad' }, { source: 'net.yaml', line: 3, column: 1 }))
      .toBe('portograph: error: INVALID_YAML at net.yaml:3:1: bad');
  });
});

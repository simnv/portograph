import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateScaleYaml } from '../../scripts/scale-input.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'bin/portograph.mjs');
const temp = mkdtempSync(join(tmpdir(), 'portograph-cli-test-'));
const golden = join(root, 'goldens/m1-sip-edge.yaml');
const svgPath = join(temp, 'golden.svg');
const jsonPath = join(temp, 'golden.layout.json');
const scorePath = join(temp, 'golden.score.json');

async function command(args: string[], env: Record<string, string> = {}) {
  try {
    const output = await run(process.execPath, [cli, ...args], { cwd: temp,
      env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, timeout: 40000 });
    return { code: 0, ...output };
  } catch (error) {
    const failure = error as Error & { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

beforeAll(async () => {
  await run('npm', ['run', 'build'], { cwd: root, timeout: 30000 });
  const result = await command(['render', golden, '--output', svgPath]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('');
}, 60000);
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe('real CLI', () => {
  it('migrates YAML and selects render layers while preserving structural geometry and score', async () => {
    const migrated = await command(['migrate', join(root, 'test/fixtures/migration/legacy.yaml')]);
    expect(migrated.code, migrated.stderr).toBe(0);
    expect(migrated.stdout).toContain('portograph: 2');
    const output = join(temp, 'overlay-only');
    const selected = await command(['render', '--layers', 'overlay', '-o', output, jsonPath]);
    expect(selected.code, selected.stderr).toBe(0);
    const svg = readFileSync(output, 'utf8');
    expect(svg).toContain('node-body');
    expect(svg).not.toContain('data-id="link-1"');
    expect(JSON.parse(readFileSync(`${output}.layout.json`, 'utf8'))).toEqual(JSON.parse(readFileSync(jsonPath, 'utf8')));
    expect(JSON.parse(readFileSync(`${output}.score.json`, 'utf8'))).toEqual(JSON.parse(readFileSync(scorePath, 'utf8')));
  });

  it('writes a draw.io document from the same layout, with the sidecars beside it', async () => {
    const output = join(temp, 'diagram.drawio');
    const written = await command(['render', '--format', 'drawio', '-o', output, jsonPath]);
    expect(written.code, written.stderr).toBe(0);
    expect(written.stdout).toBe('');
    const xml = readFileSync(output, 'utf8');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    // Uncompressed, as a plain `<mxGraphModel>` child. draw.io reads either, its own default is
    // uncompressed, and the published schema models only this form.
    expect(xml).toContain('<mxGraphModel');
    expect(xml).not.toContain('compressed="true"');
    // The two mandatory root cells, and the sidecars named from the stem of either extension.
    expect(xml).toContain('<mxCell id="0"/>');
    // With no `--icons`, the icons are draw.io's own bundled stencils, which resolve from the style
    // string and take paired `light-dark()` colours. No glyph is an embedded image, because an
    // embedded image cannot follow draw.io's dark appearance by any means.
    expect(xml).toContain('shape=mxgraph.cisco19.');
    expect(xml).not.toContain('shape=image');
    expect(JSON.parse(readFileSync(join(temp, 'diagram.layout.json'), 'utf8')))
      .toEqual(JSON.parse(readFileSync(jsonPath, 'utf8')));
    expect(JSON.parse(readFileSync(join(temp, 'diagram.score.json'), 'utf8')))
      .toEqual(JSON.parse(readFileSync(scorePath, 'utf8')));
    // The claim: choosing a format changes the artifact and nothing else. Same input, same layout,
    // same score — only the primary bytes differ.
    const svg = await command(['render', '-o', join(temp, 'diagram.svg'), jsonPath]);
    expect(svg.code, svg.stderr).toBe(0);
    expect(readFileSync(join(temp, 'diagram.svg'), 'utf8')).not.toBe(xml);
    expect(JSON.parse(readFileSync(join(temp, 'diagram.layout.json'), 'utf8')))
      .toEqual(JSON.parse(readFileSync(jsonPath, 'utf8')));
  });

  it('refuses more than 1000 authored nodes unless force is supplied', async () => {
    const input = join(temp, 'large.yaml');
    writeFileSync(input, ['portograph: 2', 'groups: {g: {tier: 0}}', 'nodes:',
      ...Array.from({ length: 1001 }, (_, i) => `  n${i}: {group: g}`), 'links: []'].join('\n'));
    const refused = await command(['layout', input]);
    expect(refused.code, refused.stderr).toBe(2);
    expect(refused.stderr).toContain('NODE_LIMIT');
    expect(refused.stdout).toBe('');
    const forced = await command(['layout', '--force', input]);
    expect(forced.code, forced.stderr).toBe(0);
    expect(Object.keys(JSON.parse(forced.stdout).nodes)).toHaveLength(1001);
    expect(forced.stderr).toContain('LARGE_DIAGRAM');
  }, 40000);

  it('writes one coherent golden artifact set and renders final JSON regardless of extension', async () => {
    const model = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const report = JSON.parse(readFileSync(scorePath, 'utf8'));
    expect(Object.keys(model.nodes)).toHaveLength(12);
    expect(model.links).toHaveLength(26);
    expect(report.snapshot.passed).toBe(true);
    expect(report.snapshot.metrics.crossings.count).toBe(0);
    const input = join(temp, 'saved.no-extension-rule');
    writeFileSync(input, JSON.stringify(model));
    const rendered = await command(['render', input]);
    expect(rendered.code, rendered.stderr).toBe(0);
    expect(rendered.stdout.trimEnd()).toBe(readFileSync(svgPath, 'utf8').trimEnd());
    const scored = await command(['score', input]);
    expect(scored.code, scored.stderr).toBe(0);
    expect(JSON.parse(scored.stdout).snapshot).toEqual(report.snapshot);
  });

  it('keeps geometry-locking CSS out of restored JSON rendering and emits no partial artifact', async () => {
    const model = JSON.parse(readFileSync(jsonPath, 'utf8'));
    model.document.css = '.node-body { stroke-width: 40px !important; }';
    const input = join(temp, 'forged-css.json'), output = join(temp, 'forged.svg');
    writeFileSync(input, JSON.stringify(model));
    const result = await command(['render', input, '--output', output]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/css is not normalised/i);
    expect(result.stdout).toBe('');
    expect(readdirSync(temp).filter(name => name.startsWith('forged.'))).toEqual([]);
  });

  it('reports computed gate failure as 1, or 0 when allowed, with the same complete artifacts', async () => {
    // A fixture that fails a gate today: `flank-two-peers` with a `secondary` tall enough that its
    // port's far end falls inside the primary block's far-end range. The block is one run of slots,
    // so no single place for that port satisfies G5 — ticket 21's recorded residue, a limitation
    // rather than a defect, which is why it is a stable choice here. Earlier inputs were retired as
    // their tickets landed: the shared-port fan at ticket 20, plain `flank-two-peers` at 21, and a
    // fan-track diagram at 42 and 43.
    const input = join(temp, 'shared.yaml');
    writeFileSync(input, `portograph: 2
profile: network
groups:
  tier-group: { tier: 0 }
  flank-group: { align: left, of: tier-group }
nodes:
  primary: { group: tier-group, ports: { side: left, list: [p, p] } }
  secondary: { group: tier-group, size: { width: 50, height: 55 }, ports: { side: left, list: [p] } }
  flank: { group: flank-group, ports: { side: right, list: [p, p, p] } }
links:
  - [flank.p#1, primary.p#1]
  - [flank.p#2, primary.p#2]
  - [flank.p#3, secondary.p#1]
`);
    const output = join(temp, 'shared.svg');
    const first = await command(['render', input, '-o', output]);
    expect(first.code, first.stderr).toBe(1);
    const report = JSON.parse(readFileSync(join(temp, 'shared.score.json'), 'utf8'));
    expect(report.snapshot.gates.G5.passed).toBe(false);
    const normal = await command(['score', join(temp, 'shared.layout.json')]);
    const allowed = await command(['score', '--allow-gate-failures', join(temp, 'shared.layout.json')]);
    expect(normal.code).toBe(1);
    expect(allowed.code).toBe(0);
    expect(JSON.parse(allowed.stdout)).toEqual(JSON.parse(normal.stdout));
  });

  it('rejects usage and input errors without writing stdout', async () => {
    for (const args of [['render'], ['render', golden, 'extra'], ['render', '--unknown', golden],
      ['render', '--layers', 'invalid', golden], ['render', join(temp, 'missing')], ['score', golden]]) {
      const result = await command(args);
      expect(result.code, result.stderr).toBe(2);
      expect(result.stdout).toBe('');
    }
  });

  it('keeps all existing artifacts when one output destination is invalid', async () => {
    const output = join(temp, 'existing.svg'), layout = join(temp, 'existing.layout.json');
    writeFileSync(output, 'original SVG');
    writeFileSync(layout, 'original layout');
    mkdirSync(join(temp, 'existing.score.json'));
    const result = await command(['render', jsonPath, '--output', output]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(readFileSync(output, 'utf8')).toBe('original SVG');
    expect(readFileSync(layout, 'utf8')).toBe('original layout');
    expect(readdirSync(temp).some(name => name.startsWith('.portograph-'))).toBe(false);
  });

  it('terminates real layout computation and its worker-host process at the command deadline', async () => {
    const input = join(temp, 'deadline.yaml'), output = join(temp, 'deadline.svg');
    writeFileSync(input, generateScaleYaml({ nodes: 1000 }).yaml);
    const started = Date.now();
    const result = await command(['render', input, '--output', output],
      { PORTOGRAPH_COMMAND_DEADLINE_MS: '500', PORTOGRAPH_PROGRESS: '1' });
    expect(result.code, result.stderr).toBe(3);
    expect(result.stderr).toContain('COMMAND_DEADLINE');
    expect(result.stderr).toContain('portograph: size took');
    expect(result.stderr).toContain('portograph: ELK worker started');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.stdout).toBe('');
    const match = /compute process (\d+)/.exec(result.stderr);
    expect(match).not.toBeNull();
    expect(() => process.kill(Number(match![1]), 0)).toThrow();
    expect(readdirSync(temp).filter(name => /^deadline\.(svg|layout\.json|score\.json)$/.test(name))).toEqual([]);
  }, 15000);

  it('writes the same bytes on two runs, and keeps the stage timings only on request', async () => {
    const [a, b] = [join(temp, 'det-a.svg'), join(temp, 'det-b.svg')];
    for (const path of [a, b]) expect((await command(['render', golden, '-o', path])).code).toBe(0);
    for (const suffix of ['.layout.json', '.score.json']) {
      expect(readFileSync(a.replace('.svg', suffix), 'utf8')).toBe(readFileSync(b.replace('.svg', suffix), 'utf8'));
    }
    expect(readFileSync(a, 'utf8')).toBe(readFileSync(b, 'utf8'));
    expect(readFileSync(a.replace('.svg', '.layout.json'), 'utf8')).not.toContain('durationMs');
    expect(JSON.parse(readFileSync(a.replace('.svg', '.score.json'), 'utf8')).runtime).toEqual({ stages: [] });
    const timed = join(temp, 'det-timed.svg');
    expect((await command(['render', '--timings', golden, '-o', timed])).code).toBe(0);
    expect(readFileSync(timed.replace('.svg', '.layout.json'), 'utf8')).toContain('durationMs');
    expect(readFileSync(timed.replace('.svg', '.score.json'), 'utf8')).toContain('"runtime"');
  }, 60000);

  it('names file, line and column for a schema error and for a syntax error, without a cascade', async () => {
    const schema = join(temp, 'schema.yaml');
    writeFileSync(schema, 'portograph: 2\ngroups:\n  g: { tier: 0 }\nnodes:\n  a:\n    group: g\n    colour: red\n');
    const unknown = await command(['layout', schema]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain(`UNKNOWN_KEY at ${schema}:7:5 ($.nodes.a.colour)`);
    const syntax = join(temp, 'syntax.yaml');
    writeFileSync(syntax, 'portograph: 2\ngroups:\n  g: { tier: 0\nnodes: {}\n');
    const broken = await command(['layout', syntax]);
    expect(broken.code).toBe(2);
    expect(broken.stderr).toMatch(new RegExp(`INVALID_YAML at ${syntax}:\\d+:\\d+:`));
    expect(broken.stderr.match(/portograph: error:/g)).toHaveLength(1);
  }, 30000);

  it('reads the document from stdin with -, names it <stdin> in diagnostics, and writes to stdout with -o -', async () => {
    const text = readFileSync(golden, 'utf8');
    const piped = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      const child = spawn(process.execPath, [cli, 'layout', '-', '-o', '-'], { cwd: temp });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', code => resolve({ code, stdout, stderr }));
      child.stdin.end(text);
    });
    expect(piped.code, piped.stderr).toBe(0);
    const direct = await command(['layout', golden]);
    expect(piped.stdout).toBe(direct.stdout);
    const bad = await new Promise<{ code: number | null; stderr: string }>(resolve => {
      const child = spawn(process.execPath, [cli, 'layout', '-'], { cwd: temp });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', code => resolve({ code, stderr }));
      child.stdin.end('portograph: 2\ngroups:\n  g: { tier: 0 }\nnodes:\n  a:\n    group: g\n    colour: red\n');
    });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('UNKNOWN_KEY at <stdin>:7:5 ($.nodes.a.colour)');
  }, 60000);

  it('writes diagnostics and status lines as one JSON object per line with --diagnostics json', async () => {
    const schema = join(temp, 'json.yaml');
    writeFileSync(schema, 'portograph: 2\ngroups:\n  g: { tier: 0 }\nnodes:\n  a:\n    group: g\n    colour: red\n');
    const result = await command(['layout', schema, '--diagnostics', 'json']);
    expect(result.code).toBe(2);
    const lines = result.stderr.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ kind: 'diagnostic', code: 'UNKNOWN_KEY', severity: 'error', path: '$.nodes.a.colour', source: schema, line: 7, column: 5 });
    expect(lines.every(line => typeof line.message === 'string' && typeof line.severity === 'string')).toBe(true);
    const wrote = await command(['render', golden, '-o', join(temp, 'json-out.svg'), '--diagnostics=json']);
    expect(wrote.code, wrote.stderr).toBe(0);
    expect(JSON.parse(wrote.stderr.trim().split('\n').at(-1)!)).toMatchObject({ kind: 'status', severity: 'info', code: 'WROTE' });
    const usage = await command(['layout', schema, '--diagnostics', 'json', '--nope']);
    expect(usage.code).toBe(2);
    expect(JSON.parse(usage.stderr.trim())).toMatchObject({ kind: 'status', severity: 'error', code: 'USAGE' });
  }, 60000);

  it('builds dist/index.js and dist/index.cjs with the export keys of src/index.ts', async () => {
    const wanted = Object.keys(await import('../../src/index.js')).sort();
    const esm = Object.keys(await import(join(root, 'dist/index.js'))).sort();
    const cjs = Object.keys(createRequire(import.meta.url)(join(root, 'dist/index.cjs'))).sort();
    expect(esm).toEqual(wanted);
    expect(cjs).toEqual(wanted);
  });
});

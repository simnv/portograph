import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
    // A fixture that fails a gate today: this one fails G6 on two counts, a fan track spaced off its
    // own members but not off `a.p`'s row (ticket 42) and two port anchors 10 px apart (ticket 43).
    // When those tickets land, swap in another failing input. `flank-two-peers` was used until
    // ticket 21, and the shared-port fan before that until ticket 20.
    const input = join(temp, 'shared.yaml');
    writeFileSync(input, `portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [{name: p, side: right, order: 0}, {name: r, side: right, order: 1}]}
  b: {group: g, ports: [{name: s, side: left, order: 0}, {name: t, side: left, order: 1}]}
  c: {group: g, ports: [{name: p, side: left, order: 0}]}
links: [[a.p, b.t], [a.r, b.s], [a.r, c.p]]
`);
    const output = join(temp, 'shared.svg');
    const first = await command(['render', input, '-o', output]);
    expect(first.code, first.stderr).toBe(1);
    const report = JSON.parse(readFileSync(join(temp, 'shared.score.json'), 'utf8'));
    expect(report.snapshot.gates.G6.passed).toBe(false);
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
});

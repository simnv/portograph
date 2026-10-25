import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const compareScript = resolve(__dirname, '../../scripts/gate-compare.mjs');
const HEADER = ['file', 'Q', 'X', 'W', 'gates', 'warn', 'routed', 'fb', 'edge', 'ob', 'bends', 'side', 'removed', 'labelBorder', 'hash'];
let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function sheet(overrides: Record<string, string> = {}): string {
  const cells: Record<string, string> = {
    file: 'goldens/a.yaml', Q: '0.5', X: '0', W: '100x100', gates: '-', warn: '-', routed: '1/1', fb: '0', edge: '0', ob: '0/0',
    bends: '0', side: '0', removed: '0', labelBorder: '0', hash: 'aaaaaaaaaaaa', ...overrides,
  };
  return HEADER.map(column => cells[column]).join('\t');
}

function compare(base: string, head: string): string {
  dir = mkdtempSync(join(tmpdir(), 'pg-compare-'));
  writeFileSync(join(dir, 'base.tsv'), `${HEADER.join('\t')}\n${base}\n`);
  writeFileSync(join(dir, 'head.tsv'), `${HEADER.join('\t')}\n${head}\n`);
  const result = spawnSync('node', [compareScript, join(dir, 'base.tsv'), join(dir, 'head.tsv')], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  return result.stdout;
}

it('judges a rise in labelBorder worse', () => {
  const out = compare(sheet(), sheet({ labelBorder: '2' }));
  expect(out).toMatch(/labelBorder\s+0\s+2\s+WORSE/);
  expect(out).toContain('worse: labelBorder 1');
});

it('does not judge a fall in labelBorder', () => {
  const out = compare(sheet({ labelBorder: '2' }), sheet());
  expect(out).not.toContain('WORSE');
});

it('shows a hash change as a changed cell and never judges it', () => {
  const out = compare(sheet(), sheet({ hash: 'bbbbbbbbbbbb' }));
  expect(out).toMatch(/hash\s+aaaaaaaaaaaa\s+bbbbbbbbbbbb/);
  expect(out).not.toContain('WORSE');
  expect(out).toContain('worse: none');
  expect(out.trimEnd().split('\n').at(-1)).toBe('1 sheets with a geometry change (hash)');
});

it('counts no geometry change when the hash stays', () => {
  const out = compare(sheet(), sheet({ Q: '0.6' }));
  expect(out.trimEnd().split('\n').at(-1)).toBe('0 sheets with a geometry change (hash)');
  expect(compare(sheet(), sheet())).toContain('0 sheets with a geometry change (hash)');
});

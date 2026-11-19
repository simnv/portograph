import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const compareScript = resolve(__dirname, '../../scripts/gate-compare.mjs');
const HEADER = ['file', 'Q', 'X', 'Xf', 'W', 'gates', 'warn', 'routed', 'fb', 'edge', 'ob', 'bends', 'side', 'removed', 'labelBorder', 'hash'];
let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function sheet(overrides: Record<string, string> = {}): string {
  const cells: Record<string, string> = {
    file: 'goldens/a.yaml', Q: '0.5', X: '0', Xf: '0', W: '100x100', gates: '-', warn: '-', routed: '1/1', fb: '0', edge: '0', ob: '0/0',
    bends: '0', side: '0', removed: '0', labelBorder: '0', hash: 'aaaaaaaaaaaa', ...overrides,
  };
  return HEADER.map(column => cells[column]).join('\t');
}

function run(base: string, head: string, baseHeader = HEADER): ReturnType<typeof spawnSync> {
  dir = mkdtempSync(join(tmpdir(), 'pg-compare-'));
  writeFileSync(join(dir, 'base.tsv'), `${baseHeader.join('\t')}\n${base}\n`);
  writeFileSync(join(dir, 'head.tsv'), `${HEADER.join('\t')}\n${head}\n`);
  return spawnSync('node', [compareScript, join(dir, 'base.tsv'), join(dir, 'head.tsv')], { encoding: 'utf8' });
}
function compare(base: string, head: string): string {
  const result = run(base, head);
  expect(result.status).toBe(0);
  return String(result.stdout);
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

// Architecture-2 ticket 40: X counts the crossings that are not faint; Xf, the faint crossings of a fan family, is printed and never judged.
it('prints a rise in Xf and does not judge it', () => {
  const out = compare(sheet(), sheet({ Xf: '9' }));
  expect(out).toMatch(/Xf\s+0\s+9/);
  expect(out).not.toContain('WORSE');
  expect(out).toContain('worse: none');
});

it('still judges a rise in X beside a rise in Xf', () => {
  const out = compare(sheet({ X: '3' }), sheet({ X: '4', Xf: '9' }));
  expect(out).toMatch(/X\s+3\s+4\s+WORSE/);
  expect(out).toContain('worse: crossings 1');
});

it('refuses a base without an Xf column: its X counts faint crossings too', () => {
  const old = HEADER.filter(column => column !== 'Xf');
  const row = old.map(column => ({ file: 'goldens/a.yaml', Q: '0.5', X: '0', W: '100x100', gates: '-', warn: '-', routed: '1/1', fb: '0', edge: '0', ob: '0/0',
    bends: '0', side: '0', removed: '0', labelBorder: '0', hash: 'aaaaaaaaaaaa' } as Record<string, string>)[column]).join('\t');
  const result = run(row, sheet(), old);
  expect(result.status).toBe(2);
  expect(String(result.stderr)).toContain('no Xf column');
});

// Architecture-2 ticket 86: a sheet only the head has is judged on its own.
const NEW = 'goldens/new.yaml';
/** The base holds goldens/a.yaml; the head holds it unchanged and `added` as a second sheet. */
const withNewSheet = (added: string): string => compare(sheet(), `${sheet()}\n${added}`);

it('flags a head-only ERROR row NEW-FAIL, with the error', () => {
  const out = withNewSheet(`${NEW}\tERROR no such node`);
  expect(out).toMatch(/goldens\/new\.yaml\s+\(sheet\)\s+-\s+ERROR no such node\s+NEW-FAIL/);
  expect(out).toContain('worse: new-fail 1');
});

it('flags a head-only TIMEOUT row NEW-FAIL', () => {
  expect(withNewSheet(`${NEW}\tTIMEOUT after 120 s`)).toMatch(/\(sheet\)\s+-\s+TIMEOUT after 120 s\s+NEW-FAIL/);
});

it('flags a head-only sheet with an error gate NEW-FAIL, with the gate id', () => {
  const out = withNewSheet(sheet({ file: NEW, gates: 'G4,G6' }));
  expect(out).toMatch(/goldens\/new\.yaml\s+gates\s+-\s+G4,G6\s+NEW-FAIL/);
  expect(out).toMatch(/goldens\/new\.yaml\s+\(sheet\)\s+-\s+only in head\s+NEW-FAIL/);
  expect(out).toContain('worse: new-fail 1');
});

it('flags a head-only sheet with removed links NEW-FAIL, and counts the sheet once', () => {
  const out = withNewSheet(sheet({ file: NEW, removed: '2', gates: 'G1' }));
  expect(out).toMatch(/goldens\/new\.yaml\s+removed\s+-\s+2\s+NEW-FAIL/);
  expect(out).toContain('worse: new-fail 1');
});

it('passes a clean head-only sheet: warnings and bends are not judged on a sheet with no base', () => {
  const out = withNewSheet(sheet({ file: NEW, warn: 'W3', bends: '4', X: '2' }));
  expect(out).toMatch(/goldens\/new\.yaml\s+\(sheet\)\s+-\s+only in head\s*$/m);
  expect(out).not.toContain('NEW-FAIL');
  expect(out).not.toContain('WORSE');
  expect(out).toContain('worse: none');
});

// Dense-16x9 ticket 56: the corpus column `fallback` is 1 when a default-on sheet published its option-off run.
const WITH_FALLBACK = [...HEADER.slice(0, -1), 'fallback', 'hash'];
function fallbackRow(fallback: string, overrides: Record<string, string> = {}): string {
  const cells: Record<string, string> = {
    file: 'goldens/a.yaml', Q: '0.5', X: '0', Xf: '0', W: '100x100', gates: '-', warn: '-', routed: '1/1', fb: '0', edge: '0', ob: '0/0',
    bends: '0', side: '0', removed: '0', labelBorder: '0', fallback, hash: 'aaaaaaaaaaaa', ...overrides,
  };
  return WITH_FALLBACK.map(column => cells[column]).join('\t');
}
function compareFallback(base: string, head: string, baseHeader = WITH_FALLBACK): string {
  dir = mkdtempSync(join(tmpdir(), 'pg-compare-'));
  writeFileSync(join(dir, 'base.tsv'), `${baseHeader.join('\t')}\n${base}\n`);
  writeFileSync(join(dir, 'head.tsv'), `${WITH_FALLBACK.join('\t')}\n${head}\n`);
  const result = spawnSync('node', [compareScript, join(dir, 'base.tsv'), join(dir, 'head.tsv')], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  return String(result.stdout);
}

it('judges a new fallback to the option-off run worse (dense-16x9 ticket 56)', () => {
  const out = compareFallback(fallbackRow('0'), fallbackRow('1', { hash: 'bbbbbbbbbbbb' }));
  expect(out).toMatch(/fallback\s+0\s+1\s+WORSE/);
  expect(out).toContain('worse: fallback 1');
});

it('reads a base with no fallback column as 0 (dense-16x9 ticket 56)', () => {
  const out = compareFallback(sheet(), fallbackRow('1', { hash: 'bbbbbbbbbbbb' }), HEADER);
  expect(out).toMatch(/fallback\s+-\s+1\s+WORSE/);
  expect(compareFallback(sheet(), fallbackRow('0'), HEADER)).toContain('no change');
});

it('flags a head-only sheet that falls back NEW-FAIL (dense-16x9 ticket 56)', () => {
  const out = compareFallback(fallbackRow('0'), `${fallbackRow('0')}\n${fallbackRow('1', { file: 'goldens/new.yaml' })}`);
  expect(out).toMatch(/goldens\/new\.yaml\s+fallback\s+-\s+1\s+NEW-FAIL/);
  expect(out).toContain('worse: new-fail 1');
});

it('judges an unlisted fallback worse when the head recovers from a base error (dense-16x9 ticket 56, review 1)', () => {
  const out = compareFallback('goldens/a.yaml\tERROR original failure', fallbackRow('1'));
  expect(out).toMatch(/goldens\/a\.yaml\s+fallback\s+-\s+1\s+WORSE/);
  expect(out).toContain('worse: fallback 1');
});

it('judges an unlisted fallback worse when the base had it too (dense-16x9 ticket 56, review 1)', () => {
  const out = compareFallback(fallbackRow('1'), fallbackRow('1', { hash: 'bbbbbbbbbbbb' }));
  expect(out).toMatch(/fallback\s+1\s+1\s+WORSE/);
  expect(out).toContain('worse: fallback 1');
});

it('refuses a fallback cell that is not 0 or 1 (dense-16x9 ticket 56, review 1)', () => {
  dir = mkdtempSync(join(tmpdir(), 'pg-compare-'));
  writeFileSync(join(dir, 'base.tsv'), `${WITH_FALLBACK.join('\t')}\n${fallbackRow('0')}\n`);
  writeFileSync(join(dir, 'head.tsv'), `${WITH_FALLBACK.join('\t')}\n${fallbackRow('yes')}\n`);
  const result = spawnSync('node', [compareScript, join(dir, 'base.tsv'), join(dir, 'head.tsv')], { encoding: 'utf8' });
  expect(result.status).toBe(2);
  expect(String(result.stderr)).toContain('fallback is not 0 or 1');
});

it('judges an unlisted fallback on an unchanged row (dense-16x9 ticket 56, review 2: the reviewer\'s two pairs)', () => {
  // Both TSVs hold the same row with fallback 1.
  const persistent = compareFallback(fallbackRow('1'), fallbackRow('1'));
  expect(persistent).toMatch(/fallback\s+1\s+1\s+WORSE/);
  expect(persistent).toContain('worse: fallback 1');
  // A base with no fallback column (read as 0) and otherwise equal cells.
  const legacy = compareFallback(sheet(), fallbackRow('1'), HEADER);
  expect(legacy).toMatch(/fallback\s+-\s+1\s+WORSE/);
  expect(legacy).toContain('worse: fallback 1');
});

const WITH_CHOICE = [...HEADER.slice(0, -1), 'fallback', 'choice', 'hash'];
function choiceRow(choice: string, overrides: Record<string, string> = {}): string {
  const cells: Record<string, string> = {
    file: 'goldens/a.yaml', Q: '0.5', X: '0', Xf: '0', W: '100x100', gates: '-', warn: '-', routed: '1/1', fb: '0', edge: '0', ob: '0/0',
    bends: '0', side: '0', removed: '0', labelBorder: '0', fallback: '0', choice, hash: 'aaaaaaaaaaaa', ...overrides,
  };
  return WITH_CHOICE.map(column => cells[column]).join('\t');
}
function compareChoice(base: string, head: string, baseHeader = WITH_CHOICE): { status: number | null; out: string; err: string } {
  dir = mkdtempSync(join(tmpdir(), 'pg-compare-'));
  writeFileSync(join(dir, 'base.tsv'), `${baseHeader.join('\t')}\n${base}\n`);
  writeFileSync(join(dir, 'head.tsv'), `${WITH_CHOICE.join('\t')}\n${head}\n`);
  const result = spawnSync('node', [compareScript, join(dir, 'base.tsv'), join(dir, 'head.tsv')], { encoding: 'utf8' });
  return { status: result.status, out: String(result.stdout), err: String(result.stderr) };
}

it('prints a growth choice and judges it worse by nothing (dense-16x9 ticket 60)', () => {
  const { status, out } = compareChoice(choiceRow('0', { bends: '4' }), choiceRow('1', { hash: 'bbbbbbbbbbbb' }));
  expect(status).toBe(0);
  expect(out).toMatch(/choice\s+0\s+1\s*$/m);
  expect(out).toContain('worse: none');
  // A choice that keeps the same geometry is a change of the choice cell alone, and no worse row.
  expect(compareChoice(choiceRow('1'), choiceRow('1')).out).toContain('no change');
});

it('reads a base written before the choice column (dense-16x9 ticket 60)', () => {
  const base = [...HEADER.slice(0, -1), 'fallback', 'hash'];
  const row = base.map(column => ({ file: 'goldens/a.yaml', Q: '0.5', X: '0', Xf: '0', W: '100x100', gates: '-', warn: '-', routed: '1/1', fb: '0', edge: '0', ob: '0/0',
    bends: '0', side: '0', removed: '0', labelBorder: '0', fallback: '0', hash: 'aaaaaaaaaaaa' } as Record<string, string>)[column]).join('\t');
  const { status, out } = compareChoice(row, choiceRow('1'), base);
  expect(status).toBe(0);
  expect(out).toContain('no change');
});

it('refuses a choice cell that is not 0 or 1 (dense-16x9 ticket 60)', () => {
  const { status, err } = compareChoice(choiceRow('0'), choiceRow('off'));
  expect(status).toBe(2);
  expect(err).toContain('choice is not 0 or 1');
});

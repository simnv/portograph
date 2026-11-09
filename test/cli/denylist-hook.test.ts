import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const script = resolve(__dirname, '../../.githooks/check-denylist.sh');
let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(listBody: string | null) {
  dir = mkdtempSync(join(tmpdir(), 'pg-deny-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  git('init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'ok\nsecret-HOST here\n');
  git('add', 'a.txt');
  if (listBody !== null) writeFileSync(join(dir, 'deny.list'), listBody);
  return spawnSync('sh', [script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PORTOGRAPH_DENYLIST: join(dir, listBody === null ? 'none' : 'deny.list') },
  });
}

it('fails on a hit, prints file:line and not the term', () => {
  const r = run('# c\n\nsecret-host\n');
  expect(r.status).toBe(1);
  expect(r.stdout).toContain('a.txt:2');
  expect(r.stdout.toLowerCase()).not.toContain('secret-host');
});

it('passes without a hit and skips silently when the file is absent', () => {
  expect(run('other\n').status).toBe(0);
  const r = run(null);
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
});

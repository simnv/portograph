import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fontDirectories, verdanaInstalled } from '../../bin/font-check.mjs';

const temp = mkdtempSync(join(tmpdir(), 'portograph-font-check-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe('Verdana check of the CLI', () => {
  it('finds a Verdana file in a directory, also in a sub-directory, and ignores other fonts', () => {
    const flat = join(temp, 'flat'), nested = join(temp, 'nested/truetype/msttcorefonts'), other = join(temp, 'other');
    for (const directory of [flat, nested, other]) mkdirSync(directory, { recursive: true });
    writeFileSync(join(flat, 'Verdana.ttf'), '');
    writeFileSync(join(nested, 'verdanab.ttf'), '');
    writeFileSync(join(other, 'Arial.ttf'), '');
    expect(verdanaInstalled([flat])).toBe(true);
    expect(verdanaInstalled([join(temp, 'nested')])).toBe(true);
    expect(verdanaInstalled([other])).toBe(false);
  });

  it('accepts a link to a Verdana file, and not a broken link', () => {
    const store = join(temp, 'store'), linked = join(temp, 'linked'), broken = join(temp, 'broken');
    for (const directory of [store, linked, broken]) mkdirSync(directory, { recursive: true });
    writeFileSync(join(store, 'verdana-regular.ttf'), '');
    symlinkSync(join(store, 'verdana-regular.ttf'), join(linked, 'Verdana.ttf'));
    symlinkSync(join(store, 'absent.ttf'), join(broken, 'Verdana.ttf'));
    expect(verdanaInstalled([linked])).toBe(true);
    expect(verdanaInstalled([broken])).toBe(false);
  });

  it('reports a missing or unreadable directory as not installed', () => {
    expect(verdanaInstalled([join(temp, 'absent')])).toBe(false);
    expect(verdanaInstalled([])).toBe(false);
  });

  it('names the usual font directories of each platform, and lets the environment replace them', () => {
    expect(fontDirectories('darwin', {}, '/home/u')).toContain('/System/Library/Fonts/Supplemental');
    expect(fontDirectories('linux', {}, '/home/u')).toContain('/usr/share/fonts');
    expect(fontDirectories('win32', { WINDIR: 'D:\\Win' }, 'C:\\Users\\u')[0]).toContain('Fonts');
    expect(fontDirectories('linux', { PORTOGRAPH_FONT_DIRS: '/a:/b' }, '/home/u')).toEqual(['/a', '/b']);
  });
});

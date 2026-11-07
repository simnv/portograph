import { expect, it } from 'vitest';
import { changedSheets, worseRows } from '../../scripts/gate-rows.mjs';

// Cells are two or more spaces apart, as gate:compare pads them.
const row = (...cells: string[]): string => cells.join('  ');
const OUTPUT = [
  row('file          ', 'column', 'base        ', 'head         '),
  row('goldens/a.yaml', 'bends ', '1           ', '2            ', 'WORSE'),
  row('goldens/a.yaml', 'hash  ', 'aaaaaaaaaaaa', 'bbbbbbbbbbbb'),
  row('goldens/b.yaml', 'W     ', '100x100     ', '120x100      ', 'WORSE'),
  row('goldens/n.yaml', '(sheet)', '-           ', 'ERROR no node', 'NEW-FAIL'),
  row('goldens/m.yaml', '(sheet)', '-           ', 'only in head ', 'NEW-FAIL'),
  row('goldens/m.yaml', 'gates  ', '-           ', 'G4           ', 'NEW-FAIL'),
  row('goldens/c.yaml', '(sheet)', '-           ', 'only in head'),
  row('goldens/z.yaml', '(sheet)', 'only in base', '-'),
  '',
  '5 of 9 sheets changed; worse: bends 1',
].join('\n');

it('reads the WORSE and NEW-FAIL rows of gate:compare output', () => {
  expect(worseRows(OUTPUT)).toEqual([
    { flag: 'WORSE', file: 'goldens/a.yaml', column: 'bends', base: '1', head: '2' },
    { flag: 'WORSE', file: 'goldens/b.yaml', column: 'W', base: '100x100', head: '120x100' },
    { flag: 'NEW-FAIL', file: 'goldens/n.yaml', column: '(sheet)', base: '-', head: 'ERROR no node' },
    { flag: 'NEW-FAIL', file: 'goldens/m.yaml', column: '(sheet)', base: '-', head: 'only in head' },
    { flag: 'NEW-FAIL', file: 'goldens/m.yaml', column: 'gates', base: '-', head: 'G4' },
  ]);
});

it('lists the sheets with a changed hash and the clean head-only sheets for the R3 report, sorted, once each', () => {
  expect(changedSheets(OUTPUT)).toEqual(['goldens/a.yaml', 'goldens/c.yaml', 'goldens/m.yaml']);
});

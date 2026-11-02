import { expect, it } from 'vitest';
import type { LayoutModel, LayoutPort } from '../../src/model/layout.js';
import { findPort } from '../../src/layout/row-paths.js';

// `findPort` guesses `ports[ordinal - 1]`, then the hint, then scans; every guess is checked on all four identity fields (ticket 59).
const port = (ref: LayoutPort['ref']): LayoutPort => ({ ref } as LayoutPort);
const model = (ports: LayoutPort[]): LayoutModel => ({ nodes: { a: { ports } } } as unknown as LayoutModel);

it('returns the port a scan finds, whatever stands at ordinal - 1', () => {
  const ports = [
    port({ node: 'a', name: 'up', ordinal: 1 }),
    port({ node: 'a', name: 'down', ordinal: 1 }),
    port({ node: 'a', anonymous: true, ordinal: 1 }),
    port({ node: 'a', name: 'down', ordinal: 2 }),
    port({ node: 'a', anonymous: true, ordinal: 2 }),
  ];
  const sheet = model(ports);
  // A named port at index 0 with ordinal 1 is not the anonymous port 1, nor a port of another name.
  expect(findPort(sheet, { node: 'a', anonymous: true, ordinal: 1 })).toBe(ports[2]);
  expect(findPort(sheet, { node: 'a', name: 'down', ordinal: 1 })).toBe(ports[1]);
  expect(findPort(sheet, { node: 'a', name: 'down', ordinal: 2 })).toBe(ports[3]);
  expect(findPort(sheet, { node: 'a', anonymous: true, ordinal: 2 })).toBe(ports[4]);
  expect(findPort(sheet, { node: 'a', name: 'up', ordinal: 1 })).toBe(ports[0]);
  // The same reference object again (hint path) and a fresh copy (guess or scan) give the same port.
  const ref = { node: 'a', name: 'down', ordinal: 2 };
  expect(findPort(sheet, ref)).toBe(ports[3]);
  expect(findPort(sheet, ref)).toBe(ports[3]);
  expect(findPort(sheet, { ...ref })).toBe(ports[3]);
});

it('returns undefined for a port or a node that does not exist', () => {
  const sheet = model([port({ node: 'a', name: 'up', ordinal: 1 })]);
  expect(findPort(sheet, { node: 'a', name: 'up', ordinal: 2 })).toBeUndefined();
  expect(findPort(sheet, { node: 'a', anonymous: true, ordinal: 1 })).toBeUndefined();
  expect(findPort(sheet, { node: 'b', name: 'up', ordinal: 1 })).toBeUndefined();
});

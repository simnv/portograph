import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseWithDiagnostics } from '../../src/parse/index.js';

const generator = fileURLToPath(new URL('../../scripts/gen-fabric.mjs', import.meta.url));
const generate = (spines: number, leafs: number, hosts: number, mode: string, sessions = false) => execFileSync(process.execPath, [
  generator, '--spines', String(spines), '--leafs', String(leafs), '--hostsPerLeaf', String(hosts), '--mode', mode,
  ...(sessions ? ['--sessions'] : []),
], { encoding: 'utf8' });

describe('fabric generator', () => {
  for (const mode of ['ibgp', 'ebgp']) for (const hosts of [0, 1]) for (const sessions of [false, true]) {
    it(`${mode}, hosts=${hosts}, sessions=${sessions}: parses, preserves incidence and emits deterministic bytes`, () => {
      const text = generate(2, 4, hosts, mode, sessions);
      expect(generate(2, 4, hosts, mode, sessions)).toBe(text);
      expect(text).toContain(sessions ? `# Sessions: 8 overlay (class flow), generated ${mode.toUpperCase()} spine-to-leaf sessions\n` : '# Sessions: none\n');
      const result = parseWithDiagnostics(text);
      expect(result.diagnostics).toEqual([]);
      if (!result.ok) throw new Error('Generated fabric did not parse');
      const { nodes, links, groups } = result.document;
      expect(Object.keys(nodes)).toEqual(['S1', 'S2', 'L1', 'L2', 'L3', 'L4', ...(hosts ? ['H1', 'H2', 'H3', 'H4'] : [])]);
      expect(Object.keys(nodes)).toHaveLength(2 + 4 + hosts * 4);
      const physical = links.filter(link => link.class !== 'flow');
      expect(physical).toHaveLength(2 * 4 + hosts * 4);
      expect(physical.map(link => `${link.from.node}-${link.to.node}`).sort()).toEqual([
        'S1-L1', 'S1-L2', 'S1-L3', 'S1-L4', 'S2-L1', 'S2-L2', 'S2-L3', 'S2-L4',
        ...(hosts ? ['H1-L1', 'H2-L2', 'H3-L3', 'H4-L4'] : []),
      ].sort());
      const overlays = links.filter(link => link.class === 'flow');
      expect(overlays).toHaveLength(sessions ? 8 : 0);
      expect(overlays.map(link => [link.from.node, link.to.node])).toEqual(sessions ? physical.slice(0, 8).map(link => [link.from.node, link.to.node]) : []);
      expect(overlays.every(link => link.label === mode.toUpperCase())).toBe(true);
      expect(new Set(links.map(link => link.id)).size).toBe(links.length);
      expect(links.every(link => 'anonymous' in link.from && link.from.anonymous && 'anonymous' in link.to && link.to.anonymous)).toBe(true);
      if (mode === 'ibgp') {
        expect(groups.as65000).toMatchObject({ label: 'AS 65000', members: ['spines', 'leafs'] });
        expect(groups.spines).toMatchObject({ tier: 0, canton: 'as65000' });
        expect(groups.leafs).toMatchObject({ tier: 1, canton: 'as65000' });
        expect(nodes.S1?.class).toBe('rr');
        expect(nodes.S2?.class).toBe('rr');
      } else {
        expect(groups.spines).toMatchObject({ tier: 0, label: 'AS 65100' });
        for (let leaf = 1; leaf <= 4; leaf++) {
          expect(groups[`leafs-L${leaf}`]).toMatchObject({ tier: 1, label: `AS ${65000 + leaf}` });
          expect(nodes[`L${leaf}`]?.group).toBe(`leafs-L${leaf}`);
        }
        expect(Object.values(nodes).some(node => node.class === 'rr')).toBe(false);
      }
      if (hosts) {
        expect(groups.hosts).toMatchObject({ tier: 2 });
        expect(groups.hosts?.canton).toBeUndefined();
      }
    });
  }

  it.each([
    [0, 4, 0, 'ibgp'], [1.5, 4, 0, 'ibgp'], [2, -1, 0, 'ibgp'],
    [2, 4, 2, 'ibgp'], [2, 4, 0, 'ospf'], [Number.MAX_SAFE_INTEGER + 1, 4, 0, 'ibgp'],
  ])('rejects invalid parameters %s %s %s %s without writing YAML', (spines, leafs, hosts, mode) => {
    const result = spawnSync(process.execPath, [generator, '--spines', String(spines), '--leafs', String(leafs), '--hostsPerLeaf', String(hosts), '--mode', mode], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage:');
  });

  it.each(['spines', 'leafs', 'hostsPerLeaf'].flatMap(name =>
    ['', '0x1', '1e0', ' 1', '+1', '1.0'].map(value => ({ name, value })),
  ))('rejects non-decimal --$name "$value"', ({ name, value }) => {
    const values = { spines: '2', leafs: '4', hostsPerLeaf: '0', mode: 'ibgp', [name]: value };
    const result = spawnSync(process.execPath, [generator, ...Object.entries(values).flatMap(([key, item]) => [`--${key}`, item])], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage:');
  });

  it.each([['--sessions', 'bad'], ['--sessions=bad']])('rejects a value supplied to the boolean session flag: %s', (...args) => {
    const result = spawnSync(process.execPath, [generator, '--spines', '2', '--leafs', '4', '--hostsPerLeaf', '0', '--mode', 'ibgp', ...args], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage:');
  });

  it('parses every matrix sheet', () => {
    for (const { spines, leafs } of [
      { spines: 1, leafs: 2 }, { spines: 2, leafs: 4 }, { spines: 4, leafs: 8 },
      { spines: 8, leafs: 32 }, { spines: 16, leafs: 64 },
    ]) {
      for (const hosts of [0, 1]) for (const mode of ['ibgp', 'ebgp']) {
        const name = `s${String(spines).padStart(2, '0')}-l${String(leafs).padStart(2, '0')}-h${hosts}-${mode}.yaml`;
        const text = generate(spines, leafs, hosts, mode);
        const result = parseWithDiagnostics(text);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(`${name} did not parse`);
        expect(Object.keys(result.document.nodes)).toHaveLength(spines + leafs + hosts * leafs);
        expect(result.document.links).toHaveLength(spines * leafs + hosts * leafs);
        expect(result.diagnostics.some(diagnostic => diagnostic.code === 'LINK_LIMIT')).toBe(spines === 16 && leafs === 64 && hosts === 0);
        if (mode === 'ebgp') expect(Object.entries(result.document.nodes).filter(([id]) => id.startsWith('S')).every(([, node]) => node.class === 'router')).toBe(true);
      }
    }
  });

  it.each([{ hosts: 0, mode: 'ibgp' }, { hosts: 1, mode: 'ebgp' }])('keeps the $mode session golden reproducible', ({ hosts, mode }) => {
    const text = readFileSync(new URL(`../../goldens/fabric/s02-l04-h${hosts}-${mode}.yaml`, import.meta.url), 'utf8');
    expect(text).toBe(generate(2, 4, hosts, mode, true));
  });
});

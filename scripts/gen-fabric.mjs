#!/usr/bin/env node
/**
 * Generate portograph data, without executing netlab or evaluating expressions.
 * Usage: node scripts/gen-fabric.mjs --spines 2 --leafs 4 --hostsPerLeaf 1 --mode ebgp [--sessions] > fabric.yaml
 * Reference: https://netlab.tools/plugins/fabric/ (read 2026-11-06).
 * Pinned documentation: https://github.com/ipspace/netlab/blob/4c3280eafa905a1f4b150a61f8d0e7484c64e1c6/docs/plugins/fabric.md
 * This portograph-owned subset adds one optional host per leaf and session overlays.
 */
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** @typedef {{ spines: number, leafs: number, hostsPerLeaf: 0 | 1, mode: 'ibgp' | 'ebgp', sessions?: boolean }} FabricParameters */

const REFERENCE = 'https://github.com/ipspace/netlab/blob/4c3280eafa905a1f4b150a61f8d0e7484c64e1c6/docs/plugins/fabric.md';
const USAGE = 'Usage: node scripts/gen-fabric.mjs --spines <positive integer> --leafs <positive integer> --hostsPerLeaf <0|1> --mode <ibgp|ebgp> [--sessions]';

/** @param {string} name @param {string | undefined} value @returns {number} */
function decimalInteger(name, value) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) throw new TypeError(`${name} must be written with decimal digits only`);
  return Number(value);
}

/** @param {FabricParameters} parameters @returns {string} */
export function generateFabric(parameters) {
  const { spines, leafs, hostsPerLeaf, mode, sessions = false } = parameters;
  for (const [name, value] of [['spines', spines], ['leafs', leafs]]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  }
  if (hostsPerLeaf !== 0 && hostsPerLeaf !== 1) throw new TypeError('hostsPerLeaf must be 0 or 1');
  if (mode !== 'ibgp' && mode !== 'ebgp') throw new TypeError('mode must be ibgp or ebgp');
  if (typeof sessions !== 'boolean') throw new TypeError('sessions must be a boolean');

  const lines = [
    '# Generator: scripts/gen-fabric.mjs',
    `# Parameters: spines=${spines} leafs=${leafs} hostsPerLeaf=${hostsPerLeaf} mode=${mode} sessions=${sessions}`,
    `# Netlab reference: ${REFERENCE}`,
    '# Reference page: https://netlab.tools/plugins/fabric/ (read 2026-11-06)',
    `# Physical links: ${spines * leafs + hostsPerLeaf * leafs}; nodes: ${spines + leafs + hostsPerLeaf * leafs}`,
    sessions ? `# Sessions: ${spines * leafs} overlay (class flow), generated ${mode.toUpperCase()} spine-to-leaf sessions` : '# Sessions: none',
    'portograph: 2',
    'profile: network',
    `title: "Fabric ${spines}x${leafs}, ${hostsPerLeaf} host per leaf, ${mode.toUpperCase()}"`,
    'groups:',
  ];
  if (mode === 'ibgp') {
    lines.push(
      '  as65000: { label: "AS 65000" }',
      '  spines: { tier: 0, label: spines, canton: as65000 }',
      '  leafs: { tier: 1, label: leafs, canton: as65000 }',
    );
  } else {
    lines.push('  spines: { tier: 0, label: "AS 65100" }');
    for (let leaf = 1; leaf <= leafs; leaf++) lines.push(`  leafs-L${leaf}: { tier: 1, label: "AS ${65000 + leaf}" }`);
  }
  if (hostsPerLeaf) lines.push('  hosts: { tier: 2, label: hosts }');
  lines.push('nodes:');
  for (let spine = 1; spine <= spines; spine++) lines.push(`  S${spine}: { group: spines, class: ${mode === 'ibgp' ? 'rr' : 'router'} }`);
  for (let leaf = 1; leaf <= leafs; leaf++) lines.push(`  L${leaf}: { group: ${mode === 'ibgp' ? 'leafs' : `leafs-L${leaf}`}, class: router, icon: router }`);
  if (hostsPerLeaf) for (let leaf = 1; leaf <= leafs; leaf++) lines.push(`  H${leaf}: { group: hosts, class: host, icon: server }`);
  lines.push('links:');
  // Keep physical fabric links first, then host links, as in netlab. Numeric declaration order is the final key.
  for (let spine = 1; spine <= spines; spine++) for (let leaf = 1; leaf <= leafs; leaf++) {
    lines.push(`  - { id: phy-S${spine}-L${leaf}, from: S${spine}, to: L${leaf} }`);
  }
  if (hostsPerLeaf) for (let leaf = 1; leaf <= leafs; leaf++) lines.push(`  - { id: phy-H${leaf}-L${leaf}, from: H${leaf}, to: L${leaf} }`);
  if (sessions) {
    let session = 0;
    for (let spine = 1; spine <= spines; spine++) for (let leaf = 1; leaf <= leafs; leaf++) {
      lines.push(`  - { id: ses-${String(++session).padStart(2, '0')}, from: S${spine}, to: L${leaf}, class: flow, label: ${mode.toUpperCase()} }`);
    }
  }
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: {
      spines: { type: 'string' }, leafs: { type: 'string' },
      hostsPerLeaf: { type: 'string' }, mode: { type: 'string' },
      sessions: { type: 'boolean', default: false }, help: { type: 'boolean' },
    } });
    if (values.help) process.stdout.write(`${USAGE}\n`);
    else process.stdout.write(generateFabric({
      spines: decimalInteger('spines', values.spines), leafs: decimalInteger('leafs', values.leafs),
      hostsPerLeaf: decimalInteger('hostsPerLeaf', values.hostsPerLeaf), mode: values.mode, sessions: values.sessions,
    }));
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    process.exitCode = 2;
  }
}

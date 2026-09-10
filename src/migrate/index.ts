import { stringify } from 'yaml';
import { parseWithDiagnostics, ParseError } from '../parse/index.js';
import type { ParseOptions, SourceDiagnostic } from '../parse/index.js';
import { Validation } from '../parse/validation.js';

export type MigrationResult =
  | { ok: true; yaml: string; diagnostics: SourceDiagnostic[] }
  | { ok: false; diagnostics: SourceDiagnostic[] };

function copyStrings(input: Map<string, unknown>, output: Map<string, unknown>, keys: readonly string[], path: string, v: Validation): void {
  for (const key of keys) if (input.has(key)) {
    const value = v.string(input.get(key), `${path}.${key}`);
    if (value !== undefined) output.set(key, value);
  }
}

function warnDropped(input: Map<string, unknown>, supported: readonly string[], path: string, v: Validation): void {
  for (const key of input.keys()) if (!supported.includes(key)) v.report('MIGRATION_IGNORED', `${path}.${key}`, `Legacy ${key} has no schema-v2 equivalent and was omitted`, 'warning');
}

/** Resolve each legacy occurrence by name before emitting any v2 endpoint. */
export function migrateWithDiagnostics(text: string, options: ParseOptions = {}): MigrationResult {
  const v = new Validation();
  const root = v.map(v.yaml(text), '$');
  v.keys(root, ['diagram'], '$');
  const legacy = v.map(root.get('diagram'), '$.diagram');
  warnDropped(legacy, ['css', 'locations', 'nodes', 'links'], '$.diagram', v);
  const output = new Map<string, unknown>([['portograph', 2]]);
  copyStrings(legacy, output, ['css'], '$.diagram', v);
  const groups = new Map<string, Map<string, unknown>>();
  const groupPaths = new Map<string, string>();
  for (const [index, value] of v.list(legacy.has('locations') ? legacy.get('locations') : [], '$.diagram.locations').entries()) {
    const path = `$.diagram.locations[${index}]`;
    const fields = v.map(value, path);
    const id = v.identifier(fields.get('id'), `${path}.id`);
    if (id === undefined) continue;
    if (groups.has(id)) { v.report('MIGRATION_DUPLICATE_ID', `${path}.id`, `Duplicate location ${id}`); continue; }
    const group = new Map<string, unknown>();
    copyStrings(fields, group, ['label'], path, v);
    warnDropped(fields, ['id', 'label'], path, v);
    groups.set(id, group); groupPaths.set(id, path);
  }
  output.set('groups', groups);
  const nodes = new Map<string, Map<string, unknown>>();
  const interfaces = new Map<string, number>();
  const nodeGroups = new Map<string, string>();
  for (const [index, value] of v.list(legacy.get('nodes'), '$.diagram.nodes').entries()) {
    const path = `$.diagram.nodes[${index}]`;
    const fields = v.map(value, path);
    const id = v.identifier(fields.get('id'), `${path}.id`);
    if (id === undefined) continue;
    if (nodes.has(id)) { v.report('MIGRATION_DUPLICATE_ID', `${path}.id`, `Duplicate node ${id}`); continue; }
    const node = new Map<string, unknown>();
    const group = v.identifier(fields.get('location'), `${path}.location`);
    if (group !== undefined) { node.set('group', group); nodeGroups.set(id, group); }
    copyStrings(fields, node, ['class', 'description', 'icon'], path, v);
    warnDropped(fields, ['id', 'location', 'class', 'description', 'icon', 'interfaces'], path, v);
    if (fields.has('interfaces')) {
      const ports: Map<string, unknown>[] = [];
      for (const [portIndex, portValue] of v.list(fields.get('interfaces'), `${path}.interfaces`).entries()) {
        const portPath = `${path}.interfaces[${portIndex}]`;
        const portFields = v.map(portValue, portPath);
        const name = v.identifier(portFields.get('name'), `${portPath}.name`);
        if (name === undefined) continue;
        const port = new Map<string, unknown>([['name', name]]);
        if (portFields.has('side')) {
          const side = v.choice(portFields.get('side'), ['top', 'right', 'bottom', 'left'], `${portPath}.side`);
          if (side !== undefined) port.set('side', side);
        }
        warnDropped(portFields, ['name', 'side'], portPath, v);
        ports.push(port);
        const key = `${id}.${name}`;
        interfaces.set(key, (interfaces.get(key) ?? 0) + 1);
      }
      node.set('ports', ports);
    }
    nodes.set(id, node);
  }
  output.set('nodes', nodes);
  const usage = new Map<string, number>();
  const peers = new Map<string, Map<string, number>>();
  function resolve(value: unknown, path: string): { endpoint: string; group?: string } | undefined {
    const text = v.string(value, path);
    if (text === undefined) return undefined;
    const match = /^([A-Za-z0-9][A-Za-z0-9_-]*)\s+([A-Za-z0-9][A-Za-z0-9_-]*)$/.exec(text.trim());
    const node = match?.[1], name = match?.[2];
    if (node === undefined || name === undefined) { v.report('MIGRATION_ENDPOINT', path, 'Expected "node interfaceName"'); return undefined; }
    const key = `${node}.${name}`;
    const ordinal = (usage.get(key) ?? 0) + 1;
    if (!interfaces.has(key)) { v.report('UNKNOWN_REFERENCE', path, `Unknown legacy interface ${text}`); return undefined; }
    if (ordinal > (interfaces.get(key) ?? 0)) { v.report('MIGRATION_INTERFACE_EXHAUSTED', path, `No unused interface ${text}; cannot preserve the wiring`); return undefined; }
    usage.set(key, ordinal);
    const result: { endpoint: string; group?: string } = { endpoint: `${key}#${ordinal}` };
    const group = nodeGroups.get(node);
    if (group !== undefined) result.group = group;
    return result;
  }
  const links: unknown[][] = [];
  for (const [index, value] of v.list(legacy.has('links') ? legacy.get('links') : [], '$.diagram.links').entries()) {
    const path = `$.diagram.links[${index}]`;
    const fields = v.map(value, path);
    warnDropped(fields, ['source', 'target', 'class', 'description'], path, v);
    const from = resolve(fields.get('source'), `${path}.source`);
    const to = resolve(fields.get('target'), `${path}.target`);
    const linkOptions = new Map<string, unknown>();
    copyStrings(fields, linkOptions, ['class'], path, v);
    if (fields.has('description')) {
      const label = v.string(fields.get('description'), `${path}.description`);
      if (label !== undefined) linkOptions.set('label', label);
    }
    if (from && to) {
      links.push(linkOptions.size ? [from.endpoint, to.endpoint, linkOptions] : [from.endpoint, to.endpoint]);
      if (from.group !== undefined && to.group !== undefined && from.group !== to.group) {
        for (const [a, b] of [[from.group, to.group], [to.group, from.group]]) if (a !== undefined && b !== undefined) {
          const counts = peers.get(a) ?? new Map<string, number>();
          counts.set(b, (counts.get(b) ?? 0) + 1); peers.set(a, counts);
        }
      }
    }
  }
  output.set('links', links);
  const guesses = new Map<string, 'left' | 'right'>();
  for (const id of groups.keys()) {
    const lower = id.toLowerCase();
    if (lower.includes('left')) guesses.set(id, 'left');
    else if (lower.includes('right')) guesses.set(id, 'right');
  }
  const tierIds = [...groups.keys()].filter(id => !guesses.has(id));
  const occupied = new Set<string>();
  for (const [id, side] of guesses) {
    const path = groupPaths.get(id) ?? '$.diagram.locations';
    const counts = peers.get(id);
    // Stable declaration-order tie break; never creates or changes links.
    const target = [...tierIds].sort((a, b) => (counts?.get(b) ?? 0) - (counts?.get(a) ?? 0))[0];
    if (target === undefined || occupied.has(`${target}.${side}`)) {
      v.report('MIGRATION_FLANK_UNRESOLVED', path, `Location ${id} suggests a ${side} flank; no unambiguous available tier target, so it remains a tier group`, 'warning');
      continue;
    }
    occupied.add(`${target}.${side}`);
    groups.get(id)?.set('align', side); groups.get(id)?.set('of', target);
    v.report('MIGRATION_FLANK_GUESS', path, `Guessed ${id} as a ${side} flank of ${target}; confirm this relation`, 'warning');
  }
  const yaml = stringify(output, { lineWidth: 0 });
  if (!v.failed) {
    const parsed = parseWithDiagnostics(yaml, options.force === undefined ? {} : { force: options.force });
    v.diagnostics.push(...parsed.diagnostics);
  }
  for (const diagnostic of v.diagnostics) options.onDiagnostic?.(diagnostic);
  return v.failed ? { ok: false, diagnostics: v.diagnostics } : { ok: true, yaml, diagnostics: v.diagnostics };
}

/** Emit schema-v2 YAML; use the result variant or callback to retain warnings. */
export function migrate(text: string, options: ParseOptions = {}): string {
  const result = migrateWithDiagnostics(text, options);
  if (!result.ok) throw new ParseError(result.diagnostics);
  return result.yaml;
}

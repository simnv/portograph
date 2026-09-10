import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse as yamlParse, stringify } from 'yaml';
import { migrate, migrateWithDiagnostics } from '../../src/migrate/index.js';
import { parse } from '../../src/parse/index.js';

it('migrates the independent mixed-name legacy fixture to explicit name-local ordinals', () => {
  const legacy = readFileSync('test/fixtures/migration/legacy.yaml', 'utf8');
  const expected = readFileSync('test/fixtures/migration/expected-v2.yaml', 'utf8');
  const result = migrate(legacy);
  expect(yamlParse(result)).toEqual(yamlParse(expected));
  expect(parse(result)).toEqual(parse(expected));
  expect(result).not.toContain('.*');
});

it('infers a flank target from linked tier groups and warns that the relation was guessed', () => {
  const result = migrateWithDiagnostics(stringify({ diagram: { locations: [{ id: 'left-edge' }, { id: 'core' }], nodes: [{ id: 'a', location: 'left-edge', interfaces: [{ name: 'p' }] }, { id: 'b', location: 'core', interfaces: [{ name: 'p' }] }], links: [{ source: 'a p', target: 'b p', description: 'feed', class: 'physical' }] } }));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(yamlParse(result.yaml).groups['left-edge']).toEqual({ align: 'left', of: 'core' });
  expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'MIGRATION_FLANK_GUESS', severity: 'warning' })]));
  expect(parse(result.yaml).links[0]).toMatchObject({ label: 'feed', class: 'physical' });
});

it.each([
  {}, { diagram: null }, { diagram: { locations: {}, nodes: [] } },
  { diagram: { locations: null, nodes: [] } }, { diagram: { locations: [], nodes: [], links: null } },
  { diagram: { locations: [{ id: 'g' }], nodes: [{ id: 'a' }] } },
  { diagram: { locations: [{ id: 'g' }], nodes: [{ id: 'a', location: 'g', interfaces: [{ name: 'p' }] }], links: [{ source: 'a p', target: 'a p' }] } },
  { diagram: { locations: [{ id: 'g' }], nodes: [{ id: 'a', location: 'g' }], links: [{ source: 'a missing', target: 'a missing' }] } },
  { diagram: { locations: [{ id: '__proto__' }], nodes: [] } },
])('diagnoses invalid migration input without inventing wiring: %j', value => {
  const result = migrateWithDiagnostics(stringify(value));
  expect(result.ok).toBe(false);
  expect(result.diagnostics.some(d => d.severity === 'error' && d.path.startsWith('$'))).toBe(true);
});

it('does not invent flank wiring when no tier group exists', () => {
  const result = migrateWithDiagnostics(stringify({ diagram: { locations: [{ id: 'left-edge' }], nodes: [{ id: 'a', location: 'left-edge' }], links: [] } }));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(yamlParse(result.yaml).groups['left-edge']).not.toHaveProperty('of');
  expect(result.diagnostics.some(d => d.code === 'MIGRATION_FLANK_UNRESOLVED')).toBe(true);
});

it('preserves numeric declaration order and warns about omitted legacy geometry', () => {
  const warnings: string[] = [];
  const yaml = migrate('diagram:\n  width: 200\n  locations: [{id: "10"}, {id: "2"}]\n  nodes: [{id: "30", location: "10", fx: 50}, {id: "3", location: "10"}]\n  links: []', { onDiagnostic: d => warnings.push(d.code) });
  const doc = parse(yaml);
  expect(doc.groupOrder).toEqual(['10', '2']);
  expect(doc.nodeOrder).toEqual(['30', '3']);
  expect(warnings.filter(code => code === 'MIGRATION_IGNORED')).toHaveLength(2);
});

it.each([
  [{ locations: [{ id: 'g' }, { id: 'g' }], nodes: [] }, 'MIGRATION_DUPLICATE_ID'],
  [{ locations: [{ id: 'g' }], nodes: [{ id: 'a', location: 'g' }, { id: 'a', location: 'g' }] }, 'MIGRATION_DUPLICATE_ID'],
  [{ locations: [{ id: 'g' }], nodes: [{ id: 'a', location: 'g' }], links: [{ source: 'a', target: 'a' }] }, 'MIGRATION_ENDPOINT'],
  [{ locations: [{ id: 'g' }], nodes: [{ id: 'a', location: 'missing' }] }, 'UNKNOWN_REFERENCE'],
])('reports migration-specific diagnostics: %j', (diagram, code) => {
  const result = migrateWithDiagnostics(stringify({ diagram }));
  expect(result.ok).toBe(false);
  expect(result.diagnostics.some(d => d.code === code)).toBe(true);
});

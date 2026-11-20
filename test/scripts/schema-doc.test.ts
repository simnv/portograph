import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { schemaGaps } from '../../scripts/schema-doc-lib.mjs';

// Retro 2026-11, ticket 03: the lint step `scripts/check-schema-doc.mjs` reads every key the parser accepts and finds it in its section of the schema doc.
const source = readFileSync(new URL('../../src/parse/index.ts', import.meta.url), 'utf8');
const doc = readFileSync(new URL('../../docs/design/schema.md', import.meta.url), 'utf8');

describe('the schema doc names every key the parser accepts', () => {
  it('has no gap on the repo, and reads every section the parser has a list for', () => {
    const { gaps, found } = schemaGaps(source, doc);
    expect(gaps).toEqual([]);
    expect([...new Set(found.map(item => item.section))].sort()).toEqual(['Group', 'Link', 'Node', 'Top level']);
    // The settings loops count too: the nine layout keys and the render key.
    expect(found.filter(item => item.where.includes('(layout.')).map(item => item.key).sort()).toEqual(
      ['aspect', 'autoArrange', 'corridorRowOrder', 'farEndPull', 'feedOrder', 'maxWidth', 'moveBeforeGrow', 'nodeContent', 'overlayOverBodies']);
    expect(found.filter(item => item.where.includes('(render.')).map(item => item.key)).toEqual(['anonymousPortMarker']);
  });

  it('fails with the key and the section when a row goes, a section goes, or a new list is not mapped', () => {
    const noWeight = doc.split('\n').filter(line => !line.startsWith('| `weight` |')).join('\n');
    expect(schemaGaps(source, noWeight).gaps).toEqual([expect.stringMatching(/^weight: accepted at src\/parse\/index\.ts:\d+ \(links\), no row or named mention in "## Link" of docs\/design\/schema\.md$/)]);
    expect(schemaGaps(source, doc.replace('## Meta', '## Metadata')).gaps).toEqual(['docs/design/schema.md: no section "## Meta"']);
    const extra = `${source}\nfunction overlaysOf(fields: Map<string, unknown>, v: Validation): void { v.keys(fields, ['mode'], '$.overlays'); }\n`;
    expect(schemaGaps(extra, doc).gaps).toEqual([expect.stringMatching(/\(overlaysOf\): a v\.keys list in a function the check does not map/)]);
  });
});

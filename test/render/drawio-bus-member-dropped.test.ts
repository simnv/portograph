import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { drawio, layout, parse } from '../../src/index.js';
import { linkIds } from '../../src/model/index.js';
import type { Diagnostic, LayoutModel } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const mesh = readFileSync(new URL('../../goldens/synthetic/a-full-mesh-on-one-row-draws-as-one-bus.yaml', import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> =>
  layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const warnings = (model: LayoutModel): Diagnostic[] => {
  const found: Diagnostic[] = [];
  drawio(model, { onDiagnostic: item => { if (item.code === 'DRAWIO_BUS_MEMBER_DROPPED') found.push(item); } });
  return found;
};

describe('the draw.io export reports the meta of a mesh bus member (contract section 5)', () => {
  it('names the member links that carry meta, and says to put meta on the ports', async () => {
    const yaml = mesh.replace('{ from: n1, to: n2, class: sync }', '{ from: n1, to: n2, class: sync, meta: { circuit: c1 } }');
    const model = await run(yaml);
    expect(model.links.filter(link => link.meshBus !== undefined)).toHaveLength(10);
    const found = warnings(model);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('warning');
    expect(found[0]!.stage).toBe('render');
    const withMeta = model.links.find(link => link.meshBus !== undefined && model.document.links[link.sourceIndex]!.meta !== undefined)!;
    expect(found[0]!.message).toContain(`Links: ${linkIds(model.document)[withMeta.sourceIndex]!}`);
    expect(found[0]!.message).toContain('has no link cell');
    expect(found[0]!.message).toContain('meta is not in the draw.io file');
    expect(found[0]!.message).toContain('put binding meta on the member ports');
  }, 60000);

  it('is silent for a mesh whose members carry a class and no meta', async () => {
    const model = await run(mesh);
    expect(model.links.filter(link => link.meshBus !== undefined)).toHaveLength(10);
    expect(warnings(model)).toEqual([]);
  }, 60000);

  it('is silent when no link is a bus member, also when a link carries meta and class', async () => {
    const yaml = mesh.replaceAll(', class: sync', '').replace('- [core, n1]', '- { from: core, to: n1, class: x, meta: { a: b } }');
    const model = await run(yaml);
    expect(model.links.filter(link => link.meshBus !== undefined)).toEqual([]);
    expect(warnings(model)).toEqual([]);
  }, 60000);
});

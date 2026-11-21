import type { Meta, NormalisedDocument } from './document.js';

/**
 * The rules for a `meta:` map, in one place (R1). The YAML reader applies them to what an author wrote, and restore applies them to
 * the document a layout JSON carries, so an edited file cannot reach the draw.io writer with a key it would write as invalid XML.
 */
export interface MetaFault { code: 'BAD_META_KEY' | 'RESERVED_META_KEY' | 'INVALID_TYPE'; message: string }

/** A meta key is an XML attribute name a draw.io cell can carry without a namespace. */
const META_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** Keys draw.io or the binding contract own on a cell (docs/drawio-binding-contract.md). */
const RESERVED_META = /^(?:pg-.*|id|label|placeholders|xml.*)$/i;

/** Why `key` cannot be a meta key, or `undefined` when it can. */
export function metaKeyFault(key: string): MetaFault | undefined {
  if (!META_KEY.test(key)) return { code: 'BAD_META_KEY', message: 'A meta key starts with a letter or an underscore and contains letters, digits, underscores or hyphens' };
  if (RESERVED_META.test(key)) return { code: 'RESERVED_META_KEY', message: `The meta key ${key} is reserved; the pg- prefix, id, label, placeholders and xml are not available` };
  return undefined;
}

/** Why `value` cannot be a meta value, or `undefined` when it can: a string, a finite number or a boolean. */
export function metaValueFault(value: unknown): MetaFault | undefined {
  if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return undefined;
  return { code: 'INVALID_TYPE', message: 'Expected a string, a finite number or a boolean' };
}

const isMap = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The first fault of every `meta` map of a saved document (root, groups, frames, nodes, ports and links), with the JSON path of the field,
 * or `undefined`. The maps are read as saved: no key is trusted because the YAML reader once accepted it.
 */
export function documentMetaFault(document: NormalisedDocument): { path: string; fault: MetaFault } | undefined {
  const check = (value: unknown, path: string): { path: string; fault: MetaFault } | undefined => {
    if (value === undefined) return undefined;
    if (!isMap(value)) return { path, fault: { code: 'INVALID_TYPE', message: 'Expected a map of meta keys' } };
    for (const [key, item] of Object.entries(value)) {
      const fault = metaKeyFault(key) ?? metaValueFault(item);
      if (fault !== undefined) return { path: `${path}.${key}`, fault };
    }
    return undefined;
  };
  const found = check((document as { meta?: unknown }).meta, '$.meta');
  if (found !== undefined) return found;
  const owners: [string, Record<string, { meta?: Meta }> | undefined][] = [['groups', document.groups], ['frames', document.frames], ['nodes', document.nodes]];
  for (const [kind, table] of owners) {
    for (const [id, item] of Object.entries(table ?? {})) {
      const own = check(item?.meta, `$.${kind}.${id}.meta`);
      if (own !== undefined) return own;
      if (kind !== 'nodes') continue;
      const ports = (item as { ports?: { meta?: Meta }[] }).ports ?? [];
      for (const [index, port] of ports.entries()) {
        const fault = check(port?.meta, `$.nodes.${id}.ports[${index}].meta`);
        if (fault !== undefined) return fault;
      }
    }
  }
  for (const [index, link] of (document.links ?? []).entries()) {
    const fault = check(link?.meta, `$.links[${index}].meta`);
    if (fault !== undefined) return fault;
  }
  return undefined;
}

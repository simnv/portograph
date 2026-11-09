import type { Meta, NormalisedDocument, NormalisedLink } from '../model/index.js';
import { orderedGroupIds, orderedNodeIds } from '../model/index.js';

/** An authored link as the parser holds it before its endpoints are resolved. */
export interface UnresolvedLink { index: number; fromValue: unknown; toValue: unknown; options: Partial<NormalisedLink> }

/** What an authored endpoint names, read without diagnostics: a group, or a node with an optional port name (`*` for any) and ordinal. */
interface EndText { group?: string; node?: string; name?: string; ordinal?: number }

function endText(value: unknown, doc: NormalisedDocument): EndText {
  if (typeof value === 'string') {
    const match = /^([A-Za-z0-9][A-Za-z0-9_-]*)(?:\.([A-Za-z0-9][A-Za-z0-9_-]*|\*)(?:#([1-9][0-9]*))?)?$/.exec(value);
    if (!match) return {};
    if (match[2] === undefined && Object.hasOwn(doc.groups, match[1]!)) return { group: match[1]! };
    return { node: match[1]!, ...(match[2] === undefined ? {} : { name: match[2] }), ...(match[3] === undefined ? {} : { ordinal: Number(match[3]) }) };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const fields = value as Record<string, unknown>;
  if (typeof fields.group === 'string') return { group: fields.group };
  return {
    ...(typeof fields.node === 'string' ? { node: fields.node } : {}),
    ...(typeof fields.port === 'string' ? { name: fields.port } : {}),
    ...(typeof fields.ordinal === 'number' ? { ordinal: fields.ordinal } : {}),
  };
}

/** Object keys in code-unit order, so equal metadata gives equal text. */
function canonical(value: Meta | unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, canonical(item)]));
}

/**
 * The canonical order of the links of a document (decision review D-Q1; ticket DR-04): link order is never input. Keys, in order:
 * the smaller declared rank of the two ends, then the larger (nodes by the declaration order of their group, then by their own
 * declaration order inside the group; then group ends in declaration order; the
 * direction of the link is no key), the rank of the port each of the two ends names with its ordinal in its node's authored list (a
 * wildcard, an unnumbered name and a bare end rank before every numbered port), and last the content of the link (its two ends in
 * that order, class, route, label, weight, id, metadata, and last its direction). Two links equal in every key are the same link twice, so their order
 * changes nothing. The position of a link in `links` is no key.
 */
export function canonicalLinkOrder<T extends UnresolvedLink>(doc: NormalisedDocument, records: readonly T[]): T[] {
  // A node ranks by the declaration order of its group, then by its own declaration order inside that group (user ruling 2026-11-09):
  // the interleaving of nodes of different groups in `nodes` is no key, so it does not move a link.
  const groupAt = new Map(orderedGroupIds(doc).map((id, index) => [id, index]));
  const declared = orderedNodeIds(doc), nodeAt = new Map(declared.map((id, index) => [id, index]));
  const grouped = [...declared].sort((a, b) => (groupAt.get(doc.nodes[a]!.group) ?? -1) - (groupAt.get(doc.nodes[b]!.group) ?? -1) || nodeAt.get(a)! - nodeAt.get(b)!);
  const nodes = new Map(grouped.map((id, index) => [id, index]));
  const groups = new Map(orderedGroupIds(doc).map((id, index) => [id, nodes.size + index]));
  const rank = (end: EndText): number => end.group !== undefined ? groups.get(end.group) ?? -1 : end.node !== undefined ? nodes.get(end.node) ?? -1 : -1;
  const portRank = (end: EndText): number => {
    if (end.node === undefined || end.name === undefined || end.name === '*' || end.ordinal === undefined) return -1;
    return Object.hasOwn(doc.nodes, end.node) ? doc.nodes[end.node]!.ports.findIndex(port => port.name === end.name && port.ordinal === end.ordinal) : -1;
  };
  const keyed = records.map(record => {
    const from = endText(record.fromValue, doc), to = endText(record.toValue, doc);
    const f = rank(from), t = rank(to), pf = portRank(from), pt = portRank(to);
    // The direction of a link is no key but the last: the end with the smaller declared rank comes first (on equal ranks, the
    // smaller text), and the content reads the two ends in that order.
    const fromText = JSON.stringify(from), toText = JSON.stringify(to);
    const flip = f > t || (f === t && fromText > toText);
    const ranks = flip ? [t, f, pt, pf] : [f, t, pf, pt];
    const { id, class: cls, route, label, weight, meta } = record.options;
    const content = JSON.stringify([flip ? toText : fromText, flip ? fromText : toText, cls ?? null, route ?? null, label ?? null,
      weight ?? null, id ?? null, canonical(meta ?? null), flip ? 1 : 0]);
    return { record, ranks, content };
  });
  // Last key: the content text in code-unit order. Records equal in it are interchangeable.
  return keyed.sort((a, b) => {
    for (let i = 0; i < a.ranks.length; i++) if (a.ranks[i] !== b.ranks[i]) return a.ranks[i]! - b.ranks[i]!;
    return a.content < b.content ? -1 : a.content > b.content ? 1 : 0;
  }).map(item => item.record);
}

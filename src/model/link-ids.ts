import type { Endpoint, NormalisedDocument } from './document.js';

/**
 * The name of one link end that does not depend on YAML order: `node:port` for a named port
 * (`node:port#n` for the n-th port of that name, n > 1), the node id for an anonymous port, and the
 * group id for a group end. An anonymous port's ordinal is given in link order, so it is left out.
 * Node and group ids share one namespace, so a bare id is never ambiguous.
 */
export function endpointId(end: Endpoint): string {
  if (end.group !== undefined) return end.group;
  if (end.anonymous === true) return end.node;
  return `${end.node}:${end.name}${end.ordinal > 1 ? `#${end.ordinal}` : ''}`;
}

/**
 * One stable id per link, in document order (docs/drawio-binding-contract.md). An author id wins.
 * Any other link takes `<from>--<to>`; when that id is taken, by an author id or by an earlier
 * parallel link, it takes `<from>--<to>@k` with the smallest free k from 2. So an id changes only
 * when the link's own ends change, or when a parallel link with the same ends moves before it.
 */
export function linkIds(document: Pick<NormalisedDocument, 'links'>): string[] {
  const taken = new Set(document.links.flatMap(link => link.id === undefined ? [] : [link.id]));
  return document.links.map(link => {
    if (link.id !== undefined) return link.id;
    const base = `${endpointId(link.from)}--${endpointId(link.to)}`;
    let id = base;
    for (let k = 2; taken.has(id); k++) id = `${base}@${k}`;
    taken.add(id);
    return id;
  });
}

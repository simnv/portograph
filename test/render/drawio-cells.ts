import { escapeAttribute } from '../../src/render/svg.js';

/**
 * A bound cell is a draw.io `UserObject`: `<object id label pg-*>` around an `<mxCell>` with no id and
 * no value. `flatCells` folds each wrapper back into one `<mxCell id value ...>`, as the exporter wrote
 * a cell before it bound them, so a test that reads cells by regex reads the same cell either way. An
 * empty `label` stands for no `value`; the `pg-*` and `meta` attributes stay on the folded tag.
 */
const OBJECT = /<object\b((?:[^>"]|"[^"]*")*)>\s*<mxCell\b((?:[^>"/]|"[^"]*"|\/(?!>))*)(\/>|>([\s\S]*?)<\/mxCell>)\s*<\/object>/g;

/** An id as the file spells it: a stable link id holds `>`, which an attribute writes `&gt;`. */
export const inFile = (id: string): string => escapeAttribute(id);

export function flatCells(xml: string): string {
  return xml.replace(OBJECT, (_whole, outer: string, inner: string, close: string, body: string | undefined) => {
    const attributes = [...outer.matchAll(/([\w:-]+)="([^"]*)"/g)].map(pair => [pair[1]!, pair[2]!] as const);
    const id = attributes.find(([key]) => key === 'id')?.[1];
    const label = attributes.find(([key]) => key === 'label')?.[1] ?? '';
    const rest = attributes.filter(([key]) => key !== 'id' && key !== 'label').map(([key, value]) => ` ${key}="${value}"`).join('');
    const head = `<mxCell${id === undefined ? '' : ` id="${id}"`}${label === '' ? '' : ` value="${label}"`}${inner}${rest}`;
    return close === '/>' ? `${head}/>` : `${head}>${body ?? ''}</mxCell>`;
  });
}

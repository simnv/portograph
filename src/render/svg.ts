/**
 * XML serialization primitives. Every string that reaches the output passes through `escapeText` or
 * `escapeAttribute`: no source string is ever interpolated as markup.
 */

const TEXT = /[&<>]/g;
const ATTRIBUTE = /[&<>"']/g;
const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
};

/** U+FFFD, the substitute for a character XML cannot carry at all. */
const REPLACEMENT = String.fromCharCode(0xfffd);

/**
 * XML 1.0 forbids these outright: no escape represents them and a parser rejects the document.
 * Tab, newline and carriage return are the only control characters it allows. The schema accepts
 * free text, so they are substituted here, at the serialization boundary, rather than emitted.
 */
function forbidden(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  // A valid surrogate pair arrives as one code point above 0xffff; a lone surrogate does not.
  return code < 0x20 || code >= 0xd800 && code <= 0xdfff || code === 0xfffe || code === 0xffff;
}

export function xmlSafe(value: string): string {
  let result = '';
  for (const character of value) {
    result += forbidden(character.codePointAt(0)!) ? REPLACEMENT : character;
  }
  return result;
}

export const escapeText = (value: string): string =>
  xmlSafe(value).replace(TEXT, character => ENTITIES[character]!);
export const escapeAttribute = (value: string): string =>
  xmlSafe(value).replace(ATTRIBUTE, character => ENTITIES[character]!);

/**
 * A coordinate, exactly as the layout model holds it. Rounding here would move rendered geometry
 * away from the geometry the gates measured, so the shortest round-trip form is used instead.
 */
export function num(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Render requires finite geometry');
  return Object.is(value, -0) ? '0' : String(value);
}

export type Attributes = Record<string, string | number | undefined>;

function attributes(values: Attributes): string {
  return Object.entries(values)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => ` ${key}="${escapeAttribute(typeof value === 'number' ? num(value) : value)}"`)
    .join('');
}

export const element = (name: string, values: Attributes, children?: string): string =>
  children === undefined ? `<${name}${attributes(values)}/>` : `<${name}${attributes(values)}>${children}</${name}>`;

/** Structural classes the renderer owns. An author class token may never enter this namespace. */
export const RESERVED_CLASS_PREFIX = 'pg-';

/** A class attribute from structural and author tokens, with empty and duplicate tokens dropped. */
export function classes(...tokens: (string | undefined)[]): string {
  const seen: string[] = [];
  for (const token of tokens) {
    if (token === undefined) continue;
    for (const part of token.split(/\s+/)) if (part && !seen.includes(part)) seen.push(part);
  }
  return seen.join(' ');
}

/**
 * An author-supplied class string, with any token claiming the reserved prefix removed. A class
 * named after a generated geometry lock — `pg-w-2` on a 3 px link — would otherwise put a second
 * `stroke-width` rule on the element and win by source order, drawing a width `score` never
 * measured. Every author-controlled token passes through here before it becomes a class.
 */
export function authorClass(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const kept = value.split(/\s+/).filter(part => part && !part.startsWith(RESERVED_CLASS_PREFIX));
  return kept.length ? kept.join(' ') : undefined;
}

/**
 * Style-sheet text for an XML `<style>` element. SVG parses it as character data, so `&` and `<`
 * are escaped; that also makes a `</style` sequence inside an author comment or string inert.
 */
export const escapeStyle = (css: string): string => escapeText(css);

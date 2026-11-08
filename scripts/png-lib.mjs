/**
 * Pure helpers of `scripts/png.mjs`.
 *
 * resvg ignores a rule whose selector holds `:where()`, so a node body keeps the default white
 * fill. The theme writes `.node-body:where(.cls){fill:...}` to keep the wash at the specificity
 * of `.node-body` (a document `css:` rule on the body wins). `flattenWhere` rewrites the sheet for
 * the PNG path only; the SVG that `render` writes does not change.
 */

/** `:where(.a, .b)` with simple class, id or tag arguments, no nested parentheses. */
const WHERE = /:where\(([^()]*)\)/g;

/**
 * Replace each `:where(X)` with `X`, in the text of every `<style>` element. A list argument
 * (`:where(.a, .b)`) turns the rule into one rule per item.
 * The flat rule is more specific than the `:where()` rule was: a document `css:` rule of the
 * type selector `.node-body` that came later no longer wins in the PNG. The theme's own rules
 * never rely on that; an author rule that does shows the wash in the PNG.
 */
export function flattenWhere(svg) {
  return svg.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/g,
    (_, open, css, close) => `${open}${flattenCss(css)}${close}`);
}

function flattenCss(css) {
  if (!css.includes(':where(')) return css;
  // Rules are `selector{body}`; an at-rule block opens with `@media ...{` and holds more rules.
  return css.replace(/([^{}@]+)\{/g, (whole, selector) => {
    if (!selector.includes(':where(')) return whole;
    return `${expandSelector(selector)}{`;
  });
}

function expandSelector(selector) {
  const lead = selector.match(/^\s*/)[0];
  const alternatives = selector.trim().split(',').length > 1 ? splitTop(selector) : [selector.trim()];
  const out = [];
  for (const alt of alternatives) out.push(...expandOne(alt.trim()));
  return lead + out.join(',');
}

/** Split on commas outside parentheses. */
function splitTop(selector) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { parts.push(selector.slice(from, i)); from = i + 1; }
  }
  parts.push(selector.slice(from));
  return parts;
}

function expandOne(selector) {
  const match = WHERE.exec(selector);
  WHERE.lastIndex = 0;
  if (!match) return [selector];
  const items = splitTop(match[1]).map(item => item.trim()).filter(Boolean);
  const head = selector.slice(0, match.index);
  const tail = selector.slice(match.index + match[0].length);
  return items.flatMap(item => expandOne(`${head}${item}${tail}`));
}

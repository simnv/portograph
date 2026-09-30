/**
 * The same diagram with every link of the flow form `- [a, b]` or `- [a, b, { … }]` authored `route: orthogonal`. Q108 (ranked-groups ticket 99) gives a
 * link between two groups on consecutive tiers its chord where it is clear; a test of the orthogonal tier-gap plan reads its subject through this.
 */
export function orthogonalLinks(yaml: string): string {
  let inLinks = false;
  return yaml.split('\n').map(line => {
    if (/^links:\s*$/.test(line)) { inLinks = true; return line; }
    if (inLinks && /^\S/.test(line)) inLinks = false;
    const match = inLinks ? /^(\s*-\s*\[)(.*)\](\s*)$/.exec(line) : null;
    if (!match || match[2]!.includes('route:')) return line;
    const body = match[2]!.trimEnd().endsWith('}') ? match[2]!.replace(/\s*\}\s*$/, ', route: orthogonal }') : `${match[2]!}, { route: orthogonal }`;
    return `${match[1]!}${body}]${match[3]!}`;
  }).join('\n');
}

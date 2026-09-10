import type { NormalisedNode } from '../../model/document.js';

/** Network profile defaults shared by node measurement and SVG rendering. */
export const NETWORK_NODE_ICONS: Readonly<Record<string, string>> = {
  provider: 'cloud', internet: 'cloud', wan: 'cloud',
  router: 'router', tbr: 'router', rr: 'router', backbone: 'router', core: 'router',
};

/** An explicit empty icon suppresses the class default. */
export function resolveNodeIcon(node: Pick<NormalisedNode, 'icon' | 'class'>): string | undefined {
  if (node.icon !== undefined) return node.icon === '' ? undefined : node.icon;
  return node.class !== undefined && Object.hasOwn(NETWORK_NODE_ICONS, node.class)
    ? NETWORK_NODE_ICONS[node.class] : undefined;
}

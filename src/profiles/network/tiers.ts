/**
 * The network profile's tier-inference table: a group whose nodes carry a top class lands in the
 * first tier, one with a bottom class in the last, and every other class is a middle tier. Parse
 * infers a group's tier from it (`inferTiers`); the rank derivation does not read it (a peer link
 * is a link between members of equal depth, docs/design/ranked-groups.md, section 1).
 */
export const TOP_CLASSES: readonly string[] = ['provider', 'internet', 'wan'];
export const BOTTOM_CLASSES: readonly string[] = ['backbone', 'core'];

/**
 * A test input whose subject is another rule and needs the row and group orders it was written with pins the joint stage-4 order off
 * (architecture-2 ticket 72): `layout.feedOrder: false`, merged into a `layout:` mapping the sheet already has. On a sheet without rank
 * cells and child frames that is the order main gave before the ticket.
 */
export function withoutJointOrder(yaml: string): string {
  if (/^layout:\s*\{/m.test(yaml)) return yaml.replace(/^layout:\s*\{\s*/m, 'layout: { feedOrder: false, ');
  if (/^layout:\s*$/m.test(yaml)) return yaml.replace(/^layout:\s*$/m, 'layout:\n  feedOrder: false');
  if (!/^portograph: 2\n/m.test(yaml)) throw new Error('withoutJointOrder: the input has no `portograph: 2` line');
  return yaml.replace(/^portograph: 2\n/m, 'portograph: 2\nlayout: { feedOrder: false }\n');
}

/** The corpus sheets whose layout the joint order changes (ticket 72, `gate:compare` against main 6a373b17: 38 sheets), and the DR-04 copies of three of them (`-middle-tier-first`). */
export const JOINT_REORDERED: ReadonlySet<string> = new Set([
  'a-band-holds-the-group-that-set-its-edge',
  'a-bent-member-passes-a-linked-peer-whose-links-stay-straight',
  'a-card-node-holds-its-ports-on-every-face',
  'a-chord-and-a-lane-share-a-middle-tier',
  'a-chord-spans-a-gap-the-solve-grows',
  'a-claimed-run-clears-a-shared-run',
  'a-course-lane-stands-beside-the-box-before-the-grid-widens-it',
  'a-declined-feed-beside-a-shared-port-grows-no-body',
  'a-declined-feed-grows-no-body-interior',
  'a-declined-feed-grows-no-body-mirrored',
  'a-declined-feed-grows-no-body',
  'a-diagonal-crosses-a-link-label',
  'a-face-aligns-one-port-and-leaves-a-chord-port-in-place',
  'a-face-aligns-one-port-and-leaves-a-chord-port-in-place-middle-tier-first',
  'a-group-shift-leaves-a-chord-clear-of-a-lane',
  'a-group-shift-leaves-a-chord-clear-of-a-lane-middle-tier-first',
  'a-hub-face-orders-its-ports-so-its-links-do-not-cross',
  'a-label-on-a-held-chord-gets-room-in-its-tier-gap',
  'a-link-leaves-its-group-through-a-door',
  'a-nested-stem-is-decided-before-its-gap-opens',
  'a-nested-tip-row-holds-no-allocated-row',
  'a-plain-tip-in-the-group-padding-holds-its-row',
  'a-port-facing-away-from-a-tier-gap-is-left-to-the-router',
  'a-reserved-approach-cannot-be-hemmed',
  'a-routed-link-between-frames-keeps-orthogonal-past-a-foreign-frame',
  'a-row-stretches-a-body-past-its-sibling',
  'a-seated-column-leaves-a-corridor-open',
  'a-seated-column-leaves-a-tip-its-pockets',
  'a-shared-end-reads-its-port-order',
  'a-stem-tip-clears-the-tip-that-faces-it',
  'a-straight-chord-crosses-a-group-title',
  'a-straight-gap-needs-no-router',
  'a-stranded-growth-is-given-back',
  'a-tier-gap-plan-orders-every-part',
  'a-tier-gap-plan-orders-every-part-middle-tier-first',
  'detoured-stem-checkpoint',
  'facing-rows-link-direct-as-families',
  'overlay-links-reorder-an-indifferent-tier',
  'two-facing-rows-pull-toward-each-other',
  'two-fans-leave-their-group-on-one-row',
  'widened-child-packs-tier',
]);
/** `yaml` pinned as `withoutJointOrder` does when the sheet `name` is one the joint order changes, else as it is: a reader for a file whose other sheets keep their feed orders. */
export function withoutJointOrderOn(name: string, yaml: string): string {
  return JOINT_REORDERED.has(name.replace(/\.yaml$/, '')) ? withoutJointOrder(yaml) : yaml;
}

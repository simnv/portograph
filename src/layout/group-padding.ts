/**
 * Group box beyond node bodies and named pills, all four sides (maintainer M1 visual review: 12 → 20). A leaf module: `regions.ts`
 * re-exports it, and the modules that read it at load (`frames.ts`, `columns.ts`) import it here, so no import cycle through `regions.ts`
 * can read it before it is set.
 */
export const GROUP_PADDING = 20;

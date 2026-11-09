## What and why

<!-- What does this change do, and why? Link the issue. -->

## Checklist

- [ ] `npm run gate:branch` ends with `GATE PASS`. For a change to documents only, `--skip-tests` is enough.
- [ ] I ran the tests through `npm test`, not through `vitest run`.
- [ ] A change to a layout or routing rule adds a sheet to `goldens/synthetic/`.
- [ ] I converted each changed render with `npm run png` and compared it with the checklist in `docs/design/quality.md`.
- [ ] The fixtures, tests and documents contain no real host names, addresses or personal data.
- [ ] New terms agree with `CONTEXT.md`.

## Gate output

<!-- Paste the gate:compare rows that changed, and the GATE PASS line. -->

## Renders

<!-- Attach the PNG before and after, for a change to the drawing. -->

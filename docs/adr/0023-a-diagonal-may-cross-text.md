# ADR-0023: A diagonal may cross text

Status: accepted (owner, 2026-10-31). Ticket: `.scratch/snack-theme/issues/162-a-diagonal-may-cross-text.md`.
Amends the group title link-margin of the M1 review (2026-09-11), Q108 for diagonal chords, and the title
cutout of the overlay mask (canton-groups ticket 60).

## Context

A group title and a link label were obstacles for every line. A straight chord that met a title was
refused (`ROUTED_CHORD_REFUSED`, reason `title`) and took a stepped path. A fan member that a title
met was refused or crowded. The title planner of 7f reserved room beside each held chord, and the
label room of 7f cut a window of a label's line at each chord that crossed it, so the tier gap grew.
G3 failed a diagonal inside a title's margin. Each of these cost bends or canvas to keep a slanted
line off text that a reader can still read when the line crosses it.

## Decision

1. **One predicate.** `diagonalMayCross(segment, text)` in `src/layout/diagonal-text.ts`: the
   segment is a diagonal (no axis, `isDiagonal`) and the text is a group title or a link's own label
   (`crossableText`). Every place that refused, bent, moved or counted a diagonal for such text reads
   it (R1): the title planner (`linkRects`, `chordCrossings`), the chord checks (`titleRefusal`,
   `titleFitsBeside`), the fan admission (`titleCrowdedFanMembers`), the row-path corridor
   (`straightCorridorClear`), the label room and stage 9 (`fixedLinkRuns`, `collides`) and G3.
2. **What keeps its rules.** Orthogonal segments; node bodies, the labels inside them and port pills;
   multiplicity labels (a bundle's) and bus labels; label-vs-label and label-vs-node rules; the
   router's label obstacles (stage 8 routes only orthogonal segments).
3. **Stage 9 prefers clear space.** A diagonal stays an obstacle on the rungs that count overlays, so
   a label takes a place clear of it when one exists, and one across it before it is shortened.
4. **The halo.** Every text outside node bodies (group titles, link and multiplicity labels, bus
   labels, legend labels) carries an SVG outline under its glyphs (`paint-order: stroke fill`,
   4 px) in the colour behind it: the page with each group fill behind the text laid over it at its
   opacity (`backdropColour`, one function for SVG and draw.io). One rule per depth, in light, dark
   and print, for each theme. The overlay mask no longer cuts a title out; it still cuts a pill and a
   link label box.
5. **draw.io.** A plain-text label has no outline, and `textShadow` with no offset is a soft glow
   that a crossing line shows through (measured with the drawio CLI, 2026-10-31). A text in the
   labels layer takes `labelBackgroundColor` in the colour behind it instead. A group title lies in
   the diagram layer, under the links, so no backdrop of its own can cover a line; draw.io shows the
   line over the title.

## Consequences

- Chords that a title refused are straight; the bends and the tier-gap growth they cost are gone.
- Fixtures whose premise was a title that refuses a slanted leg now mark those legs
  `route: orthogonal` to keep the premise (ticket 162 lists them).
- The keep-out of 7f, which the new geometry reaches more often, now undoes a sweep that breaks or
  deepens a hard separation (G9), judged on the frames derived from the moved boxes.

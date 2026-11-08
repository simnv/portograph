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
   segment is a diagonal (`isDiagonal`: at least `DIAGONAL_MIN_DEGREES`, 10 degrees, from both
   axes; a segment nearer an axis keeps the orthogonal rules, so a shallow chord never lies along a
   label's baseline; coordinator's ruling in the ticket 162 review) and the text is a group title or a link's own label
   (`crossableText`). Every place that refused, bent, moved or counted a diagonal for such text reads
   it (R1): the title placement (`linkRects`, `chordCrossings`), the row-path corridor
   (`straightCorridorClear`), the label room and stage 9 (`fixedLinkRuns`, `collides`) and G3.
   (The chord checks `titleRefusal` and the re-check `titleCrowdedChords` were removed by ticket 54:
   no title refuses any chord.)
2. **What keeps its rules.** Orthogonal segments; node bodies, the labels inside them and port pills;
   multiplicity labels (a bundle's) and bus labels; label-vs-label and label-vs-node rules; the
   router's label obstacles (stage 8 routes only orthogonal segments).
3. **Stage 9 prefers clear space.** A diagonal stays an obstacle on the rungs that count overlays, so
   a label takes a place clear of it when one exists, and one across it before it is shortened.
   Title placement keeps no such soft preference: the title planner reads no diagonal at all, so a
   title stands where it would stand with no diagonal on the sheet.
4. **The halo.** Every text outside node bodies (group titles, link and multiplicity labels, bus
   labels, legend labels) carries an SVG outline under its glyphs (`paint-order: stroke fill`,
   4 px) in the colour behind it: the page with each group fill behind the text laid over it at its
   opacity (`backdropColour`, one function for SVG and draw.io). One rule per depth, in light, dark
   and print, for each theme.
6. **Masks cut one line each.** A label on its own line cuts that line only (one mask per line,
   `pg-line-mask-*`); a foreign line, routed or overlay, is not cut by it. A group title or a foreign
   link label cuts an overlay line only where an orthogonal run of it meets the text: the text box
   cut to the run's stroke rectangle. A diagonal is never cut by such text; the halo breaks it. The
   common overlay mask keeps node bodies, pills, multiplicity labels and bus labels.
5. **draw.io.** A plain-text label has no outline, and `textShadow` with no offset is a soft glow
   that a crossing line shows through (measured with the drawio CLI, 2026-10-31). A text in the
   labels layer takes `labelBackgroundColor` in the colour behind it instead. A group title that no
   link crosses lies in the diagram layer; a title with a non-empty `crossedBy` (ticket 54) is a text
   cell on the labels layer with that backdrop, so it paints over the lines that cross it.

## Amendment: a group title yields to every link (architecture-2 ticket 54, user 2026-11-02)

A group title yields to any routed segment, not only a diagonal. The title is placed once, at the end of
7f, after the last move of a box, a lane or a port (`placeGroupTitles`): it slides along its edge to the
free span nearest the centre; where no span is free it stands at the centre across the links with its
halo (`yield: 'halo'`) and records the routed links that cross it (`crossedBy`, in id order; `[]` for a
title that slid clear; absent means not placed, R1). A straight vertical drop through the middle of a
title is accepted. No placement reader sees a title: no chord is refused (`titleRefusal`), no fan or
direct member is refused or crowded (`title`), no gap row, corridor, lane or leg keeps clear of a title,
no box grows and no link bends for one. Text against text stays hard (pills, other titles, stage 9 link
labels). The validator reads the record and checks it on the geometry (R5); it never places a title again.
G3 reads the record: a segment of a link in the title's `crossedBy` is no hit, except a horizontal segment drawn
through the text (a run along the title); any other crossing is. Where no x of the band is clear of text, the
title stands on it with `GROUP_TITLE_ON_TEXT` (warning) and G3 judges; the validator accepts a title on text only
where it proves that no candidate x of the band is clear of text.

Stage 8 (a scope change of ticket 54's item 8, approved by the coordinator 2026-11-02): a title lists
its `crossedBy` links as consumers of its router obstacle and its reservation (`obstacles.ts`,
`reservations.ts`), the same rule as G3, so a planned leg through a title is not refused; the router
reads `crossedBy` and never adds to it. For every other link the title stays a router obstacle and a
reservation, and a routed link that turns beside a title it does not cross is named
(`ROUTE_TITLE_DETOUR`, warning; a turn of a planned tier-gap run is no detour and is not named,
ticket 56). Letting such a residual cross with the halo is a later slice.

This replaces the 7f re-check of the held chords of ticket 162 (`titleCrowdedChords`, the retry reason
`title`, `STRAIGHT_LINK_TITLE`): a chord that 7f turns onto an axis under a title keeps its chord, and the
title yields to it.

## Consequences

- Chords that a title refused are straight; the bends and the tier-gap growth they cost are gone.
- Fixtures whose premise was a title that refuses a slanted leg now mark those legs
  `route: orthogonal` to keep the premise (ticket 162 lists them).
- The keep-out of 7f, which the new geometry reaches more often, now undoes a sweep that breaks or
  deepens a hard separation (G9), judged on the frames derived from the moved boxes. It restores the
  boxes and anchors exactly as they stood and states `KEEP_OUT_UNDONE`.

## Amendment: a crossed title in draw.io (DX-06, user 2026-11-08)

Point 5 no longer holds for a title with a non-empty `crossedBy`. In draw.io that title is a child of its group (the swimlane value, or a
text cell inside the group), so it moves and copies with the group, and a link paints over it: the group lies under the Links layer.
The SVG halo rule is unchanged.

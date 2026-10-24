# ADR-0014: Link labels follow their run, and their length is reserved in placement

Status: accepted (maintainer, 2026-09-13)

Three rules for link descriptions (stage 9 labels):

1. **Text follows the run.** A label on a horizontal segment stays upright; a label on a vertical
   segment is rotated so it reads bottom-to-top. This is Visio's "gravity": rotated text is never
   upside down and never reads top-to-bottom, so orthogonal paths need only the headings 0° and −90°; a straight bundle member (ADR-0017) takes
   its run's own heading, brought into (−90°, 90°] by the same rule. An exactly vertical member is
   a vertical run: it takes −90° and reads bottom-to-top, whichever way the member runs.
   The stored label box is the rotated one, with its long side along the segment; the renderer
   already draws rotated text about the box centre exactly as it does for port pills.
2. **Description width influences link length.** Stage 7f reserves, before anything is routed, a
   run long enough for each authored label plus both shortening margins. Stage 9 centres the label on
   the run's midpoint, so the room is measured symmetrically about the anchor midpoint out to the
   nearer pill face (or node edge). A link between tiers moves every lower tier down by the deficit;
   a link between two ends of one tier inserts the room at the gap itself: every group in every tier at
   or beyond the split between the two pill faces moves right, and a group straddling the split shifts
   only its nodes beyond it, so alignments, flank sides and bar-to-source slots all move alike and
   nothing moves left into a preceding group; a reserved lane at or beyond the split makes the link
   unreservable. A routed link whose
   ends are not level, or whose straight run the corridor check finds blocked — by a node, a pill, a
   foreign group box with its margin, a lane, a fixed run, a bundle row or a bundle envelope — will detour: its run is reserved with both
   stroke-aware router stems and the anchor-side pill protrusion on top of the label, and the group's
   title band reserves, below the title, the room that label needs beside the detour (title margin,
   label height, gap, stroke and the node clearance the run keeps). Every authored label on a drawn
   link counts — bars, and overlay links whose labels are not suppressed — except bundle members,
   whose geometry 7e owns. Self-links, same-tier links through top/bottom ports and pairs whose ports do
   not face each other across the gap are diagnosed rather than forced. (Amended by architecture-2
   ticket 23: room beyond a reserved lane is no longer diagnosed; it is inserted and the lane moves out
   with it.) Moves settle pills before the next link measures, any
   movement replays the region producers, and publication and restore re-run the reservation on a
   copy and reject a model it would still change.
3. **The best location is found automatically.** The stage 9 ladder keeps its order for the full
   text — longest segment first, first side before second — but a segment may carry the full text
   only when it is at least the text plus the 8 px shorten margin at each end long, so no label
   reaches past both ends of the run it names (ticket 30). When the text must be shortened, the
   placement that keeps the most characters wins across every segment and side, instead of the
   first clear candidate in ladder order.

Why: the maintainer's review found horizontal labels hanging beside vertical drops, descriptions
that did not fit their link because placement never knew about them, and shortened labels landing
on stubs while a longer run stood free. Rule 2 is the pipeline's load-bearing rule applied to text:
nothing routing would have to discover was left unreserved.

Consequences: fixtures with authored labels change (fitting-link-label's "uplink" now runs along
its drop). The golden has no link labels and is byte-identical. A straight bundle member
(ADR-0017, ticket 26) extends rule 1 with the segment's own angle under the same gravity flip.

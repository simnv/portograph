# ADR-0016: The root stem of a fan has one owner, whichever producer draws its members

Date: 2026-09-14 · Status: accepted (maintainer, 2026-09-14; drafted from ticket 36) · Decisions: ticket 36

## Problem

Ticket 20 gives every port with two or more routed links a stage 7e junction tree: every member
leaves on one root stem owned by the junction, and G4/G6 exempt segments the junction owns. A member
whose complete path an earlier rule fixed — a bar drop (7d), a straight flank or row link (7b, 6) —
keeps that path, so its first segment coincides with the root stem but is owned by the link. The
scorer then reports the overlap (`test` fixture in ticket 36: one bar drop plus two remainders).
Stage 7e cannot re-own the drop: `withLayoutMutation` rejects a callback that edits a path the bars
transaction derived, and 7d cannot name a junction 7e has not built.

## Decision (proposed): option (a)

Stage 7d (and 6, 7b for their fixed paths) split the first segment of any fixed path that leaves a
port with two or more routed links into a stem segment owned by the port's junction — with the
stable id 7e already uses, `junction:<port>:shared:0` — plus the remainder owned by the link. Stage
7e, building the tree, adopts that root as its depth-0 stem (same point, same owner) and lists the
fixed member in the junction's `links`; the fixed member's `sharedRuns` is the prefix of its own
path, so the scorer's chain validation and the G4/G6 exemptions see one owner on both segments.
The fixed member is the tree's straight-through leaf: its target is the port coordinate, so the
peel order is unchanged.

## Consequences

Bar drops, flank and row paths gain a second segment; `barDrops.hint` and the row/flank path
validators compare against the split path. Fixed-plus-one (one bar drop, one remainder) forms a
tree of two. The golden has no such port; synthetic fixtures with bars will re-baseline.

## Alternatives considered

- (b) Build trees before bars and derive the drop from the tree's leaf: a stage-order change
  (bundles before bars) that touches every 7d/7e validator; larger blast radius.
- (c) Widen the scorer's shared-stem exemption to a fixed member listed in the junction whose
  segment covers the root: a gate-rule change that exempts a segment no junction owns; weakens G4.

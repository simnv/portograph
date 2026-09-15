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

Stage 7d — and, deferred to ticket 37, stages 6 and 7b for their fixed paths — splits the first
segment of any fixed path that leaves a port with two or more routed links into a stem segment owned
by the port's junction — with the
stable id 7e already uses, `junction:<port>:shared:0` — plus the remainder owned by the link. Stage
7e, building the tree, adopts that root as its depth-0 stem (same point, same owner) and lists the
fixed member in the junction's `links`; the fixed member's `sharedRuns` is the prefix of its own
path, so the scorer's chain validation and the G4/G6 exemptions see one owner on both segments.
The fixed member is the tree's straight-through leaf: its target is the port coordinate, so the
peel order is unchanged.

## Scope in M1

Bar drops (7d) whose straight run reaches the tree's rows are split and join it. Row and flank
straight paths (6, 7b) join it too, since ticket 37 (2026-09-15): `joinFanTrees` offers each pinned
path to `treeCohorts` at **both** of its ports, and where the two ports both carry a fan the row gap
reserves both continuations so the two trees split the one path from opposite ends without either
re-owning the other's stems.

A drop at its bar end and a drop that jogs before the rows still need work in their own producers
(ticket 47). Until that lands they stay outside the tree, the cohort is formed without them, and
stage 7e reports each with a `FAN_MEMBER_UNRESERVED` warning — their own stem still covers the tree's
root, so G4 reports that overlap and the model says why. No input has yet been found that reaches
either shape; ticket 47 asks for one before the geometry is written.

## Consequences

Bar drops gain the tree's segments; `barDrops.hint` follows the split path. Row and flank paths
gain the same under ticket 37, when their validators compare against the split path. Fixed-plus-one
(one bar drop, one remainder) forms a tree of two. The golden has no such port; synthetic fixtures
with bars will re-baseline.

## Alternatives considered

- (b) Build trees before bars and derive the drop from the tree's leaf: a stage-order change
  (bundles before bars) that touches every 7d/7e validator; larger blast radius.
- (c) Widen the scorer's shared-stem exemption to a fixed member listed in the junction whose
  segment covers the root: a gate-rule change that exempts a segment no junction owns; weakens G4.

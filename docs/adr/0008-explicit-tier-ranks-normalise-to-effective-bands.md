# ADR-0008: Explicit tier ranks normalise to effective bands

Status: accepted

Amended by ADR-0019 (2026-09-29): a group with more than one rank expands into cells on consecutive sub-tiers, so one effective band per group becomes one sub-tier band per cell.

An explicit `tier:` is the author's ordering rank and always wins over class inference, but it is
not required to remain the emitted band index. Normalisation orders inferred top groups, explicit
ranks, inferred middle groups and inferred bottom groups, then compacts those bands from zero;
equal explicit ranks continue to share a band. This preserves author intent while allowing an
inferred top group to precede an explicit rank 0 without sparse or negative layout bands. The
validated input may retain the authored rank for diagnostics, while normalised JSON records only
the effective `tier`.

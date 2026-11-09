# ADR-0007: The project is named portograph

Date: 2026-09-10 · Status: accepted · Decision: Q17

## Context
Constraint: European/Latin root, pronounceable by Russian speakers with 1:1 transliteration.
Twenty-nine candidates vetted (the maintainer's naming review). `portgraph` is a generic
CS term with an active same-concept Rust crate and is too descriptive to trademark; `tierlay`
reads badly in Russian; `portlay` is a live SaaS; the Russian-word set had IT collisions.

## Decision
**portograph** — coined on the *cartograph* pattern; npm/PyPI/crates free; no exact GitHub repo or
user; `.dev`/`.io` no DNS; `.com` held idle since 2019; no software collision. Pronounce
POR-to-graf; Портограф. Fallback: `portula`.

## Consequences
- Before any filing or domain purchase: direct EUIPO / USPTO / Rospatent lookup (all were
  CAPTCHA-walled to agents) and a check on Portograph Studio (fonts, Class 9).
- Package name `portograph`; CLI `portograph`.

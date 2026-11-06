# Addendum to /tmp/bgplab/decision.md: the user's answers (2026-11-06). These override decision.md where they differ.

1. Scope = physical topology PLUS BGP sessions as overlay links (user chose "Physical + sessions overlay").
   - A session is a link with `class: flow` (an overlay class, src/resolve/index.ts:37 OVERLAY_CLASSES = flow, sync, signal)
     and `label: EBGP` or `label: IBGP` (or the session label the drawing writes, for example `IBGP RR`). Bare-node endpoints.
   - Which sessions: the session arrows the reference PNG draws (the dark-red EBGP/IBGP double arrows), one overlay link per arrow,
     between the two nodes it joins. Do not derive sessions the drawing does not draw. A lab without a PNG gets no sessions.
     An arrow between a node and a whole box: join it to the box's one router, or if ambiguous record it as dropped.
   - A session arrow is not a cable: never add a physical link for it. Non-BGP arrows (BFD and similar) are dropped and listed.
   - Header: add a line `# Sessions: <n> overlay (class flow) from the drawing: a-b EBGP, ...` and keep the dropped-annotations line for callouts.
   - Session links get ids `ses-01`, `ses-02`, ... in drawing reading order.
2. LANs with 3+ members: astra's cloud node (`lan-<idx>`, class cloud, icon cloud, one leg per member) stands.
3. Location: `goldens/bgplab/<category>-<lab>.yaml`, in the corpus gate, as decided. Failing sheets: `.scratch/architecture-2/fixtures/bgplab/`.
4. Records are LIGHT: the YAML header (drop the `# Record:` line) plus one coordinator-owned `ref/corpora/bgplab/manifest.md`
   (one row per lab: lab, sheet or alias-of, status admitted|pending|alias, reason, ticket) and `ref/corpora/bgplab/LICENSE.md`.
   No per-lab review JSON, no SHA-256 hashes, no copied reference PNGs.
   A conversion worker writes per lab, in its own /tmp dir: `<slug>.yaml`, `<slug>.svg`, `<slug>.png`, `notes.md` (fidelity result,
   gates, removed links, warnings, runtime, alias nomination, open conflicts), and one batch `manifest-rows.md`.
5. Fabric generator: now, in parallel (separate worker).

# bgplab corpus manifest

Ticket 78. One row per lab: all 54 labs of the source, plus the two drawing-only labs `challenge/21` and `challenge/22`.

- Source: <https://github.com/bgplab/bgplab>, commit `4bd74dbc7f19f172d51cda9ff681303f7e152a5a`, fetched 2026-11-06.
- Licence: MIT, Copyright (c) 2023–2024 Ivan Pepelnjak. [`LICENSE.md`](LICENSE.md) holds the full upstream notice.
- Sheets: [`goldens/bgplab/`](../../../goldens/bgplab/). Each sheet header names its source, reference drawing, what it keeps, adds, simplifies and drops.
- Recipe: [`recipe/decision.md`](recipe/decision.md) (the design), [`recipe/decision-addendum.md`](recipe/decision-addendum.md)
  (the user's answers; they override the design: sessions are overlay links, records are light) and
  [`recipe/rulings.md`](recipe/rulings.md) (rulings R1 to R8, which override the conversion drafts).
- Method: a sheet is authored from the static `topology.yml` (nodes, cables) and the reference PNG (AS boxes, labels, rows). The engine owns layout.
  Cables are routed links; the session arrows of the drawing are `class: flow` overlay links. A LAN of 3 or more members is one cloud node with one leg per member.
- Aliases: two labs are one sheet only when their retained contract is equal (labels, classes, boxes and members, tiers, cables with multiplicity, LAN legs, sessions, link labels).
  The representative is the lexicographically first lab id. Its `# Aliases:` header line lists the others.
- Status: `admitted` = a sheet in `goldens/bgplab/`; `alias` = drawn by the sheet in the `sheet` column; `pending` = no sheet yet.
  Admission rule: the sheet lays out, 0 error-severity gates, 0 removed links, and a fidelity review against the reference PNG.
  The conversion workers rendered every sheet once with that result; the corpus run of the branch confirms it.

Counts: 56 labs = 44 admitted + 11 alias + 1 pending. 0 sheets wait in `.scratch/architecture-2/fixtures/bgplab/`.

| lab | sheet | status | alias-of | reason |
| --- | --- | --- | --- | --- |
| basic/0-frrouting | [basic-0-frrouting](../../../goldens/bgplab/basic-0-frrouting.yaml) | admitted | — | representative of 2 labs; 0 error gates, 0 removed links |
| basic/1-session | [basic-0-frrouting](../../../goldens/bgplab/basic-0-frrouting.yaml) | alias | basic/0-frrouting | same retained body as the representative; only the title and dropped callouts differ |
| basic/2-multihomed | [basic-2-multihomed](../../../goldens/bgplab/basic-2-multihomed.yaml) | admitted | — | representative of 5 labs; 0 error gates, 0 removed links |
| basic/3-originate | [basic-2-multihomed](../../../goldens/bgplab/basic-2-multihomed.yaml) | alias | basic/2-multihomed | same retained body as the representative; only the title and dropped callouts differ |
| basic/4-ipv6 | [basic-2-multihomed](../../../goldens/bgplab/basic-2-multihomed.yaml) | alias | basic/2-multihomed | same retained body as the representative; only the title and dropped callouts differ |
| basic/5-redistribute | [basic-5-redistribute](../../../goldens/bgplab/basic-5-redistribute.yaml) | admitted | — | OSPF-only s1/s2 ignore group bgp.as, drawn customer boxes win (ruling R1); source-only x1-x2 and two stubs kept; 0 error gates, 0 removed links |
| basic/6-protect | [basic-6-protect](../../../goldens/bgplab/basic-6-protect.yaml) | admitted | — | representative of 2 labs; 0 error gates, 0 removed links |
| basic/7-bfd | [basic-7-bfd](../../../goldens/bgplab/basic-7-bfd.yaml) | admitted | — | fidelity reviewed; 0 error gates, 0 removed links |
| basic/8-aggregate | [basic-8-aggregate](../../../goldens/bgplab/basic-8-aggregate.yaml) | admitted | — | fidelity reviewed; 0 error gates, 0 removed links |
| basic/9-ao | [basic-6-protect](../../../goldens/bgplab/basic-6-protect.yaml) | alias | basic/6-protect | same retained body as the representative; only the title and dropped callouts differ |
| basic/b-max-prefix | [basic-b-max-prefix](../../../goldens/bgplab/basic-b-max-prefix.yaml) | admitted | — | fidelity reviewed; 0 error gates, 0 removed links |
| basic/c-default-route | [basic-c-default-route](../../../goldens/bgplab/basic-c-default-route.yaml) | admitted | — | fidelity reviewed; 0 error gates, 0 removed links |
| basic/d-interface | [basic-2-multihomed](../../../goldens/bgplab/basic-2-multihomed.yaml) | alias | basic/2-multihomed | same retained body as the representative; only the title and dropped callouts differ |
| basic/e-ebgp-multihop | [basic-e-ebgp-multihop](../../../goldens/bgplab/basic-e-ebgp-multihop.yaml) | admitted | — | fidelity reviewed; 0 error gates, 0 removed links |
| challenge/01-bird-rr | [challenge-01-bird-rr](../../../goldens/bgplab/challenge-01-bird-rr.yaml) | admitted | — | 0 error gates, 0 removed links; 6 nodes, 3 AS boxes, 5 cables, 5 sessions |
| challenge/02-anycast | [challenge-02-anycast](../../../goldens/bgplab/challenge-02-anycast.yaml) | admitted | — | 0 error gates, 0 removed links; 5-member LAN node "Access VLAN", no boxes |
| challenge/03-graceful-shutdown | [challenge-03-graceful-shutdown](../../../goldens/bgplab/challenge-03-graceful-shutdown.yaml) | admitted | — | same drawn graph as policy/5-local-preference but other link names, so not an alias; 2 "Unused link" cables omitted with source evidence; 0 error gates, 0 removed links |
| challenge/04-block-fat-fingers | [challenge-04-block-fat-fingers](../../../goldens/bgplab/challenge-04-block-fat-fingers.yaml) | admitted | — | AS 65107 from topology.yml and the lab text; the PNG label 65007 is a drawing typo (ruling R6) |
| challenge/05-ebgp-dc | [challenge-05-ebgp-dc](../../../goldens/bgplab/challenge-05-ebgp-dc.yaml) | admitted | — | 16 cables; warnings ROUTE_UNSUPPORTED (engine-inferred group-link, all links drawn) and PLACEMENT_NON_CONVERGENCE; 0 error gates, 0 removed links |
| challenge/20-merge-as | [challenge-20-merge-as](../../../goldens/bgplab/challenge-20-merge-as.yaml) | admitted | — | 0 error gates, 0 removed links; 8 nodes, 4 boxes, 9 cables (pe2-pe3 l2only link is drawn), 7 sessions |
| challenge/21-loopback-vrf | — | pending | — | drawing only, no sheet: the AS 65000 and VRF AS 64501 boxes overlap (RTR is in both), which groups cannot express (ruling R8); also an unlabelled firewall and an ambiguous H-RTR-ISP line |
| challenge/22-bgp-ha-protocol | [challenge-22-bgp-ha-protocol](../../../goldens/bgplab/challenge-22-bgp-ha-protocol.yaml) | admitted | — | drawing only, no topology.yml; unlabelled firewalls fw-1 and fw-2 with an empty label, LAN cloud for the shared segment (ruling R7); 0 error gates, 0 removed links |
| challenge/30-reduce-fib | [challenge-30-reduce-fib](../../../goldens/bgplab/challenge-30-reduce-fib.yaml) | admitted | — | 0 error gates, 0 removed links; 6 boxes in two rows, 6 cables, 3 callouts dropped |
| challenge/31-table-size | [challenge-31-table-size](../../../goldens/bgplab/challenge-31-table-size.yaml) | admitted | — | no PNG: static reconstruction with adopted AS boxes, no sessions; same graph as session/5-routeserver but a different retained contract (labels, boxes, no sessions); 0 error gates, 0 removed links |
| challenge/40-mpls-core | [challenge-40-mpls-core](../../../goldens/bgplab/challenge-40-mpls-core.yaml) | admitted | — | 0 error gates, 0 removed links; CORE inside transit box per drawing; 3 sessions |
| ibgp/1-edge | [ibgp-1-edge](../../../goldens/bgplab/ibgp-1-edge.yaml) | admitted | — | fidelity checked; 0 error gates, 0 removed links; 0.622 s; 2 reviewed warnings; source additions reconciled |
| ibgp/2-transit | [ibgp-2-transit](../../../goldens/bgplab/ibgp-2-transit.yaml) | admitted | — | fidelity checked; 0 error gates, 0 removed links; 0.603 s; 1 reviewed warnings; source additions reconciled |
| ibgp/3-rr | [ibgp-3-rr](../../../goldens/bgplab/ibgp-3-rr.yaml) | admitted | — | fidelity checked; 0 error gates, 0 removed links; 0.639 s; 15 reviewed warnings |
| lb/1-ebgp | [lb-1-ebgp](../../../goldens/bgplab/lb-1-ebgp.yaml) | admitted | — | 0 error gates, 0 removed links; 6 cables (p1-p2 not drawn, retained as addition), 5 sessions |
| lb/2-dmz-bw | [lb-2-dmz-bw](../../../goldens/bgplab/lb-2-dmz-bw.yaml) | admitted | — | 0 error gates, 0 removed links; 3 cables (x1-x2 not drawn, retained as addition), 2 sessions |
| lb/3-ibgp | [lb-3-ibgp](../../../goldens/bgplab/lb-3-ibgp.yaml) | admitted | — | 0 error gates, 0 removed links; parallel pair we1-x1 kept, x1-x2 addition, 3 sessions; warnings LINK_LABEL_ROOM_UNRESERVED, CENTRE_ALIGNMENT_INFEASIBLE |
| lb/4-ibgp-add-path | [lb-4-ibgp-add-path](../../../goldens/bgplab/lb-4-ibgp-add-path.yaml) | admitted | — | 0 error gates, 0 removed links; 5 source-only cables retained as additions, 5 sessions; 1 crossing, TIER_GAP_GROWN warning |
| policy/1-weights | [policy-1-weights](../../../goldens/bgplab/policy-1-weights.yaml) | admitted | — | representative of 4 labs; 0 error gates, 0 removed links |
| policy/2-stop-transit | [policy-1-weights](../../../goldens/bgplab/policy-1-weights.yaml) | alias | policy/1-weights | same body as the representative; the PNG differs only in dropped callouts; the x1-x2 cable it does not draw is kept from the YAML (ruling R3) |
| policy/3-prefix | [policy-1-weights](../../../goldens/bgplab/policy-1-weights.yaml) | alias | policy/1-weights | same body as the representative; the PNG differs only in dropped callouts; the x1-x2 cable it does not draw is kept from the YAML (ruling R3) |
| policy/4-reduce | [policy-1-weights](../../../goldens/bgplab/policy-1-weights.yaml) | alias | policy/1-weights | same body as the representative; the PNG differs only in dropped callouts; the x1-x2 cable it does not draw is kept from the YAML (ruling R3) |
| policy/5-local-preference | [policy-5-local-preference](../../../goldens/bgplab/policy-5-local-preference.yaml) | admitted | — | representative of 2 labs; 0 error gates, 0 removed links |
| policy/6-med | [policy-5-local-preference](../../../goldens/bgplab/policy-5-local-preference.yaml) | alias | policy/5-local-preference | same body as the representative; the PNG differs only in dropped callouts |
| policy/7-prepend | [policy-7-prepend](../../../goldens/bgplab/policy-7-prepend.yaml) | admitted | — | fidelity reviewed; 0 error gates, 0 removed links |
| policy/8-community-attach | [policy-8-community-attach](../../../goldens/bgplab/policy-8-community-attach.yaml) | admitted | — | fidelity reviewed; 0 error gates, 0 removed links |
| policy/9-community-use | [policy-9-community-use](../../../goldens/bgplab/policy-9-community-use.yaml) | admitted | — | fidelity reviewed; 0 error gates, 0 removed links |
| policy/a-locpref-route-map | [policy-a-locpref-route-map](../../../goldens/bgplab/policy-a-locpref-route-map.yaml) | admitted | — | fidelity reviewed; 0 error gates, 0 removed links |
| policy/b-disaggregate | [policy-b-disaggregate](../../../goldens/bgplab/policy-b-disaggregate.yaml) | admitted | — | drawing-only node INT kept with no link (ruling R4); 0 error gates, 0 removed links |
| policy/c-cond-advertise | [session-5-routeserver](../../../goldens/bgplab/session-5-routeserver.yaml) | alias | session/5-routeserver | upstream topology.yml copied from the route-server lab; the drawing shows rtr/x1/x2 (ruling R5) |
| policy/d-no-export | [policy-d-no-export](../../../goldens/bgplab/policy-d-no-export.yaml) | admitted | — | fidelity reviewed; 0 error gates, 0 removed links |
| policy/e-wedgies | [policy-e-wedgies](../../../goldens/bgplab/policy-e-wedgies.yaml) | admitted | — | fidelity reviewed; 0 error gates, 0 removed links |
| policy/f-orf | [policy-f-orf](../../../goldens/bgplab/policy-f-orf.yaml) | admitted | — | fidelity reviewed; 0 error gates, 0 removed links |
| session/1-allowas_in | [session-1-allowas-in](../../../goldens/bgplab/session-1-allowas-in.yaml) | admitted | — | fidelity checked; 0 error gates, 0 removed links; 0.477 s; 3 reviewed warnings |
| session/2-asoverride | [session-2-asoverride](../../../goldens/bgplab/session-2-asoverride.yaml) | admitted | — | fidelity checked; 0 error gates, 0 removed links; 0.618 s; 3 reviewed warnings |
| session/3-localas | [session-3-localas](../../../goldens/bgplab/session-3-localas.yaml) | admitted | — | fidelity checked; 0 error gates, 0 removed links; 0.605 s; 0 reviewed warnings |
| session/4-removeprivate | [session-4-removeprivate](../../../goldens/bgplab/session-4-removeprivate.yaml) | admitted | — | fidelity checked; 0 error gates, 0 removed links; 0.606 s; 0 reviewed warnings |
| session/5-routeserver | [session-5-routeserver](../../../goldens/bgplab/session-5-routeserver.yaml) | admitted | — | representative of 2 labs; 4-leg IXP LAN node; 0 error gates, 0 removed links |
| session/6-templates | [session-6-templates](../../../goldens/bgplab/session-6-templates.yaml) | admitted | — | fidelity checked; 0 error gates, 0 removed links; 0.617 s; 3 reviewed warnings |
| session/7-policy | [basic-2-multihomed](../../../goldens/bgplab/basic-2-multihomed.yaml) | alias | basic/2-multihomed | cross-batch duplicate found at assembly: same body as basic/2-multihomed; its PNG differs only in two dropped "Policy template" callouts |
| session/8-passive | [session-8-passive](../../../goldens/bgplab/session-8-passive.yaml) | admitted | — | fidelity checked; 0 error gates, 0 removed links; 0.752 s; 6 reviewed warnings; source additions reconciled |
| session/9-dynamic | [session-9-dynamic](../../../goldens/bgplab/session-9-dynamic.yaml) | admitted | — | fidelity checked; 0 error gates, 0 removed links; 0.716 s; 3 reviewed warnings; source additions reconciled |

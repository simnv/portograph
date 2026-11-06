# Coordinator rulings (2026-11-06), for the assembly worker

R1 basic/5-redistribute: s1/s2 have module [ospf] only; group bgp.as is inert on them; drawn AS boxes win. (w01 applied.)
R2 Session arrows of any colour (dark red, grey) are sessions; colour is paint. Keep w02's grey-arrow sessions.
R3 A link active in topology.yml but not drawn is kept and listed under "Added" (decision.md Section 2: the YAML owns links). policy 2/3/4 stay aliases of policy-1-weights.
R4 A drawing-only node with no link (policy/b-disaggregate INT) is kept as drawn and listed under "Added"; b-disaggregate stays its own sheet.
R5 policy/c-cond-advertise: its topology.yml is a copy of the route-server lab and its drawing shows rtr/x1/x2 (an upstream inconsistency). No sheet of its own: manifest status alias of the sheet its YAML graph equals (session/5-routeserver from w03, if equal; else keep w02's YAML-only sheet as pending), reason "upstream topology.yml copied from the route-server lab; the drawing shows rtr/x1/x2".
R6 challenge/04: the AS number comes from topology.yml when it and the lab text agree (65107); the PNG's 65007 is a drawing typo, recorded in the header.
R7 challenge/22 (drawing only): no invented names. Unlabelled firewalls get ids fw-1, fw-2 and an empty label; the shared segment is a LAN cloud node per decision.md.
R8 challenge/21: pending, no sheet: overlapping AS 65000 and VRF AS 64501 boxes (RTR in both) are not expressible (groups do not overlap).

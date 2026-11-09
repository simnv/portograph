# portograph glossary

Portograph turns a description of nodes, ports, links and groups into a laid-out diagram.
This glossary gives short definitions of its domain terms.

[CONTEXT.md](CONTEXT.md) remains the source for detailed vocabulary, invariants and geometry rules.
The [architecture decisions](docs/adr/) explain the choices behind those rules.

## Language

### Nodes, ports and links

**Node**:
A drawn box with a label, a class and zero or more ports, belonging to exactly one group.
_Avoid_: Device or component outside their profile-specific vocabulary.

**Port**:
A named or anonymous attachment point on one side of a node.
Every link end attaches to a port.
_Avoid_: Interface or terminal outside their profile-specific vocabulary.

**Side**:
One of a node's four faces: top, right, bottom or left.
Each port has exactly one side.

**Lateral side**:
The left or right side of a node.
A lateral port is a port on either of these sides.

**Natural side**:
The side a port receives without an authored side or a side hint.

**Side hint**:
A lateral side chosen for a port from the placed diagram.
An authored side takes precedence over a hint.

**Lane hint**:
A side hint for an L-shaped routed path through a side lane.

**Approach**:
The face of a shared named port's pill that one link end meets when it differs from the port's side.

**Link**:
A connection between two ports, with a class and an optional route override.
_Avoid_: Edge, connection as the name of the domain object.

**Peer link**:
A routed link within a group whose ends have equal depth from the anchors, or whose ports are both fixed to lateral sides.
It does not lengthen a rank path.

**Family**:
The routed or overlay classification of a link, determined by its class through the profile.
Physical links are routed; flow, sync and signal links are overlay.

### Groups and hierarchy

**Group**:
A labelled container for nodes, or, for a canton, for tier groups.
A node belongs to exactly one group.
_Avoid_: Location, zone, area as substitutes for group.

**Tier**:
A group's position in the document's top-to-bottom hierarchy, with tier zero at the top.
A document tier can contain several sub-tiers.
_Avoid_: Layer as a substitute for tier.

**Anchor**:
A group member with a routed link to the tier above, or to the tier below when no member links upward.
Anchors occupy the first rank for upward feeds or the last rank for downward feeds.

**Rank**:
A member's depth from the group's anchors along routed links, before adjustments for child groups.
A group with no anchor has one rank.

**Rank cell**:
The layout group containing the members of one rank of a document group.
It occupies one sub-tier and has no label or frame of its own.

**Sub-tier**:
One row in the expanded hierarchy used for layout.
Each document tier expands to as many sub-tiers as the largest rank count among its groups.

**Anchor tier**:
The tier with the most nodes, including bar nodes and excluding flank nodes, with ties going to the lowest effective tier index.
It is the reference tier for centring groups above and below it.

**Frame**:
The drawn box enclosing a document group's rank cells and child frames, with room for padding and its title.
A child frame lies inside its parent frame.

**Column**:
A frame's box together with horizontal slack on each side for placement.
A grid column is a different concept: a corridor inside a grid group.

**Canton**:
A group containing tier groups on consecutive tiers.
It has no tier, nodes, shape or flank of its own, and cannot belong to another canton.

**Member of a canton**:
A tier group belonging to a canton while retaining its own tier and children.

**Canton frame**:
The drawn box enclosing a canton's member frames, with padding and room for its title.
It spans the tier gaps between its members.

**Canton column**:
A canton frame's box together with horizontal slack on each side for placement.

**Aligned extent**:
The reserved box of a canton member just above the anchor tier when its ports align over their feeds.
It bounds how far that member may extend beyond the canton wall.

**Parent spread**:
The outward spread of a parent's fed bottom ports to match its children's top ports below the anchor tier.
It includes the body growth and space between neighbours needed to hold that spread.

**Flank**:
A group placed to the left or right of a tier.
Its primary peer is the tier node with which it shares the most links.

**Feed order**:
The left-to-right order of rank-cell members or child frames determined by their routed feeds from the row directly above.

### Shapes and node content

**Shape**:
The arrangement of nodes within a group, such as ranked, row, bar or grid.
_Avoid_: Layout algorithm as a substitute for shape.

**Ranked**:
The default group shape, with members arranged by rank.
A ranked group with one rank is a row.

**Grid**:
A group shape with shared columns and stacked rows.
Each column is also a corridor for links that leave upward or downward.

**Bar**:
A group shape whose nodes are horizontal bars spanning their attached ports.
Links onto a bar are vertical drops.

**Node content**:
The arrangement of a node's icon, title and description inside its body.
Stacked content uses one centred column; card content places an icon tile left of a left-aligned text block.

**Width budget**:
A requested upper bound for the published canvas width, measured in pixels.
It is a placement constraint, not a scale factor.

**Stagger**:
A reserved two-line arrangement of at least three nodes whose routed links all leave through one horizontal face.
Alternate members stand away from their feeds while preserving horizontal feed order and clear vertical drops.
A width budget asks for it; without one, stage 5 chooses it for a wide leaf row on a sheet wider than tall, only toward square (`groupArrangements`).

### Reserved space and paths

**Region**:
The space between adjacent tiers, or between a flank and its tier.
_Avoid_: Group as a substitute for region.

**Band**:
Reserved horizontal space with a vertical extent.
A tier band holds a tier; a label band holds a group label.

**Lane**:
A reserved vertical corridor beside a group for a link crossing a tier where it does not end.
A riser lane instead belongs to a joined mesh bus.
_Avoid_: Channel as a substitute for lane.

**Side lane**:
A lane through an endpoint's own sub-tier band, outside its frame on the side its lateral port faces.

**Side run**:
The fixed horizontal segment between a side lane and a lateral port's face, at the port's height.

**Perimeter lane**:
A lane on the left or right of the drawing, beyond every unit, frame and lane along its span.

**Column-gap lane**:
A lane at a fixed horizontal position in a free column of one or more bands.
It lies between sibling units or beyond their outermost unit.

**Course**:
The planned route of one link from face to face, including its endpoint faces, stems, lanes, rows and tier-gap parts.
It describes the plan rather than the final drawn path.

**Planned bends**:
The bends implied by placement's reserved geometry.
They form a lower bound for the bends of a link that still needs routing.

**Part**:
The portion of one routed link's path within one tier gap.
Its ends are stem tips or lane mouths; a held routed chord is not a part.
_Avoid_: Segment or piece as a substitute for part.

**Drop**:
A part whose ends are less than one run clearance apart horizontally.
It uses one vertical run, with a jog when the ends differ.

**Stepped part**:
A part that is not a drop, with an upper leg, a horizontal run on its own row and a lower leg.

**Z part**:
A stepped part with two rows joined by a middle drop where a single row cannot fit.

**U part**:
A tier-gap part whose ends lie on the same boundary of the gap, with two legs and one row.

**Residual part**:
A part that the placement plan declines and leaves for routing among the reserved parts.
It remains part of its link, rather than a removed link.

**Skeleton**:
The initial tier and group placement before region rules apply.
It is an intermediate arrangement, not the complete layout.

### Link techniques and aggregation

**Junction**:
A branch point in a tree of shared runs at one port.

**Bundle**:
Two or more routed links between the same pair of nodes, passing through a shared channel and fanning out to ports.
Selected members may share counted trunks; other members remain parallel.

**Routed chord**:
A routed link drawn as one straight segment between port faces, at any angle and without stems.
A frame chord joins ends within one frame or a parent and its direct child; a cross-frame chord joins ends across consecutive document tiers.

**Direct family**:
Routed links from one source node to a facing row or node across one tier gap, between row groups on adjacent occupied sub-tiers.
Their straight or orthogonal paths are chosen together when the orthogonal arrangement would cross more than once.

**Fan family**:
Dashed or dotted routed links from at least two hubs in one tier group to at least three units on the next tier above or below.
Every hub links to every unit, and straight members are chosen together while refused members remain orthogonal.
Solid links form no family, and dashed and dotted family members cross at the 0.09 cost. A complete solid block is a separate rule (CONTEXT.md, "Complete solid blocks", tickets 81 and 83): joint admission with full-weight crossings, the 600 px cap and the 34-degree face pitch (D5, decision review 2026-11-07).

**Overlay**:
A link family drawn thin and translucent beneath routed links, with paths derived from placement rather than routed.
Overlay links normally take a straight path, with orthogonal detours for blocked or unsuitable port exits.

**Mesh bus**:
A shared bar, member stubs and label representing a full mesh of same-class overlay links among at least three nodes of one row.
Compatible buses on different rows can share a riser or perimeter trunk.

**Group-link**:
One drawn link representing a complete bipartite set of same-class links between two groups, each containing at least two nodes.
It retains the member links and their routed or overlay family.

**Stub**:
A link represented by a label at each endpoint instead of a line across the diagram.
Both ends remain marked.

### Labels and appearance

**Multiplicity label**:
The count beside a counted merge trunk, owned by that trunk's bundle.

**Supporting segment**:
The particular path segment against which a visible link label is placed and measured.

**Profile**:
The domain vocabulary, tier conventions, link-family conventions, default theme, icons and validation rules for a kind of diagram.

**Theme**:
A named set of colours and corner radii for the diagram's appearance.
It changes paint without changing sizes, positions or routes.

**Legend**:
The generated key to the symbols, line styles and port roles present in the diagram.
It occupies reserved space below the drawing.

### Quality

**Golden**:
A reference diagram whose reproduction requires the maintainer's visual approval.
It is not a snapshot test.

**Gate**:
A hard pass-or-fail check on layout geometry, such as overlap, clearance, attachment or containment.

**Score**:
A weighted quality value from zero to one based on crossings, bends, continuity, compactness, alignment, flow, aspect and uniformity.
It measures quality without repairing the diagram or replacing gates.

**Salience**:
The visual weight of a drawn link.
The score currently discounts crossings only between two members of the same fan family.

**Node-area share**:
The sum of node areas divided by the area of their bounding box, excluding the key.
It measures compactness rather than canvas size alone.

# /// script
# dependencies = ["pyyaml"]
# ///
"""Convert drawthe.net topology and its named NTP styles to portograph grid groups."""
import argparse
from collections import Counter
import json
from pathlib import Path
import re
import sys

import yaml


ICON_ROLES = {
    'router': ('router', 'router'), 'spacerouter': ('satellite-router', 'router'),
    'cloud': ('provider', 'cloud'), 'nexus5000': ('switch', 'switch'),
    'nexus7000': ('switch', 'switch'), 'workgroupswitch': ('switch', 'switch'),
    'antenna': ('antenna', 'default'), 'ace': ('load-balancer', 'default'),
    'smallbusiness': ('client-site', 'default'), 'file_server': ('server', 'server'),
}


def identifiers(names):
    used = set()
    result = {}
    for name in names:
        base = re.sub(r'[^A-Za-z0-9]+', '-', str(name)).strip('-').lower() or 'x'
        if base[0].isdigit():
            base = 'n' + base
        candidate, suffix = base, 2
        while candidate in used:
            candidate = f'{base}-{suffix}'
            suffix += 1
        used.add(candidate)
        result[name] = candidate
    return result


def place(icons):
    result = {}
    previous = {'x': None, 'y': None}
    for name, spec in icons.items():
        at = dict(spec or {})
        for axis in ('x', 'y'):
            value = at.get(axis, previous[axis])
            if value is None:
                raise ValueError('The first icon must specify both coordinates')
            if isinstance(value, str) and value.startswith(('+', '-')):
                if previous[axis] is None:
                    raise ValueError('A relative coordinate needs a previous icon')
                value = previous[axis] + int(value)
            at[axis] = int(value)
            previous[axis] = at[axis]
        for axis in ('w', 'h'):
            at[axis] = int(at.get(axis, 1))
            if at[axis] < 1:
                raise ValueError('Icon dimensions must be positive')
        result[name] = at
    return result


def descendants(name, groups, icons, ancestors=()):
    if name in icons:
        return [name]
    if name not in groups:
        raise ValueError('Unknown group member or connection endpoint')
    if name in ancestors:
        raise ValueError('Cyclic group membership')
    return [leaf for member in (groups[name].get('members') or [])
            for leaf in descendants(member, groups, icons, (*ancestors, name))]


def style(spec):
    dash = spec.get('strokeDashArray') or []
    if isinstance(dash, str):
        dash = re.split(r'[, ]+', dash.strip())
    dash = tuple(float(value) for value in dash)
    if not any(dash):
        dash = ()
    return (spec.get('stroke', 'orange'), dash, float(spec.get('strokeWidth', 1)), spec.get('color', 'orange'))


def link_class(connection, doc):
    signature = style(connection)
    for preset, role in (('ntpSync', 'sync'), ('ntpFlow', 'flow')):
        if preset in doc and signature == style(doc[preset]):
            return role
    physical = style(doc.get('connection') or {})
    if signature[::2] == physical[::2] and signature[3] == physical[3]:
        return 'dashed' if signature[1] else 'physical'
    raise ValueError('Unmapped connection style; do not infer its semantic family from topology')


def node_role(spec, doc):
    fallback, icon = ICON_ROLES.get(spec.get('icon'), ('unknown-device', 'default'))
    for preset, role in (('stratum1', 'ntp-stratum1'), ('stratum2', 'ntp-stratum2'), ('ntpClient', 'ntp-client')):
        paint = {key: doc.get(preset, {}).get(key) for key in ('iconFill', 'iconStroke', 'iconFamily')
                 if doc.get(preset, {}).get(key) is not None}
        if paint.keys() & {'iconFill', 'iconStroke'} and all(spec.get(key) == value for key, value in paint.items()):
            return role, icon
    return fallback, icon


def opaque_fill(value):
    """Prove opacity from a CSS fill; unknown or context-dependent colours stay visible."""
    colour = str(value).strip().lower()
    if re.fullmatch(r'#[0-9a-f]{3}|#[0-9a-f]{6}', colour):
        return True
    if re.fullmatch(r'#[0-9a-f]{4}', colour):
        return colour[-1] == 'f'
    if re.fullmatch(r'#[0-9a-f]{8}', colour):
        return colour[-2:] == 'ff'
    if colour in {'black', 'silver', 'gray', 'grey', 'white', 'maroon', 'red', 'purple',
                  'fuchsia', 'green', 'lime', 'olive', 'yellow', 'navy', 'blue', 'teal', 'aqua', 'orange'}:
        return True
    functional = re.fullmatch(r'(?:rgb|rgba|hsl|hsla)\(([^()]*)\)', colour)
    if not functional:
        return False
    components = re.split(r'[,\s/]+', functional[1].strip())
    if len(components) not in (3, 4):
        return False
    try:
        for component in components[:3]:
            float(re.sub(r'(?:deg|grad|rad|turn|%)$', '', component))
        if len(components) == 3:
            return True
        alpha = components[3]
        return float(alpha.rstrip('%')) >= (100 if alpha.endswith('%') else 1)
    except ValueError:
        return False


def nesting(containers):
    """Map each container to the smallest other container whose box holds its own, or None.

    Ordering matches the icon walk: equal boxes are broken by declaration order, earlier is inner."""
    parents = {}
    for name, box, area, index in containers:
        outer = [(other_area, other_index, other) for other, other_box, other_area, other_index in containers
                 if (other_area, other_index) > (area, index)
                 and other_box[0] <= box[0] and other_box[1] <= box[1]
                 and box[2] <= other_box[2] and box[3] <= other_box[3]]
        parents[name] = min(outer)[2] if outer else None
    return parents


def convert(doc, cantons=()):
    icons = place(doc.get('icons') or {})
    groups = {name: spec or {} for name, spec in (doc.get('groups') or {}).items()}
    if icons.keys() & groups.keys():
        raise ValueError('Icon and group identities must be distinct')
    node_ids = identifiers(icons)
    group_ids = identifiers(groups)
    leaves = {name: descendants(name, groups, icons) for name in groups}
    diagram = doc.get('diagram') or {}
    gap = float(diagram.get('gridPaddingInner', 0.4))
    padding = float(diagram.get('groupPadding', 0.33))

    def depth(name):
        return 1 + max((depth(member) for member in groups[name].get('members', []) if member in groups), default=0)

    # Coordinates in grid steps, with y reversed. An h-cell icon extends down, not up.
    boxes = {name: (at['x'], -at['y'], at['x'] + at['w'] - gap, -at['y'] + at['h'] - gap)
             for name, at in icons.items()}
    containers = []
    for index, (name, spec) in enumerate(groups.items()):
        if all(str(spec.get(key, 'orange')).lower() == 'none' for key in ('stroke', 'fill')) or not leaves[name]:
            continue
        bounds = [boxes[member] for member in leaves[name]]
        pad = gap * padding * depth(name)
        box = (min(b[0] for b in bounds) - pad, min(b[1] for b in bounds) - pad,
               max(b[2] for b in bounds) + pad, max(b[3] for b in bounds) + pad)
        containers.append((name, box, (box[2] - box[0]) * (box[3] - box[1]), index))

    redundant = set()
    # Decide outer boxes first, so a redundant parent cannot hide a nearer painted boundary.
    for name, box, area, index in sorted(containers, key=lambda entry: (-entry[2], entry[3])):
        spec = groups[name]
        if (spec.get('name') or str(spec.get('stroke', 'orange')).lower() != 'none'
                or not opaque_fill(spec.get('fill', 'orange'))):
            continue
        fill = spec.get('fill', 'orange')
        if str(fill).lower() == 'none':
            continue
        enclosing = [(outer_area, -outer_index, parent)
                     for parent, outer, outer_area, outer_index in containers
                     if parent != name and parent not in redundant
                     and (outer_area, -outer_index) > (area, -index)
                     and str(groups[parent].get('fill', 'orange')).lower() not in {'none', 'transparent'}
                     and outer[0] <= box[0] and outer[1] <= box[1] and box[2] <= outer[2] and box[3] <= outer[3]]
        if enclosing:
            parent = min(enclosing)[2]
            if groups[parent].get('fill', 'orange') == fill and opaque_fill(groups[parent].get('fill', 'orange')):
                redundant.add(name)
    containers = [entry for entry in containers if entry[0] not in redundant]

    # A box inside a box is a child group. One level only: a box under a child is folded into
    # that child, and its icons go there.
    parents = nesting(containers)
    while True:
        deep = [name for name, parent in parents.items() if parent and parents[parent]]
        if not deep:
            break
        shallowest = [name for name in deep if not parents[parents[parents[name]]]]
        for name in shallowest:
            print(f'warning: group {group_ids[name]!r} is nested more than one level deep; '
                  f'flattened into {group_ids[parents[name]]!r}', file=sys.stderr)
        containers = [entry for entry in containers if entry[0] not in shallowest]
        parents = nesting(containers)

    assignments, active = {}, {}

    def activate(group):
        gid = group_ids[group]
        parent = parents[group]
        active[gid] = {'label': groups[group].get('name', ''),
                       'top': -max(icons[member]['y'] for member in leaves[group]),
                       'parent': group_ids[parent] if parent else None}
        return gid

    for name, at in icons.items():
        own = boxes[name]
        inside = [(area, order, group) for group, box, area, order in containers
                  if box[0] <= own[0] and box[1] <= own[1] and own[2] <= box[2] and own[3] <= box[3]]
        if inside:
            group = min(inside)[2]
            gid = activate(group)
            if parents[group]:
                activate(parents[group])
        else:
            gid = f'row-{int(diagram.get("rows", 21)) - 1 - at["y"]:02d}'
            while gid in group_ids.values():
                gid = 'uncontained-' + gid
            active[gid] = {'label': f'Row {int(diagram.get("rows", 21)) - 1 - at["y"]}', 'top': -at['y'],
                           'parent': None}
        assignments[name] = gid
    # Only top-level groups take a tier; a child sits in its parent's.
    ranks = {top: i for i, top in enumerate(sorted({v['top'] for v in active.values() if not v['parent']}))}

    def emit(value):
        if value['parent']:
            return {'label': value['label'], 'parent': value['parent']}
        return {'tier': ranks[value['top']], 'label': value['label']}

    def order(item):
        gid, value = item
        root = active[value['parent']] if value['parent'] else value
        return (root['top'], value['parent'] or gid, bool(value['parent']), value['top'], gid)

    result = {'portograph': 2, 'profile': 'network',
              'groups': {gid: emit(value) for gid, value in sorted(active.items(), key=order)},
              'nodes': {}, 'links': []}
    if (doc.get('title') or {}).get('text'):
        result['title'] = doc['title']['text']
    for name, spec in icons.items():
        role, icon = node_role(spec, doc)
        result['nodes'][node_ids[name]] = {'group': assignments[name], 'class': role,
                                         'icon': icon, 'label': str(spec.get('text', name))}

    report = {'nodes': len(icons), 'declarations': len(doc.get('connections') or []),
              'expanded': 0, 'self_pairs': 0, 'duplicates': 0, 'redundant_hidden_groups': len(redundant)}
    seen = set()
    classes = Counter()
    for connection in doc.get('connections') or []:
        endpoints = connection.get('endpoints') or []
        if len(endpoints) != 2:
            raise ValueError('Each connection must have exactly two endpoints')
        parsed = [str(endpoint).partition(':') for endpoint in endpoints]
        (a, _, label_a), (b, _, label_b) = parsed
        role = link_class(connection, doc)
        for left in descendants(a, groups, icons):
            for right in descendants(b, groups, icons):
                report['expanded'] += 1
                if left == right:
                    report['self_pairs'] += 1
                    continue
                identity = (tuple(sorted(((left, label_a), (right, label_b)))), role, style(connection))
                if identity in seen:
                    report['duplicates'] += 1
                    continue
                seen.add(identity)
                options = {'class': role}
                labels = list(dict.fromkeys(label for label in (label_a, label_b) if label))
                if labels:
                    options['label'] = ' / '.join(labels)
                result['links'].append([node_ids[left], node_ids[right], options])
                classes[role] += 1
    report.update(links=len(result['links']), groups=len(result['groups']), tiers=len(ranks), classes=dict(classes))
    if cantons:
        report['cantons'] = assign_cantons(result, cantons)
    return result, report


def assign_cantons(result, cantons):
    """Add canton entries and `canton:` keys to a converted document; return the member count per canton.

    One pass (docs/design/canton-groups.md, Section 1): identifier tokens first, longest token wins;
    then a majority of overlay-family links to step-1 groups; then consecutive tiers or the canton is dropped."""
    groups, nodes = result['groups'], result['nodes']
    top = {gid: (spec.get('parent') or gid) for gid, spec in groups.items()}
    tokens = sorted(((token.lower(), token, label) for token, label in cantons), key=lambda t: -len(t[0]))
    ids = {}
    for token, label in cantons:
        cid = next(iter(identifiers([token]).values()))
        if cid in groups:
            raise ValueError(f'Canton identifier {cid!r} collides with a group identifier')
        ids[token] = (cid, label)
    member = {}
    for gid, spec in groups.items():
        if spec.get('parent'):
            continue
        match = next((t for t in tokens if gid.lower().startswith(t[0])), None)
        if not match:
            continue
        if spec.get('shape') in ('bar', 'grid'):
            print(f'warning: group {gid!r} matches canton token {match[1]!r} but is a {spec["shape"]} group; left outside',
                  file=sys.stderr)
            continue
        member[gid] = match[1]
    step_one = dict(member)
    for gid, spec in groups.items():
        if spec.get('parent') or gid in step_one:
            continue
        counts = Counter()
        for source, target, options in result['links']:
            if options.get('class') not in ('sync', 'flow'):
                continue
            here, there = top[nodes[source]['group']], top[nodes[target]['group']]
            if here != gid:
                here, there = there, here
            if here == gid and there in step_one:
                counts[step_one[there]] += 1
        total = sum(counts.values())
        best = counts.most_common(1)
        if best and best[0][1] * 2 > total:
            member[gid] = best[0][0]
        else:
            named = ', '.join(f'{token!r}={n}' for token, n in sorted(counts.items())) or 'none'
            print(f'warning: group {gid!r} has no canton majority (overlay links to tokenised groups: {named}); '
                  f'left outside', file=sys.stderr)
    for _, token, _ in tokens:
        tiers = sorted({groups[gid]['tier'] for gid, t in member.items() if t == token})
        if tiers and tiers != list(range(tiers[0], tiers[-1] + 1)):
            print(f'warning: canton {ids[token][0]!r} dropped: its members stand on tiers {tiers}, '
                  f'which are not consecutive', file=sys.stderr)
            member = {gid: t for gid, t in member.items() if t != token}
    counts = Counter(member.values())
    entries = {ids[token][0]: {'label': ids[token][1]} for _, token, _ in tokens if counts[token]}
    for gid in member:
        groups[gid]['canton'] = ids[member[gid]][0]
    result['groups'] = {**dict(sorted(entries.items())), **groups}
    return {ids[token][0]: n for token, n in sorted(counts.items())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--canton', action='append', default=[], metavar='TOKEN[=LABEL]',
                        help='group top-level groups whose identifier starts with TOKEN into a canton; repeatable')
    args = parser.parse_args()
    cantons = [(token, label or token) for token, _, label in (value.partition('=') for value in args.canton)]
    result, report = convert(yaml.safe_load(args.source.read_text()), cantons)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(yaml.safe_dump(result, sort_keys=False, allow_unicode=True))
    print(json.dumps(report, sort_keys=True))


if __name__ == '__main__':
    main()

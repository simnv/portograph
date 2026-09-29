"""Generic conversion contracts. Run with uv run --with pyyaml python -m unittest discover -s scripts/conversion."""
import contextlib
import importlib.util
import io
from pathlib import Path
import unittest


def converter():
    spec = importlib.util.spec_from_file_location('drawthe_net', Path(__file__).with_name('drawthe_net.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def source():
    return {'connection': {'stroke': 'black'}, 'ntpSync': {'stroke': 'blue', 'strokeDashArray': [1, 1]},
            'ntpFlow': {'stroke': 'blue'},
            'icons': {'alpha': {'x': 0, 'y': 3, 'icon': 'router'},
                      'beta': {'x': 2, 'y': 3, 'icon': 'nexus5000'}},
            'groups': {}, 'connections': []}


class ConversionTests(unittest.TestCase):
    def test_preserves_distinct_physical_sync_and_labelled_parallel_links(self):
        doc = source()
        doc['connections'] = [
            {'stroke': 'black', 'endpoints': ['alpha', 'beta']},
            {'stroke': 'blue', 'strokeDashArray': [1, 1], 'endpoints': ['alpha:sync', 'beta:sync']},
            {'stroke': 'blue', 'strokeDashArray': [1, 1], 'endpoints': ['beta:sync', 'alpha:sync']},
            {'stroke': 'blue', 'endpoints': ['alpha:a description longer than twelve', 'beta:other endpoint']},
        ]
        result, report = converter().convert(doc)
        self.assertEqual(len(result['links']), 3)
        self.assertEqual([link[2]['class'] for link in result['links']], ['physical', 'sync', 'flow'])
        self.assertEqual(result['links'][2][2]['label'], 'a description longer than twelve / other endpoint')
        self.assertEqual(report['duplicates'], 1)

    def test_expands_macros_and_reports_degenerate_self_pairs(self):
        doc = source()
        doc['groups']['pair'] = {'members': ['alpha', 'beta'], 'fill': 'none', 'stroke': 'none'}
        doc['connections'] = [{'stroke': 'blue', 'endpoints': ['pair', 'pair']}]
        result, report = converter().convert(doc)
        self.assertEqual(len(result['links']), 1)
        self.assertEqual(report['expanded'], 4)
        self.assertEqual(report['self_pairs'], 2)
        self.assertEqual(report['duplicates'], 1)

    def test_containment_uses_interior_icons_and_tiers_use_box_top(self):
        doc = source()
        doc['icons'] = {
            'top': {'x': 0, 'y': 8, 'icon': 'router'},
            'bottom': {'x': 2, 'y': 0, 'icon': 'router'},
            'inside': {'x': 1, 'y': 2, 'icon': 'router'},
            'other': {'x': 4, 'y': 6, 'icon': 'router'},
        }
        doc['groups'] = {
            'tall': {'name': 'Tall', 'members': ['top', 'bottom']},
            'short': {'name': 'Short', 'members': ['other']},
        }
        result, _ = converter().convert(doc)
        self.assertEqual(result['nodes']['inside']['group'], 'tall')
        self.assertLess(result['groups']['tall']['tier'], result['groups']['short']['tier'])
        self.assertTrue(all('shape' not in group for group in result['groups'].values()))

    def test_tall_icons_extend_down_and_innermost_box_wins(self):
        doc = source()
        doc['icons'] = {'wide': {'x': 0, 'y': 4, 'w': 3, 'h': 3, 'icon': 'cloud'},
                        'inside': {'x': 1, 'y': 2, 'icon': 'router'},
                        'above': {'x': 1, 'y': 6, 'icon': 'router'}}
        doc['groups'] = {'outer': {'members': ['wide']}, 'inner': {'members': ['inside']}}
        result, _ = converter().convert(doc)
        self.assertEqual(result['nodes']['inside']['group'], 'inner')
        self.assertEqual(result['nodes']['wide']['group'], 'outer')
        self.assertNotEqual(result['nodes']['above']['group'], 'outer')

    def test_node_classes_follow_source_icons_not_declaration_index(self):
        doc = source()
        first, _ = converter().convert(doc)
        doc['icons'] = dict(reversed(list(doc['icons'].items())))
        second, _ = converter().convert(doc)
        for name in ('alpha', 'beta'):
            self.assertEqual(first['nodes'][name]['class'], second['nodes'][name]['class'])
        self.assertEqual(first['nodes']['alpha']['icon'], 'router')
        self.assertEqual(first['nodes']['beta']['icon'], 'switch')

    def test_refuses_unknown_endpoints_and_extra_endpoints_instead_of_dropping_them(self):
        for ends in (['alpha', 'missing'], ['alpha', 'beta', 'alpha']):
            with self.subTest(endpoints=ends):
                doc = source()
                doc['connections'] = [{'stroke': 'black', 'endpoints': ends}]
                with self.assertRaises(ValueError):
                    converter().convert(doc)

    def test_omits_only_redundant_opaque_anonymous_boxes(self):
        doc = source()
        doc['icons'] = {name: {'x': x, 'y': y, 'icon': 'router'} for name, x, y in [
            ('corner1', 0, 5), ('corner2', 4, 1), ('inside', 2, 3),
            ('different', 3, 2), ('standalone', 8, 3)]}
        doc['groups'] = {
            'parent': {'name': 'Visible parent', 'members': ['corner1', 'corner2'], 'fill': 'gray'},
            'redundant': {'members': ['inside'], 'fill': 'gray', 'stroke': 'none'},
            'different-box': {'members': ['different'], 'fill': 'blue', 'stroke': 'none'},
            'standalone-box': {'members': ['standalone'], 'fill': 'gray', 'stroke': 'none'},
        }
        result, report = converter().convert(doc)
        self.assertNotIn('redundant', result['groups'])
        self.assertEqual(result['nodes']['inside']['group'], 'parent')
        self.assertIn('different-box', result['groups'])
        self.assertIn('standalone-box', result['groups'])
        self.assertEqual(report['redundant_hidden_groups'], 1)
        doc['groups']['redundant'].update(name='', color='purple', strokeWidth=9, textLocation='bottomLeft')
        inherited, report = converter().convert(doc)
        self.assertNotIn('redundant', inherited['groups'])
        self.assertEqual(report['redundant_hidden_groups'], 1)
        doc['groups']['redundant']['name'] = 'Named child'
        named, _ = converter().convert(doc)
        self.assertIn('redundant', named['groups'])
        doc['groups']['redundant']['name'] = ''
        for fill in ('rgba(128, 128, 128, 0.5)', '#80808080', '#8888'):
            with self.subTest(fill=fill):
                doc['groups']['redundant']['fill'] = fill
                doc['groups']['parent']['fill'] = fill
                translucent, _ = converter().convert(doc)
                self.assertIn('redundant', translucent['groups'])
        for fill in ('rgba(128, 128, 128, 1)', '#808080ff', '#888f'):
            with self.subTest(fill=fill):
                doc['groups']['redundant']['fill'] = fill
                doc['groups']['parent']['fill'] = fill
                opaque, _ = converter().convert(doc)
                self.assertNotIn('redundant', opaque['groups'])

    def test_empty_paint_preset_does_not_classify_an_unstyled_server(self):
        doc = source()
        doc['stratum1'] = {}
        doc['icons']['alpha']['icon'] = 'file_server'
        result, _ = converter().convert(doc)
        self.assertEqual(result['nodes']['alpha']['class'], 'server')

    def test_anonymous_patch_is_compared_with_nearest_painted_container(self):
        doc = source()
        doc['icons'] = {name: {'x': x, 'y': y, 'icon': 'router'} for name, x, y in [
            ('outer-top', 0, 8), ('outer-bottom', 8, 0),
            ('zone-top', 2, 6), ('zone-bottom', 6, 2), ('patch-node', 4, 4)]}
        doc['groups'] = {
            'outer': {'members': ['outer-top', 'outer-bottom'], 'name': 'Outer', 'fill': 'gray'},
            'zone': {'members': ['zone-top', 'zone-bottom'], 'name': 'Zone', 'fill': 'blue'},
            'patch': {'members': ['patch-node'], 'fill': 'gray', 'stroke': 'none'},
        }
        with contextlib.redirect_stderr(io.StringIO()):
            result, report = converter().convert(doc)
        # The patch is kept by the redundancy rule (report 0), then folded into 'zone' as a third level.
        self.assertEqual(report['redundant_hidden_groups'], 0)
        self.assertEqual(result['groups']['zone']['parent'], 'outer')
        self.assertEqual(result['nodes']['patch-node']['group'], 'zone')

    def test_ntp_paint_applies_to_servers_client_routers_and_outlets_without_changing_glyphs(self):
        doc = source()
        doc.update(stratum1={'iconFill': '#112233'}, stratum2={'iconFill': '#445566'},
                   ntpClient={'iconFill': '#778899'})
        doc['icons'] = {
            'first': {'x': 0, 'y': 1, 'icon': 'file_server', 'iconFill': '#112233', 'iconFamily': 'cisco'},
            'second': {'x': 1, 'y': 1, 'icon': 'file_server', 'iconFill': '#445566', 'iconFamily': 'cisco'},
            'client-router': {'x': 2, 'y': 1, 'icon': 'router', 'iconFill': '#778899', 'iconFamily': 'cisco'},
            'client-outlet': {'x': 3, 'y': 1, 'icon': 'smallbusiness', 'iconFill': '#778899', 'iconFamily': 'cisco'},
        }
        result, _ = converter().convert(doc)
        actual = {name: (node['class'], node['icon']) for name, node in result['nodes'].items()}
        self.assertEqual(actual, {'first': ('ntp-stratum1', 'server'), 'second': ('ntp-stratum2', 'server'),
                                  'client-router': ('ntp-client', 'router'), 'client-outlet': ('ntp-client', 'default')})

    def test_physical_dash_style_stays_routed_and_distinct_from_solid_physical(self):
        doc = source()
        doc['connections'] = [
            {'stroke': 'black', 'strokeDashArray': [3, 3], 'endpoints': ['alpha', 'beta']},
            {'stroke': 'black', 'endpoints': ['alpha', 'beta']},
        ]
        result, _ = converter().convert(doc)
        self.assertEqual([link[2]['class'] for link in result['links']], ['dashed', 'physical'])

    def test_dashed_link_at_a_signal_source_is_a_signal_and_other_dashed_links_stay_dashed(self):
        doc = source()
        doc['icons'] = {'sat': {'x': 0, 'y': 0, 'icon': 'spacerouter'}, 'mast': {'x': 1, 'y': 0, 'icon': 'antenna'},
                        'edge': {'x': 0, 'y': 3, 'icon': 'router'}, 'mpls': {'x': 2, 'y': 3, 'icon': 'cloud'}}
        doc['connections'] = [
            {'stroke': 'black', 'strokeDashArray': [3, 3], 'endpoints': ['sat', 'edge']},
            {'stroke': 'black', 'strokeDashArray': [3, 3], 'endpoints': ['mast', 'edge']},
            {'stroke': 'black', 'strokeDashArray': [3, 3], 'endpoints': ['edge', 'mpls']},
            {'stroke': 'black', 'endpoints': ['sat', 'mpls']},
        ]
        result, report = converter().convert(doc)
        self.assertEqual([link[2]['class'] for link in result['links']], ['signal', 'signal', 'dashed', 'physical'])
        self.assertEqual(report['classes'], {'signal': 2, 'dashed': 1, 'physical': 1})

    def nested(self, depth):
        """Boxes nested `depth` levels: g0 outermost, each next one inside the previous."""
        doc = source()
        doc['icons'] = {}
        doc['groups'] = {}
        for level in range(depth):
            span = 2 * (depth - level)
            doc['icons'][f'a{level}'] = {'x': level * 2, 'y': span * 2 + level * 2, 'icon': 'router'}
            doc['icons'][f'b{level}'] = {'x': level * 2 + span, 'y': level * 2, 'icon': 'router'}
            doc['groups'][f'g{level}'] = {'name': f'G{level}', 'members': [f'a{level}', f'b{level}']}
        return doc

    def test_groups_carry_no_shape_key(self):
        result, _ = converter().convert(self.nested(2))
        self.assertTrue(result['groups'])
        self.assertTrue(all('shape' not in group for group in result['groups'].values()))

    def test_box_inside_a_box_gets_parent_and_no_tier(self):
        result, _ = converter().convert(self.nested(2))
        self.assertNotIn('parent', result['groups']['g0'])
        self.assertIn('tier', result['groups']['g0'])
        self.assertEqual(result['groups']['g1']['parent'], 'g0')
        self.assertNotIn('tier', result['groups']['g1'])
        self.assertEqual(result['nodes']['a1']['group'], 'g1')
        self.assertEqual(result['nodes']['a0']['group'], 'g0')

    def test_parent_is_emitted_even_when_the_outer_box_has_no_direct_node(self):
        doc = self.nested(2)
        # g0 holds only g1, so its deeper padding makes a larger box and it owns no node itself.
        doc['icons'] = {name: spec for name, spec in doc['icons'].items() if name in ('a1', 'b1')}
        doc['groups'] = {'g0': {'name': 'G0', 'members': ['g1']}, 'g1': {'name': 'G1', 'members': ['a1', 'b1']}}
        result, _ = converter().convert(doc)
        self.assertEqual({node['group'] for node in result['nodes'].values()}, {'g1'})
        self.assertIn('tier', result['groups']['g0'])
        self.assertNotIn('tier', result['groups']['g1'])
        for group in result['groups'].values():
            if 'parent' in group:
                self.assertIn(group['parent'], result['groups'])
                self.assertNotIn('parent', result['groups'][group['parent']])
        self.assertEqual(result['groups']['g1']['parent'], 'g0')

    def test_sibling_boxes_are_top_level_and_keep_tiers(self):
        doc = source()
        doc['icons'] = {'p': {'x': 0, 'y': 6, 'icon': 'router'}, 'q': {'x': 0, 'y': 0, 'icon': 'router'}}
        doc['groups'] = {'up': {'name': 'Up', 'members': ['p']}, 'down': {'name': 'Down', 'members': ['q']}}
        result, _ = converter().convert(doc)
        for group in result['groups'].values():
            self.assertNotIn('parent', group)
            self.assertIn('tier', group)

    def test_third_level_is_flattened_into_its_parent_with_a_warning(self):
        doc = self.nested(3)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            result, _ = converter().convert(doc)
        self.assertIn('g2', stderr.getvalue())
        self.assertNotIn('g2', result['groups'])
        self.assertEqual(result['groups']['g1']['parent'], 'g0')
        self.assertEqual(result['nodes']['a2']['group'], 'g1')
        for group in result['groups'].values():
            parent = group.get('parent')
            self.assertTrue(parent is None or 'parent' not in result['groups'][parent])
            self.assertEqual('tier' in group, parent is None)


def continents():
    """Two continents, generic names: north and south are tokens; the rest is decided by links."""
    layout = [  # group, top row, icons
        ('far-a', 12, ['fa']), ('far-b', 2, ['fb']), ('top', 10, ['t']),
        ('hub-n', 8, ['hn1', 'hn2', 'hn3']), ('hub-s', 8, ['hs1', 'hs2']),
        ('hub-mix', 8, ['hm1', 'hm2', 'hm3', 'hm4']),
        ('north-clients', 6, ['nc']), ('south-clients', 6, ['sc']),
        ('north-edge', 4, ['ne']), ('leaf', 4, ['lf']),
    ]
    icons, groups, x = {}, {}, 0
    for name, row, members in layout:
        for member in members:
            icons[member] = {'x': x, 'y': row, 'icon': 'router'}
            x += 2
        groups[name] = {'name': name.title(), 'members': members}
        x += 6
    groups['south-clients']['name'] = 'North clients'  # a label with the other token: the identifier decides
    flow = {'stroke': 'blue'}
    pairs = [('hn1', 'nc'), ('hn2', 'nc'), ('hn3', 'nc'), ('hn1', 'sc'), ('hs1', 'sc'), ('hs2', 'sc'),
             ('hm1', 'nc'), ('hm2', 'nc'), ('hm3', 'sc'), ('hm4', 'sc'), ('lf', 'hn2')]
    connections = [{**flow, 'endpoints': list(pair)} for pair in pairs]
    connections += [{'stroke': 'blue', 'strokeDashArray': [1, 1], 'endpoints': ['t', 'hn1']}]
    connections += [{'stroke': 'black', 'endpoints': ['t', 'nc']}, {'stroke': 'black', 'endpoints': ['t', 'sc']}]
    return {'connection': {'stroke': 'black'}, 'ntpSync': {'stroke': 'blue', 'strokeDashArray': [1, 1]},
            'ntpFlow': {'stroke': 'blue'}, 'icons': icons, 'groups': groups, 'connections': connections}


class CantonTests(unittest.TestCase):
    def convert(self, cantons):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            result, report = converter().convert(continents(), cantons)
        return result, report, stderr.getvalue()

    def test_without_the_flag_the_output_is_byte_identical(self):
        module = converter()
        with contextlib.redirect_stderr(io.StringIO()):
            plain, plain_report = module.convert(continents())
            empty, empty_report = module.convert(continents(), [])
        self.assertEqual(module.yaml.safe_dump(plain, sort_keys=False), module.yaml.safe_dump(empty, sort_keys=False))
        self.assertEqual(plain_report, empty_report)
        self.assertNotIn('canton', module.yaml.safe_dump(plain))

    def test_tokens_then_majority_then_consecutive_tiers(self):
        result, report, stderr = self.convert([('north', 'North'), ('south', 'South'), ('far', 'Far')])
        groups = result['groups']
        self.assertEqual(groups['north'], {'label': 'North'})
        self.assertEqual(groups['south'], {'label': 'South'})
        self.assertNotIn('tier', groups['north'])
        # Step 1: the identifier decides, not the label.
        self.assertEqual(groups['north-clients']['canton'], 'north')
        self.assertEqual(groups['south-clients']['canton'], 'south')
        self.assertEqual(groups['north-edge']['canton'], 'north')
        # Step 2: three of four to one canton, and all of two.
        self.assertEqual(groups['hub-n']['canton'], 'north')
        self.assertEqual(groups['hub-s']['canton'], 'south')
        # No majority: outside, with the counts in the warning. Physical links are not counted.
        self.assertNotIn('canton', groups['hub-mix'])
        self.assertIn("'hub-mix'", stderr)
        self.assertIn("'north'=2", stderr)
        self.assertIn("'south'=2", stderr)
        # Zero links to tokenised groups: outside. A step-2 member is never read by step 2.
        self.assertNotIn('canton', groups['top'])
        self.assertNotIn('canton', groups['leaf'])
        self.assertIn('none', stderr)
        # Step 3: tiers 0 and 5 are not consecutive, so the canton is dropped whole.
        self.assertNotIn('far', groups)
        self.assertNotIn('canton', groups['far-a'])
        self.assertIn("canton 'far' dropped", stderr)
        self.assertEqual(report['cantons'], {'north': 3, 'south': 2})

    def test_the_longest_token_wins(self):
        result, report, _ = self.convert([('no', 'No'), ('north', 'North'), ('south', 'South')])
        self.assertEqual(result['groups']['north-clients']['canton'], 'north')
        self.assertNotIn('no', result['groups'])
        self.assertEqual(report['cantons'], {'north': 3, 'south': 2})

    def test_a_member_is_a_tier_group_and_the_label_defaults_to_the_token(self):
        result, _, _ = self.convert([('north', 'north')])
        self.assertEqual(result['groups']['north'], {'label': 'north'})
        self.assertIn('tier', result['groups']['north-clients'])
        self.assertEqual(list(result['groups'])[0], 'north')

    def test_a_tokenised_grid_group_stays_outside_with_a_warning(self):
        result = {'groups': {'north-grid': {'tier': 0, 'shape': 'grid'}}, 'nodes': {}, 'links': []}
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            counts = converter().assign_cantons(result, [('north', 'North')])
        self.assertEqual(counts, {})
        self.assertNotIn('canton', result['groups']['north-grid'])
        self.assertIn('grid', stderr.getvalue())


if __name__ == '__main__':
    unittest.main()

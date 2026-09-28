"""Generic conversion contracts. Run with uv run --with pyyaml python -m unittest discover -s scripts/conversion."""
import importlib.util
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
        self.assertTrue(all(group['shape'] == 'grid' for group in result['groups'].values()))

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
        result, report = converter().convert(doc)
        self.assertIn('patch', result['groups'])
        self.assertEqual(result['nodes']['patch-node']['group'], 'patch')
        self.assertEqual(report['redundant_hidden_groups'], 0)

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


if __name__ == '__main__':
    unittest.main()

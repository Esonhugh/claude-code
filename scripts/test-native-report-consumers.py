#!/usr/bin/env python3
"""Synthetic report contracts; original capture/replay remains a separate gate."""
import importlib.util
from pathlib import Path
import unittest
import copy

path = Path(__file__).resolve().parents[1] / '.claude/skills/release-validation/scripts/run-binary-gate.py'
spec = importlib.util.spec_from_file_location('native_report_driver', path)
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


def report():
    frames = [
        {'frameId': 1, 'columns': 110, 'rows': 34, 'verdict': 'passed',
         'semantic': {'diffMode': 'files', 'alphaBody': True}},
        {'frameId': 2, 'columns': 110, 'rows': 34, 'verdict': 'passed',
         'semantic': {'diffMode': 'detail', 'omegaFile': True, 'loading': True, 'omegaBody': False}},
        {'frameId': 3, 'columns': 110, 'rows': 34, 'verdict': 'passed',
         'semantic': {'diffMode': 'detail', 'omegaFile': True, 'omegaBody': True}},
        {'frameId': 4, 'columns': 109, 'rows': 34, 'verdict': 'passed',
         'semantic': {'diffMode': 'detail', 'omegaFile': True, 'omegaBody': True}},
        {'frameId': 5, 'columns': 110, 'rows': 34, 'verdict': 'passed',
         'semantic': {'diffMode': 'detail', 'omegaFile': True, 'omegaBody': True}},
    ]
    for frame in frames:
        frame.update(outputBytes=10, replayBytes=15)
    return {'method': 'native-journal-ioctl-geometry-replay-v1',
            'framePhysicalBoundary': 'native-frame-end-v1', 'verdict': 'passed',
            'semanticSource': 'independent-xterm-native-frame-end-v1',
            'parserSHA256': '17a90b650cf6b77cce2b98c4063884d43545e4ce177a54b76ccfc906f1aacaed',
            'frameCount': len(frames), 'frames': frames,
            'sizeSequence': [{key: f[key] for key in ('columns', 'rows', 'frameId')}
                             for f in (frames[0], frames[3], frames[4])]}


class NativeReportContractTest(unittest.TestCase):
    def test_native_physical_semantics_and_dimensions_keep_the_native_method(self):
        checks = driver.terminal_frame_report_checks(report())
        self.assertTrue(checks['frame_resize_sequence'])
        self.assertTrue(checks['frame_semantics'])
        self.assertFalse(checks['renderer_write_replay'])

    def test_missing_native_boundaries_or_physical_semantics_are_rejected(self):
        for key in ('framePhysicalBoundary', 'semanticSource', 'parserSHA256'):
            with self.subTest(key=key):
                invalid = report()
                invalid.pop(key)
                self.assertFalse(driver.terminal_frame_report_checks(invalid)['frame_semantics'])

    def test_native_resize_consumer_requires_the_specific_request_ack_paint_proof(self):
        value = report()
        for frame in value['frames']:
            frame['outputBytes'] = 10
        value['nativeGeometryProof'] = {'method': 'native-driver-mach-frame-geometry-v1',
            'verdict': 'passed', 'requested': 2, 'acknowledged': 2,
            'sizes': [{'columns': 109, 'rows': 34, 'actionId': 1, 'geometryId': 1, 'ioId': 3, 'frameId': 4},
                      {'columns': 110, 'rows': 34, 'actionId': 2, 'geometryId': 2, 'ioId': 5, 'frameId': 5}]}
        self.assertEqual(driver.terminal_resize_sizes(value), [(109, 34), (110, 34)])
        for key, bad in [('method', 'legacy'), ('verdict', 'not covered'), ('requested', True),
                         ('acknowledged', 1), ('sizes', [])]:
            with self.subTest(key=key):
                altered = copy.deepcopy(value)
                altered['nativeGeometryProof'][key] = bad
                self.assertIsNone(driver.terminal_resize_sizes(altered))
        altered = copy.deepcopy(value)
        altered['frames'][3]['outputBytes'] = 0
        self.assertIsNone(driver.terminal_resize_sizes(altered))
        altered = copy.deepcopy(value)
        altered['nativeGeometryProof']['sizes'][1]['frameId'] = 4
        self.assertIsNone(driver.terminal_resize_sizes(altered))

    def test_legacy_alias_cannot_stand_in_for_native_geometry(self):
        value = report()
        value['geometryProof'] = {'verdict': 'passed', 'sizes': [{'columns': 109, 'rows': 34}]}
        self.assertIsNone(driver.terminal_resize_sizes(value))

    def test_false_integer_frame_identity_and_invalid_dimensions_are_rejected(self):
        for key, bad in [('frameId', True), ('frameId', 0), ('frameId', -1),
                         ('rows', True), ('columns', 0), ('outputBytes', True), ('replayBytes', False)]:
            with self.subTest(key=key, bad=bad):
                value = report()
                value['frames'][0][key] = bad
                if key in ('frameId', 'rows', 'columns'):
                    value['sizeSequence'][0][key] = bad
                self.assertFalse(driver.terminal_frame_report_checks(value)['frame_semantics'])

    def test_gap_replay_bytes_cannot_count_as_a_positive_frame_transaction(self):
        value = report()
        value['nativeGeometryProof'] = {'method': 'native-driver-mach-frame-geometry-v1',
            'verdict': 'passed', 'requested': 1, 'acknowledged': 1,
            'sizes': [{'columns': 109, 'rows': 34, 'actionId': 1, 'geometryId': 1, 'ioId': 3, 'frameId': 4}]}
        value['frames'][3].update(outputBytes=0, replayBytes=32)
        self.assertIsNone(driver.terminal_resize_sizes(value))


if __name__ == '__main__':
    unittest.main()

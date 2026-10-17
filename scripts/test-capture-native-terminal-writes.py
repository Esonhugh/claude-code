#!/usr/bin/env python3
"""Collector failure handling; native byte probes are separate integration evidence."""
import argparse
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'native_write_capture', Path(__file__).with_name('capture-native-terminal-writes.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CollectorCleanupTests(unittest.TestCase):
    def test_missing_input_keeps_original_error_and_captured_artifacts(self):
        with tempfile.TemporaryDirectory(prefix='cc-collector-input-', dir='/private/tmp') as directory:
            base = Path(directory)
            binary = base / 'fake-native'
            binary.write_bytes(b'not executed')
            args = argparse.Namespace(evidence_root=base / 'run', executable=binary,
                                      command=['--version'], mode='pipe', deadline=1)

            def fake_compile(command, **kwargs):
                Path(command[-1]).write_bytes(b'fake observer for input failure only')
                return SimpleNamespace(returncode=0)

            def failed_spawn(*values, **kwargs):
                binary.unlink()
                raise PermissionError('spawn denied')

            with patch.object(module.subprocess, 'run', side_effect=fake_compile), \
                 patch.object(module.subprocess, 'Popen', side_effect=failed_spawn):
                with self.assertRaisesRegex(module.validator.EvidenceError, 'spawn denied'):
                    module.capture(args, {})
            receipt = json.loads((args.evidence_root / 'receipt.json').read_text())
            self.assertEqual(receipt['captureError'], 'spawn denied')
            self.assertFalse(receipt['inputsUnchanged'])
            self.assertEqual(receipt['inputReread'][str(binary)]['status'], 'missing')
            for name in ('packets.bin', 'stdout.raw', 'stderr.raw', 'pty.raw'):
                self.assertTrue((args.evidence_root / name).is_file())

    def test_final_drain_checks_the_shared_deadline(self):
        sock = SimpleNamespace(recv=lambda size: b'packet')
        with patch.object(module.time, 'monotonic', return_value=2):
            with self.assertRaisesRegex(module.validator.EvidenceError, 'deadline'):
                module.receive_packet(sock, [], 1)

    def test_final_drain_cannot_exceed_packet_budget(self):
        sock = SimpleNamespace(recv=lambda size: b'packet')
        packets = [b'packet'] * 100000
        with patch.object(module.time, 'monotonic', return_value=0):
            with self.assertRaisesRegex(module.validator.EvidenceError, 'Packet budget'):
                module.receive_packet(sock, packets, 1)
        self.assertEqual(len(packets), 100000)

    def test_late_receive_is_not_promoted_to_a_complete_packet(self):
        sock = SimpleNamespace(recv=lambda size: b'packet')
        packets = []
        with patch.object(module.time, 'monotonic', side_effect=[0, 2]):
            with self.assertRaisesRegex(module.validator.EvidenceError, 'deadline'):
                module.receive_packet(sock, packets, 1)
        self.assertEqual(packets, [])

    def test_cleanup_error_does_not_skip_socket_unlink_or_receipt(self):
        with tempfile.TemporaryDirectory(prefix='cc-collector-close-', dir='/private/tmp') as directory:
            base = Path(directory)
            binary = base / 'fake-native'
            binary.write_bytes(b'not executed')
            args = argparse.Namespace(evidence_root=base / 'run', executable=binary,
                                      command=['--version'], mode='pipe', deadline=1)
            roots = []
            real_mkdtemp = tempfile.mkdtemp
            real_socket = module.socket.socket

            def make_socket_root(**kwargs):
                result = real_mkdtemp(prefix=kwargs['prefix'], dir=base)
                roots.append(Path(result))
                return result

            class FaultSocket:
                def __init__(self, *values):
                    self.original = real_socket(*values)

                def __getattr__(self, name):
                    return getattr(self.original, name)

                def close(self):
                    self.original.close()
                    raise OSError('socket close injected')

            def fake_compile(command, **kwargs):
                Path(command[-1]).write_bytes(b'fake observer for cleanup failure only')
                return SimpleNamespace(returncode=0)

            with patch.object(module.subprocess, 'run', side_effect=fake_compile), \
                 patch.object(module.subprocess, 'Popen', side_effect=PermissionError('spawn denied')), \
                 patch.object(module.tempfile, 'mkdtemp', side_effect=make_socket_root), \
                 patch.object(module.socket, 'socket', side_effect=FaultSocket):
                with self.assertRaisesRegex(module.validator.EvidenceError, 'spawn denied'):
                    module.capture(args, {})
            self.assertEqual(len(roots), 1)
            self.assertFalse(roots[0].exists())
            receipt = json.loads((args.evidence_root / 'receipt.json').read_text())
            self.assertIn('spawn denied', receipt['captureError'])
            self.assertEqual(receipt['cleanupErrors'],
                             [{'action': 'socket-close', 'error': 'socket close injected'}])

    def test_spawn_failure_closes_owned_socket_and_preserves_failure(self):
        with tempfile.TemporaryDirectory(prefix='cc-collector-test-', dir='/private/tmp') as directory:
            base = Path(directory)
            binary = base / 'fake-native'
            binary.write_bytes(b'not executed')
            args = argparse.Namespace(evidence_root=base / 'run', executable=binary,
                                      command=['--version'], mode='pipe', deadline=1)
            socket_roots = []
            real_mkdtemp = tempfile.mkdtemp

            def make_socket_root(**kwargs):
                result = real_mkdtemp(prefix=kwargs['prefix'], dir=base)
                socket_roots.append(Path(result))
                return result

            def fake_compile(command, **kwargs):
                Path(command[-1]).write_bytes(b'fake observer for setup failure only')
                return SimpleNamespace(returncode=0)

            with patch.object(module.subprocess, 'run', side_effect=fake_compile), \
                 patch.object(module.subprocess, 'Popen', side_effect=PermissionError('spawn denied')) as spawn, \
                 patch.object(module.tempfile, 'mkdtemp', side_effect=make_socket_root):
                with self.assertRaisesRegex(module.validator.EvidenceError, 'spawn denied'):
                    module.capture(args, {})
            spawn.assert_called_once()
            self.assertEqual(len(socket_roots), 1)
            self.assertFalse(socket_roots[0].exists())
            self.assertTrue((args.evidence_root / 'receipt.json').is_file())
            self.assertFalse((args.evidence_root / 'start.json').exists())

    def test_existing_directory_is_never_written(self):
        with tempfile.TemporaryDirectory(prefix='cc-collector-existing-', dir='/private/tmp') as directory:
            base = Path(directory)
            sentinel = base / 'sentinel'
            sentinel.write_bytes(b'foreign directory contents')
            args = ['capture', '--evidence-root', str(base), '--executable', '/missing-native']
            with patch('sys.argv', args), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(module.main(), 1)
            self.assertEqual(sentinel.read_bytes(), b'foreign directory contents')
            self.assertEqual(sorted(p.name for p in base.iterdir()), ['sentinel'])


if __name__ == '__main__':
    unittest.main()

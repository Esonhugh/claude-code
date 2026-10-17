"""Synthetic receipt/type tests; actual CLI exercises the same exit guard."""
import copy
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parent.parent / '.claude/skills/release-validation/scripts/run-binary-gate.py'
spec = importlib.util.spec_from_file_location('exit_driver', path)
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class NativeExitReceiptTest(unittest.TestCase):
    def test_real_terminal_handler_keeps_bound_identity_after_close_clears_members(self):
        # Receipt fixtures and stubbed UI are not a native/UI oracle. This
        # invokes the actual handler's failure/cleanup path and final guard.
        for kind in ('valid', 'missing-descriptor', 'foreign-run', 'foreign-digest', 'missing-manifest'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                run = Path(directory).resolve()
                capture, digest, _ = self.fixture(run)
                (run / 'capture-eof').unlink()
                gate = driver.BinaryGate.__new__(driver.BinaryGate)
                launch = {'run': str(run), 'binarySha256': digest, 'capture': capture.copy()}
                gate.terminal_capture = launch
                gate.manifest = {'binary_sha256': digest}
                if kind == 'missing-descriptor':
                    gate.terminal_capture = None
                elif kind == 'foreign-run':
                    launch['run'] = str(run / 'foreign')
                elif kind == 'foreign-digest':
                    launch['binarySha256'] = 'b' * 64
                elif kind == 'missing-manifest':
                    del gate.manifest
                gate.start = lambda *_: (run, 'fixture-session', 'fixture-pane', False)
                def pane(_target, path, **_kwargs):
                    path.write_text('❯')
                    return '❯'
                gate.capture = pane
                gate.wait_until = lambda predicate, *_: bool(predicate())
                sent = []
                gate.paste_bytes = lambda _target, _root, data, _name: sent.append(data)
                def close(*_):
                    launch['capture']['captureId'] = 'changed-after-identity-held'
                    gate.terminal_capture = None
                    self.write(run, 'capture-eof', '0')
                    return {}
                gate.close = close
                gate.cleanup_passed = lambda _: True
                gate.terminal_jsonl = lambda _: []
                gate.required_assertion = lambda *_args, **kwargs: kwargs
                results = []
                gate.record = results.append
                with patch.object(driver, 'release_terminal_git_wrapper', lambda _: None):
                    gate.terminal_interaction()
                result = results[0]
                self.assertEqual(sent, [b'/exit\r'])
                self.assertIsNone(gate.terminal_capture)
                self.assertEqual(result['checks']['normal_native_exit'], kind == 'valid')
                self.assertEqual(result['native_exit_observation']['producerClosedBeforeCaptureClose'], kind == 'valid')
                self.assertEqual(result['validation_verdict'], 'failed')

    def test_missing_binary_digest_cannot_validate_equal_missing_receipt_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            capture, _, _ = self.fixture(run)
            for name in ('start.json', 'producer-expected-native.json'):
                value = json.loads((run / name).read_text())
                value['binarySha256'] = None
                self.write(run, name, value)
            self.assertFalse(driver.terminal_native_producer_exit_passed(run, capture, None))
            self.assertFalse(driver.terminal_native_exit_passed(run, capture, None))

    def test_producer_closure_does_not_replace_the_outer_collector_eof(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            capture, digest, closed = self.fixture(run)
            (run / 'capture-eof').unlink()
            self.assertTrue(driver.terminal_native_producer_exit_passed(run, capture, digest))
            self.assertFalse(driver.terminal_native_exit_passed(run, capture, digest))
            self.write(run, 'capture-eof', '1')
            self.assertTrue(driver.terminal_native_producer_exit_passed(run, capture, digest))
            self.assertFalse(driver.terminal_native_exit_passed(run, capture, digest))
            self.write(run, 'capture-eof', '0')
            self.assertTrue(driver.terminal_native_exit_passed(run, capture, digest))
            closed['normalCompletion'] = False
            closed['cleanupErrors'] = [{'action': 'close-live-publication', 'type': 'TimeoutError'}]
            for name in ('cleanup.json', 'broker-cleanup.json'):
                self.write(run, name, closed)
            self.assertFalse(driver.terminal_native_producer_exit_passed(run, capture, digest))
            self.assertFalse(driver.terminal_native_exit_passed(run, capture, digest))

    def fixture(self, run):
        capture = {'nativeJournal': True, 'captureId': 'receipt-fixture'}
        digest = 'a' * 64
        start = {'childPid': 789, 'childPgid': 789, 'binarySha256': digest}
        content = {'method': 'owned-broker-closed-native-v1', 'recordCount': 5, 'files': {}}
        io = {'method': 'owned-broker-closed-io-v1', 'recordCount': 3, 'rawBytes': 2, 'finalGeometryId': 0}
        producer = {'backend': 'native-shared-slot-v1', 'captureId': capture['captureId'],
                    'childPid': 789, 'binarySha256': digest, 'nativeClose': content, 'ioClose': io}
        closed = {'backend': 'native-shared-slot-v1', 'captureId': capture['captureId'], 'childPid': 789,
                  'childExitCode': 0, 'childReaped': True, 'physicalEof': True, 'normalCompletion': True,
                  'failure': None, 'signalsSent': [], 'cleanupErrors': [], 'nativeClose': content, 'ioClose': io}
        for name, value in [('start.json', start), ('producer-expected-native.json', producer),
                            ('cleanup.json', closed), ('broker-cleanup.json', closed), ('capture-eof', '0')]:
            self.write(run, name, value)
        return capture, digest, closed

    def write(self, run, name, value):
        file = run / name
        file.write_text(value if name == 'capture-eof' else json.dumps(value))
        file.chmod(0o600)

    def test_native_exit_does_not_require_or_create_fifo_aliases(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            capture, digest, _ = self.fixture(run)
            self.assertTrue(driver.terminal_native_exit_passed(run, capture, digest))
            self.assertFalse((run / 'native-pty-eof.json').exists())
            self.assertFalse((run / 'frame-response.fifo').exists())

    def test_missing_termination_identity_and_wrong_types_are_rejected(self):
        changes = {'childPid': True, 'childExitCode': False, 'childReaped': False,
                   'physicalEof': False, 'normalCompletion': False, 'failure': {'type': 'interrupted'},
                   'signalsSent': ['SIGKILL'], 'cleanupErrors': [{'action': 'close'}],
                   'captureId': 'foreign', 'backend': 'legacy'}
        for key, value in changes.items():
            with self.subTest(key=key), tempfile.TemporaryDirectory() as directory:
                run = Path(directory)
                capture, digest, original = self.fixture(run)
                changed = copy.deepcopy(original)
                changed[key] = value
                for name in ('cleanup.json', 'broker-cleanup.json'):
                    self.write(run, name, changed)
                self.assertFalse(driver.terminal_native_exit_passed(run, capture, digest))
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            capture, digest, closed = self.fixture(run)
            del closed['failure']
            for name in ('cleanup.json', 'broker-cleanup.json'):
                self.write(run, name, closed)
            self.assertFalse(driver.terminal_native_exit_passed(run, capture, digest))

    def test_foreign_binary_changed_close_and_unowned_file_cannot_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            capture, digest, _ = self.fixture(run)
            self.assertFalse(driver.terminal_native_exit_passed(run, capture, 'b' * 64))
            self.assertFalse(driver.terminal_native_exit_passed(run, {**capture, 'nativeJournal': '1'}, digest))
            producer = json.loads((run / 'producer-expected-native.json').read_text())
            producer['ioClose']['recordCount'] += 1
            self.write(run, 'producer-expected-native.json', producer)
            self.assertFalse(driver.terminal_native_exit_passed(run, capture, digest))
        for kind in ('symlink', 'hardlink', 'permissions', 'missing', 'collector-failure'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                run = Path(directory)
                capture, digest, _ = self.fixture(run)
                file = run / 'capture-eof'
                if kind == 'symlink':
                    file.rename(run / 'original-eof')
                    file.symlink_to(run / 'original-eof')
                elif kind == 'hardlink': os.link(file, run / 'second-link')
                elif kind == 'permissions': file.chmod(0o644)
                elif kind == 'missing': file.unlink()
                else: self.write(run, 'capture-eof', '1')
                self.assertFalse(driver.terminal_native_exit_passed(run, capture, digest))

    def test_equal_float_pids_and_missing_capture_identity_are_rejected(self):
        for name, field in [('start.json', 'childPgid'), ('cleanup.json', 'childPid'), ('producer-expected-native.json', 'childPid')]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                run = Path(directory)
                capture, digest, _ = self.fixture(run)
                value = json.loads((run / name).read_text()); value[field] = 789.0
                self.write(run, name, value)
                if name == 'cleanup.json': self.write(run, 'broker-cleanup.json', value)
                self.assertFalse(driver.terminal_native_exit_passed(run, capture, digest))
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            capture, digest, _ = self.fixture(run)
            del capture['captureId']
            for name in ('cleanup.json', 'broker-cleanup.json', 'producer-expected-native.json'):
                value = json.loads((run / name).read_text()); del value['captureId']; self.write(run, name, value)
            self.assertFalse(driver.terminal_native_exit_passed(run, capture, digest))

    def test_broker_copy_and_nested_close_types_cannot_borrow_python_equality(self):
        for field, value in [('childPid', 789.0), ('childExitCode', False), ('childReaped', 1),
                             ('physicalEof', 1), ('normalCompletion', 1)]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                run = Path(directory); capture, digest, _ = self.fixture(run)
                closed = json.loads((run / 'broker-cleanup.json').read_text()); closed[field] = value
                self.write(run, 'broker-cleanup.json', closed)
                self.assertFalse(driver.terminal_native_exit_passed(run, capture, digest))
        for key in ('nativeClose', 'ioClose'):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as directory:
                run = Path(directory); capture, digest, _ = self.fixture(run)
                producer = json.loads((run / 'producer-expected-native.json').read_text())
                producer[key]['recordCount'] = float(producer[key]['recordCount'])
                self.write(run, 'producer-expected-native.json', producer)
                self.assertFalse(driver.terminal_native_exit_passed(run, capture, digest))

    def test_native_exit_rejects_fifo_without_waiting_for_a_writer(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            capture, digest, _ = self.fixture(run)
            (run / 'capture-eof').unlink(); os.mkfifo(run / 'capture-eof', 0o600)
            code = 'import importlib.util,json;from pathlib import Path;spec=importlib.util.spec_from_file_location("guard",'+repr(str(path))+');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);raise SystemExit(1 if module.terminal_native_exit_passed(Path('+repr(str(run))+'),'+repr(capture)+','+repr(digest)+') else 0)'
            child = subprocess.run([sys.executable, '-c', code], capture_output=True, timeout=2)
            self.assertEqual(child.returncode, 0, child.stderr.decode())

    def test_legacy_exit_keeps_its_own_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            capture = {'nativeJournal': False}
            self.assertFalse(driver.terminal_native_exit_passed(run, capture, 'a' * 64))
            self.write(run, 'native-pty-eof.json', {'childExitCode': 0})
            self.assertTrue(driver.terminal_native_exit_passed(run, capture, 'a' * 64))
            self.write(run, 'native-pty-eof.json', {'childExitCode': False})
            self.assertFalse(driver.terminal_native_exit_passed(run, capture, 'a' * 64))
            file = run / 'native-pty-eof.json'
            file.unlink(); os.mkfifo(file, 0o600)
            code = 'import importlib.util;from pathlib import Path;spec=importlib.util.spec_from_file_location("guard",'+repr(str(path))+');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);raise SystemExit(1 if module.terminal_native_exit_passed(Path('+repr(str(run))+'),'+repr(capture)+','+repr('a' * 64)+') else 0)'
            child = subprocess.run([sys.executable, '-c', code], capture_output=True, timeout=2)
            self.assertEqual(child.returncode, 0, child.stderr.decode())


if __name__ == '__main__':
    unittest.main()

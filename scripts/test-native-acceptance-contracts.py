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

path = Path(__file__).resolve().parent.parent / '.claude/skills/release-validation/scripts/run-binary-gate.py'
spec = importlib.util.spec_from_file_location('exit_driver', path)
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class NativeExitReceiptTest(unittest.TestCase):
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

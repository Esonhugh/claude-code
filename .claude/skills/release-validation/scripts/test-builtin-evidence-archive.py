#!/usr/bin/env python3
"""Filesystem regressions for builtin evidence archival, not native UI proof."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    'archive_driver', Path(__file__).with_name('run-binary-gate.py'))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class ArchiveTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='ba-', dir='/private/tmp')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / 'source'
        self.run = self.source / 'runs/r-012345abcdef'
        self.run.mkdir(parents=True)
        self.archive = self.root / 'archive'
        self.receipt = self.root / 'receipt.json'
        self.evidence = b'\x1b[2Jraw terminal bytes\r\n'
        (self.run / 'native-pty.raw').write_bytes(self.evidence)
        (self.run / 'acceptance.json').write_text('{"verdict":"failed"}\n')

    def copy(self):
        self.snapshot = driver.archive_builtin_cache(self.source, self.archive, self.receipt)
        return json.loads(self.receipt.read_text())

    def test_actual_known_transports_are_recorded_without_reading_or_recreating_them(self):
        for name in ('frame-request.fifo', 'frame-response.fifo'):
            os.mkfifo(self.run / name, 0o600)
        transport = socket.socket(socket.AF_UNIX)
        self.addCleanup(transport.close)
        transport.bind(str(self.run / 'tmux.sock'))
        before = driver.tree_manifest(self.source)
        receipt = self.copy()
        self.assertTrue(receipt['archiveComplete'])
        self.assertTrue(receipt['sourceFilesStable'])
        self.assertTrue(receipt['archiveFilesMatch'])
        self.assertEqual(receipt['sourceManifest'], before)
        self.assertTrue(driver.builtin_cache_archive_matches(
            self.source, self.archive, self.receipt, self.snapshot))
        self.assertEqual(driver.tree_manifest(self.archive), before)
        self.assertEqual((self.archive / 'runs/r-012345abcdef/native-pty.raw').read_bytes(), self.evidence)
        self.assertEqual({row['path']: row['type'] for row in receipt['excludedTransports']}, {
            'runs/r-012345abcdef/frame-request.fifo': 'fifo',
            'runs/r-012345abcdef/frame-response.fifo': 'fifo',
            'runs/r-012345abcdef/tmux.sock': 'socket',
        })
        for row in receipt['excludedTransports']:
            self.assertEqual((self.source / row['path']).lstat().st_ino, row['inode'])
            self.assertFalse((self.archive / row['path']).exists())
        # File preservation must not invent EOF/reap or upgrade a failed report.
        self.assertFalse((self.archive / 'runs/r-012345abcdef/native-pty-eof.json').exists())
        self.assertFalse((self.archive / 'runs/r-012345abcdef/broker-cleanup.json').exists())
        self.assertEqual(json.loads((self.archive / 'runs/r-012345abcdef/acceptance.json').read_text())['verdict'], 'failed')

    def test_replaced_original_socket_is_not_a_verified_exclusion(self):
        original = socket.socket(socket.AF_UNIX)
        self.addCleanup(original.close)
        endpoint = self.run / 'tmux.sock'
        original.bind(str(endpoint))
        self.copy()
        self.assertTrue(driver.builtin_cache_archive_matches(
            self.source, self.archive, self.receipt, self.snapshot))
        endpoint.unlink()
        replacement = socket.socket(socket.AF_UNIX)
        self.addCleanup(replacement.close)
        replacement.bind(str(endpoint))
        self.assertNotEqual(endpoint.lstat().st_ino, self.snapshot['excludedTransports'][0]['inode'])
        self.assertFalse(driver.builtin_cache_archive_matches(
            self.source, self.archive, self.receipt, self.snapshot))

    def test_regular_files_with_transport_names_are_preserved(self):
        for name in ('frame-request.fifo', 'frame-response.fifo', 'tmux.sock'):
            (self.run / name).write_bytes(b'durable content')
        receipt = self.copy()
        self.assertEqual(receipt['excludedTransports'], [])
        for name in ('frame-request.fifo', 'frame-response.fifo', 'tmux.sock'):
            self.assertEqual((self.archive / 'runs/r-012345abcdef' / name).read_bytes(), b'durable content')

    def test_unknown_fifo_is_not_silently_discarded(self):
        os.mkfifo(self.run / 'unknown.fifo', 0o600)
        with self.assertRaises(shutil.Error):
            self.copy()
        receipt = json.loads(self.receipt.read_text())
        self.assertFalse(receipt['archiveComplete'])
        self.assertEqual(receipt['excludedTransports'], [])

    def test_named_fifo_outside_the_exact_run_location_is_rejected(self):
        os.mkfifo(self.source / 'frame-request.fifo', 0o600)
        with self.assertRaises(shutil.Error):
            self.copy()
        self.assertFalse(json.loads(self.receipt.read_text())['archiveComplete'])

    def test_unknown_socket_is_not_silently_discarded(self):
        transport = socket.socket(socket.AF_UNIX)
        self.addCleanup(transport.close)
        transport.bind(str(self.run / 'unknown.sock'))
        with self.assertRaises(shutil.Error):
            self.copy()
        receipt = json.loads(self.receipt.read_text())
        self.assertFalse(receipt['archiveComplete'])
        self.assertEqual(receipt['excludedTransports'], [])

    def test_symlink_is_preserved_without_copying_its_foreign_target(self):
        foreign = self.root / 'foreign.bin'
        foreign.write_bytes(b'outside this cache')
        (self.run / 'link').symlink_to(foreign)
        self.copy()
        link = self.archive / 'runs/r-012345abcdef/link'
        self.assertTrue(link.is_symlink())
        self.assertEqual(link.readlink(), foreign)
        self.assertEqual(json.loads(self.receipt.read_text())['sourceManifest']['runs/r-012345abcdef/link'],
                         {'type': 'link', 'target': str(foreign)})

    def test_source_drift_is_a_failed_archive(self):
        original = shutil.copytree
        def changed(source, destination, *arguments, **options):
            result = original(source, destination, *arguments, **options)
            if Path(source) == self.source:
                (self.run / 'native-pty.raw').write_bytes(b'late producer bytes')
            return result
        with patch.object(driver.shutil, 'copytree', side_effect=changed):
            with self.assertRaisesRegex(OSError, 'evidence changed'):
                self.copy()
        receipt = json.loads(self.receipt.read_text())
        self.assertFalse(receipt['archiveComplete'])
        self.assertFalse(receipt['sourceFilesStable'])

    def test_corrupt_copy_is_a_failed_archive(self):
        original = shutil.copytree
        def corrupted(source, destination, *arguments, **options):
            result = original(source, destination, *arguments, **options)
            if Path(source) == self.source:
                (self.archive / 'runs/r-012345abcdef/native-pty.raw').write_bytes(b'corrupt')
            return result
        with patch.object(driver.shutil, 'copytree', side_effect=corrupted):
            with self.assertRaisesRegex(OSError, 'archive bytes differ'):
                self.copy()
        receipt = json.loads(self.receipt.read_text())
        self.assertFalse(receipt['archiveComplete'])
        self.assertFalse(receipt['archiveFilesMatch'])

    def test_existing_receipt_is_never_overwritten(self):
        self.receipt.write_bytes(b'previous epoch')
        with self.assertRaises(FileExistsError):
            self.copy()
        self.assertEqual(self.receipt.read_bytes(), b'previous epoch')
        self.assertFalse(self.archive.exists())


class BuiltinArchiveIntegrationTest(unittest.TestCase):
    """Actual builtin_mods bookkeeping with a controlled acceptance producer."""
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='bi-', dir='/private/tmp')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.gate = object.__new__(driver.BinaryGate)
        self.gate.evidence_root = self.root / 'evidence'
        self.gate.evidence_root.mkdir()
        self.gate.repo, self.gate.binary = self.root / 'repo', self.root / 'binary'
        self.gate.manifest = {'binary_sha256': 'a' * 64}
        self.gate.stamp, self.gate.pid, self.gate.registered_runs = 'unit', os.getpid(), {}
        self.recorded = []
        self.gate.record = self.recorded.append
        self.raw = b'original producer bytes\r\n'
        self.produce_report = True
        self.unknown_fifo = False
        self.open_producer = False

    def producer(self, command, **options):
        import subprocess
        if '--cache' not in command:
            # Native-overlay driver rechecks remain failed: these are not UI receipts.
            Path(command[-1]).write_text('{"verdict":"failed","sides":{}}\n')
            return subprocess.CompletedProcess(command, 1, '', 'controlled non-native recheck')
        self.cache = Path(command[command.index('--cache') + 1])
        self.addCleanup(lambda: shutil.rmtree(self.cache, ignore_errors=True))
        self.run = self.cache / 'runs/r-012345abcdef'
        self.run.mkdir(parents=True)
        (self.run / 'native-pty.raw').write_bytes(self.raw)
        # Controlled filesystem receipts; this producer does not launch native code.
        initial = {'captureId': 'controlled-fixture', 'binarySha256': 'a' * 64,
                   'pid': 123456, 'pgid': 123456}
        (self.run / 'native-pty-initial.json').write_text(json.dumps(initial))
        if not self.open_producer:
            (self.run / 'native-pty-eof.json').write_text(json.dumps({
                'captureId': initial['captureId'], 'childPid': initial['pid'],
                'rawBytes': len(self.raw), 'childExitCode': 0}))
            (self.run / 'broker-cleanup.json').write_text(json.dumps({
                'captureId': initial['captureId'], 'childPid': initial['pid'],
                'childReaped': True,
                'fifoRemoved': ['frame-request.fifo', 'frame-response.fifo']}))
        if self.unknown_fifo:
            os.mkfifo(self.run / 'unknown.fifo', 0o600)
        if self.produce_report:
            (self.run / 'acceptance.json').write_text('{"pair":{},"assertions":{}}\n')
        return subprocess.CompletedProcess(command, 1, 'controlled archive producer', '')

    def execute(self, fault=None):
        original = shutil.copytree
        def changed(source, destination, *arguments, **options):
            result = original(source, destination, *arguments, **options)
            if Path(source) == self.cache:
                if fault == 'source':
                    (self.run / 'native-pty.raw').write_bytes(b'late producer bytes')
                elif fault == 'copy':
                    (Path(destination) / 'runs/r-012345abcdef/native-pty.raw').write_bytes(b'bad copy')
            return result
        with patch.object(driver.subprocess, 'run', side_effect=self.producer):
            if fault is None:
                self.gate.builtin_mods()
            else:
                with patch.object(driver.shutil, 'copytree', side_effect=changed):
                    self.gate.builtin_mods()
        self.assertEqual(len(self.recorded), 1)
        self.assertEqual(self.recorded[0]['validation_verdict'], 'failed')
        return self.recorded[0]

    def assert_retained_failure(self, result, expected):
        self.assertFalse(result['checks']['cache_cleanup'])
        self.assertFalse(result['checks']['report'])
        self.assertEqual((self.run / 'native-pty.raw').read_bytes(), expected)
        checks = json.loads((self.gate.evidence_root / 'builtin-mods/builtin-mods-checks.json').read_text())
        self.assertEqual(checks['retained_cache'], str(self.cache))

    def test_source_drift_retains_the_actual_late_producer_bytes(self):
        result = self.execute('source')
        self.assert_retained_failure(result, b'late producer bytes')

    def test_corrupt_archive_retains_the_unchanged_original_source(self):
        result = self.execute('copy')
        self.assert_retained_failure(result, self.raw)
        archived = self.gate.evidence_root / 'builtin-mods/acceptance-cache/runs/r-012345abcdef/native-pty.raw'
        self.assertEqual(archived.read_bytes(), b'bad copy')

    def test_unknown_fifo_failure_retains_the_source_cache(self):
        self.unknown_fifo = True
        self.assert_retained_failure(self.execute(), self.raw)

    def test_missing_report_retains_the_unarchived_source_cache(self):
        self.produce_report = False
        self.assert_retained_failure(self.execute(), self.raw)

    def test_verified_archive_removes_cache_but_does_not_upgrade_business_failure(self):
        result = self.execute()
        self.assertTrue(result['checks']['cache_cleanup'])
        self.assertTrue(result['checks']['report'])
        self.assertFalse(self.cache.exists())
        root = self.gate.evidence_root / 'builtin-mods'
        self.assertEqual((root / 'acceptance-cache/runs/r-012345abcdef/native-pty.raw').read_bytes(), self.raw)
        self.assertEqual((root / 'acceptance-cache/runs/r-012345abcdef/acceptance.json').read_bytes(),
                         b'{"pair":{},"assertions":{}}\n')
        self.assertEqual(json.loads((root / 'acceptance-remapped.json').read_text()),
                         {'pair': {}, 'assertions': {}})
        self.assertIsNone(json.loads((root / 'builtin-mods-checks.json').read_text()).get('retained_cache'))

    def test_open_native_producer_retains_bytes_arriving_after_verified_copy(self):
        self.open_producer = True
        original = driver.remap_path_strings
        def late(value, source, destination):
            remapped = original(value, source, destination)
            if isinstance(value, dict) and 'pair' in value:
                (self.run / 'native-pty.raw').write_bytes(b'after verification')
            return remapped
        with patch.object(driver, 'remap_path_strings', side_effect=late):
            result = self.execute()
        self.assertFalse(result['checks']['cache_cleanup'])
        self.assertTrue(result['checks']['report'])
        self.assertEqual((self.run / 'native-pty.raw').read_bytes(), b'after verification')
        root = self.gate.evidence_root / 'builtin-mods'
        self.assertEqual((root / 'acceptance-cache/runs/r-012345abcdef/native-pty.raw').read_bytes(), self.raw)
        checks = json.loads((root / 'builtin-mods-checks.json').read_text())
        self.assertEqual(checks['retained_cache'], str(self.cache))


    def test_late_completed_producer_retains_bytes_missing_from_the_archive(self):
        self.open_producer = True
        original = driver.remap_path_strings
        late_bytes = self.raw + b'late completed producer bytes'
        def late(value, source, destination):
            remapped = original(value, source, destination)
            if isinstance(value, dict) and 'pair' in value:
                (self.run / 'native-pty.raw').write_bytes(late_bytes)
                (self.run / 'native-pty-eof.json').write_text(json.dumps({
                    'captureId': 'controlled-fixture', 'childPid': 123456,
                    'rawBytes': len(late_bytes), 'childExitCode': 0}))
                (self.run / 'broker-cleanup.json').write_text(json.dumps({
                    'captureId': 'controlled-fixture', 'childPid': 123456,
                    'childReaped': True,
                    'fifoRemoved': ['frame-request.fifo', 'frame-response.fifo']}))
            return remapped
        with patch.object(driver, 'remap_path_strings', side_effect=late):
            result = self.execute()
        self.assertFalse(result['checks']['cache_cleanup'])
        self.assertTrue(result['checks']['report'])
        self.assertEqual((self.run / 'native-pty.raw').read_bytes(), late_bytes)
        self.assertTrue(driver.builtin_cache_producers_closed(self.cache, 'a' * 64))
        root = self.gate.evidence_root / 'builtin-mods'
        archived_run = root / 'acceptance-cache/runs/r-012345abcdef'
        self.assertEqual((archived_run / 'native-pty.raw').read_bytes(), self.raw)
        self.assertFalse((archived_run / 'native-pty-eof.json').exists())
        self.assertFalse((archived_run / 'broker-cleanup.json').exists())
        checks = json.loads((root / 'builtin-mods-checks.json').read_text())
        self.assertEqual(checks['retained_cache'], str(self.cache))

    def test_archive_corrupted_after_verified_copy_retains_original_evidence(self):
        original = driver.remap_path_strings
        def late(value, source, destination):
            remapped = original(value, source, destination)
            if isinstance(value, dict) and 'pair' in value:
                (Path(destination) / 'runs/r-012345abcdef/native-pty.raw').write_bytes(b'late corruption')
            return remapped
        with patch.object(driver, 'remap_path_strings', side_effect=late):
            result = self.execute()
        self.assertFalse(result['checks']['cache_cleanup'])
        self.assertTrue(result['checks']['report'])
        self.assertEqual((self.run / 'native-pty.raw').read_bytes(), self.raw)
        checks_path = self.gate.evidence_root / 'builtin-mods/builtin-mods-checks.json'
        self.assertEqual(json.loads(checks_path.read_text())['retained_cache'], str(self.cache))



    def assert_late_endpoint_retained(self, endpoint, destination='source'):
        original = driver.remap_path_strings
        def late(value, source, archive):
            remapped = original(value, source, archive)
            if isinstance(value, dict) and 'pair' in value:
                run = self.run if destination == 'source' else Path(archive) / 'runs/r-012345abcdef'
                self.endpoint = run / endpoint
                if endpoint.endswith('.fifo'):
                    os.mkfifo(self.endpoint, 0o600)
                else:
                    transport = socket.socket(socket.AF_UNIX)
                    self.addCleanup(transport.close)
                    transport.bind(str(self.endpoint))
            return remapped
        with patch.object(driver, 'remap_path_strings', side_effect=late):
            result = self.execute()
        self.assertFalse(result['checks']['cache_cleanup'])
        self.assertTrue(result['checks']['report'])
        self.assertEqual((self.run / 'native-pty.raw').read_bytes(), self.raw)
        self.assertTrue(self.endpoint.exists())
        self.assertTrue(driver.builtin_cache_producers_closed(self.cache, 'a' * 64))
        checks = self.gate.evidence_root / 'builtin-mods/builtin-mods-checks.json'
        self.assertEqual(json.loads(checks.read_text())['retained_cache'], str(self.cache))

    def test_unknown_fifo_added_after_copy_retains_source(self):
        self.assert_late_endpoint_retained('unknown.fifo')

    def test_unknown_socket_added_after_copy_retains_source(self):
        self.assert_late_endpoint_retained('unknown.sock')

    def test_reserved_socket_added_after_copy_is_not_an_original_exclusion(self):
        self.assert_late_endpoint_retained('tmux.sock')

    def test_unknown_fifo_added_to_archive_after_copy_retains_source(self):
        self.assert_late_endpoint_retained('unknown.fifo', destination='archive')



if __name__ == '__main__':
    unittest.main()

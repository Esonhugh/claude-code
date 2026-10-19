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
        self.temporary = tempfile.TemporaryDirectory(prefix='ba-', dir=driver.HOST_TMP_ROOT)
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

    def assert_recorded_unexpected(self, relative, kind):
        receipt = self.copy()
        self.assertTrue(receipt['archiveComplete'])
        self.assertEqual(receipt['excludedTransports'], [])
        self.assertEqual([(row['path'], row['type']) for row in receipt['unexpectedSpecialFiles']],
                         [(relative, kind)])
        self.assertEqual(self.snapshot['unexpectedSpecialFiles'], receipt['unexpectedSpecialFiles'])
        self.assertEqual((self.source / relative).lstat().st_ino, receipt['unexpectedSpecialFiles'][0]['inode'])
        self.assertFalse((self.archive / relative).exists())

    def test_unknown_fifo_is_not_silently_discarded(self):
        os.mkfifo(self.run / 'unknown.fifo', 0o600)
        self.assert_recorded_unexpected('runs/r-012345abcdef/unknown.fifo', 'fifo')

    def test_named_fifo_outside_the_exact_run_location_is_rejected(self):
        os.mkfifo(self.source / 'frame-request.fifo', 0o600)
        self.assert_recorded_unexpected('frame-request.fifo', 'fifo')

    def test_unknown_socket_is_not_silently_discarded(self):
        transport = socket.socket(socket.AF_UNIX)
        self.addCleanup(transport.close)
        transport.bind(str(self.run / 'unknown.sock'))
        self.assert_recorded_unexpected('runs/r-012345abcdef/unknown.sock', 'socket')

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
        self.temporary = tempfile.TemporaryDirectory(prefix='bi-', dir=driver.HOST_TMP_ROOT)
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
        self.cleanup_override = {}
        self.eof_override = {}

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
                'rawBytes': len(self.raw), 'childExitCode': 0, 'childStatus': 0,
                **self.eof_override}))
            (self.run / 'broker-cleanup.json').write_text(json.dumps({
                'captureId': initial['captureId'], 'childPid': initial['pid'],
                'childReaped': True, 'childStatus': 0, 'physicalEof': True, 'normalCompletion': True,
                'failure': None, 'stopReason': None, 'cleanupErrors': [],
                'fifoRemoved': ['frame-request.fifo', 'frame-response.fifo'],
                **self.cleanup_override}))
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

    def test_cleanup_wait_status_cannot_disagree_with_successful_eof(self):
        self.cleanup_override = {'childStatus': 512}
        self.assertFalse(self.execute()['checks']['cache_cleanup'])
        self.assertTrue(self.cache.exists())

    def test_signal_wait_status_cannot_claim_successful_exit(self):
        self.eof_override = {'childStatus': 9}
        self.assertFalse(self.execute()['checks']['cache_cleanup'])
        self.assertTrue(self.cache.exists())

    def test_missing_raw_wait_status_is_not_closed_proof(self):
        self.eof_override = {'childStatus': None}
        self.assertFalse(self.execute()['checks']['cache_cleanup'])
        self.assertTrue(self.cache.exists())

    def test_boolean_raw_wait_status_is_not_closed_proof(self):
        self.cleanup_override = {'childStatus': False}
        self.assertFalse(self.execute()['checks']['cache_cleanup'])
        self.assertTrue(self.cache.exists())

    def test_cleanup_failure_cannot_authorize_deleting_original_evidence(self):
        self.cleanup_override = {'cleanupErrors': [{'action': 'restore-outer-tty'}]}
        result = self.execute()
        self.assertFalse(result['checks']['cache_cleanup'])
        self.assertTrue(self.cache.exists())

    def test_abnormal_stop_cannot_authorize_deleting_original_evidence(self):
        self.cleanup_override = {'normalCompletion': False, 'stopReason': 'SIGTERM'}
        result = self.execute()
        self.assertFalse(result['checks']['cache_cleanup'])
        self.assertTrue(self.cache.exists())

    def test_unobserved_physical_eof_cannot_authorize_deleting_original_evidence(self):
        self.cleanup_override = {'physicalEof': False}
        result = self.execute()
        self.assertFalse(result['checks']['cache_cleanup'])
        self.assertTrue(self.cache.exists())

    def test_source_drift_retains_the_actual_late_producer_bytes(self):
        result = self.execute('source')
        self.assert_retained_failure(result, b'late producer bytes')

    def test_corrupt_archive_retains_the_unchanged_original_source(self):
        result = self.execute('copy')
        self.assert_retained_failure(result, self.raw)
        archived = self.gate.evidence_root / 'builtin-mods/acceptance-cache/runs/r-012345abcdef/native-pty.raw'
        self.assertEqual(archived.read_bytes(), b'bad copy')

    def test_unknown_fifo_is_reported_as_failed_cleanup_and_the_cache_removed(self):
        self.unknown_fifo = True
        result = self.execute()
        self.assertTrue(result['checks']['report'])
        self.assertFalse(result['checks']['cache_cleanup'])
        self.assertFalse(self.cache.exists())
        checks = json.loads((self.gate.evidence_root / 'builtin-mods/builtin-mods-checks.json').read_text())
        self.assertIn('runs/r-012345abcdef/unknown.fifo (fifo)', checks['report_error'])
        self.assertIsNone(checks['retained_cache'])

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
                    'rawBytes': len(late_bytes), 'childExitCode': 0, 'childStatus': 0}))
                (self.run / 'broker-cleanup.json').write_text(json.dumps({
                    'captureId': 'controlled-fixture', 'childPid': 123456,
                    'childReaped': True, 'childStatus': 0, 'physicalEof': True, 'normalCompletion': True,
                    'failure': None, 'stopReason': None, 'cleanupErrors': [],
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




class NativeCacheClosureTest(unittest.TestCase):
    """Synthetic closure/type tests; the original seven-run RED is separate."""
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='bn-close-', dir=driver.HOST_TMP_ROOT)
        self.addCleanup(self.temporary.cleanup)
        self.cache = Path(self.temporary.name)
        self.run = self.cache / 'runs/r-012345abcdef'
        self.run.mkdir(parents=True)
        self.binary = 'a' * 64
        self.capture = {'nativeJournal': True, 'captureId': 'native-cache-fixture'}
        self.native_close = {'method': 'owned-broker-closed-native-v1', 'recordCount': 5, 'files': {}}
        self.io_close = {'method': 'owned-broker-closed-io-v1', 'recordCount': 3, 'rawBytes': 0, 'finalGeometryId': 0}
        self.producer = {'backend': 'native-shared-slot-v1', 'captureId': self.capture['captureId'],
                         'childPid': 123, 'binarySha256': self.binary,
                         'nativeClose': self.native_close, 'ioClose': self.io_close}
        self.closed = {'backend': 'native-shared-slot-v1', 'captureId': self.capture['captureId'],
                       'childPid': 123, 'childExitCode': 0, 'childReaped': True,
                       'physicalEof': True, 'normalCompletion': True, 'failure': None,
                       'signalsSent': [], 'cleanupErrors': [],
                       'nativeClose': self.native_close, 'ioClose': self.io_close}
        self.launch = {'run': str(self.run.resolve()), 'binarySha256': self.binary, 'capture': self.capture}
        self.write('journal.bin', b'native artifact; this fixture does not claim content/physical coverage')
        self.write('capture-launch.json', self.launch)
        self.write('start.json', {'childPid': 123, 'childPgid': 123, 'binarySha256': self.binary})
        self.write('producer-expected-native.json', self.producer)
        self.write('capture-eof', b'0\n')
        self.reset_closed()

    def write(self, name, value):
        path = self.run / name
        path.write_bytes(value if isinstance(value, bytes) else (json.dumps(value) + '\n').encode())
        path.chmod(0o600)

    def reset_closed(self):
        for name in ('cleanup.json', 'broker-cleanup.json'):
            self.write(name, self.closed)

    def passed(self):
        return driver.builtin_cache_producers_closed(self.cache, self.binary)

    def test_closed_native_without_legacy_aliases_is_accepted(self):
        self.assertTrue(self.passed())
        for name in ('native-pty-initial.json', 'native-pty-eof.json', 'frame-request.fifo', 'frame-response.fifo'):
            self.assertFalse((self.run / name).exists())

    def test_each_missing_required_native_receipt_is_rejected(self):
        for name in ('capture-launch.json', 'start.json', 'cleanup.json', 'broker-cleanup.json',
                     'producer-expected-native.json', 'capture-eof'):
            with self.subTest(name=name):
                path = self.run / name
                original = path.read_bytes()
                path.unlink()
                self.assertFalse(self.passed())
                self.write(name, original)

    def test_failed_or_wrong_native_closure_cannot_delete_cache(self):
        for key, value in {'childExitCode': True, 'childPid': True, 'childReaped': False,
                           'physicalEof': False, 'normalCompletion': False,
                           'failure': {'error': 'failed'}, 'signalsSent': ['SIGTERM'],
                           'cleanupErrors': [{'action': 'close'}], 'captureId': 'foreign',
                           'backend': 'legacy'}.items():
            with self.subTest(key=key):
                original = self.closed[key]
                self.closed[key] = value
                self.reset_closed()
                self.assertFalse(self.passed())
                self.closed[key] = original
                self.reset_closed()

    def test_legacy_declaration_cannot_mask_native_artifacts(self):
        self.capture['nativeJournal'] = False
        self.write('capture-launch.json', self.launch)
        self.assertFalse(self.passed())

    def test_foreign_launch_run_or_binary_is_rejected(self):
        for key, value in {'run': str(self.run.parent / 'foreign'), 'binarySha256': 'b' * 64}.items():
            with self.subTest(key=key):
                original = self.launch[key]
                self.launch[key] = value
                self.write('capture-launch.json', self.launch)
                self.assertFalse(self.passed())
                self.launch[key] = original
                self.write('capture-launch.json', self.launch)

    def test_linked_launch_or_close_receipts_are_rejected(self):
        for name in ('capture-launch.json', 'cleanup.json', 'capture-eof'):
            with self.subTest(name=name):
                path = self.run / name
                retained = self.cache / ('retained-' + name)
                original = path.read_bytes()
                path.rename(retained)
                path.symlink_to(retained)
                self.assertFalse(self.passed())
                path.unlink()
                self.write(name, original)
                retained.unlink()

    def test_launch_must_keep_owned_private_mode(self):
        (self.run / 'capture-launch.json').chmod(0o644)
        self.assertFalse(self.passed())

    def test_collector_error_or_mixed_fifo_retains_native_cache(self):
        self.write('capture-eof', b'1\n')
        self.assertFalse(self.passed())
        self.write('capture-eof', b'0\n')
        os.mkfifo(self.run / 'frame-response.fifo', 0o600)
        self.assertFalse(self.passed())


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('native_broker', Path(__file__).with_name('terminal-evidence-broker-native.py'))
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


class NativeBrokerBufferTest(unittest.TestCase):
    def test_python_entries_do_not_write_bytecode_to_validation_sources(self):
        evidence = Path(os.environ['BROKER_TEST_EVIDENCE_DIR'])
        evidence.mkdir(parents=True, exist_ok=True)
        source = Path(__file__).resolve().parent
        for name in ('terminal-evidence-broker.py', 'verify-native-frame-journal.py'):
            run = Path(tempfile.mkdtemp(prefix='bytecode-entry-', dir=evidence))
            scripts = run / 'scripts'
            scripts.mkdir()
            for dependency in ('terminal-evidence-broker.py', 'terminal-evidence-broker-native.py',
                               'verify-native-frame-journal.py', 'native-terminal-journal.py'):
                shutil.copy2(source / dependency, scripts / dependency)
            env = dict(os.environ)
            env.pop('PYTHONDONTWRITEBYTECODE', None)
            env['CLAUDE_CODE_FRAME_NATIVE_JOURNAL'] = '1'
            command = [sys.executable, str(scripts / name)]
            if name == 'terminal-evidence-broker.py':
                command += ['--run', str(run), '--', str(run / 'unused-binary')]
            result = subprocess.run(command, env=env, capture_output=True, timeout=5)
            (run / 'stdout.txt').write_bytes(result.stdout)
            (run / 'stderr.txt').write_bytes(result.stderr)
            cache = list(scripts.rglob('*.pyc'))
            (run / 'result.json').write_text(json.dumps({'command': command,
                'exitCode': result.returncode, 'bytecodeFiles': [str(path) for path in cache]}) + '\n')
            self.assertEqual(result.returncode, 1)
            if name == 'terminal-evidence-broker.py':
                self.assertIn(b'native-observer.json', result.stderr)
            else:
                self.assertIn(b'Usage:', result.stdout)
            self.assertEqual(cache, [], 'Validation entry polluted its source with Python bytecode')

    def test_native_intent_with_missing_descriptor_never_enters_legacy(self):
        entry_spec = importlib.util.spec_from_file_location('entry_broker', Path(__file__).with_name('terminal-evidence-broker.py'))
        entry = importlib.util.module_from_spec(entry_spec)
        entry_spec.loader.exec_module(entry)
        with tempfile.TemporaryDirectory(prefix='native-missing-') as directory:
            run = Path(directory)
            binary = run / 'binary'
            binary.write_bytes(b'private binary fixture')
            with patch.dict(os.environ, {
                'CLAUDE_CODE_FRAME_NATIVE_JOURNAL': '1',
                'CLAUDE_CODE_FRAME_CAPTURE_ID': 'owned-capture',
                'CLAUDE_CODE_FRAME_BINARY_SHA256': hashlib.sha256(binary.read_bytes()).hexdigest(),
            }), patch.object(sys, 'argv', ['broker', '--run', str(run), '--', str(binary)]), \
                 patch.object(entry.termios, 'tcgetattr', side_effect=AssertionError('Legacy branch was entered')) as legacy:
                with self.assertRaises(FileNotFoundError):
                    entry.main()
                legacy.assert_not_called()
            self.assertFalse((run / 'frame-request.fifo').exists())
            self.assertFalse((run / 'frame-response.fifo').exists())
            self.assertFalse((run / 'start.json').exists())
            self.assertFalse((run / 'broker-cleanup.json').exists())

    def test_overflow_retains_a_bounded_prefix_without_waiting_for_disk(self):
        evidence = broker.EvidenceBuffer(limit=8)
        self.assertTrue(evidence.add('raw', b'original'))
        self.assertFalse(evidence.add('packets', b'lost'))
        self.assertFalse(evidence.add('raw', b'later'))
        self.assertEqual(evidence.used, 8)
        self.assertEqual(evidence.dropped, 9)
        self.assertEqual(evidence.values, {'raw': [b'original'], 'packets': [], 'io': []})

    def test_preexisting_raw_is_never_registered_or_overwritten(self):
        with tempfile.TemporaryDirectory(prefix='native-preexisting-') as directory:
            run = Path(directory)
            library, binary = run / 'observer.dylib', run / 'binary'
            library.write_bytes(b'private observer fixture')
            binary.write_bytes(b'private binary fixture')
            (run / 'native-observer.json').write_text(json.dumps({
                'method': 'native-shared-slot-v1', 'library': str(library),
                'librarySha256': hashlib.sha256(library.read_bytes()).hexdigest(),
            }))
            for name in ('raw.bin', 'producer-expected-native.json'):
                with self.subTest(name=name):
                    original = run / name
                    original.write_bytes(b'preexisting evidence must survive')
                    with patch.dict(os.environ, {
                        'CLAUDE_CODE_FRAME_CAPTURE_ID': 'owned-capture',
                        'CLAUDE_CODE_FRAME_BINARY_SHA256': hashlib.sha256(binary.read_bytes()).hexdigest(),
                    }):
                        with self.assertRaisesRegex(ValueError, 'Preexisting native capture artifact'):
                            broker.capture_native(run, [str(binary)])
                    self.assertEqual(original.read_bytes(), b'preexisting evidence must survive')
                    self.assertFalse((run / 'start.json').exists())
                    self.assertFalse((run / 'cleanup.json').exists())
                    original.unlink()



if __name__ == '__main__':
    unittest.main()

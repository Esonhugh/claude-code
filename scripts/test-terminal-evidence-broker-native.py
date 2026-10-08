#!/usr/bin/env python3
import hashlib
import importlib.util
import json
import os
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('native_broker', Path(__file__).with_name('terminal-evidence-broker-native.py'))
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


class NativeBrokerBufferTest(unittest.TestCase):
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
            raw = run / 'raw.bin'
            raw.write_bytes(b'preexisting evidence must survive')
            with patch.dict(os.environ, {
                'CLAUDE_CODE_FRAME_CAPTURE_ID': 'owned-capture',
                'CLAUDE_CODE_FRAME_BINARY_SHA256': hashlib.sha256(binary.read_bytes()).hexdigest(),
            }):
                with self.assertRaisesRegex(ValueError, 'Preexisting native capture artifact'):
                    broker.capture_native(run, [str(binary)])
            self.assertEqual(raw.read_bytes(), b'preexisting evidence must survive')
            self.assertFalse((run / 'start.json').exists())
            self.assertFalse((run / 'cleanup.json').exists())


if __name__ == '__main__':
    unittest.main()

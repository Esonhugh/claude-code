#!/usr/bin/env python3
"""Logical file preservation and sparse clone isolation; not product UI proof."""
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('owned_copy', Path(__file__).with_name('owned-evidence-copy.py'))
copy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(copy)


class OwnedEvidenceCopyTest(unittest.TestCase):
    def test_actual_copy_preserves_bytes_mode_mtime_and_independent_mutations(self):
        with tempfile.TemporaryDirectory(prefix='owned-copy-') as root:
            source, target = Path(root) / 'source', Path(root) / 'target'
            source.write_bytes(b'original native evidence\0tail')
            source.chmod(0o600)
            original = source.stat()
            copy.copy_evidence_file(source, target)
            self.assertEqual(target.read_bytes(), source.read_bytes())
            self.assertEqual(target.stat().st_mode, original.st_mode)
            self.assertEqual(target.stat().st_mtime_ns, original.st_mtime_ns)
            self.assertNotEqual(target.stat().st_ino, original.st_ino)
            self.assertEqual(target.stat().st_nlink, 1)
            target.write_bytes(b'negative fixture mutation')
            self.assertEqual(source.read_bytes(), b'original native evidence\0tail')

    def test_sparse_zero_slots_keep_their_full_logical_digest(self):
        with tempfile.TemporaryDirectory(prefix='owned-sparse-copy-') as root:
            source, target = Path(root) / 'journal', Path(root) / 'derived'
            with source.open('wb') as stream:
                stream.write(b'held-header')
                stream.truncate(16 * 1024 * 1024)
            copy.copy_evidence_file(source, target)
            self.assertEqual(target.stat().st_size, source.stat().st_size)
            self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(),
                             hashlib.sha256(source.read_bytes()).hexdigest())
            if os.uname().sysname == 'Darwin':
                self.assertLessEqual(target.stat().st_blocks, source.stat().st_blocks + 8)

    def test_existing_destination_is_preserved(self):
        with tempfile.TemporaryDirectory(prefix='owned-copy-existing-') as root:
            source, target = Path(root) / 'source', Path(root) / 'target'
            source.write_bytes(b'new'); target.write_bytes(b'older owner')
            with self.assertRaises(FileExistsError):
                copy.copy_evidence_file(source, target)
            self.assertEqual(target.read_bytes(), b'older owner')

    def test_non_darwin_fallback_keeps_the_same_bytes(self):
        with tempfile.TemporaryDirectory(prefix='owned-copy-fallback-') as root:
            source, target = Path(root) / 'source', Path(root) / 'target'
            source.write_bytes(b'full original bytes')
            with patch.object(copy.sys, 'platform', 'linux'):
                copy.copy_evidence_file(source, target)
            self.assertEqual(source.read_bytes(), target.read_bytes())


if __name__ == '__main__':
    unittest.main()

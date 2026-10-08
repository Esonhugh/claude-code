#!/usr/bin/env python3
"""Protocol prefix tests; fixture records are not current CLI acceptance."""
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('live_journal', Path(__file__).with_name('native-terminal-journal.py'))
journal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journal)
spec = importlib.util.spec_from_file_location('live_publisher', Path(__file__).with_name('native-live-publisher.py'))
live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)


class NativeLivePrefixTest(unittest.TestCase):
    def fixture(self):
        header = [0] * 32
        header[:6] = [journal.MAGIC, 1, journal.HEADER.size, 4288, 64, 4096]
        header[6:8] = [123, 456]
        registration = {'header': list(header), 'payloadBytes': 4096}
        registration['header'][18] = header[18] = 3
        header[8], header[9], header[12], header[13], header[19] = 789, 5, 1, 1, 50
        identity = {'captureId': 'unit-prefix', 'spanId': 1, 'rendererId': 1, 'rootEpoch': 1,
                    'columns': 2, 'rows': 1, 'profile': 'ink-post-write-v1'}
        frame = {'viewport': {'width': 2, 'height': 1}, 'cursor': {'visible': False}}
        snapshot = {'native': identity, 'rootReset': False, 'cursorVisible': False,
                    'frameBase64': base64.b64encode(json.dumps(frame).encode()).decode()}
        packets = []
        for kind, entry, payload in [(10, 100, identity), (12, 110, identity), (1, 120, b'HI'),
                                     (13, 130, identity), (11, 140, snapshot)]:
            data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
            word = [0] * 20
            word[:7] = [2, len(packets) + 1, kind, 789, 1, entry, entry + 1]
            word[10] = word[14] = len(data)
            if kind == 1:
                word[7:10] = [1, 3, 1]
                word[11] = len(data)
            else:
                word[15] = 1
            packets.append(journal.RECORD.pack(*word) + data)
        return header, packets, registration

    def test_open_prefix_never_supplies_a_fake_final_close(self):
        header, packets, registration = self.fixture()
        before = copy.deepcopy(header)
        self.assertEqual(len(journal.decode_live_records(header, packets, registration, 789)), 5)
        with self.assertRaisesRegex(journal.JournalError, 'close boundary'):
            journal.decode_records(header, packets, registration, 789)
        self.assertEqual(header, before)
        header[11], header[21] = 1, 200
        self.assertEqual(len(journal.decode_records(header, packets, registration, 789)), 5)
        with self.assertRaisesRegex(journal.JournalError, 'Missing native record sequence'):
            journal.decode_records(header, packets[:-1], registration, 789)

    def test_frames_wait_for_the_original_physical_prefix_and_keep_extra_tail(self):
        header, packets, registration = self.fixture()
        args = (header, packets)
        rest = (registration, 789, 'unit-prefix', 0)
        self.assertEqual(journal.ink_live_frame_entries(*args, b'H', *rest), [])
        entries = journal.ink_live_frame_entries(*args, b'HIreal later bytes', *rest)
        self.assertEqual(len(entries), 1)
        self.assertEqual((entries[0]['frameId'], entries[0]['rawStart'], entries[0]['rawEnd']), (1, 0, 2))
        self.assertEqual(base64.b64decode(entries[0]['outputBase64']), b'HI')
        for raw in (b'X', b'Xi', b'wrong prefix'):
            with self.subTest(raw=raw), self.assertRaisesRegex(journal.JournalError, 'raw prefix differs'):
                journal.ink_live_frame_entries(*args, raw, *rest)

    def test_live_prefix_rejects_foreign_lost_and_malformed_committed_records(self):
        header, packets, registration = self.fixture()
        for index, value in ((8, 790), (10, 1), (11, 2), (12, 0), (19, 0), (9, 4), (6, 999)):
            with self.subTest(index=index):
                changed = list(header)
                changed[index] = value
                with self.assertRaises(journal.JournalError):
                    journal.decode_live_records(changed, packets, registration, 789)
        for index, value in ((0, 1), (1, 99), (3, 999), (5, 20), (13, 1), (14, 9999), (16, 1)):
            with self.subTest(index=index):
                changed = list(packets)
                word = list(journal.RECORD.unpack_from(changed[0]))
                word[index] = value
                changed[0] = journal.RECORD.pack(*word) + changed[0][journal.RECORD.size:]
                with self.assertRaises(journal.JournalError):
                    journal.decode_live_records(header, changed, registration, 789)

    def test_unfinished_frame_is_pending_but_a_missing_earlier_marker_is_rejected(self):
        header, packets, registration = self.fixture()
        self.assertEqual(journal.ink_live_frame_entries(header, packets[:-1], b'HI', registration, 789, 'unit-prefix', 0), [])
        broken = list(packets)
        word = list(journal.RECORD.unpack_from(broken[1]))
        word[2] = 14
        broken[1] = journal.RECORD.pack(*word) + broken[1][journal.RECORD.size:]
        with self.assertRaisesRegex(journal.JournalError, 'Missing, duplicated or reordered frame markers'):
            journal.ink_live_frame_entries(header, broken, b'HI', registration, 789, 'unit-prefix', 0)


class NativeLivePublisherTest(unittest.TestCase):
    def two_frames(self):
        header, first, registration = NativeLivePrefixTest().fixture()
        packets = list(first)
        for packet in first:
            word = list(journal.RECORD.unpack_from(packet))
            data = packet[journal.RECORD.size:]
            word[1] += 5
            word[5] += 200
            word[6] += 200
            if word[2] == 1:
                data = b'BY'
            else:
                value = json.loads(data)
                (value['native'] if word[2] == 11 else value)['spanId'] = 2
                data = json.dumps(value).encode()
                word[15] = 2
            word[10] = word[14] = len(data)
            packets.append(journal.RECORD.pack(*word) + data)
        header[9] = len(packets)
        return header, packets, registration

    def complete_frames(self, header, packets, registration, raw):
        closed = list(header)
        closed[11], closed[21] = 1, 700
        return journal.ink_frame_entries(journal.decode_records(closed, packets, registration, 789),
                                         raw, 'unit-prefix', 0)

    def wait_for_frames(self, run, count):
        path = Path(run) / 'frames.jsonl'
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if path.exists():
                data = path.read_bytes()
                if data.endswith(b'\n'):
                    rows = [json.loads(line) for line in data.splitlines()]
                    if len(rows) == count:
                        return rows
            time.sleep(.01)
        self.fail('Incomplete live frame prefix')

    def test_multiple_queued_snapshots_keep_the_exact_physical_prefix(self):
        with tempfile.TemporaryDirectory() as run:
            header, packets, registration = self.two_frames()
            expected = self.complete_frames(header, packets, registration, b'HIBY')
            io = b'{"ioId": 1}\n'
            writer = live.NativeLivePublisher(run, journal, registration, 789, 'unit-prefix', 0)
            entered, release = threading.Event(), threading.Event()
            original = writer._write
            def blocked(fd, data):
                if not entered.is_set():
                    entered.set()
                    self.assertTrue(release.wait(2))
                original(fd, data)
            writer._write = blocked
            try:
                self.assertTrue(writer.offer('io', io))
                self.assertTrue(entered.wait(2))
                self.assertTrue(writer.offer('raw', b'HIBY'))
                for packet in packets:
                    self.assertTrue(writer.offer('packet', packet, header))
                release.set()
                writer.finish(io, expected)
                self.assertFalse(writer.thread.is_alive())
                self.assertEqual((Path(run) / 'frames.jsonl').read_bytes(), live.rows_bytes(expected))
                self.assertEqual((Path(run) / 'pty-io.jsonl').read_bytes(), io)
            finally:
                release.set()
                if writer.thread.is_alive():
                    writer.finish(io, expected)

    def test_pending_snapshot_crosses_batches_and_tail_does_not_invent_a_frame(self):
        with tempfile.TemporaryDirectory() as run:
            header, packets, registration = self.two_frames()
            pending, drained, tail_drained = threading.Event(), threading.Event(), threading.Event()
            def observe(*args):
                result = journal.ink_live_frame_entries(*args)
                if not result:
                    pending.set()
                return result
            observed = SimpleNamespace(RECORD=journal.RECORD, ink_live_frame_entries=observe)
            writer = live.NativeLivePublisher(run, observed, registration, 789, 'unit-prefix', 0)
            original = writer._write
            def write(fd, data):
                original(fd, data)
                if data == b'{"ioId": 2}\n':
                    drained.set()
                elif data == b'{"ioId": 3}\n':
                    tail_drained.set()
            writer._write = write
            io = b'{"ioId": 2}\n{"ioId": 3}\n'
            word = list(journal.RECORD.unpack_from(packets[7]))
            word[1], word[5], word[6] = 11, 500, 501
            word[10], word[11], word[14] = 4, 4, 4
            tail = journal.RECORD.pack(*word) + b'tail'
            final_header = list(header)
            final_header[9] = 11
            expected = self.complete_frames(final_header, [*packets, tail], registration, b'HIBYtail')
            try:
                for packet in packets[:5]:
                    self.assertTrue(writer.offer('packet', packet, header))
                self.assertTrue(pending.wait(2))
                self.assertEqual((Path(run) / 'frames.jsonl').read_bytes(), b'')
                self.assertTrue(writer.offer('raw', b'HI'))
                self.assertEqual(self.wait_for_frames(run, 1), expected[:1])
                for packet in packets[5:8]:
                    self.assertTrue(writer.offer('packet', packet, header))
                self.assertTrue(writer.offer('raw', b'BY'))
                self.assertTrue(writer.offer('io', b'{"ioId": 2}\n'))
                self.assertTrue(drained.wait(2))
                self.assertEqual((Path(run) / 'frames.jsonl').read_bytes(), live.rows_bytes(expected[:1]))
                for packet in packets[8:]:
                    self.assertTrue(writer.offer('packet', packet, header))
                self.assertEqual(self.wait_for_frames(run, 2), expected)
                self.assertTrue(writer.offer('packet', tail, final_header))
                self.assertTrue(writer.offer('raw', b'tail'))
                self.assertTrue(writer.offer('io', b'{"ioId": 3}\n'))
                self.assertTrue(tail_drained.wait(2))
                self.assertEqual((Path(run) / 'frames.jsonl').read_bytes(), live.rows_bytes(expected))
                writer.finish(io, expected)
                self.assertFalse(writer.thread.is_alive())
            finally:
                if writer.thread.is_alive():
                    writer.finish(io, expected)

    def start(self, run, **options):
        header, packets, registration = NativeLivePrefixTest().fixture()
        writer = live.NativeLivePublisher(run, journal, registration, 789, 'unit-prefix', 0, **options)
        return writer, header, packets, registration

    def feed(self, writer, header, packets):
        for packet in packets:
            self.assertTrue(writer.offer('packet', packet, header))
        self.assertTrue(writer.offer('raw', b'HI'))
        self.assertTrue(writer.offer('io', b'{"ioId": 1}\n'))

    def wait_for_frame(self, run):
        path = Path(run) / 'frames.jsonl'
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if path.exists() and path.read_bytes().endswith(b'\n'):
                return json.loads(path.read_bytes())
            time.sleep(.01)
        self.fail('No live immutable frame before close')

    def test_publishes_before_close_and_binds_final_originals(self):
        with tempfile.TemporaryDirectory() as run:
            writer, header, packets, registration = self.start(run)
            self.feed(writer, header, packets)
            entry = self.wait_for_frame(run)
            self.assertFalse(writer.closing.is_set())
            self.assertEqual(entry['frameId'], 1)
            header[11], header[21] = 1, 200
            records = journal.decode_records(header, packets, registration, 789)
            final = journal.ink_frame_entries(records, b'HI', 'unit-prefix', 0)
            writer.finish(b'{"ioId": 1}\n', final)
            self.assertFalse(writer.thread.is_alive())
            self.assertEqual((Path(run) / 'frames.jsonl').read_bytes(), live.rows_bytes(final))
            self.assertEqual((Path(run) / 'pty-io.jsonl').stat().st_mode & 0o777, 0o600)

    def test_blocked_disk_never_blocks_offer_and_overflow_invalidates(self):
        with tempfile.TemporaryDirectory() as run:
            writer, *_ = self.start(run, limit=800)
            entered, release = threading.Event(), threading.Event()
            original = writer._write
            def blocked(fd, data):
                entered.set()
                self.assertTrue(release.wait(2))
                original(fd, data)
            writer._write = blocked
            self.assertTrue(writer.offer('io', b'first\n'))
            self.assertTrue(entered.wait(2))
            started = time.monotonic()
            self.assertTrue(writer.offer('io', b'second\n'))
            self.assertTrue(writer.offer('io', b'third\n'))
            self.assertFalse(writer.offer('io', b'overflow\n'))
            self.assertLess(time.monotonic() - started, .1)
            with self.assertRaises(TimeoutError):
                writer.finish(b'', [], timeout=.01)
            release.set()
            with self.assertRaisesRegex(ValueError, 'lost evidence'):
                writer.finish(b'', [])
            self.assertFalse(writer.thread.is_alive())

    def test_replaced_file_is_rejected_without_overwriting_replacement(self):
        with tempfile.TemporaryDirectory() as run:
            writer, header, packets, _ = self.start(run)
            self.feed(writer, header, packets)
            entry = self.wait_for_frame(run)
            path = Path(run) / 'frames.jsonl'
            path.rename(Path(run) / 'held-frame')
            path.write_bytes(live.rows_bytes([entry]))
            os.chmod(path, 0o600)
            with self.assertRaisesRegex(ValueError, 'ownership changed'):
                writer.finish(b'{"ioId": 1}\n', [entry])
            self.assertEqual(path.read_bytes(), live.rows_bytes([entry]))

    def test_mutated_same_file_is_rejected_against_memory_originals(self):
        with tempfile.TemporaryDirectory() as run:
            writer, header, packets, _ = self.start(run)
            self.feed(writer, header, packets)
            entry = self.wait_for_frame(run)
            path = Path(run) / 'frames.jsonl'
            path.write_bytes(b'forged original\n')
            with self.assertRaisesRegex(ValueError, 'differs from held originals'):
                writer.finish(b'{"ioId": 1}\n', [entry])

    def test_final_frame_and_io_disagreement_cannot_pass(self):
        for io, final in ((b'{"ioId": 1}\n', []), (b'forged io\n', None)):
            with self.subTest(io=io), tempfile.TemporaryDirectory() as run:
                writer, header, packets, _ = self.start(run)
                self.feed(writer, header, packets)
                entry = self.wait_for_frame(run)
                with self.assertRaisesRegex(ValueError, 'differs from final closed originals'):
                    writer.finish(io, [entry] if final is None else final)

    def test_foreign_packet_and_preexisting_file_are_rejected(self):
        with tempfile.TemporaryDirectory() as run:
            writer, header, packets, _ = self.start(run)
            changed = list(header)
            changed[8] = 999
            for packet in packets:
                writer.offer('packet', packet, changed)
            writer.offer('raw', b'HI')
            writer.offer('io', b'{\"ioId\": 1}\n')
            with self.assertRaisesRegex(journal.JournalError, 'Foreign'):
                writer.finish(b'{"ioId": 1}\n', [])
        with tempfile.TemporaryDirectory() as run:
            path = Path(run) / 'frames.jsonl'
            path.write_bytes(b'prior capture')
            writer, *_ = self.start(run)
            with self.assertRaises(FileExistsError):
                writer.finish(b'', [])
            self.assertEqual(path.read_bytes(), b'prior capture')


if __name__ == '__main__':
    unittest.main()

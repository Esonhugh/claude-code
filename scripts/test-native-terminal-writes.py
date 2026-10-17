#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import struct
import termios
import unittest

spec = importlib.util.spec_from_file_location(
    'native_terminal_writes', Path(__file__).with_name('native-terminal-writes.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
PID = 123


def packet(record_kind, sequence=0, data=b'', **fields):
    values = dict(magic=module.MAGIC, kind=record_kind, pid=PID, sequence=sequence,
                  fd=1 if record_kind == 1 else 0, requested=len(data), returned=len(data),
                  flags=0, operation=1 if record_kind == 1 else 0, offset=0,
                  captured=len(data), length=len(data), mask=1 if record_kind == 1 else 0,
                  error=0, thread=100)
    values.update(fields)
    keys = ('magic', 'kind', 'pid', 'sequence', 'fd', 'requested', 'returned',
            'flags', 'operation', 'offset', 'captured', 'length', 'mask', 'error',
            'thread')
    raw = module.HEADER.pack(*(values[k] % (1 << 64) for k in keys)) + data
    return struct.pack('<I', len(raw)) + raw


def capture(*writes, count=None):
    return packet(0) + b''.join(writes) + packet(2, len(writes) if count is None else count)


class NativeWritesTests(unittest.TestCase):
    def decode(self, data):
        return module.decode_packets(data, PID)

    def invalid(self, data):
        with self.assertRaises(module.EvidenceError):
            self.decode(data)

    def test_actual_alias_fd_and_successful_prefix(self):
        writes = self.decode(capture(packet(1, 1, b'abc', fd=5, requested=10)))
        self.assertEqual(writes[0]['fd'], 5)
        self.assertEqual(module.verify_raw(writes, b'abc', 1)['rawBytes'], 3)
        with self.assertRaises(module.EvidenceError):
            module.verify_raw(writes, b'abcdefghij', 1)

    def test_failed_and_zero_syscalls_own_no_bytes(self):
        writes = self.decode(capture(packet(1, 1, returned=-1, requested=4, error=9),
                                     packet(1, 2)))
        self.assertEqual(module.verify_raw(writes, b'', 1)['syscalls'], 2)

    def test_fragments_reassembled_from_offsets(self):
        data = capture(packet(1, 1, b'cd', offset=2, captured=4, returned=4, requested=4),
                       packet(1, 1, b'ab', captured=4, returned=4, requested=4), count=1)
        self.assertEqual(module.verify_raw(self.decode(data), b'abcd', 1)['rawBytes'], 4)

    def test_missing_duplicate_and_overlapping_fragments(self):
        a = packet(1, 1, b'ab', captured=4, returned=4, requested=4)
        for data in (capture(a, count=1), capture(a, a, count=1),
                     capture(a, packet(1, 1, b'cd', offset=1, captured=4,
                                       returned=4, requested=4), count=1)):
            self.invalid(data)

    def test_empty_fragment_cannot_be_duplicated(self):
        self.invalid(capture(packet(1, 1), packet(1, 1), count=1))

    def test_cross_producer_and_fragment_metadata(self):
        for fields in ({'pid': PID + 1}, {'mask': 2}, {'fd': 9}, {'thread': 101},
                       {'requested': 5}, {'operation': 2}, {'error': 9}):
            a = packet(1, 1, b'ab', captured=4, returned=4, requested=4)
            b = packet(1, 1, b'cd', offset=2, captured=4, returned=4, requested=4,
                       **{k: v for k, v in fields.items() if k != 'requested'})
            if 'requested' in fields:
                b = packet(1, 1, b'cd', offset=2, captured=4, returned=4,
                           requested=fields['requested'])
            self.invalid(capture(a, b, count=1))

    def test_fail_closed_packet_envelope(self):
        good = capture(packet(1, 1, b'x'))
        for data in (b'', b'\x01', good[:-1], good + b'\x00',
                     struct.pack('<I', 0), struct.pack('<I', 2**32 - 1)):
            self.invalid(data)

    def test_lifecycle_is_not_inferred_from_later_data(self):
        write = packet(1, 1, b'x')
        for data in (write + packet(2, 1), packet(0) + write,
                     capture(write) + write, packet(0) + packet(2, 1) + write,
                     packet(0) + capture(write), capture(write) + packet(2, 1)):
            self.invalid(data)

    def test_format_capacity_drop_and_result_validation(self):
        for fields in ({'magic': 1}, {'kind': 9}, {'flags': 1}, {'mask': 0},
                       {'mask': 4}, {'thread': 0}, {'returned': 2},
                       {'captured': 5000}, {'length': 0}, {'offset': 1},
                       {'operation': 5}, {'fd': 2**32}, {'returned': -2}):
            self.invalid(capture(packet(1, 1, b'x', **fields)))
        self.invalid(packet(0) + packet(1, 1, b'x') + packet(2, 1, flags=1))
        self.invalid(capture(packet(1, 1, returned=-1)))

    def test_sequence_holes_and_forged_count(self):
        for data in (capture(packet(1, 2, b'x')), capture(packet(1, 1, b'x'), count=0),
                     capture(packet(1, 1, b'x'), count=2**63)):
            self.invalid(data)

    def test_declared_request_cannot_exceed_observer_capacity(self):
        # This observer marks every oversized request incomplete, even if the
        # original syscall happened to return a short successful prefix.
        self.invalid(capture(packet(1, 1, b'x', requested=module.MAX_CAPTURE + 1)))

    def test_unowned_prefix_tail_and_reorder(self):
        writes = self.decode(capture(packet(1, 1, b'ab')))
        for raw in (b'a', b'xab', b'abx', b'ba'):
            with self.assertRaises(module.EvidenceError):
                module.verify_raw(writes, raw, 1)

    def test_thread_order_cannot_be_guessed_from_raw(self):
        writes = self.decode(capture(packet(1, 1, b'a'),
                                     packet(1, 2, b'b', thread=101)))
        for raw in (b'ab', b'ba'):
            with self.assertRaises(module.EvidenceError):
                module.verify_raw(writes, raw, 1)

    def test_shared_pty_uses_only_recorded_transform(self):
        writes = self.decode(capture(packet(1, 1, b'a\nb', mask=3)))
        result = module.verify_raw(writes, b'a\r\nb', 3, termios.OPOST | termios.ONLCR)
        self.assertEqual(result['rawBytes'], 4)
        for mask, flags in ((1, None), (2, None), (3, None), (3, 0)):
            with self.assertRaises(module.EvidenceError):
                module.verify_raw(writes, b'a\r\nb', mask, flags)

    def test_stderr_is_not_stdout(self):
        writes = self.decode(capture(packet(1, 1, b'err', mask=2, fd=2)))
        self.assertEqual(module.verify_raw(writes, b'err', 2)['rawBytes'], 3)
        with self.assertRaises(module.EvidenceError):
            module.verify_raw(writes, b'err', 1)


if __name__ == '__main__':
    unittest.main()

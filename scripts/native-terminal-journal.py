#!/usr/bin/env python3
"""Validate immutable native records. No timestamps or logical cells select bytes.

This protocol proves bounded write coverage and metadata spans, not complete
termios/geometry/input/UI acceptance. Loss and ambiguous ordering stay failed.
"""
import hashlib
import json
import mmap
import os
from pathlib import Path
import struct
import uuid

MAGIC = 0x314C4E4A544343
HEADER = struct.Struct('<32Q')
RECORD = struct.Struct('<20Q')
TERMIOS_PREFIX = struct.Struct('<6Q')
TERMIOS_VALUE = struct.Struct('<6Q20B')
MUTABLE_HEADER = {8, 9, 10, 11, 12, 13, 19, 21}


class JournalError(ValueError):
    pass


def require(condition, reason):
    if not condition:
        raise JournalError(reason)


def create_journal(path, endpoint, output_mask, capacity=64, payload_bytes=65536):
    require(type(capacity) is int and 1 <= capacity <= 4096, 'Invalid slot count')
    require(type(payload_bytes) is int and 1 <= payload_bytes <= 1048576,
            'Invalid immutable payload capacity')
    require(output_mask in (1, 2, 3), 'Invalid endpoint mask')
    nonce = uuid.uuid4().int
    stride = ((RECORD.size + payload_bytes + 63) // 64) * 64
    header = [MAGIC, 1, HEADER.size, stride, capacity, payload_bytes,
              nonce >> 64, nonce & ((1 << 64) - 1), *([0] * 24)]
    # Darwin exposes signed dev_t in Python; the observer casts it to uint64_t.
    identity = [endpoint.st_dev, endpoint.st_ino, endpoint.st_rdev, endpoint.st_mode]
    require(all(type(value) is int and -(1 << 63) <= value < 1 << 64 for value in identity),
            'Invalid native endpoint identity')
    header[14:19] = [value & ((1 << 64) - 1) for value in identity] + [output_mask]
    path = Path(path)
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.ftruncate(fd, HEADER.size + stride * capacity)
        os.pwrite(fd, HEADER.pack(*header), 0)
    finally:
        os.close(fd)
    return {'header': header, 'path': str(path), 'capacity': capacity,
            'payloadBytes': payload_bytes, 'nonce': f'{nonce:032x}'}


def final_records(path, registration):
    """Finite, no-consumer diagnostic; normal exit must precede this read.

    Interactive collectors must acquire/release slots using the native consumer
    API and keep every copied record, rather than reading live slot structures.
    """
    data = Path(path).read_bytes()
    require(len(data) >= HEADER.size, 'Missing native header')
    header = HEADER.unpack_from(data)
    require(len(data) == registration['header'][2] +
            registration['header'][3] * registration['header'][4],
            'Shared journal size changed')
    require(header[9] <= registration['capacity'],
            'Final-only reader cannot reconstruct a reused ring')
    records = []
    for sequence in range(1, header[9] + 1):
        offset = registration['header'][2] + (sequence - 1) * registration['header'][3]
        metadata = RECORD.unpack_from(data, offset)
        require(metadata[14] <= registration['payloadBytes'], 'Invalid payload size')
        records.append(data[offset:offset + RECORD.size + metadata[14]])
    return header, records


def decode_records(header, records, registration, expected_pid):
    return _decode_records(header, records, registration, expected_pid, closed=True)


def decode_live_records(header, records, registration, expected_pid):
    """Committed prefix only. This never establishes a close or full coverage."""
    return _decode_records(header, records, registration, expected_pid, closed=False)


def _decode_records(header, records, registration, expected_pid, *, closed):
    require(type(expected_pid) is int and expected_pid > 0, 'Independent main PID required')
    require(len(header) == 32 and all(type(word) is int and 0 <= word < 1 << 64
            for word in header), 'Invalid header')
    require(all(header[index] == word for index, word in enumerate(registration['header'])
                if index not in MUTABLE_HEADER), 'Native registration changed')
    require(header[8] == expected_pid, 'Foreign or absent native producer')
    require(header[10] == 0, 'Lost native journal record')
    if closed:
        require(header[11] == 1 and header[19] > 0 and header[21] >= header[19] and
                header[12] > 0 and header[13] > 0, 'Missing native clock or close boundary')
        require(header[9] == len(records), 'Missing native record sequence')
    else:
        require(header[11] in (0, 1) and header[19] > 0 and header[12] > 0 and header[13] > 0,
                'Missing native prefix clock or lifecycle')
        require(header[9] >= len(records), 'Prefix exceeds native record sequence')
        if header[11] == 1:
            require(header[21] >= header[19], 'Missing closed native prefix boundary')
    decoded = []
    for sequence, data in enumerate(records, 1):
        require(len(data) >= RECORD.size, 'Truncated native metadata')
        word = RECORD.unpack_from(data)
        (state, ticket, kind, pid, thread, entry, returned_at, fd, mask,
         operation, requested, returned, error, flags, length, span,
         *reserved) = word
        require(state == 2 and ticket == sequence and pid == expected_pid and thread > 0,
                'Foreign, duplicated or incomplete native record')
        require(flags == 0 and not any(reserved), 'Truncated or unsupported native observation')
        require(header[19] <= entry <= returned_at and
                (not header[11] or returned_at <= header[21]),
                'Native syscall bracket lies outside lifecycle')
        require(length <= registration['payloadBytes'] and len(data) == RECORD.size + length,
                'Immutable payload bounds mismatch')
        result = returned if returned < 1 << 63 else returned - (1 << 64)
        if kind == 1:
            require(mask == registration['header'][18] and operation in (1, 2, 3, 4)
                    and fd < 1 << 31 and -1 <= result <= requested <= registration['payloadBytes']
                    and length == max(0, result), 'Original write result/prefix mismatch')
            require(result != -1 or error > 0, 'Failed write lacks original errno')
        elif kind == 2:
            require(mask == registration['header'][18] and fd < 1 << 31 and span == 0 and
                    -1 <= result <= 0 and (operation in (0, 1, 2) or result == -1) and
                    requested == length == TERMIOS_PREFIX.size + 3 * TERMIOS_VALUE.size,
                    'Original tcsetattr result or canonical payload mismatch')
            require(result != -1 or error > 0, 'Failed tcsetattr lacks original errno')
            prefix = TERMIOS_PREFIX.unpack_from(data, RECORD.size)
            require(prefix[:2] == (1, 20) and prefix[2] == prefix[4] == 0,
                    'Native termios kernel query failed')
        else:
            require(10 <= kind <= 20 and fd == mask == operation == returned == error == 0
                    and requested == length, 'Invalid native metadata observation')
        decoded.append({'sequence': ticket, 'kind': kind, 'pid': pid,
                        'threadId': thread, 'entry': entry, 'return': returned_at,
                        'fd': fd, 'outputMask': mask, 'operation': operation,
                        'requested': requested, 'result': result, 'errno': error,
                        'spanId': span, 'bytes': data[RECORD.size:]})
        if kind == 2:
            for index, name in enumerate(('modeBefore', 'modeRequested', 'modeAfter')):
                values = TERMIOS_VALUE.unpack_from(data, RECORD.size + TERMIOS_PREFIX.size + index * TERMIOS_VALUE.size)
                decoded[-1][name] = dict(zip(('inputFlags', 'outputFlags', 'controlFlags', 'localFlags',
                                             'inputSpeed', 'outputSpeed'), values[:6])) | {'controlChars': list(values[6:])}
    return decoded


def native_write_outputs(records, output_flags):
    """Transform each successful write using ordered observed kernel modes.

    Captured tcsetattr calls do not cover unobserved direct mode ioctls or input
    ownership. An overlapping mode change cannot select a write's transform.
    """
    import termios
    require(type(output_flags) is int and 0 <= output_flags < 2 ** 64,
            'Invalid native initial output flags')
    effects = sorted((row for row in records if row['kind'] in (1, 2)),
                     key=lambda row: (row['entry'], row['return'], row['sequence']))
    require(all(left['return'] <= right['entry'] for left, right in zip(effects, effects[1:])),
            'Overlapping writes or termios changes lack kernel order')
    outputs = {}
    current = output_flags
    for row in effects:
        if row['kind'] == 2:
            require(row['modeBefore']['outputFlags'] == current,
                    'Native termios before-state differs from mode ledger')
            current = row['modeAfter']['outputFlags']
            continue
        if current & termios.OPOST:
            require(current == termios.OPOST | termios.ONLCR, 'Unproved native PTY transformation')
            output = row['bytes'].replace(b'\n', b'\r\n')
        else:
            output = row['bytes']
        outputs[row['sequence']] = output
    return outputs


def verify_raw(records, raw, output_flags):
    writes = [row for row in records if row['kind'] == 1]
    require(len({row['threadId'] for row in writes}) <= 1,
            'Multiple writers lack kernel order')
    require(all(left['return'] <= right['entry'] for left, right in zip(writes, writes[1:])),
            'Overlapping writes lack kernel order')
    outputs = native_write_outputs(records, output_flags)
    source = b''.join(outputs[row['sequence']] for row in writes)
    require(source == raw,
            'Unowned, missing, transformed or reordered raw bytes')
    return {'verdict': 'passed', 'method': 'native-shared-slot-writes-v1',
            'rawBytes': len(raw), 'rawSHA256': hashlib.sha256(raw).hexdigest(),
            'syscalls': len(writes), 'scope': 'bounded write coverage only',
            'productTimingEquivalent': False,
            'remaining': ['termios lifetime', 'geometry brackets', 'actual input/owner',
                          'immutable logical/physical frame proof', 'normal PTY EOF/reap']}


def frame_spans(records, profile='pre-write-v1'):
    """Use strict native brackets; do not guess offsets from nearby timestamps.

    Kinds 10 layout, 11 immutable snapshot, 12 begin, 13 end. Every frame write
    must occur completely after begin returns and before end enters. Other
    output remains in the byte ledger. No logical correctness is claimed here.
    """
    require(profile in ('pre-write-v1', 'ink-post-write-v1'), 'Unknown native frame profile')
    order = [10, 11, 12, 13] if profile == 'pre-write-v1' else [10, 12, 13, 11]
    groups = {}
    for row in records:
        if row['kind'] in (10, 11, 12, 13):
            require(row['spanId'] > 0, 'Frame marker lacks identity')
            groups.setdefault(row['spanId'], []).append(row)
    writes = [row for row in records if row['kind'] == 1]
    require(len({row['threadId'] for row in records}) <= 1,
            'Frame correlation cannot assume multiple-thread order')
    previous_end = 0
    result = []
    for span, rows in groups.items():
        require([row['kind'] for row in rows] == order,
                'Missing, duplicated or reordered frame markers')
        if profile == 'pre-write-v1':
            layout, snapshot, begin, end = rows
        else:
            layout, begin, end, snapshot = rows
        require(previous_end <= layout['entry'] and
                all(left['return'] <= right['entry'] for left, right in zip(rows, rows[1:])),
                'Overlapping frame metadata')
        selected = [row for row in writes if begin['entry'] <= row['entry'] <= end['return']]
        require(all(begin['return'] <= row['entry'] <= row['return'] <= end['entry']
                    for row in selected), 'Write crosses native frame boundary')
        require(all(not (row['entry'] < begin['entry'] < row['return'] or
                         row['entry'] < end['return'] < row['return']) for row in writes),
                'Asynchronous write crosses native frame boundary')
        if profile == 'ink-post-write-v1':
            require(all(not (end['entry'] <= row['entry'] < snapshot['return'])
                        for row in writes), 'Output occurred before immutable post-write snapshot')
        start = sum(len(row['bytes']) for row in writes if row['return'] <= begin['entry'])
        byte_count = sum(len(row['bytes']) for row in selected)
        result.append({'spanId': span, 'layoutSequence': layout['sequence'],
                       'snapshotSequence': snapshot['sequence'],
                       'startSequence': begin['sequence'], 'endSequence': end['sequence'],
                       'writeSequences': [row['sequence'] for row in selected],
                       'untransformedStart': start, 'untransformedBytes': byte_count,
                       'observationKind': 'output-transaction' if byte_count else 'logical-observation',
                       'scope': 'native span only; no geometry or UI verdict'})
        previous_end = rows[-1]['return']
    return result


def ink_frame_entries(records, raw, capture_id, output_flags):
    """Bind post-write snapshots to exact successful syscall prefixes.

    This write adapter does not establish termios/resize lifetime or
    input ownership. The independent replay retains those uncovered boundaries.
    """
    import base64
    verify_raw(records, raw, output_flags)
    outputs = native_write_outputs(records, output_flags)
    spans = frame_spans(records, 'ink-post-write-v1')
    require(spans and [span['spanId'] for span in spans] == list(range(1, len(spans) + 1)),
            'Missing native Ink frame identity')
    by_sequence = {row['sequence']: row for row in records}
    entries = []
    previous_offset = 0
    for span in spans:
        layout, begin, end, snapshot = [by_sequence[span[key]] for key in
                                      ('layoutSequence', 'startSequence', 'endSequence', 'snapshotSequence')]
        try:
            identities = [json.loads(row['bytes']) for row in (layout, begin, end)]
            value = json.loads(snapshot['bytes'])
            frame_bytes = base64.b64decode(value['frameBase64'], validate=True)
            frame = json.loads(frame_bytes)
        except (ValueError, KeyError, TypeError) as error:
            raise JournalError('Malformed immutable Ink frame') from error
        identity = identities[0]
        require(all(row == identity for row in identities) and value['native'] == identity and
                identity.get('profile') == 'ink-post-write-v1' and identity.get('captureId') == capture_id and
                identity.get('spanId') == span['spanId'], 'Foreign immutable Ink frame identity')
        require(all(type(identity.get(key)) is int and identity[key] > 0
                    for key in ('spanId', 'rendererId', 'rootEpoch', 'columns', 'rows')),
                'Invalid immutable Ink layout identity')
        require(type(value.get('rootReset')) is bool and type(value.get('cursorVisible')) is bool and
                isinstance(frame, dict) and frame.get('viewport') ==
                {'width': identity['columns'], 'height': identity['rows']} and
                frame.get('cursor', {}).get('visible') is value['cursorVisible'],
                'Immutable Ink snapshot differs from its layout or cursor policy')
        before = [row for row in records if row['kind'] == 1 and row['return'] <= begin['entry']]
        selected = [by_sequence[sequence] for sequence in span['writeSequences']]
        start = sum(len(outputs[row['sequence']]) for row in before)
        count = sum(len(outputs[row['sequence']]) for row in selected)
        finish = start + count
        require(previous_offset <= start <= finish <= len(raw), 'Invalid native physical frame prefix')
        entries.append({'frameId': span['spanId'], 'native': identity,
                        **{key: value[key] for key in ('rootReset', 'terminalPanes', 'terminalUiRevision')
                           if key in value},
                        'rawStart': start, 'rawEnd': finish,
                        'writeSequences': span['writeSequences'],
                        'outputBase64': base64.b64encode(raw[previous_offset:finish]).decode(),
                        'frameBase64': value['frameBase64']})
        previous_offset = finish
    return entries


def ink_live_frame_entries(header, packets, raw, registration, expected_pid, capture_id, output_flags):
    """Derive complete frames from copied native records and physical raw bytes.

    No close marker is invented. Incomplete trailing frames remain pending;
    malformed earlier records and physical prefix disagreement are rejected.
    The final verifier must separately bind all originals and the actual close.
    """
    records = decode_live_records(header, packets, registration, expected_pid)
    snapshots = [index for index, row in enumerate(records) if row['kind'] == 11]
    if not snapshots:
        return []
    complete = records[:snapshots[-1] + 1]
    outputs = native_write_outputs(complete, output_flags)
    physical = b''.join(outputs[row['sequence']] for row in complete if row['kind'] == 1)
    if len(raw) < len(physical):
        require(physical.startswith(raw), 'Native live raw prefix differs from original writes')
        return []
    require(raw.startswith(physical), 'Native live raw prefix differs from original writes')
    return ink_frame_entries(complete, raw[:len(physical)], capture_id, output_flags)


class NativeConsumer:
    """Independent collector; native acquire/copy/release owns each live slot.

    Returned bytes never reference the shared mapping. The producer never waits
    for this consumer; saturation still increments loss and invalidates capture.
    """
    def __init__(self, path, registration, library, expected_pid=None):
        import ctypes
        import stat
        import threading
        self.owner = threading.current_thread()
        self.closed = False
        self.mapping = None
        self.pin = None
        self.fd = None
        self.registration = {**registration, 'header': list(registration['header'])}
        self.expected_pid = expected_pid
        try:
            self.fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
            file = os.fstat(self.fd)
            size = registration['header'][2] + registration['header'][3] * registration['header'][4]
            require(stat.S_ISREG(file.st_mode) and file.st_uid == os.getuid() and
                    stat.S_IMODE(file.st_mode) == 0o600 and file.st_nlink == 1 and
                    file.st_size == size, 'Foreign native collector mapping')
            self.mapping = mmap.mmap(self.fd, size)
            self.pin = (ctypes.c_ubyte * size).from_buffer(self.mapping)
            self.destination = ctypes.create_string_buffer(RECORD.size + registration['payloadBytes'])
            self.library = ctypes.CDLL(str(library))
            self.function = self.library.cc_terminal_journal_consume
            self.function.argtypes = [ctypes.c_void_p, ctypes.c_uint64, ctypes.c_uint64,
                                      ctypes.c_void_p, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_uint64]
            self.function.restype = ctypes.c_int
            self.resize_function = self.library.cc_terminal_native_resize
            self.resize_function.argtypes = [ctypes.c_int, ctypes.c_uint64, ctypes.POINTER(ctypes.c_uint64)]
            self.resize_function.restype = ctypes.c_int
            self.size = size
            self.expected = (ctypes.c_uint64 * 32)(*self.registration['header'])
            self.check_registration()
            if expected_pid is not None:
                self.bind_producer(expected_pid)
        except BaseException:
            self.close()
            raise

    def require_owner(self):
        import threading
        require(threading.current_thread() is self.owner,
                'Native collector requires its owner thread')

    def check_registration(self):
        header = HEADER.unpack_from(self.mapping)
        require(all(header[index] == word for index, word in enumerate(self.registration['header'])
                    if index not in MUTABLE_HEADER), 'Native collector registration changed')
        return header

    def bind_producer(self, pid):
        self.require_owner()
        require(type(pid) is int and pid > 0 and pid != os.getpid(),
                'Independent producer PID required')
        require(self.expected_pid in (None, pid), 'Native producer binding cannot change')
        self.expected_pid = pid
        require(self.check_registration()[8] in (0, pid), 'Foreign native producer registration')

    def consume(self, sequence):
        self.require_owner()
        require(not self.closed and type(sequence) is int and sequence > 0,
                'Invalid collector sequence')
        require(self.expected_pid is not None, 'Independent producer binding required')
        require(self.check_registration()[8] in (0, self.expected_pid),
                'Foreign native producer registration')
        status = self.function(self.pin, self.size, sequence, self.destination,
                               len(self.destination), self.expected, self.expected_pid)
        require(status in (0, 1), 'Foreign or corrupt native slot')
        if status == 0:
            return None
        header = RECORD.unpack_from(self.destination)
        require(header[0] == 2 and header[1] == sequence and
                header[14] <= self.registration['payloadBytes'],
                'Exclusive native copy identity changed')
        return bytes(self.destination.raw[:RECORD.size + header[14]])

    def header(self):
        self.require_owner()
        require(not self.closed, 'Native collector is closed')
        return HEADER.unpack_from(self.mapping)

    def resize(self, fd, size):
        import ctypes
        self.require_owner()
        require(not self.closed and self.expected_pid is not None and len(size) == 8,
                'Native resize requires the owned collector and winsize')
        receipt = (ctypes.c_uint64 * 12)()
        returned = self.resize_function(fd, struct.unpack('<Q', size)[0], receipt)
        require(returned == 0 and receipt[2] == receipt[6] == receipt[8] == 0 and
                struct.pack('<Q', receipt[5]) == size and
                0 < receipt[0] <= receipt[1] and receipt[10] > 0 and receipt[11] > 0,
                'Actual native resize or acknowledgement failed')
        return {'method': 'native-mach-ioctl-resize-v1', 'entry': str(receipt[0]), 'return': str(receipt[1]),
                'result': returned, 'errno': receipt[3], 'beforeSizeHex': struct.pack('<Q', receipt[4]).hex(),
                'afterSizeHex': struct.pack('<Q', receipt[5]).hex(),
                'timebaseNumer': receipt[10], 'timebaseDenom': receipt[11],
                'nonce': self.registration['nonce'], 'childPid': self.expected_pid}

    def close(self):
        self.require_owner()
        self.pin = None
        try:
            if self.mapping is not None:
                self.mapping.close()
                self.mapping = None
        finally:
            if self.fd is not None:
                os.close(self.fd)
                self.fd = None
            self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_error):
        self.close()

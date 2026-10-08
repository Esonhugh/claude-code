#!/usr/bin/env python3
"""Re-derive every native Ink frame from original packets and raw after exit."""
import hashlib
import base64
import importlib.util
import json
import os
from pathlib import Path
import stat
import struct
import sys

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('native_journal', Path(__file__).with_name('native-terminal-journal.py'))
journal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journal)


def verify_fixed_geometry_io(run, expected):
    """Reject resize rather than infer native ordering from a raw read offset."""
    try:
        data = (run / 'pty-io.jsonl').read_bytes()
        io = [json.loads(line) for line in data.splitlines()]
    except FileNotFoundError as error:
        raise journal.JournalError('Native IO geometry receipt is missing') from error
    journal.require(io and all(type(row) is dict for row in io), 'Invalid native IO geometry receipt')
    first = io[0]
    journal.require(first.get('kind') == 'initial-geometry' and
                    first.get('columns') == expected['columns'] and first.get('rows') == expected['rows'] and
                    first.get('childPid') == expected['childPid'] and first.get('rawOffset') == 0,
                    'Native IO initial geometry differs from independent expectation')
    for index, row in enumerate(io, 1):
        journal.require(row.get('kind') != 'resize-ack' and type(row.get('geometryId')) is int and
                        row['geometryId'] == 0,
                        'Fixed-geometry replay cannot accept resize without native brackets '
                        f"(ioId={row.get('ioId')}, geometryId={row.get('geometryId')}, "
                        f"size={row.get('columns')}x{row.get('rows')})")
        journal.require(type(row.get('ioId')) is int and row['ioId'] == index and
                        type(row.get('rawOffset')) is int and row['rawOffset'] >= 0 and
                        row.get('captureId') == expected['captureId'] and
                        row.get('kind') in ('initial-geometry', 'input', 'output') and
                        (row['kind'] == 'initial-geometry') == (index == 1),
                        'Foreign, missing or unsupported native IO geometry receipt')
    close = expected.get('ioClose')
    journal.require(type(close) is dict and close.get('method') == 'owned-broker-closed-io-v1' and
                    type(close.get('recordCount')) is int and close['recordCount'] == len(io) and
                    close.get('sha256') == hashlib.sha256(data).hexdigest() and
                    type(close.get('rawBytes')) is int and close['rawBytes'] > 0 and
                    type(close.get('finalGeometryId')) is int and
                    close['finalGeometryId'] == io[-1]['geometryId'],
                    'Native IO does not match independent close receipt')
    offset = 0
    for row in io:
        if row['kind'] == 'output':
            journal.require(type(row.get('start')) is int and type(row.get('end')) is int and
                            row['start'] == offset < row['end'] <= close['rawBytes'] and
                            row['rawOffset'] == row['end'], 'Native IO output coverage is incomplete')
            offset = row['end']
        else:
            journal.require(row['rawOffset'] == offset, 'Native IO raw offset moved without output')
    journal.require(offset == close['rawBytes'] == len((run / 'raw.bin').read_bytes()),
                    'Native IO output coverage is incomplete')


def derive_frames(run, expected):
    run = Path(run).resolve(strict=True)
    launch = json.loads((run / 'launch.json').read_text())
    start = json.loads((run / 'start.json').read_text())
    cleanup = json.loads((run / 'cleanup.json').read_text())
    initial = json.loads((run / 'native-initial.json').read_text())
    registration = json.loads((run / 'registration.json').read_text())
    journal.require(launch['captureId'] == expected['captureId'] and
                    launch['binarySha256'] == start['binarySha256'] == expected['binarySha256'] and
                    start['childPid'] == start['childPgid'] == expected['childPid'],
                    'Native capture does not match independent launch identity')
    binary = Path(launch['command'][0]).resolve(strict=True)
    journal.require(hashlib.sha256(binary.read_bytes()).hexdigest() == expected['binarySha256'],
                    'Actual native binary changed')
    journal.require(cleanup['childPid'] == expected['childPid'] and cleanup['normalCompletion'] is True and
                    cleanup['childReaped'] is True and cleanup['physicalEof'] is True and
                    cleanup['childExitCode'] == 0 and cleanup['signalsSent'] == [] and
                    cleanup['failure'] is None and cleanup['cleanupErrors'] == [],
                    'Native capture lacks normal EOF/reap/cleanup')
    rows, columns, _, _ = struct.unpack('HHHH', bytes.fromhex(initial['sizeHex']))
    journal.require(columns == expected['columns'] and rows == expected['rows'],
                    'Actual initial native geometry differs from independent expectation')
    if 'backend' in expected or 'backend' in cleanup:
        journal.require(expected.get('backend') == cleanup.get('backend') == 'native-shared-slot-v1',
                        'Native capture backend differs from independent expectation')
        verify_fixed_geometry_io(run, expected)
        closed = json.loads((run / 'broker-cleanup.json').read_text())
        journal.require(closed == cleanup and cleanup.get('ioClose') == expected['ioClose'] and
                        cleanup.get('observedRawBytes') == expected['ioClose']['rawBytes'],
                        'Native IO does not match independent close receipt')
    header = json.loads((run / 'header.json').read_text())
    fd = os.open(run / 'journal.bin', os.O_RDONLY | os.O_NOFOLLOW)
    try:
        file = os.fstat(fd)
        journal.require(stat.S_ISREG(file.st_mode) and file.st_uid == os.getuid() and
                        stat.S_IMODE(file.st_mode) == 0o600 and file.st_nlink == 1 and
                        file.st_size == registration['header'][2] + registration['header'][3] * registration['header'][4],
                        'Native journal file identity changed')
        journal.require(list(journal.HEADER.unpack(os.read(fd, journal.HEADER.size))) == header,
                        'Saved header differs from original native mapping')
    finally:
        os.close(fd)
    saved = (run / 'records.bin').read_bytes()
    packets, offset = [], 0
    while offset < len(saved):
        journal.require(offset + 4 <= len(saved), 'Truncated saved native packet prefix')
        size = struct.unpack_from('<I', saved, offset)[0]
        offset += 4
        journal.require(journal.RECORD.size <= size <= journal.RECORD.size + registration['payloadBytes'] and
                        offset + size <= len(saved), 'Truncated saved native packet')
        packets.append(saved[offset:offset + size])
        offset += size
    records = journal.decode_records(header, packets, registration, expected['childPid'])
    raw = (run / 'raw.bin').read_bytes()
    entries = journal.ink_frame_entries(records, raw, expected['captureId'], initial['outputFlags'])
    return {'entries': entries, 'rawBytes': len(raw), 'rawSha256': hashlib.sha256(raw).hexdigest(),
            'tailBase64': base64.b64encode(raw[entries[-1]['rawEnd']:]).decode(),
            'productTimingEquivalent': False, 'fullNativeGatePassed': False}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise journal.JournalError('Usage: verify-native-frame-journal.py RUN EXPECTED.json')
        result = derive_frames(sys.argv[1], json.loads(Path(sys.argv[2]).read_text()))
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({'verdict': 'failed', 'error': str(error)}))
        raise SystemExit(1)

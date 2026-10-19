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
import re

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('native_journal', Path(__file__).with_name('native-terminal-journal.py'))
journal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journal)


def open_native_regular(path, mode=None):
    named = os.lstat(path)
    journal.require(stat.S_ISREG(named.st_mode) and named.st_uid == os.getuid() and named.st_nlink == 1,
                    'Native original is not an owned regular file')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        journal.require(stat.S_ISREG(opened.st_mode) and opened.st_uid == os.getuid() and opened.st_nlink == 1 and
                        (opened.st_dev, opened.st_ino) == (named.st_dev, named.st_ino) and
                        (mode is None or stat.S_IMODE(opened.st_mode) == mode), 'Native original file identity changed')
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_native_regular(path, mode=None):
    with os.fdopen(open_native_regular(path, mode), 'rb') as source:
        before = os.fstat(source.fileno())
        data = source.read()
        after, named = os.fstat(source.fileno()), os.lstat(path)
        journal.require(stat.S_ISREG(named.st_mode) and named.st_nlink == after.st_nlink == 1 and
                        (named.st_dev, named.st_ino) == (before.st_dev, before.st_ino) and
                        before.st_size == after.st_size == len(data), 'Native original changed during read')
        return data


def verify_fixed_geometry_io(run, expected, native_brackets=False, resize_method='native-mach-ioctl-resize-v1'):
    """Reject resize rather than infer native ordering from a raw read offset."""
    try:
        data = read_native_regular(run / 'pty-io.jsonl')
        io = [json.loads(line) for line in data.splitlines()]
    except FileNotFoundError as error:
        raise journal.JournalError('Native IO geometry receipt is missing') from error
    journal.require(io and all(type(row) is dict for row in io), 'Invalid native IO geometry receipt')
    first = io[0]
    journal.require(first.get('kind') == 'initial-geometry' and
                    first.get('columns') == expected['columns'] and first.get('rows') == expected['rows'] and
                    first.get('childPid') == expected['childPid'] and first.get('rawOffset') == 0,
                    'Native IO initial geometry differs from independent expectation')
    geometry_id = 0
    for index, row in enumerate(io, 1):
        if row.get('kind') == 'resize-ack':
            journal.require(native_brackets and type(row.get('nativeBracket')) is dict and
                            row['nativeBracket'].get('method') == resize_method,
                            'Fixed-geometry replay cannot accept resize without native brackets '
                            f"(ioId={row.get('ioId')}, geometryId={row.get('geometryId')}, "
                            f"size={row.get('columns')}x{row.get('rows')})")
            geometry_id += 1
        journal.require(type(row.get('geometryId')) is int and row['geometryId'] == geometry_id,
                        'Native IO geometry identity is missing or reordered')
        journal.require(type(row.get('ioId')) is int and row['ioId'] == index and
                        type(row.get('rawOffset')) is int and row['rawOffset'] >= 0 and
                        row.get('captureId') == expected['captureId'] and
                        row.get('kind') in ('initial-geometry', 'input', 'output', 'resize-ack') and
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
    journal.require(offset == close['rawBytes'] == len(read_native_regular(run / 'raw.bin')),
                    'Native IO output coverage is incomplete')
    return io


def verify_native_content(run, expected, cleanup):
    """Require the broker's closed memory bytes before deriving any frames."""
    close = expected.get('nativeClose')
    names = {'raw.bin', 'native-pty.raw', 'pty.raw', 'records.bin',
             'native-initial.json', 'registration.json', 'header.json'}
    journal.require(type(close) is dict and set(close) == {'method', 'recordCount', 'files'} and
                    close.get('method') == 'owned-broker-closed-native-v1' and
                    type(close.get('recordCount')) is int and close['recordCount'] > 0 and
                    type(close.get('files')) is dict and set(close['files']) == names and
                    json.dumps(cleanup.get('nativeClose'), sort_keys=True) == json.dumps(close, sort_keys=True),
                    'Native content does not match independent close receipt')
    data_by_name = {}
    for name in sorted(names):
        receipt = close['files'][name]
        journal.require(type(receipt) is dict and set(receipt) == {'bytes', 'sha256'} and
                        type(receipt.get('bytes')) is int and receipt['bytes'] > 0 and
                        type(receipt.get('sha256')) is str and len(receipt['sha256']) == 64 and
                        all(char in '0123456789abcdef' for char in receipt['sha256']),
                        'Native content does not match independent close receipt')
        fd = open_native_regular(run / name, 0o600)
        with os.fdopen(fd, 'rb') as source:
            file = os.fstat(source.fileno())
            journal.require(stat.S_ISREG(file.st_mode) and file.st_uid == os.getuid() and
                            stat.S_IMODE(file.st_mode) == 0o600 and file.st_nlink == 1,
                            'Native content file identity changed (' + name + ')')
            data = source.read()
        data_by_name[name] = data
        journal.require(len(data) == receipt['bytes'] and hashlib.sha256(data).hexdigest() == receipt['sha256'],
                        'Native content does not match independent close receipt (' + name + ')')
    journal.require(close['files']['raw.bin'] == close['files']['native-pty.raw'] == close['files']['pty.raw'],
                    'Native content does not match independent close receipt')
    return close, data_by_name


def native_resize_events(io, header, registration, records, initial):
    """Only non-overlapping kernel brackets determine physical resize offsets."""
    writes = [row for row in records if row['kind'] == 1]
    outputs = journal.native_write_outputs(records, initial['outputFlags'])
    spans = journal.frame_spans(records, 'ink-post-write-v1')
    by_sequence = {row['sequence']: row for row in records}
    events = []
    previous_return, size = header[19], initial['sizeHex']
    # decode_records bound header[20] to the registration; it selects the one method set.
    journal.require(header[20] in journal.METHODS, 'Unknown native observer platform')
    resize_method = journal.METHODS[header[20]]['resize']
    if header[20] == journal.LINUX_V1:
        # Each ACK must be a bracket the tracer ordered the product's writes and SIGWINCH against.
        journal.require(header[24] == 2 * sum(row['kind'] == 'resize-ack' for row in io),
                        'Native resize brackets differ from observer-ordered resizes')
    for row in io:
        if row['kind'] != 'resize-ack':
            continue
        bracket = row['nativeBracket']
        ticks = []
        for key in ('entry', 'return'):
            value = bracket.get(key)
            journal.require(type(value) is str and 0 < len(value) <= 20 and
                            value.isascii() and value.isdecimal() and value[0] != '0' and
                            int(value) < 2 ** 64, 'Native resize clock must be an exact uint64 decimal string')
            ticks.append(int(value))
        entry, returned = ticks
        journal.require(row.get('succeeded') is True and row.get('nativeClockCorrelationCovered') is True and
                        bracket.get('method') == resize_method and
                        bracket.get('nonce') == registration['nonce'] and
                        type(bracket.get('childPid')) is int and bracket['childPid'] == header[8] and
                        type(bracket.get('timebaseNumer')) is int and bracket['timebaseNumer'] == header[12] and
                        type(bracket.get('timebaseDenom')) is int and bracket['timebaseDenom'] == header[13] and
                        type(bracket.get('result')) is int and bracket['result'] == 0 and
                        type(bracket.get('errno')) is int and 0 <= bracket['errno'] < 2 ** 31 and
                        previous_return <= entry <= returned <= header[21],
                        'Native resize has foreign clock, identity or lifecycle')
        journal.require(bracket.get('beforeSizeHex') == size, 'Native resize initial kernel geometry changed')
        try:
            after = bytes.fromhex(bracket['afterSizeHex'])
            rows, columns, _, _ = struct.unpack('HHHH', after)
        except (ValueError, KeyError, TypeError, struct.error) as error:
            raise journal.JournalError('Malformed native resize kernel geometry') from error
        journal.require(type(row.get('columns')) is int and type(row.get('rows')) is int and
                        0 < columns <= 1000 and 0 < rows <= 1000 and
                        (columns, rows) == (row['columns'], row['rows']),
                        'Native resize confirmation differs from requested geometry')
        journal.require(all(write['return'] <= entry or write['entry'] >= returned
                            for write in writes), 'Native resize overlaps an output syscall')
        before_frame = len(spans) + 1
        for span in spans:
            layout = by_sequence[span['layoutSequence']]
            end = by_sequence[span['endSequence']]
            if span['physicalBoundary'] == 'native-pre-layout-observation-v1':
                # This branch was proved from every original syscall, not from
                # outputBytes or a supplied label. Compare before layout, then
                # apply the actual ACK before subsequent raw output/paint.
                journal.require(layout['return'] <= entry or layout['entry'] >= returned,
                                f"Native resize overlaps observation layout marker (frameId={span['spanId']})")
            else:
                journal.require(end['return'] <= entry or layout['entry'] >= returned,
                                f"Native resize overlaps output transaction (frameId={span['spanId']})")
            if layout['entry'] >= returned:
                before_frame = min(before_frame, span['spanId'])
        raw_offset = sum(len(outputs[write['sequence']]) for write in writes
                         if write['return'] <= entry)
        events.append({'ioId': row['ioId'], 'geometryId': row['geometryId'],
                       'beforeFrameId': before_frame, 'rawOffset': raw_offset,
                       'columns': columns, 'rows': rows, 'nativeBracket': bracket})
        previous_return, size = returned, bracket['afterSizeHex']
    return events


def archived_binary(run, launch, archive_receipt):
    if archive_receipt is None:
        return Path(launch['command'][0])
    receipt_path = Path(archive_receipt).resolve(strict=True)
    receipt = json.loads(read_native_regular(receipt_path))
    capture_bytes = read_native_regular(run / 'capture-launch.json')
    capture = json.loads(capture_bytes)
    source, archive, original = [Path(value) for value in
        (receipt['source'], receipt['archive'], capture['run'])]
    journal.require(all(path.is_absolute() and str(path) == os.path.normpath(str(path))
                        for path in (source, archive, original)), 'Native archive paths are not canonical')
    try:
        relative = original.relative_to(source)
    except ValueError:
        raise journal.JournalError('Native archive original run is outside its source')
    journal.require(re.fullmatch(r'runs/r-[0-9a-f]{12}', str(relative)) is not None
                    and receipt_path == archive.parent / 'builtin-cache-archive.json'
                    and archive == (receipt_path.parent / 'acceptance-cache').resolve(strict=True)
                    and run == archive / relative
                    and all(receipt.get(key) is True for key in
                        ('archiveComplete', 'sourceFilesStable', 'archiveFilesMatch'))
                    and launch['command'][0] == str(original / 'bin/claude'),
                    'Native archive is not bound to the original launch')
    for name, data in [('capture-launch.json', capture_bytes),
                       ('launch.json', read_native_regular(run / 'launch.json')),
                       ('bin/claude', read_native_regular(run / 'bin/claude'))]:
        held = receipt['sourceManifest'].get(str(relative / name), {})
        journal.require(held.get('type') == 'file' and
                        held.get('sha256') == hashlib.sha256(data).hexdigest(),
                        'Native archived original differs from held source digest (' + name + ')')
    return run / 'bin/claude'


def derive_frames(run, expected, archive_receipt=None):
    run = Path(run).resolve(strict=True)
    launch = json.loads(read_native_regular(run / 'launch.json'))
    start = json.loads(read_native_regular(run / 'start.json'))
    cleanup = json.loads(read_native_regular(run / 'cleanup.json'))
    journal.require(launch['captureId'] == expected['captureId'] and
                    launch['binarySha256'] == start['binarySha256'] == expected['binarySha256'] and
                    type(start['childPid']) is type(start['childPgid']) is type(expected['childPid']) is int and
                    start['childPid'] > 0 and start['childPid'] == start['childPgid'] == expected['childPid'],
                    'Native capture does not match independent launch identity')
    binary = archived_binary(run, launch, archive_receipt)
    journal.require(hashlib.sha256(read_native_regular(binary)).hexdigest() == expected['binarySha256'],
                    'Actual native binary changed')
    journal.require(type(cleanup['childPid']) is int and cleanup['childPid'] == expected['childPid'] and cleanup['normalCompletion'] is True and
                    cleanup['childReaped'] is True and cleanup['physicalEof'] is True and
                    type(cleanup['childExitCode']) is int and cleanup['childExitCode'] == 0 and cleanup['signalsSent'] == [] and
                    cleanup['failure'] is None and cleanup['cleanupErrors'] == [],
                    'Native capture lacks normal EOF/reap/cleanup')
    io = []
    native_close = None
    content = None
    if 'backend' in expected or 'backend' in cleanup:
        journal.require(expected.get('backend') == cleanup.get('backend') == 'native-shared-slot-v1',
                        'Native capture backend differs from independent expectation')
        # Registered header[20] selects one method set; content below re-binds these bytes.
        method = journal.methods(json.loads(read_native_regular(run / 'registration.json')))
        io = verify_fixed_geometry_io(run, expected, native_brackets=True, resize_method=method['resize'])
        closed = json.loads(read_native_regular(run / 'broker-cleanup.json'))
        journal.require(json.dumps(closed, sort_keys=True) == json.dumps(cleanup, sort_keys=True) and
                        json.dumps(cleanup.get('ioClose'), sort_keys=True) == json.dumps(expected['ioClose'], sort_keys=True) and
                        cleanup.get('observedRawBytes') == expected['ioClose']['rawBytes'],
                        'Native IO does not match independent close receipt')
        native_close, content = verify_native_content(run, expected, cleanup)
    def native_bytes(name):
        return content[name] if content is not None else read_native_regular(run / name)
    initial = json.loads(native_bytes('native-initial.json'))
    registration = json.loads(native_bytes('registration.json'))
    journal.require(native_close is None or journal.methods(registration) is method,
                    'Native observer platform changed during verification')
    rows, columns, _, _ = struct.unpack('HHHH', bytes.fromhex(initial['sizeHex']))
    journal.require(columns == expected['columns'] and rows == expected['rows'],
                    'Actual initial native geometry differs from independent expectation')
    header = json.loads(native_bytes('header.json'))
    fd = open_native_regular(run / 'journal.bin', 0o600)
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
    saved = native_bytes('records.bin')
    packets, offset = [], 0
    while offset < len(saved):
        journal.require(offset + 4 <= len(saved), 'Truncated saved native packet prefix')
        size = struct.unpack_from('<I', saved, offset)[0]
        offset += 4
        journal.require(journal.RECORD.size <= size <= journal.RECORD.size + registration['payloadBytes'] and
                        offset + size <= len(saved), 'Truncated saved native packet')
        packets.append(saved[offset:offset + size])
        offset += size
    if native_close is not None:
        journal.require(native_close['recordCount'] == len(packets),
                        'Native content does not match independent close receipt')
    records = journal.decode_records(header, packets, registration, expected['childPid'])
    raw = native_bytes('raw.bin')
    entries = journal.ink_frame_entries(records, raw, expected['captureId'], initial['outputFlags'])
    geometry = native_resize_events(io, header, registration, records, initial)
    return {'entries': entries, 'io': io, 'geometryEvents': geometry, 'rawBytes': len(raw), 'rawSha256': hashlib.sha256(raw).hexdigest(),
            'tailBase64': base64.b64encode(raw[entries[-1]['rawEnd']:]).decode(),
            'productTimingEquivalent': False, 'fullNativeGatePassed': False}


if __name__ == '__main__':
    try:
        if len(sys.argv) not in (3, 4):
            raise journal.JournalError('Usage: verify-native-frame-journal.py RUN EXPECTED.json [ARCHIVE_RECEIPT.json]')
        result = derive_frames(sys.argv[1], json.loads(read_native_regular(Path(sys.argv[2]))),
                               sys.argv[3] if len(sys.argv) == 4 else None)
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({'verdict': 'failed', 'error': str(error)}))
        raise SystemExit(1)

#!/usr/bin/env python3
"""Fail closed on incomplete Darwin syscall captures; prove bytes, not UI frames.

The collector stores each datagram as a uint32 little-endian length followed by
the unmodified packet. Writers never wait for a collector acknowledgement.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct

MAGIC = 0x34434C4C41435754
HEADER = struct.Struct('<15Q')
MAX_CAPTURE = 4096
MAX_FRAGMENT = 1024


class EvidenceError(ValueError):
    pass


def require(condition, reason):
    if not condition:
        raise EvidenceError(reason)


def decode_packets(data, expected_pid):
    require(type(expected_pid) is int and expected_pid > 0, 'Native PID required')
    packets = []
    offset = 0
    while offset < len(data):
        require(offset + 4 <= len(data), 'Truncated datagram envelope')
        length = struct.unpack_from('<I', data, offset)[0]
        offset += 4
        require(HEADER.size <= length <= HEADER.size + MAX_FRAGMENT,
                'Unsupported datagram length')
        require(offset + length <= len(data), 'Truncated datagram')
        packet = data[offset:offset + length]
        offset += length
        (magic, kind, pid, sequence, fd, requested, returned, flags, operation,
         fragment_offset, captured, fragment_length, output_mask, error,
         thread_id) = HEADER.unpack_from(packet)
        require(magic == MAGIC and kind in (0, 1, 2), 'Foreign packet format')
        require(pid == expected_pid and thread_id > 0, 'Foreign native producer')
        require(flags == 0, 'Dropped, truncated or unreadable capture')
        require(fragment_length == length - HEADER.size and
                fragment_offset + fragment_length <= captured <= MAX_CAPTURE,
                'Invalid fragment bounds')
        returned = returned if returned < (1 << 63) else returned - (1 << 64)
        if kind == 1:
            require(sequence > 0 and operation in (1, 2, 3, 4) and
                    fd < (1 << 31) and output_mask in (1, 2, 3),
                    'Unsupported output syscall')
            require(requested <= MAX_CAPTURE and -1 <= returned <= requested and
                    captured == max(0, returned),
                    'Captured bytes do not match original syscall result')
            require(returned != -1 or error > 0, 'Failed syscall lacks errno')
        else:
            require(fd == requested == returned == operation == fragment_offset ==
                    captured == fragment_length == output_mask == error == 0,
                    'Invalid lifecycle fields')
            require(kind != 0 or sequence == 0, 'Invalid header sequence')
        packets.append({'kind': kind, 'pid': pid, 'sequence': sequence, 'fd': fd,
                        'requested': requested, 'returned': returned,
                        'operation': operation, 'captured': captured,
                        'offset': fragment_offset, 'outputMask': output_mask,
                        'errno': error, 'threadId': thread_id,
                        'bytes': packet[HEADER.size:]})
    require(packets and packets[0]['kind'] == 0 and packets[-1]['kind'] == 2,
            'Missing native header/footer')
    require(sum(p['kind'] == 0 for p in packets) == 1 and
            sum(p['kind'] == 2 for p in packets) == 1,
            'Duplicate native lifecycle record')
    groups = {}
    for packet in packets[1:-1]:
        require(packet['kind'] == 1, 'Lifecycle crossed syscall records')
        groups.setdefault(packet['sequence'], []).append(packet)
    count = packets[-1]['sequence']
    # Bound validation before constructing a sequence range from untrusted input.
    require(count == len(groups) and sorted(groups) == list(range(1, count + 1)),
            'Missing or duplicated syscall sequence')
    writes = []
    for sequence in range(1, count + 1):
        parts = sorted(groups[sequence], key=lambda p: p['offset'])
        first = parts[0]
        metadata = {k: v for k, v in first.items() if k not in ('offset', 'bytes')}
        require(all({k: v for k, v in p.items() if k not in ('offset', 'bytes')}
                    == metadata for p in parts), 'Foreign fragment metadata')
        require(len({p['offset'] for p in parts}) == len(parts),
                'Duplicated syscall fragment')
        require(first['captured'] != 0 or len(parts) == 1,
                'Duplicated empty syscall')
        position = 0
        for part in parts:
            require(part['offset'] == position, 'Missing or overlapping fragment')
            position += len(part['bytes'])
        require(position == first['captured'], 'Missing final syscall fragment')
        writes.append({**metadata, 'bytes': b''.join(p['bytes'] for p in parts)})
    return writes


def verify_raw(writes, raw, output_mask, output_flags=None):
    """One endpoint only. Shared PTY output requires mask=3 and recorded flags.

    A single writer thread provides syscall order in this bounded proof. Multiple
    threads require a separate ordering witness and are deliberately rejected.
    No logical cell, expected screenshot or timing observation selects bytes.
    """
    require(output_mask in (1, 2, 3), 'Invalid output endpoint mask')
    require(all(w['outputMask'] == output_mask or
                not (w['outputMask'] & output_mask) for w in writes),
            'Ambiguous stdout/stderr endpoint')
    selected = [w for w in writes if w['outputMask'] == output_mask]
    require(len({w['threadId'] for w in selected}) <= 1,
            'Multiple threads lack a kernel ordering witness')
    source = b''.join(w['bytes'] for w in selected)
    if output_mask == 3:
        import termios
        require(output_flags == termios.OPOST | termios.ONLCR,
                'Unsupported or unrecorded PTY transformation')
        source = source.replace(b'\n', b'\r\n')
    else:
        require(output_flags is None, 'Pipe proof cannot claim a PTY transform')
    require(source == raw, 'Unowned, missing, reordered or transformed raw bytes')
    return {'verdict': 'passed', 'rawBytes': len(raw),
            'rawSHA256': hashlib.sha256(raw).hexdigest(),
            'syscalls': len(selected),
            'scope': 'Byte coverage only; independent EOF, producer/binary identity, '
                     'termios lifetime, geometry and UI/frame evidence required'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packets', type=Path, required=True)
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--raw', type=Path, required=True)
    parser.add_argument('--output-mask', type=int, choices=(1, 2, 3), required=True)
    parser.add_argument('--output-flags', type=int)
    args = parser.parse_args()
    try:
        writes = decode_packets(args.packets.read_bytes(), args.pid)
        proof = verify_raw(writes, args.raw.read_bytes(), args.output_mask,
                           args.output_flags)
    except EvidenceError as error:
        print(json.dumps({'verdict': 'failed', 'reason': str(error)}))
        return 1
    print(json.dumps(proof))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

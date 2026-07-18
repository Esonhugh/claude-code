#!/usr/bin/env python3
import re
import sys
from pathlib import Path

MASK = (1 << 64) - 1
SEED = 0x4D659218E32A3268

P1 = 0x9E3779B185EBCA87
P2 = 0xC2B2AE3D27D4EB4F
P3 = 0x165667B19E3779F9
P4 = 0x85EBCA77C2B2AE63
P5 = 0x27D4EB2F165667C5


def rol(x, r):
    return ((x << r) | (x >> (64 - r))) & MASK


def round64(acc, x):
    acc = (acc + x * P2) & MASK
    acc = rol(acc, 31)
    return (acc * P1) & MASK


def merge_round(acc, val):
    acc ^= round64(0, val)
    return (acc * P1 + P4) & MASK


def xxh64(data: bytes, seed: int = SEED) -> int:
    b = memoryview(data)
    n = len(b)
    i = 0

    if n >= 32:
        v1 = (seed + P1 + P2) & MASK
        v2 = (seed + P2) & MASK
        v3 = seed & MASK
        v4 = (seed - P1) & MASK

        while i <= n - 32:
            v1 = round64(v1, int.from_bytes(b[i:i + 8], "little"))
            i += 8
            v2 = round64(v2, int.from_bytes(b[i:i + 8], "little"))
            i += 8
            v3 = round64(v3, int.from_bytes(b[i:i + 8], "little"))
            i += 8
            v4 = round64(v4, int.from_bytes(b[i:i + 8], "little"))
            i += 8

        h = (rol(v1, 1) + rol(v2, 7) + rol(v3, 12) + rol(v4, 18)) & MASK
        h = merge_round(h, v1)
        h = merge_round(h, v2)
        h = merge_round(h, v3)
        h = merge_round(h, v4)
    else:
        h = (seed + P5) & MASK

    h = (h + n) & MASK

    while i + 8 <= n:
        k = round64(0, int.from_bytes(b[i:i + 8], "little"))
        h ^= k
        h = (rol(h, 27) * P1 + P4) & MASK
        i += 8

    if i + 4 <= n:
        h ^= (int.from_bytes(b[i:i + 4], "little") * P1) & MASK
        h = (rol(h, 23) * P2 + P3) & MASK
        i += 4

    while i < n:
        h ^= (b[i] * P5) & MASK
        h = (rol(h, 11) * P1) & MASK
        i += 1

    h ^= h >> 33
    h = (h * P2) & MASK
    h ^= h >> 29
    h = (h * P3) & MASK
    h ^= h >> 32
    return h & MASK


def string_end(data: bytes, quote_pos: int) -> int:
    i = quote_pos + 1
    esc = False
    while i < len(data):
        c = data[i]
        if esc:
            esc = False
        elif c == 0x5C:
            esc = True
        elif c == 0x22:
            return i
        i += 1
    raise ValueError("unterminated string")


def value_end(data: bytes, value_start: int) -> int:
    i = value_start
    while i < len(data) and data[i] in b" \t\r\n":
        i += 1
    if i >= len(data):
        raise ValueError("missing value")

    if data[i] == 0x22:
        return string_end(data, i) + 1

    if data[i] in (0x7B, 0x5B):
        open_ch = data[i]
        close_ch = 0x7D if open_ch == 0x7B else 0x5D
        depth = 0
        in_str = False
        esc = False
        while i < len(data):
            c = data[i]
            if in_str:
                if esc:
                    esc = False
                elif c == 0x5C:
                    esc = True
                elif c == 0x22:
                    in_str = False
            else:
                if c == 0x22:
                    in_str = True
                elif c == open_ch:
                    depth += 1
                elif c == close_ch:
                    depth -= 1
                    if depth == 0:
                        return i + 1
            i += 1
        raise ValueError("unmatched bracket")

    while i < len(data) and data[i] not in b",}":
        i += 1
    return i


def top_level_fields(data: bytes):
    obj_start = data.find(b"{")
    if obj_start < 0 or data[:obj_start].strip():
        raise ValueError("body must be a JSON object")

    i = obj_start + 1
    while i < len(data):
        while i < len(data) and data[i] in b" \t\r\n,":
            i += 1
        if i >= len(data) or data[i] == 0x7D:
            break
        if data[i] != 0x22:
            raise ValueError(f"expected object key at byte {i}")

        key_start = i
        key_end = string_end(data, key_start)
        key = data[key_start + 1:key_end].decode("utf-8")

        j = key_end + 1
        while j < len(data) and data[j] in b" \t\r\n":
            j += 1
        if j >= len(data) or data[j] != 0x3A:
            raise ValueError("expected ':' after key")

        value_start = j + 1
        value_stop = value_end(data, value_start)

        field_stop = value_stop
        while field_stop < len(data) and data[field_stop] in b" \t\r\n":
            field_stop += 1
        if field_stop < len(data) and data[field_stop] == 0x2C:
            field_stop += 1

        yield key, key_start, key_end, value_start, value_stop, field_stop
        i = field_stop


def cch_hash_input(body: bytes) -> bytes:
    body = re.sub(rb"cch=[0-9a-fA-F]{5};", b"cch=00000;", body, count=1)

    cuts = []
    for key, key_start, _key_end, value_start, _value_stop, field_stop in top_level_fields(body):
        if key == "model":
            q1 = body.index(b'"', value_start)
            q2 = string_end(body, q1)
            cuts.append((q1 + 1, q2))
        elif key in ("max_tokens", "fallbacks"):
            cuts.append((key_start, field_stop))

    cuts.sort()
    out = bytearray()
    pos = 0
    for start, stop in cuts:
        out += body[pos:start]
        pos = stop
    out += body[pos:]
    return bytes(out)


def compute_cch(body: bytes) -> str:
    return f"{xxh64(cch_hash_input(body), SEED) & 0xfffff:05x}"


def patch_cch(body: bytes) -> bytes:
    cch = compute_cch(body).encode()
    return re.sub(rb"cch=[0-9a-fA-F]{5};", b"cch=" + cch + b";", body, count=1)


def current_cch(body: bytes) -> str | None:
    match = re.search(rb"cch=([0-9a-fA-F]{5});", body)
    return match.group(1).decode("ascii").lower() if match else None


def main(argv):
    if len(argv) < 2:
        print(f"usage: {argv[0]} BODY.bin [--patch OUT.bin]", file=sys.stderr)
        return 2
    patch_index = argv.index("--patch") if "--patch" in argv else None
    if patch_index is not None and patch_index + 1 >= len(argv):
        print(f"usage: {argv[0]} BODY.bin [--patch OUT.bin]", file=sys.stderr)
        return 2
    body = Path(argv[1]).read_bytes()
    computed = compute_cch(body)
    existing = current_cch(body)
    if patch_index is not None:
        out = Path(argv[patch_index + 1])
        out.write_bytes(patch_cch(body))
    print(computed if existing is None else f"computed={computed} existing={existing} match={computed == existing}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

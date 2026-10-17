#!/usr/bin/env python3
"""Reject a launcher capture that does not own the exact native binary."""
import hashlib
import os
from pathlib import Path
import re
import uuid


def validate(env):
    evidence = Path(env['CC_VALIDATION_EVIDENCE_DIR'])
    run = Path(env['CC_VALIDATION_FRAME_BROKER_DIR'])
    if (not run.is_absolute() or run.is_symlink() or
            run.resolve(strict=True) != run or run != evidence.resolve(strict=True)):
        raise ValueError('broker directory must be the owned evidence directory')
    frames = Path(env['CC_VALIDATION_FRAME_EVIDENCE_PATH'])
    if frames != run / 'frames.jsonl' or frames.is_symlink():
        raise ValueError('frame journal is outside the owned capture')
    capture_id = env['CC_VALIDATION_FRAME_CAPTURE_ID']
    if str(uuid.UUID(capture_id)) != capture_id:
        raise ValueError('invalid capture UUID')
    digest = env['CC_VALIDATION_FRAME_BINARY_SHA256']
    if not re.fullmatch(r'[a-f0-9]{64}', digest):
        raise ValueError('invalid native binary SHA256')
    binary = Path(env['CC_VALIDATION_BINARY'])
    if (binary != run / 'bin/claude' or binary.is_symlink() or
            binary.resolve(strict=True) != binary or not binary.is_file() or
            hashlib.sha256(binary.read_bytes()).hexdigest() != digest):
        raise ValueError('capture must execute the exact owned native binary')
    for name in ('capture-ready', 'capture-output.sh', 'launch-captured.sh'):
        path = run / name
        if not path.is_file() or path.is_symlink():
            raise ValueError('capture recorder is not installed')
    if (run / 'capture-ready').read_text() != 'installed\n':
        raise ValueError('capture recorder was not acknowledged')


if __name__ == '__main__':
    validate(os.environ)

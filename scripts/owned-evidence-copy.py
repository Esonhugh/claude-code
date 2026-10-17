"""Copy owned evidence without allocating sparse zero slots on APFS.

Clones keep independent inodes and identical logical bytes. Unsupported
filesystems use ordinary copy2; an existing destination is never overwritten.
"""
import ctypes
import errno
import os
from pathlib import Path
import shutil
import sys


def copy_evidence_file(source, target):
    source, target = Path(source), Path(target)
    if os.path.lexists(target):
        raise FileExistsError(errno.EEXIST, 'Evidence destination already exists', str(target))
    if sys.platform != 'darwin':
        return shutil.copy2(source, target)
    library = ctypes.CDLL(None, use_errno=True)
    clone = library.clonefile
    clone.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int)
    clone.restype = ctypes.c_int
    if clone(os.fsencode(source), os.fsencode(target), 1) != 0:
        code = ctypes.get_errno()
        if code in (errno.EXDEV, errno.ENOTSUP) and not os.path.lexists(target):
            return shutil.copy2(source, target)
        raise OSError(code, os.strerror(code), str(target))
    shutil.copystat(source, target)
    return str(target)

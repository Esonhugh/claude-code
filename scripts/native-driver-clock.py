"""Original Darwin caller Mach timestamps, independent of asynchronous file tails."""
import ctypes
import json
import os
from pathlib import Path
import sys
import importlib.util

spec = importlib.util.spec_from_file_location('native_clock_owned_files', Path(__file__).with_name('verify-native-frame-journal.py'))
files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(files)
_system = None


def read_native_driver_clock(launch):
    global _system
    capture = launch.get('capture', {})
    if (sys.platform != 'darwin' or capture.get('nativeJournal') is not True or
            type(launch.get('driverPid')) is not int or launch['driverPid'] != os.getpid()):
        raise ValueError('Native driver clock requires the original Darwin caller')
    run = Path(launch['run'])
    registration = json.loads(files.read_native_regular(run / 'registration.json', 0o600))
    start = json.loads(files.read_native_regular(run / 'start.json', 0o600))
    nonce = registration.get('nonce')
    digest = launch.get('binarySha256')
    if (not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest) or
            not isinstance(nonce, str) or len(nonce) != 32 or any(c not in '0123456789abcdef' for c in nonce) or
            type(start.get('childPid')) is not int or start['childPid'] <= 0 or start['childPid'] == os.getpid() or
            start.get('binarySha256') != launch.get('binarySha256') or
            not isinstance(capture.get('captureId'), str) or not capture['captureId']):
        raise ValueError('Native driver clock enrollment differs from prepared capture')
    if _system is None:
        _system = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
        _system.mach_absolute_time.restype = ctypes.c_uint64
        _system.mach_timebase_info.argtypes = [ctypes.c_void_p]
        _system.mach_timebase_info.restype = ctypes.c_int
        _system.pthread_threadid_np.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint64)]
        _system.pthread_threadid_np.restype = ctypes.c_int
    timebase, thread = (ctypes.c_uint32 * 2)(), ctypes.c_uint64()
    if (_system.mach_timebase_info(ctypes.byref(timebase)) != 0 or
            _system.pthread_threadid_np(None, ctypes.byref(thread)) != 0 or
            not timebase[0] or not timebase[1] or not thread.value):
        raise ValueError('Actual native driver clock identity is unavailable')
    tick = _system.mach_absolute_time()
    return {'method': 'driver-mach-absolute-time-v1', 'tick': str(tick),
            'captureId': capture['captureId'], 'nonce': nonce, 'childPid': start['childPid'],
            'callerPid': os.getpid(), 'callerThreadId': str(thread.value),
            'timebaseNumer': timebase[0], 'timebaseDenom': timebase[1]}

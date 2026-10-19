#!/usr/bin/env python3
"""Bounded no-ACK capture with asynchronous frame/IO prefix publication.

Overflow invalidates evidence while PTY forwarding continues. Native geometry
history, OS input ownership and schedule equivalence are separate open gates.
"""
import ctypes
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pty
import select
import selectors
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import tty

spec = importlib.util.spec_from_file_location('native_journal', Path(__file__).with_name('native-terminal-journal.py'))
journal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journal)
spec = importlib.util.spec_from_file_location('native_live_publisher', Path(__file__).with_name('native-live-publisher.py'))
live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)
spec = importlib.util.spec_from_file_location('native_original_files', Path(__file__).with_name('verify-native-frame-journal.py'))
original_files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(original_files)


class EvidenceBuffer:
    """A full observer drops evidence, never waits for disk or producer ACK."""
    def __init__(self, limit=64 * 1024 * 1024):
        self.limit, self.used, self.dropped = limit, 0, 0
        self.values = {'raw': [], 'packets': [], 'io': []}

    def add(self, kind, value):
        if self.dropped or self.used + len(value) > self.limit:
            self.dropped += len(value)
            return False
        self.used += len(value)
        self.values[kind].append(value)
        return True


def set_child_subreaper():
    # observer-exec double-forks its tracer; the reparented tracer is ours to reap.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0):  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), 'PR_SET_CHILD_SUBREAPER')


def read_tracer_pid(fd, timeout=5):
    report, deadline = b'', time.monotonic() + timeout
    with selectors.DefaultSelector() as report_selector:
        report_selector.register(fd, selectors.EVENT_READ)
        while time.monotonic() < deadline and report_selector.select(deadline - time.monotonic()):
            chunk = os.read(fd, 64)
            if not chunk:
                break
            report += chunk
    if not report.endswith(b'\n') or not report[:-1].isdigit() or int(report) <= 0:
        raise RuntimeError('Linux native tracer did not attach')
    return int(report)


def reap_tracer(pid, timeout=2):
    """Return (exit code, killed). A tracer that outlives its tracees is killed."""
    deadline, killed = time.monotonic() + timeout, False
    while True:
        reaped, status = os.waitpid(pid, os.WNOHANG)
        if reaped == pid:
            return os.waitstatus_to_exitcode(status), killed
        if time.monotonic() >= deadline:
            if killed:
                raise TimeoutError('Linux native tracer was not reaped')
            os.kill(pid, signal.SIGKILL)
            killed, deadline = True, time.monotonic() + timeout
        time.sleep(.01)


def probe_linux_observer(run):
    """Trace /bin/true on an owned PTY with the prepared observer-exec, or fail."""
    run = Path(run).resolve(strict=True)
    set_child_subreaper()
    root = Path(tempfile.mkdtemp(prefix='.observer-probe-', dir=run))
    master, slave = pty.openpty()
    report_read, report_write = os.pipe()
    child = None
    try:
        registration = journal.create_journal(root / 'journal.bin', os.fstat(slave), 3, 4, 4096, 'linux')
        child = subprocess.Popen([str(run / 'observer-exec'), '--journal', str(root / 'journal.bin'),
                                  '--binary', '/bin/true', '--tracer-pid-fd', str(report_write), '--', '/bin/true'],
                                 env={'PATH': '/usr/bin:/bin'}, stdin=slave, stdout=slave, stderr=slave,
                                 start_new_session=True, pass_fds=(report_write,))
        os.close(report_write)
        report_write = None
        tracer = read_tracer_pid(report_read)
        child.wait(timeout=10)
        tracer_exit, killed = reap_tracer(tracer, 10)
        header, records = journal.final_records(root / 'journal.bin', registration)
        journal.decode_records(header, records, registration, child.pid)
        if child.returncode != 0 or tracer_exit != 0 or killed:
            raise RuntimeError('Linux native observer probe did not complete normally')
        return {'command': ['/bin/true'], 'childPid': child.pid, 'childExitCode': child.returncode,
                'tracerPid': tracer, 'tracerExitCode': tracer_exit, 'recordCount': header[9]}
    finally:
        if child is not None and child.poll() is None:
            child.kill()
            child.wait(timeout=5)
        for fd in (master, slave, report_read, report_write):
            if fd is not None:
                os.close(fd)
        shutil.rmtree(root)


def capture_native(run, argv):
    run = Path(run).resolve(strict=True)
    if (run / 'native-observer.json').is_symlink():
        raise ValueError('Native observer descriptor must be owned by this capture')
    observer = json.loads((run / 'native-observer.json').read_text())
    library = Path(observer['library'])
    linux = observer.get('observer') == journal.LINUX_OBSERVER
    if linux != sys.platform.startswith('linux') or (not linux and 'observer' in observer):
        raise ValueError('Native observer platform differs from this host')
    if (observer.get('method') != 'native-shared-slot-v1' or library != run / ('observer.so' if linux else 'observer.dylib')
            or library.is_symlink() or not library.is_file()
            or hashlib.sha256(library.read_bytes()).hexdigest() != observer['librarySha256']):
        raise ValueError('Native observer enrollment identity changed')
    observer_exec = run / 'observer-exec'
    if linux and (observer.get('observerExec') != str(observer_exec) or observer_exec.is_symlink()
                  or not observer_exec.is_file()
                  or hashlib.sha256(observer_exec.read_bytes()).hexdigest() != observer['observerExecSha256']):
        raise ValueError('Native observer enrollment identity changed')
    capture_id = os.environ['CLAUDE_CODE_FRAME_CAPTURE_ID']
    binary = Path(argv[0]).resolve(strict=True)
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    if digest != os.environ['CLAUDE_CODE_FRAME_BINARY_SHA256']:
        raise ValueError('Native binary changed before broker startup')
    owned_names = ('raw.bin', 'native-pty.raw', 'records.bin', 'pty-io.jsonl', 'journal.bin',
                   'native-initial.json', 'registration.json', 'header.json', 'start.json',
                   'frames.jsonl', 'cleanup.json', 'broker-cleanup.json', 'producer-expected-native.json')
    if any(os.path.lexists(run / name) for name in owned_names):
        raise ValueError('Preexisting native capture artifact is not owned by this launch')
    def save(name, data):
        with open(run / name, 'xb') as file:
            file.write(data)
    def encode_json(data):
        return (json.dumps(data) + '\n').encode()
    def save_json(name, data):
        save(name, encode_json(data))
    if not (run / 'launch.json').exists():
        save_json('launch.json', {'command': argv, 'captureId': capture_id, 'binarySha256': digest})
    launch = json.loads((run / 'launch.json').read_text())
    if launch['command'] != argv or launch['captureId'] != capture_id or launch['binarySha256'] != digest:
        raise ValueError('Native broker launch receipt changed')
    normal_origin = None
    origin_path = run / 'native-normal-origin.json'
    if os.path.lexists(origin_path):
        origin_bytes = original_files.read_native_regular(origin_path, 0o600)
        origin = json.loads(origin_bytes)
        if (origin.get('method') != 'builtin-fresh-tmux-normal-origin-v1'
                or origin.get('captureId') != capture_id or origin.get('binarySha256') != digest
                or origin.get('rawOffset') != 0):
            raise ValueError('Native normal origin enrollment differs from the prepared launch')
        # Hold this pre-Popen identity. Closing never regenerates an origin from frames.
        normal_origin = {'path': str(origin_path), 'sha256': hashlib.sha256(origin_bytes).hexdigest()}
    child = master = slave = consumer = selector = publisher = None
    tracer = tracer_exit = tracer_read = tracer_write = None
    outer_attrs = native_attrs = None
    initial = registration = header = None
    evidence = EvidenceBuffer()
    sequence = raw_offset = packet_sequence = geometry_id = 0
    eof = completed = pending_resize = False
    failure = capture_failure = None
    cleanup_errors, signals_sent = [], []
    startup_mask = None

    def detail(error):
        return {'type': type(error).__name__, 'message': str(error)}

    def record(kind, **fields):
        nonlocal sequence
        sequence += 1
        data = (json.dumps({'ioId': sequence, 'kind': kind,
            'captureId': capture_id, 'geometryId': geometry_id,
            'rawOffset': raw_offset, **fields}) + '\n').encode()
        if evidence.add('io', data) and publisher is not None:
            publisher.offer('io', data)

    def collect():
        nonlocal packet_sequence, capture_failure
        if consumer is None or capture_failure is not None:
            return
        try:
            while True:
                packet = consumer.consume(packet_sequence + 1)
                if packet is None:
                    return
                packet_sequence += 1
                # Continue releasing slots even after the bounded memory is full.
                if evidence.add('packets', struct.pack('<I', len(packet)) + packet) and publisher is not None:
                    publisher.offer('packet', packet, consumer.header())
        except Exception as error:
            capture_failure = detail(error)

    def output(forward=True):
        nonlocal eof, raw_offset
        try:
            chunk = os.read(master, 65536)
        except BlockingIOError:
            return
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            chunk = b''
        if not chunk:
            eof = True
            selector.unregister(master)
            return
        start = raw_offset
        raw_offset += len(chunk)
        if evidence.add('raw', chunk) and publisher is not None:
            publisher.offer('raw', chunk)
        record('output', start=start, end=raw_offset)
        if forward:
            offset = 0
            while offset < len(chunk):
                offset += os.write(1, chunk[offset:])

    def interrupted(number, _frame):
        raise InterruptedError('Native broker stopped by ' + signal.Signals(number).name)

    def resized(_number, _frame):
        nonlocal pending_resize
        pending_resize = True

    try:
        for number in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
            signal.signal(number, interrupted)
        signal.signal(signal.SIGWINCH, resized)
        startup_mask = signal.pthread_sigmask(signal.SIG_BLOCK, (signal.SIGHUP, signal.SIGTERM, signal.SIGINT))
        outer_attrs = termios.tcgetattr(0)
        size = fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8)
        master, slave = pty.openpty()
        termios.tcsetattr(slave, termios.TCSANOW, outer_attrs)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, size)
        native_attrs = termios.tcgetattr(slave)
        initial = {'sizeHex': fcntl.ioctl(slave, termios.TIOCGWINSZ, b'\0' * 8).hex(),
                   'outputFlags': native_attrs[1]}
        registration = journal.create_journal(run / 'journal.bin', os.fstat(slave), 3, 256, 1048576,
                                              'linux' if linux else 'darwin')
        # Immutable enrollment is available before producer startup. Driver
        # clocks never depend on registration first appearing at final close.
        save_json('registration.json', registration)
        consumer = journal.NativeConsumer(run / 'journal.bin', registration, library)
        env = {**os.environ, **({} if linux else {'DYLD_INSERT_LIBRARIES': str(library)}),
               'CLAUDE_PRIVATE_NATIVE_JOURNAL': str(run / 'journal.bin'),
               'CLAUDE_PRIVATE_NATIVE_JOURNAL_LIBRARY': str(library),
               'CLAUDE_CODE_FRAME_BROKER_DIR': str(run / 'no-legacy-fifos')}
        def own_controlling_tty():
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            signal.pthread_sigmask(signal.SIG_SETMASK, startup_mask)
        command, pass_fds = argv, ()
        if linux:
            # observer-exec execs the product in place: childPid stays the product pid and pgid.
            set_child_subreaper()
            tracer_read, tracer_write = os.pipe()
            command = [str(observer_exec), '--journal', str(run / 'journal.bin'), '--binary', str(binary),
                       '--tracer-pid-fd', str(tracer_write), '--', *argv]
            pass_fds = (tracer_write,)
        child = subprocess.Popen(command, env=env, stdin=slave, stdout=slave, stderr=slave,
                                 start_new_session=True, preexec_fn=own_controlling_tty, pass_fds=pass_fds)
        if linux:
            os.close(tracer_write)
            tracer_write = None
            tracer = read_tracer_pid(tracer_read)
        consumer.bind_producer(child.pid)
        save_json('start.json', {'childPid': child.pid, 'childPgid': child.pid, 'binarySha256': digest})
        publisher = live.NativeLivePublisher(run, journal, registration, child.pid, capture_id,
                                             initial['outputFlags'])
        os.close(slave)
        slave = None
        os.set_blocking(master, False)
        selector = selectors.DefaultSelector()
        selector.register(master, selectors.EVENT_READ, 'output')
        selector.register(0, selectors.EVENT_READ, 'input')
        rows, columns, _, _ = struct.unpack('HHHH', size)
        record('initial-geometry', rows=rows, columns=columns, childPid=child.pid)
        tty.setraw(0, termios.TCSANOW)
        signal.pthread_sigmask(signal.SIG_SETMASK, startup_mask)
        startup_mask = None
        child_exit_deadline = None
        while not eof or child.poll() is None:
            collect()
            if child.poll() is not None and child_exit_deadline is None:
                child_exit_deadline = time.monotonic() + 2
            if child_exit_deadline is not None and time.monotonic() >= child_exit_deadline and not eof:
                raise TimeoutError('Owned child exited without physical PTY EOF')
            if pending_resize:
                size = fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8)
                bracket = consumer.resize(master, size)
                geometry_id += 1
                rows, columns, _, _ = struct.unpack('HHHH', size)
                record('resize-ack', rows=rows, columns=columns, succeeded=True,
                       nativeClockCorrelationCovered=True, nativeBracket=bracket)
                pending_resize = False
            for key, _mask in selector.select(.01):
                if key.data == 'output':
                    output()
                else:
                    chunk = os.read(0, 65536)
                    if not chunk:
                        raise EOFError('Outer input closed before native completion')
                    record('input', hex=chunk.hex(), actualOsReadCovered=False)
                    offset = 0
                    while offset < len(chunk):
                        try:
                            count = os.write(master, chunk[offset:])
                            if count <= 0:
                                raise OSError('Native PTY input write made no progress')
                            offset += count
                        except BlockingIOError:
                            select.select([], [master], [], .01)
            collect()
        child.wait(timeout=2)
        collect()
        if child.returncode != 0:
            raise RuntimeError('Native child exit code ' + str(child.returncode))
        if termios.tcgetattr(master) != native_attrs:
            raise RuntimeError('Native child did not restore termios')
        completed = True
    except BaseException as error:
        failure = detail(error)
    finally:
        signal.pthread_sigmask(signal.SIG_BLOCK, (signal.SIGHUP, signal.SIGTERM, signal.SIGINT))
        def cleanup(action, operation):
            try:
                operation()
            except BaseException as error:
                cleanup_errors.append({'action': action, **detail(error)})
        if child is not None:
            if child.poll() is None or not eof:
                def stop():
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                        signals_sent.append('SIGKILL')
                    except ProcessLookupError:
                        pass
                cleanup('stop-owned-child-group', stop)
            cleanup('wait-owned-child', lambda: child.wait(timeout=2))
        if tracer is not None:
            def reap_owned_tracer():
                nonlocal tracer_exit
                tracer_exit, killed = reap_tracer(tracer)
                if killed:
                    signals_sent.append('SIGKILL')
            cleanup('reap-observer-tracer', reap_owned_tracer)
        for fd in (tracer_read, tracer_write):
            if fd is not None:
                cleanup('close-tracer-report', lambda fd=fd: os.close(fd))
        if master is not None and selector is not None:
            deadline = time.monotonic() + 2
            while not eof and time.monotonic() < deadline:
                try:
                    if select.select([master], [], [], .01)[0]:
                        output(False)
                    collect()
                except BaseException as error:
                    cleanup_errors.append({'action': 'drain-owned-pty', **detail(error)})
                    break
        if consumer is not None:
            collect()
            try:
                header = list(consumer.header())
            except BaseException as error:
                cleanup_errors.append({'action': 'read-final-header', **detail(error)})
            cleanup('close-consumer', consumer.close)
        if selector is not None:
            cleanup('close-selector', selector.close)
        for fd in (master, slave):
            if fd is not None:
                cleanup('close-owned-pty', lambda fd=fd: os.close(fd))
        if outer_attrs is not None:
            cleanup('restore-outer-termios', lambda: termios.tcsetattr(0, termios.TCSANOW, outer_attrs))
        raw = b''.join(evidence.values['raw'])
        io = b''.join(evidence.values['io'])
        saved = b''.join(evidence.values['packets'])
        native_data = {'raw.bin': raw, 'native-pty.raw': raw, 'records.bin': saved}
        for name, data in [('native-initial.json', initial), ('registration.json', registration), ('header.json', header)]:
            if data is not None:
                native_data[name] = encode_json(data)
        # Bind held bytes before publishing files. The outer PTY copy must
        # later equal the same memory-origin digest, never a disk rehash.
        native_close = {'method': 'owned-broker-closed-native-v1', 'recordCount': packet_sequence,
                        'files': {name: {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
                                  for name, data in {**native_data, 'pty.raw': raw}.items()}}
        for name, data in native_data.items():
            if name == 'registration.json':
                def verify_registration():
                    if original_files.read_native_regular(run / name, 0o600) != data:
                        raise ValueError('Original startup registration changed before close')
                cleanup('verify:registration.json', verify_registration)
            else:
                cleanup('save:' + name, lambda name=name, data=data: save(name, data))
        if evidence.dropped:
            capture_failure = {'type': 'EvidenceOverflow', 'message': 'Bounded observer lost evidence',
                               'droppedBytes': evidence.dropped}
        if failure is None:
            failure = capture_failure
        normal = bool(completed and failure is None and not cleanup_errors and eof and child is not None
                      and child.returncode == 0 and not signals_sent and (not linux or tracer_exit == 0))
        entries = []
        if normal:
            try:
                packets, offset = [], 0
                while offset < len(saved):
                    length = struct.unpack_from('<I', saved, offset)[0]
                    offset += 4
                    packets.append(saved[offset:offset + length])
                    offset += length
                records = journal.decode_records(header, packets, registration, child.pid)
                entries = journal.ink_frame_entries(records, raw, capture_id, initial['outputFlags'])
            except BaseException as error:
                normal, failure = False, detail(error)
        if publisher is not None:
            cleanup('close-live-publication', lambda: publisher.finish(io, entries))
        if cleanup_errors:
            normal = False
        result = {'captureId': capture_id, 'childPid': child.pid if child else None,
                  'childExitCode': child.returncode if child else None,
                  'childReaped': child is None or child.poll() is not None,
                  'physicalEof': eof, 'signalsSent': signals_sent, 'failure': failure,
                  'cleanupErrors': cleanup_errors, 'normalCompletion': normal,
                  'backend': 'native-shared-slot-v1', 'evidenceBytes': evidence.used,
                  'observedRawBytes': raw_offset, 'droppedBytes': evidence.dropped,
                  'ioClose': {'method': 'owned-broker-closed-io-v1', 'recordCount': sequence,
                              'sha256': hashlib.sha256(io).hexdigest(), 'rawBytes': raw_offset,
                              'finalGeometryId': geometry_id},
                  'nativeClose': native_close,
                  **({'observer': journal.LINUX_OBSERVER, 'tracerPid': tracer, 'tracerExitCode': tracer_exit,
                      'tracerReaped': tracer_exit is not None} if linux else {}),
                  'productTimingEquivalent': False, 'fullNativeGatePassed': False}
        # Publish the expectation from the broker's memory before any sealer
        # consumes mutable cleanup/IO files. Never regenerate it at first seal.
        if child is not None and initial is not None:
            rows, columns, _, _ = struct.unpack('HHHH', bytes.fromhex(initial['sizeHex']))
            cleanup('save:producer-expected-native.json', lambda: save_json('producer-expected-native.json', {
                'binarySha256': digest, 'captureId': capture_id, 'backend': 'native-shared-slot-v1',
                'childPid': child.pid, 'columns': columns, 'rows': rows, 'ioClose': result['ioClose'],
                'nativeClose': native_close,
                **({'normalRootOrigin': normal_origin} if normal_origin is not None else {}),
            }))
            if cleanup_errors:
                result['normalCompletion'] = False
        save_json('cleanup.json', result)
        save_json('broker-cleanup.json', result)
    return 0 if result['normalCompletion'] else 1


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != '--probe':
        raise SystemExit('usage: terminal-evidence-broker-native.py --probe RUN')
    print(json.dumps(probe_linux_observer(sys.argv[2])))

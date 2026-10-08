#!/usr/bin/env python3
"""Bounded no-ACK capture. Frame/raw records reach disk after the child stops.

Overflow invalidates evidence while PTY forwarding continues. Native geometry
history, OS input ownership and schedule equivalence are separate open gates.
"""
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
import signal
import struct
import subprocess
import termios
import time
import tty

spec = importlib.util.spec_from_file_location('native_journal', Path(__file__).with_name('native-terminal-journal.py'))
journal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journal)


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


def capture_native(run, argv):
    run = Path(run).resolve(strict=True)
    if (run / 'native-observer.json').is_symlink():
        raise ValueError('Native observer descriptor must be owned by this capture')
    observer = json.loads((run / 'native-observer.json').read_text())
    library = Path(observer['library'])
    if (observer.get('method') != 'native-shared-slot-v1' or library != run / 'observer.dylib'
            or library.is_symlink() or not library.is_file()
            or hashlib.sha256(library.read_bytes()).hexdigest() != observer['librarySha256']):
        raise ValueError('Native observer enrollment identity changed')
    capture_id = os.environ['CLAUDE_CODE_FRAME_CAPTURE_ID']
    binary = Path(argv[0]).resolve(strict=True)
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    if digest != os.environ['CLAUDE_CODE_FRAME_BINARY_SHA256']:
        raise ValueError('Native binary changed before broker startup')
    owned_names = ('raw.bin', 'native-pty.raw', 'records.bin', 'pty-io.jsonl', 'journal.bin',
                   'native-initial.json', 'registration.json', 'header.json', 'start.json',
                   'frames.jsonl', 'cleanup.json', 'broker-cleanup.json')
    if any(os.path.lexists(run / name) for name in owned_names):
        raise ValueError('Preexisting native capture artifact is not owned by this launch')
    def save(name, data):
        with open(run / name, 'xb') as file:
            file.write(data)
    def save_json(name, data):
        save(name, (json.dumps(data) + '\n').encode())
    if not (run / 'launch.json').exists():
        save_json('launch.json', {'command': argv, 'captureId': capture_id, 'binarySha256': digest})
    launch = json.loads((run / 'launch.json').read_text())
    if launch['command'] != argv or launch['captureId'] != capture_id or launch['binarySha256'] != digest:
        raise ValueError('Native broker launch receipt changed')
    child = master = slave = consumer = selector = None
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
        evidence.add('io', (json.dumps({'ioId': sequence, 'kind': kind,
            'captureId': capture_id, 'geometryId': geometry_id,
            'rawOffset': raw_offset, **fields}) + '\n').encode())

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
                evidence.add('packets', struct.pack('<I', len(packet)) + packet)
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
        evidence.add('raw', chunk)
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
        registration = journal.create_journal(run / 'journal.bin', os.fstat(slave), 3, 256, 1048576)
        consumer = journal.NativeConsumer(run / 'journal.bin', registration, library)
        env = {**os.environ, 'DYLD_INSERT_LIBRARIES': str(library),
               'CLAUDE_PRIVATE_NATIVE_JOURNAL': str(run / 'journal.bin'),
               'CLAUDE_PRIVATE_NATIVE_JOURNAL_LIBRARY': str(library),
               'CLAUDE_CODE_FRAME_BROKER_DIR': str(run / 'no-legacy-fifos')}
        def own_controlling_tty():
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            signal.pthread_sigmask(signal.SIG_SETMASK, startup_mask)
        child = subprocess.Popen(argv, env=env, stdin=slave, stdout=slave, stderr=slave,
                                 start_new_session=True, preexec_fn=own_controlling_tty)
        consumer.bind_producer(child.pid)
        save_json('start.json', {'childPid': child.pid, 'childPgid': child.pid, 'binarySha256': digest})
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
                fcntl.ioctl(master, termios.TIOCSWINSZ, size)
                if fcntl.ioctl(master, termios.TIOCGWINSZ, b'\0' * 8) != size:
                    raise OSError('Native resize acknowledgement mismatch')
                geometry_id += 1
                rows, columns, _, _ = struct.unpack('HHHH', size)
                record('resize-ack', rows=rows, columns=columns, succeeded=True,
                       nativeClockCorrelationCovered=False)
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
        for name, data in [('raw.bin', raw), ('native-pty.raw', raw),
                           ('records.bin', b''.join(evidence.values['packets'])),
                           ('pty-io.jsonl', b''.join(evidence.values['io']))]:
            cleanup('save:' + name, lambda name=name, data=data: save(name, data))
        for name, data in [('native-initial.json', initial), ('registration.json', registration), ('header.json', header)]:
            if data is not None:
                cleanup('save:' + name, lambda name=name, data=data: save_json(name, data))
        if evidence.dropped:
            capture_failure = {'type': 'EvidenceOverflow', 'message': 'Bounded observer lost evidence',
                               'droppedBytes': evidence.dropped}
        if failure is None:
            failure = capture_failure
        normal = bool(completed and failure is None and not cleanup_errors and eof and child is not None
                      and child.returncode == 0 and not signals_sent)
        result = {'captureId': capture_id, 'childPid': child.pid if child else None,
                  'childExitCode': child.returncode if child else None,
                  'childReaped': child is None or child.poll() is not None,
                  'physicalEof': eof, 'signalsSent': signals_sent, 'failure': failure,
                  'cleanupErrors': cleanup_errors, 'normalCompletion': normal,
                  'backend': 'native-shared-slot-v1', 'evidenceBytes': evidence.used,
                  'observedRawBytes': raw_offset, 'droppedBytes': evidence.dropped,
                  'productTimingEquivalent': False, 'fullNativeGatePassed': False}
        # Keep prefix artifacts even when native decoding or frame derivation fails.
        if normal:
            try:
                saved = (run / 'records.bin').read_bytes()
                packets, offset = [], 0
                while offset < len(saved):
                    length = struct.unpack_from('<I', saved, offset)[0]
                    offset += 4
                    packets.append(saved[offset:offset + length])
                    offset += length
                records = journal.decode_records(header, packets, registration, child.pid)
                entries = journal.ink_frame_entries(records, raw, capture_id, initial['outputFlags'])
                save('frames.jsonl', ''.join(json.dumps(entry) + '\n' for entry in entries).encode())
            except BaseException as error:
                result.update(normalCompletion=False, failure=detail(error))
        save_json('cleanup.json', result)
        save_json('broker-cleanup.json', result)
    return 0 if result['normalCompletion'] else 1

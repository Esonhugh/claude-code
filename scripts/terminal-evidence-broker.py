#!/usr/bin/env python3
"""Own a native PTY and record byte/resize/frame boundaries before forwarding."""
import argparse
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import selectors
import signal
import stat
import struct
import termios
import time
import tty


class BrokerStopped(Exception):
    """A requested stop must propagate through selectors' EINTR handling."""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    argv = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not argv:
        parser.error('native argv is required')
    run = args.run.resolve(strict=True)
    os.umask(0o077)
    native_intent = os.environ.get('CLAUDE_CODE_FRAME_NATIVE_JOURNAL', '')
    if native_intent not in ('', '1'):
        raise ValueError('Invalid native journal selection')
    if native_intent == '1':
        import importlib.util
        spec = importlib.util.spec_from_file_location('native_broker', Path(__file__).with_name('terminal-evidence-broker-native.py'))
        native = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(native)
        return native.capture_native(run, argv)
    if os.path.lexists(run / 'native-observer.json'):
        raise ValueError('Native observer requires explicit native journal selection')
    capture_id = os.environ.get('CLAUDE_CODE_FRAME_CAPTURE_ID')
    if not capture_id:
        raise ValueError('terminal capture identity is required')
    executable = Path(argv[3] if argv[0] == '/usr/bin/sandbox-exec' else argv[0]).resolve(strict=True)
    binary_sha = hashlib.sha256(executable.read_bytes()).hexdigest()
    expected_sha = os.environ.get('CLAUDE_CODE_FRAME_BINARY_SHA256')
    if expected_sha and binary_sha != expected_sha:
        raise ValueError('copied native binary identity changed before startup')

    # Include partial startup in cleanup. Never register preexisting paths as ours.
    outer_attrs = None
    child = master = request_fd = response_fd = ready_read = ready_write = None
    raw = journal = selector = None
    fifo_identity, removed, cleanup_errors = {}, [], []
    raw_offset = sequence = geometry_id = 0
    status = None
    pending_resize = stopped = eof = completed = eof_written = master_nonblocking = False
    stop_reason = failure = None
    cleanup_started = terminal_sealed = False
    startup_mask = None
    stop_deadline = None
    request_bytes = b''

    def error_detail(error):
        return {'type': type(error).__name__, 'message': str(error),
                'errno': getattr(error, 'errno', None)}

    def cleanup_attempt(action, operation):
        try:
            operation()
        except Exception as error:
            cleanup_errors.append({'action': action, **error_detail(error)})

    def record(kind, **fields):
        nonlocal sequence
        sequence += 1
        event = {'ioId': sequence, 'kind': kind, 'captureId': capture_id,
                 'rawOffset': raw_offset, 'geometryId': geometry_id, **fields}
        journal.write(json.dumps(event) + '\n')
        return event

    def output(forward=True, max_bytes=None):
        nonlocal raw_offset, eof
        read_bytes = 0
        while not eof and (max_bytes is None or read_bytes < max_bytes):
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
                if selector is not None:
                    try:
                        selector.unregister(master)
                    except KeyError:
                        pass
                return
            read_bytes += len(chunk)
            start = raw_offset
            raw.write(chunk)
            raw_offset += len(chunk)
            record('output', start=start, end=raw_offset)
            if forward:
                offset = 0
                while offset < len(chunk):
                    offset += os.write(1, chunk[offset:])

    def reap():
        nonlocal status
        # waitpid consumes the child's status. A stop must not interrupt the
        # successful syscall-to-registration window and lose that ownership.
        mask = signal.pthread_sigmask(
            signal.SIG_BLOCK, (signal.SIGHUP, signal.SIGTERM, signal.SIGINT))
        try:
            if status is None:
                waited, result = os.waitpid(child, os.WNOHANG)
                if waited:
                    status = result
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, mask)

    def seal_eof():
        nonlocal eof_written
        # Sending a signal or closing the master is not evidence of physical EOF.
        if not eof_written and eof and status is not None:
            record('eof', childStatus=status)
            with open(run / 'native-pty-eof.json', 'x') as file:
                json.dump({'captureId': capture_id, 'rawBytes': raw_offset,
                           'childPid': child, 'childStatus': status,
                           'childExitCode': os.waitstatus_to_exitcode(status)}, file)
                file.write('\n')
            eof_written = True

    def on_resize(_signal, _frame):
        nonlocal pending_resize
        pending_resize = True

    def on_stop(number, _frame):
        nonlocal stopped, stop_reason
        # Once all owned resources are closed, the outcome has a single
        # publication boundary. Late signals cannot rewrite that outcome.
        if terminal_sealed:
            return
        stopped = True
        if stop_reason is None:
            stop_reason = signal.Signals(number).name
        # Interrupt Python's restarted/blocking writes and inner EAGAIN loops.
        # Cleanup itself must remain uninterrupted so every resource is tried.
        if not cleanup_started:
            raise BrokerStopped('broker stopped by ' + stop_reason)

    try:
        signal.signal(signal.SIGWINCH, on_resize)
        for number in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
            signal.signal(number, on_stop)
        # Delay raising stops until every acquired resource is registered.
        startup_mask = signal.pthread_sigmask(
            signal.SIG_BLOCK, (signal.SIGHUP, signal.SIGTERM, signal.SIGINT))
        outer_attrs = termios.tcgetattr(0)
        initial_size = fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8)
        request_path, response_path = run / 'frame-request.fifo', run / 'frame-response.fifo'
        for path in (request_path, response_path):
            os.mkfifo(path, 0o600)
            identity = path.lstat()
            fifo_identity[path] = (identity.st_dev, identity.st_ino, identity.st_mode)
        request_fd = os.open(request_path, os.O_RDWR | os.O_NONBLOCK)
        response_fd = os.open(response_path, os.O_RDWR | os.O_NONBLOCK)
        raw = open(run / 'native-pty.raw', 'xb', buffering=0)
        journal = open(run / 'pty-io.jsonl', 'x', buffering=1)
        ready_read, ready_write = os.pipe()
        child, master = pty.fork()
        if child == 0:
            # Child startup errors must not enter the parent's cleanup path.
            try:
                os.close(ready_write)
                os.close(request_fd)
                os.close(response_fd)
                raw.close()
                journal.close()
                termios.tcsetattr(0, termios.TCSANOW, outer_attrs)
                fcntl.ioctl(0, termios.TIOCSWINSZ, initial_size)
                os.environ['CLAUDE_CODE_FRAME_BROKER_DIR'] = str(run)
                with open(run / 'native-pty-initial.json', 'x') as file:
                    attrs = termios.tcgetattr(0)
                    attrs[6] = [value.hex() if isinstance(value, bytes) else value for value in attrs[6]]
                    json.dump({'captureId': capture_id, 'binarySha256': binary_sha,
                               'pid': os.getpid(), 'pgid': os.getpgrp(), 'tty': os.ttyname(0),
                               'termios': attrs, 'sizeHex': initial_size.hex()}, file)
                if os.read(ready_read, 1) != b'1':
                    os._exit(125)
                os.close(ready_read)
                signal.pthread_sigmask(signal.SIG_SETMASK, startup_mask)
                os.execvpe(argv[0], argv, os.environ)
            except BaseException as error:
                try:
                    os.write(2, (str(error) + '\n').encode())
                finally:
                    os._exit(125)

        os.set_blocking(master, False)
        master_nonblocking = True
        rows, columns, _, _ = struct.unpack('HHHH', initial_size)
        record('initial-geometry', rows=rows, columns=columns, childPid=child)
        # Only the outer transport is raw; retain the native PTY's initial flags.
        tty.setraw(0, termios.TCSANOW)
        os.close(ready_read)
        ready_read = None
        os.write(ready_write, b'1')
        os.close(ready_write)
        ready_write = None
        selector = selectors.DefaultSelector()
        selector.register(master, selectors.EVENT_READ, 'output')
        selector.register(0, selectors.EVENT_READ, 'input')
        selector.register(request_fd, selectors.EVENT_READ, 'request')
        signal.pthread_sigmask(signal.SIG_SETMASK, startup_mask)
        startup_mask = None
        while status is None or not eof:
            if stopped:
                if stop_deadline is None:
                    try:
                        os.killpg(child, signal.SIGHUP)
                    except ProcessLookupError:
                        pass
                    stop_deadline = time.monotonic() + 2
                    record('stop', reason=stop_reason)
                stopped = False
            if stop_deadline is not None and time.monotonic() >= stop_deadline:
                raise TimeoutError('native PTY did not close before stop deadline')
            if pending_resize:
                output()
                size = fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8)
                fcntl.ioctl(master, termios.TIOCSWINSZ, size)
                if fcntl.ioctl(master, termios.TIOCGWINSZ, b'\0' * 8) != size:
                    raise OSError('native PTY resize acknowledgement differed from requested size')
                geometry_id += 1
                rows, columns, _, _ = struct.unpack('HHHH', size)
                record('resize-ack', rows=rows, columns=columns, ioctl='TIOCSWINSZ', succeeded=True)
                pending_resize = False
            for key, _mask in selector.select(0.05):
                if key.data == 'output':
                    output()
                elif key.data == 'input':
                    chunk = os.read(0, 65536)
                    if chunk:
                        record('input', hex=chunk.hex())
                        offset = 0
                        while offset < len(chunk):
                            try:
                                offset += os.write(master, chunk[offset:])
                            except BlockingIOError:
                                time.sleep(0.001)
                    else:
                        selector.unregister(0)
                        record('outer-input-eof')
                        if stop_reason is None:
                            stop_reason = 'outer-input-eof'
                        stopped = True
                else:
                    request_bytes += os.read(request_fd, 65536)
                    while b'\n' in request_bytes:
                        line, request_bytes = request_bytes.split(b'\n', 1)
                        message = json.loads(line)
                        if message.get('kind') not in ('frame-start', 'frame-end'):
                            raise ValueError('unexpected frame boundary request')
                        output()
                        event = record(message['kind'], requestId=message['requestId'],
                                       rendererId=message['rendererId'], rootEpoch=message['rootEpoch'])
                        reply = (json.dumps(event) + '\n').encode()
                        if os.write(response_fd, reply) != len(reply):
                            raise OSError('incomplete frame acknowledgement')
            reap()
        seal_eof()
        completed = True
    except BaseException as error:
        failure = error_detail(error)
    finally:
        cleanup_started = True
        if startup_mask is not None:
            cleanup_attempt('restore-startup-signal-mask',
                            lambda: signal.pthread_sigmask(signal.SIG_SETMASK, startup_mask))
        # Failure of any one cleanup operation must not skip the other resources.
        if outer_attrs is not None:
            cleanup_attempt('restore-outer-tty', lambda: termios.tcsetattr(0, termios.TCSANOW, outer_attrs))
        for descriptor in (ready_read, ready_write):
            if descriptor is not None:
                cleanup_attempt('close-ready-pipe', lambda fd=descriptor: os.close(fd))
        if child is not None and status is None:
            def stop_child():
                try:
                    os.killpg(child, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            cleanup_attempt('stop-owned-child', stop_child)
        if master is not None:
            deadline = time.monotonic() + 2
            while True:
                if master_nonblocking and raw is not None and journal is not None:
                    cleanup_attempt('drain-native-pty', lambda: output(False, max_bytes=65536))
                cleanup_attempt('reap-owned-child', reap)
                if (status is not None and (eof or not master_nonblocking)) or time.monotonic() >= deadline:
                    break
                time.sleep(0.01)
            cleanup_attempt('close-native-pty', lambda: os.close(master))
            if status is None:
                cleanup_errors.append({'action': 'reap-owned-child', 'type': 'TimeoutError',
                                       'message': 'owned child was not reaped before cleanup deadline', 'errno': None})
            cleanup_attempt('seal-native-eof', seal_eof)
        if selector is not None:
            cleanup_attempt('close-selector', selector.close)
        for descriptor in (request_fd, response_fd):
            if descriptor is not None:
                cleanup_attempt('close-fifo-descriptor', lambda fd=descriptor: os.close(fd))
        for stream in (raw, journal):
            if stream is not None:
                cleanup_attempt('close-evidence-file', stream.close)
        for path, identity in fifo_identity.items():
            def remove_owned(path=path, identity=identity):
                current = path.lstat()
                if ((current.st_dev, current.st_ino, current.st_mode) != identity
                        or not stat.S_ISFIFO(current.st_mode)):
                    raise RuntimeError('Owned terminal evidence FIFO identity changed')
                path.unlink()
                removed.append(path.name)
            cleanup_attempt('remove-owned-fifo:' + path.name, remove_owned)
        terminal_sealed = True
        normal = (completed and stop_reason is None and failure is None and not cleanup_errors
                  and status is not None and os.waitstatus_to_exitcode(status) == 0)
        with open(run / 'broker-cleanup.json', 'x') as file:
            json.dump({'captureId': capture_id, 'childPid': child, 'childReaped': status is not None,
                       'childStatus': status, 'physicalEof': eof, 'normalCompletion': normal,
                       'terminalOutcomeSealed': terminal_sealed,
                       'stopReason': stop_reason, 'failure': failure, 'cleanupErrors': cleanup_errors,
                       'fifoRemoved': removed}, file)
            file.write('\n')
    if normal:
        return 0
    return (os.waitstatus_to_exitcode(status) or 1) if status is not None else 1


if __name__ == '__main__':
    raise SystemExit(main())

#!/usr/bin/env python3
"""Capture one isolated native process without writer ACKs or fd redirection.

Compile the adjacent Darwin observer into a fresh evidence directory. Use only
dummy credentials if a controlled provider is later added to an isolated probe.
This command proves output bytes and closure, never complete UI acceptance.
"""
import argparse
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pty
import selectors
import signal
import socket
import struct
import subprocess
import tempfile
import termios
import time

spec = importlib.util.spec_from_file_location(
    'native_terminal_writes', Path(__file__).with_name('native-terminal-writes.py'))
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def attrs_json(attrs):
    return [*attrs[:6], [v.hex() if isinstance(v, bytes) else v for v in attrs[6]]]


def receive_packet(sock, packets, deadline):
    validator.require(time.monotonic() < deadline, 'Native packet deadline exceeded')
    packet = sock.recv(65536)
    validator.require(time.monotonic() < deadline, 'Native packet deadline exceeded')
    validator.require(len(packets) < 100000, 'Packet budget exceeded')
    packets.append(packet)


def capture(args, ownership):
    run = args.evidence_root.resolve()
    run.mkdir(mode=0o700)
    ownership['run'] = run
    binary = args.executable.resolve(strict=True)
    source = Path(__file__).with_name('native-terminal-write-witness.c')
    validator_source = Path(spec.origin)
    library = run / 'witness.dylib'
    inputs = {str(p): sha(p) for p in (binary, source, validator_source, Path(__file__))}
    for part in ('home', 'config', 'tmp', 'cache'):
        (run / part).mkdir(mode=0o700)
    env = {'PATH': '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
           'HOME': str(run / 'home'), 'CLAUDE_CONFIG_DIR': str(run / 'config'),
           'TMPDIR': str(run / 'tmp'), 'XDG_CACHE_HOME': str(run / 'cache'),
           'TERM': 'xterm-256color', 'DISABLE_TELEMETRY': '1',
           'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
           'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1'}
    compile_command = ['/usr/bin/clang', '-std=c11', '-O2', '-Wall', '-Wextra',
                       '-Werror', '-dynamiclib', str(source), '-o', str(library)]
    with (run / 'compile.log').open('xb') as log:
        compiled = subprocess.run(compile_command, env=env, cwd=run, stdout=log,
                                  stderr=subprocess.STDOUT, timeout=15)
    save(run / 'compile.json', {'command': compile_command,
                               'exitCode': compiled.returncode})
    validator.require(compiled.returncode == 0, 'Observer compilation failed')
    socket_dir = Path(tempfile.mkdtemp(prefix='cc-write-', dir='/private/tmp'))
    socket_path = socket_dir / 'observer.sock'
    sock = None
    child = None
    selector = None
    master = slave = None
    packets = []
    raw = {'stdout': bytearray(), 'stderr': bytearray(), 'pty': bytearray()}
    eofs = set()
    receipt = {'mode': args.mode, 'command': [str(binary), *args.command],
               'inputs': inputs, 'librarySHA256': sha(library), 'timedOut': False}
    error = None
    cleanup_errors = []

    def cleanup_action(name, action):
        try:
            action()
        except Exception as failure:
            cleanup_errors.append({'action': name, 'error': str(failure)})

    def stop_owned_group():
        try:
            os.killpg(child.pid, signal.SIGKILL)
            receipt['cleanupKilledOwnedGroup'] = True
        except ProcessLookupError:
            pass

    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        sock.bind(str(socket_path))
        os.chmod(socket_path, 0o600)
        sock.setblocking(False)
        env.update(DYLD_INSERT_LIBRARIES=str(library),
                   CLAUDE_PRIVATE_SYSCALL_WITNESS_SOCKET=str(socket_path))
        receipt['environment'] = env
        kwargs = {'stdin': subprocess.DEVNULL, 'stdout': subprocess.PIPE,
                  'stderr': subprocess.PIPE}
        if args.mode == 'pty':
            master, slave = pty.openpty()
            size = struct.pack('HHHH', 30, 100, 0, 0)
            fcntl.ioctl(slave, termios.TIOCSWINSZ, size)
            attrs = termios.tcgetattr(slave)
            validator.require(attrs[1] == termios.OPOST | termios.ONLCR,
                              'Unsupported initial PTY output flags')
            receipt.update(tty=os.ttyname(slave), termiosBefore=attrs_json(attrs),
                           sizeHexBefore=size.hex())

            def acquire_tty():
                fcntl.ioctl(0, termios.TIOCSCTTY, 0)

            kwargs = {'stdin': slave, 'stdout': slave, 'stderr': slave,
                      'preexec_fn': acquire_tty}
        child = subprocess.Popen(receipt['command'], env=env, cwd=run,
                                 start_new_session=True, **kwargs)
        receipt.update(pid=child.pid, pgid=child.pid)
        save(run / 'start.json', receipt)
        selector = selectors.DefaultSelector()
        selector.register(sock, selectors.EVENT_READ, 'packets')
        if args.mode == 'pty':
            os.close(slave)
            slave = None
            os.set_blocking(master, False)
            selector.register(master, selectors.EVENT_READ, 'pty')
            required_eofs = {'pty'}
        else:
            selector.register(child.stdout, selectors.EVENT_READ, 'stdout')
            selector.register(child.stderr, selectors.EVENT_READ, 'stderr')
            required_eofs = {'stdout', 'stderr'}
        deadline = time.monotonic() + args.deadline
        while child.poll() is None or eofs != required_eofs:
            if time.monotonic() >= deadline:
                receipt['timedOut'] = True
                raise validator.EvidenceError('Native process/EOF deadline exceeded')
            for key, _ in selector.select(timeout=0.05):
                if key.data == 'packets':
                    receive_packet(sock, packets, deadline)
                    continue
                try:
                    chunk = os.read(key.fd, 65536)
                except OSError as failure:
                    if key.data != 'pty' or failure.errno != errno.EIO:
                        raise
                    chunk = b''
                if chunk:
                    raw[key.data].extend(chunk)
                    validator.require(len(raw[key.data]) <= 64 * 1024 * 1024,
                                      'Raw output budget exceeded')
                else:
                    eofs.add(key.data)
                    selector.unregister(key.fileobj)
        child.wait(timeout=3)
        while True:
            try:
                receive_packet(sock, packets, deadline)
            except BlockingIOError:
                break
        if args.mode == 'pty':
            receipt.update(termiosAfter=attrs_json(termios.tcgetattr(master)),
                           sizeHexAfter=fcntl.ioctl(master, termios.TIOCGWINSZ,
                                                   b'\0' * 8).hex())
    except Exception as failure:
        error = str(failure)
    finally:
        if child is not None:
            def stop_running_child():
                if child.poll() is None:
                    stop_owned_group()

            cleanup_action('owned-process-stop', stop_running_child)
            cleanup_action('owned-process-wait', lambda: child.wait(timeout=3))
            receipt['exitCode'] = child.returncode

            def probe_group():
                try:
                    os.killpg(child.pid, 0)
                    receipt['processGroupRemains'] = True
                    stop_owned_group()
                except ProcessLookupError:
                    receipt['processGroupRemains'] = False

            cleanup_action('owned-group-probe', probe_group)
        if selector is not None:
            cleanup_action('selector-close', selector.close)
        if args.mode == 'pipe' and child is not None:
            cleanup_action('stdout-close', child.stdout.close)
            cleanup_action('stderr-close', child.stderr.close)
        for fd in (master, slave):
            if fd is not None:
                cleanup_action('pty-fd-close', lambda fd=fd: os.close(fd))
        if sock is not None:
            cleanup_action('socket-close', sock.close)

        def unlink_socket():
            if socket_path.exists():
                socket_path.unlink()

        cleanup_action('socket-unlink', unlink_socket)
        cleanup_action('socket-directory-remove', socket_dir.rmdir)
    receipt['captureError'] = error
    receipt['cleanupErrors'] = cleanup_errors
    receipt['EOF'] = sorted(eofs)
    packed = b''.join(struct.pack('<I', len(packet)) + packet for packet in packets)
    (run / 'packets.bin').write_bytes(packed)
    for name, data in raw.items():
        (run / (name + '.raw')).write_bytes(data)
    reread = {}
    for path, digest in inputs.items():
        try:
            actual = sha(Path(path))
            reread[path] = {'status': 'unchanged' if actual == digest else 'changed',
                            'sha256': actual}
        except FileNotFoundError as failure:
            reread[path] = {'status': 'missing', 'error': str(failure)}
        except OSError as failure:
            reread[path] = {'status': 'unknown', 'error': str(failure)}
    receipt['inputReread'] = reread
    receipt['inputsUnchanged'] = all(record['status'] == 'unchanged'
                                     for record in reread.values())
    save(run / 'receipt.json', receipt)
    validator.require(error is None, error)
    validator.require(not cleanup_errors, 'Native resource cleanup failed')
    validator.require(receipt.get('exitCode') == 0 and not receipt['timedOut'] and
                      receipt['inputsUnchanged'] and not receipt['processGroupRemains'],
                      'Native identity, exit or cleanup failed')
    writes = validator.decode_packets(packed, child.pid)
    if args.mode == 'pty':
        validator.require(receipt['termiosBefore'] == receipt['termiosAfter'] and
                          receipt['sizeHexBefore'] == receipt['sizeHexAfter'],
                          'PTY settings changed during this bounded probe')
        proofs = [validator.verify_raw(writes, raw['pty'], 3,
                                       receipt['termiosBefore'][1])]
    else:
        proofs = [validator.verify_raw(writes, raw[name], mask)
                  for mask, name in ((1, 'stdout'), (2, 'stderr'))]
    return {'verdict': 'passed', 'byteProofs': proofs, 'evidenceRoot': str(run),
            'scope': 'One native byte/EOF probe; no interactive UI, resize, frame '
                     'mapping, termios event history or product timing claim'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-root', type=Path, required=True)
    parser.add_argument('--executable', type=Path, required=True)
    parser.add_argument('--mode', choices=('pipe', 'pty'), default='pipe')
    parser.add_argument('--deadline', type=float, default=10)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if not 1 <= args.deadline <= 60:
        parser.error('deadline must be between 1 and 60 seconds')
    if args.command[:1] == ['--']:
        args.command = args.command[1:]
    ownership = {}
    try:
        proof = capture(args, ownership)
    except Exception as error:
        proof = {'verdict': 'failed', 'reason': str(error),
                 'evidenceRoot': str(args.evidence_root)}
    if 'run' in ownership:
        save(ownership['run'] / 'proof.json', proof)
    print(json.dumps(proof))
    return 0 if proof['verdict'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())

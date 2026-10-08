#!/usr/bin/env python3
"""Real CLI/tmux frame-journal entry. This is not the complete release gate."""
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pty
import selectors
import shlex
import signal
import struct
import subprocess
import sys
import termios
import time
import tty
import unittest

SOURCE = Path(__file__).resolve().parent
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SOURCE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
journal = load('frame_journal', 'native-terminal-journal.py')


class NativeResizeOrderingTest(unittest.TestCase):
    def fixture(self):
        verifier = load('resize_verifier', 'verify-native-frame-journal.py')
        records = []
        for span, offset in ((1, 0), (2, 200)):
            for kind, entry, returned in ((10, 100, 101), (12, 110, 111),
                                          (1, 120, 121), (13, 130, 131), (11, 200, 201)):
                records.append({'sequence': len(records) + 1, 'kind': kind, 'spanId': span,
                                'threadId': 1, 'entry': entry + offset, 'return': returned + offset,
                                'bytes': b'x\n' if kind == 1 else b''})
        header = [0] * 32
        header[8], header[12], header[13], header[19], header[21] = 123, 125, 3, 50, 500
        before, after = struct.pack('HHHH', 30, 100, 0, 0).hex(), struct.pack('HHHH', 34, 110, 0, 0).hex()
        bracket = {'method': 'native-mach-ioctl-resize-v1', 'entry': '150', 'return': '151',
                   'nonce': 'owned', 'childPid': 123, 'timebaseNumer': 125, 'timebaseDenom': 3,
                   'result': 0, 'errno': errno.EINTR, 'beforeSizeHex': before, 'afterSizeHex': after}
        row = {'kind': 'resize-ack', 'ioId': 3, 'geometryId': 1, 'rawOffset': 0,
               'columns': 110, 'rows': 34, 'succeeded': True,
               'nativeClockCorrelationCovered': True, 'nativeBracket': bracket}
        return verifier, [row], header, {'nonce': 'owned'}, records, {'sizeHex': before, 'outputFlags': termios.OPOST | termios.ONLCR}

    def test_resize_after_frame_end_precedes_next_frame_not_late_snapshot(self):
        verifier, *arguments = self.fixture()
        events = verifier.native_resize_events(*arguments)
        self.assertEqual(len(events), 1)
        self.assertEqual((events[0]['beforeFrameId'], events[0]['rawOffset']), (2, 3))
        self.assertEqual(events[0]['nativeBracket']['entry'], '150')

    def test_resize_rejects_output_or_layout_overlap_and_foreign_receipt(self):
        verifier, *arguments = self.fixture()
        bracket = arguments[0][0]['nativeBracket']
        for entry, returned, message in (('120', '121', 'output syscall'),
                                         ('105', '106', 'output transaction'),
                                         ('129', '132', 'output transaction')):
            with self.subTest(entry=entry):
                bracket.update(entry=entry, **{'return': returned})
                with self.assertRaisesRegex(verifier.journal.JournalError, message):
                    verifier.native_resize_events(*arguments)
        bracket.update(entry='150', **{'return': '151'})
        for key, value in (('entry', 150), ('return', 2 ** 64), ('entry', '0150'),
                           ('entry', '18446744073709551616'), ('entry', '1.5'),
                           ('entry', '-1'), ('entry', '١٥٠'), ('childPid', True),
                           ('result', False), ('timebaseNumer', True), ('nonce', 'foreign'),
                           ('beforeSizeHex', '00' * 8), ('afterSizeHex', '00' * 8)):
            with self.subTest(key=key, value=value):
                original = bracket[key]
                bracket[key] = value
                with self.assertRaises(verifier.journal.JournalError):
                    verifier.native_resize_events(*arguments)
                bracket[key] = original

    def test_resize_uint64_clock_survives_json_without_float_rounding(self):
        verifier, *arguments = self.fixture()
        offset = 2 ** 53 + 1
        for row in arguments[3]:
            row['entry'] += offset
            row['return'] += offset
        arguments[1][19] += offset
        arguments[1][21] += offset
        arguments[0][0]['nativeBracket'].update(entry=str(offset + 150), **{'return': str(offset + 151)})
        result = verifier.native_resize_events(*arguments)
        self.assertEqual(result[0]['nativeBracket']['entry'], '9007199254741143')
        self.assertEqual(json.loads(json.dumps(result))[0]['nativeBracket']['entry'], str(offset + 150))


def capture_cli(run):
    os.umask(0o077)
    spec = json.loads((run / 'launch.json').read_text())
    child = master = slave = consumer = selector = None
    outer_attrs = None
    raw = bytearray()
    packets, inputs, cleanup_errors, signals_sent = [], [], [], []
    eof = False
    failure = None
    started = time.monotonic()
    try:
        def interrupted(number, _frame):
            raise InterruptedError('Capture interrupted by ' + signal.Signals(number).name)
        for number in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
            signal.signal(number, interrupted)
        outer_attrs = termios.tcgetattr(0)
        tty.setraw(0)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
        attrs = termios.tcgetattr(slave)
        (run / 'native-initial.json').write_text(json.dumps({
            'sizeHex': fcntl.ioctl(slave, termios.TIOCGWINSZ, b'\0' * 8).hex(),
            'outputFlags': attrs[1],
        }) + '\n')
        registration = journal.create_journal(run / 'journal.bin', os.fstat(slave), 3, 256, 1048576)
        (run / 'registration.json').write_text(json.dumps(registration) + '\n')
        env = dict(spec['environment'])
        env.update(DYLD_INSERT_LIBRARIES=spec['library'],
                   CLAUDE_PRIVATE_NATIVE_JOURNAL=str(run / 'journal.bin'),
                   CLAUDE_PRIVATE_NATIVE_JOURNAL_LIBRARY=spec['library'],
                   CLAUDE_CODE_FRAME_CAPTURE_ID=spec['captureId'],
                   CLAUDE_CODE_FRAME_BROKER_DIR=str(run / 'legacy-fifos-must-not-open'),
                   CLAUDE_CODE_FRAME_EVIDENCE_PATH=str(run / 'legacy-frames-must-not-write.jsonl'))
        consumer = journal.NativeConsumer(run / 'journal.bin', registration, spec['library'])
        selector = selectors.DefaultSelector()
        child = subprocess.Popen(spec['command'], cwd=run / 'project', env=env,
                                 stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        consumer.bind_producer(child.pid)
        (run / 'start.json').write_text(json.dumps({'childPid': child.pid, 'childPgid': child.pid,
                                                   'binarySha256': spec['binarySha256']}) + '\n')
        os.close(slave)
        slave = None
        os.set_blocking(master, False)
        selector.register(master, selectors.EVENT_READ, 'output')
        selector.register(0, selectors.EVENT_READ, 'input')
        def collect():
            while True:
                packet = consumer.consume(len(packets) + 1)
                if packet is None:
                    break
                packets.append(packet)
        while not eof and time.monotonic() - started < 15:
            collect()
            for key, _ in selector.select(.01):
                if key.data == 'input':
                    chunk = os.read(0, 65536)
                    if not chunk:
                        selector.unregister(0)
                        continue
                    offset = 0
                    while offset < len(chunk):
                        count = os.write(master, chunk[offset:])
                        inputs.append({'hex': chunk[offset:offset + count].hex(), 'returned': count})
                        offset += count
                else:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        chunk = b''
                    if not chunk:
                        eof = True
                        break
                    raw.extend(chunk)
                    offset = 0
                    while offset < len(chunk):
                        offset += os.write(1, chunk[offset:])
        if not eof:
            raise TimeoutError('Actual CLI did not reach physical EOF')
        child.wait(timeout=2)
        collect()
        header = consumer.header()
        (run / 'header.json').write_text(json.dumps(list(header)) + '\n')
        if child.returncode:
            raise RuntimeError('Actual CLI exit code ' + str(child.returncode))
        if termios.tcgetattr(master) != attrs:
            raise RuntimeError('Actual CLI did not restore native termios')
    except BaseException as error:
        failure = {'type': type(error).__name__, 'message': str(error)}
    finally:
        signal.pthread_sigmask(signal.SIG_BLOCK, (signal.SIGHUP, signal.SIGTERM, signal.SIGINT))
        def cleanup(action, operation):
            try:
                operation()
            except Exception as error:
                cleanup_errors.append({'action': action, 'error': str(error)})
        if child is not None:
            if child.poll() is None:
                def stop():
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                        signals_sent.append('SIGKILL')
                    except ProcessLookupError:
                        pass
                cleanup('stop-owned-child', stop)
            cleanup('wait-owned-child', lambda: child.wait(timeout=2))
        if consumer is not None:
            cleanup('close-consumer', consumer.close)
        if selector is not None:
            cleanup('close-selector', selector.close)
        for fd in (master, slave):
            if fd is not None:
                cleanup('close-owned-fd', lambda fd=fd: os.close(fd))
        if outer_attrs is not None:
            cleanup('restore-outer-termios', lambda: termios.tcsetattr(0, termios.TCSANOW, outer_attrs))
        (run / 'raw.bin').write_bytes(raw)
        (run / 'records.bin').write_bytes(b''.join(struct.pack('<I', len(packet)) + packet for packet in packets))
        (run / 'input.json').write_text(json.dumps(inputs) + '\n')
        result = {'childPid': child.pid if child else None,
                  'childExitCode': child.returncode if child else None,
                  'childReaped': child is None or child.poll() is not None,
                  'physicalEof': eof, 'signalsSent': signals_sent,
                  'failure': failure, 'cleanupErrors': cleanup_errors,
                  'normalCompletion': failure is None and not cleanup_errors and eof and child is not None and child.returncode == 0,
                  'scope': 'actual CLI entry and native frame journal; no full acceptance verdict'}
        (run / 'cleanup.json').write_text(json.dumps(result, indent=2) + '\n')
    return 0 if result['normalCompletion'] else 1


class NativeFrameJournalTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        native = load('native_probes', 'test-native-terminal-journal.py').NativeJournalTest
        native.setUpClass()
        cls.root, cls.library, cls.env = native.root, native.library, native.env

    def test_actual_cli_emits_immutable_frame_journal_without_fifo_ack(self):
        import uuid
        run = self.root / ('cli-' + str(len(list(self.root.glob('cli-*')))))
        run.mkdir()
        self.last_cli_run = run
        for name in ('home', 'config', 'project', 'tmp'):
            (run / name).mkdir()
        binary = Path(os.environ['JOURNAL_TEST_BINARY']).resolve(strict=True)
        digest = hashlib.sha256(binary.read_bytes()).hexdigest()
        env = {**self.env, 'HOME': str(run / 'home'), 'CLAUDE_CONFIG_DIR': str(run / 'config'),
               'TMPDIR': str(run / 'tmp'), 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor',
               'ANTHROPIC_API_KEY': 'sk-ant-mods-test-lab-fake-not-a-credential',
               'ANTHROPIC_BASE_URL': 'http://127.0.0.1:9', 'CLAUDE_CODE_MAX_RETRIES': '0',
               'CLAUDE_CODE_ENABLE_MODS': '1'}
        (run / 'config/.claude.json').write_text(json.dumps({
            'hasCompletedOnboarding': True, 'numStartups': 2, 'theme': 'dark',
            'customApiKeyResponses': {'approved': [env['ANTHROPIC_API_KEY'][-20:]], 'rejected': []},
            'projects': {str(run / 'project'): {'hasTrustDialogAccepted': True, 'hasCompletedProjectOnboarding': True}},
        }) + '\n')
        (run / 'config/settings.json').write_text(json.dumps({'skipDangerousModePermissionPrompt': True,
                                                             'tui': 'fullscreen', 'theme': 'dark'}) + '\n')
        launch = {'command': [str(binary), '--dangerously-skip-permissions', '--model', 'claude-sonnet-4-6'],
                  'binarySha256': digest, 'library': str(self.library), 'environment': env,
                  'captureId': str(uuid.uuid4())}
        socket = run / 'tmux.sock'
        columns, rows = 100, 30
        if getattr(self, 'production_broker', False):
            import shutil
            (run / 'bin').mkdir()
            shutil.copy2(binary, run / 'bin/claude')
            binary = run / 'bin/claude'
            env.update(CC_VALIDATION_REPO_ROOT=str(SOURCE.parent),
                       CC_VALIDATION_EVIDENCE_DIR=str(run), CC_VALIDATION_HOME=str(run / 'home'),
                       CC_VALIDATION_CONFIG_DIR=str(run / 'config'), CC_VALIDATION_CWD=str(run / 'project'),
                       CC_VALIDATION_BINARY=str(binary), CC_VALIDATION_USE_OPENAI='0',
                       CC_VALIDATION_ANTHROPIC_API_KEY=env['ANTHROPIC_API_KEY'],
                       CC_VALIDATION_ANTHROPIC_BASE_URL=env['ANTHROPIC_BASE_URL'],
                       CC_VALIDATION_MAX_RETRIES='0', CC_VALIDATION_DISABLE_NONESSENTIAL_TRAFFIC='1')
            descriptor = {'run': str(run), 'socket': str(socket), 'target': 'journal:0.0',
                'pane': 'journal:0.0', 'tmux': '/opt/homebrew/bin/tmux', 'env': env,
                'binarySha256': digest,
                'argv': [str(SOURCE.parent / '.claude/skills/claude-agent-workflow-validation/scripts/launch-built-claude.sh')]}
            path = run / 'capture-launch.json'
            path.write_text(json.dumps(descriptor, indent=2) + '\n')
            prepare = subprocess.run(['/opt/homebrew/bin/bun', str(SOURCE / 'terminal-capture-driver.mjs'),
                                      'prepare', str(path)], env=env, capture_output=True, timeout=5)
            (run / 'prepare.log').write_bytes(prepare.stdout + prepare.stderr)
            self.assertEqual(prepare.returncode, 0, prepare.stderr.decode())
            descriptor = json.loads(path.read_text())
            env = descriptor['env']
            launch['captureId'] = descriptor['capture']['captureId']
            columns, rows = (descriptor['capture']['initialSize'][key] for key in ('columns', 'rows'))
            self.assertEqual(env['CC_VALIDATION_FRAME_NATIVE_JOURNAL'], '1')
        else:
            (run / 'launch.json').write_text(json.dumps(launch, indent=2) + '\n')
        config = run / 'tmux.conf'
        config.write_text('set-option -g default-shell /bin/sh\nset-option -g remain-on-exit on\n')
        tmux = ['/opt/homebrew/bin/tmux', '-S', str(socket)]
        calls = []
        def boundary():
            values = {}
            for name in ('frames.jsonl', 'pty-io.jsonl'):
                data = (run / name).read_bytes()
                values[name] = [json.loads(line) for line in data[:data.rfind(b'\n') + 1].splitlines()]
            return {'lastObservedFrameId': values['frames.jsonl'][-1]['frameId'] if values['frames.jsonl'] else 0,
                    'lastObservedIoId': values['pty-io.jsonl'][-1]['ioId'],
                    'observedRawBytes': (run / 'pty.raw').stat().st_size}
        def command(*args):
            receipt = {'argv': list(args)}
            calls.append(receipt)
            geometry = None
            if args[0] == 'resize-window':
                geometry = {'actionId': 1, 'columns': int(args[args.index('-x') + 1]),
                            'rows': int(args[args.index('-y') + 1]),
                            'actualArgs': list(args), 'target': descriptor['target']}
                with (run / 'geometry.jsonl').open('a') as stream:
                    stream.write(json.dumps({**geometry, 'phase': 'resize-send', **boundary()}) + '\n')
            try:
                result = subprocess.run([*tmux, *args], env=env, capture_output=True, timeout=5)
                receipt['exitCode'] = result.returncode
            except Exception as error:
                receipt['error'] = {'type': type(error).__name__, 'message': str(error)}
                raise
            if geometry is not None:
                with (run / 'geometry.jsonl').open('a') as stream:
                    stream.write(json.dumps({**geometry, 'phase': 'resize-return',
                                             'exitCode': result.returncode, **boundary()}) + '\n')
            if result.returncode:
                raise RuntimeError(result.stderr.decode())
            return result.stdout.decode()
        started = False
        try:
            if socket.exists():
                raise RuntimeError('Private tmux socket existed before launch')
            argv = [descriptor['capture']['wrapper']] if getattr(self, 'production_broker', False) else \
                   ['python3', str(Path(__file__).resolve()), '--capture-cli', str(run)]
            # The server can exist even if its client times out or fails.
            started = True
            pane = command('-f', str(config), 'new-session', '-d', '-s', 'journal', '-x', str(columns), '-y', str(rows),
                           '-P', '-F', '#{pane_id}', shlex.join(argv)).strip()
            if getattr(self, 'production_broker', False):
                install = subprocess.run(['/opt/homebrew/bin/bun', str(SOURCE / 'terminal-capture-driver.mjs'),
                                          'install', str(run / 'capture-launch.json')], env=env, capture_output=True, timeout=5)
                (run / 'install.log').write_bytes(install.stdout + install.stderr)
                self.assertEqual(install.returncode, 0, install.stderr.decode())
            deadline = time.monotonic() + 10
            while True:
                text = command('capture-pane', '-p', '-t', pane)
                if '❯' in text and 'bypass permissions' in text:
                    (run / 'ready-pane.txt').write_text(text)
                    break
                if command('display-message', '-p', '-t', pane, '#{pane_dead}').strip() == '1':
                    raise RuntimeError('CLI exited before readiness: ' + text)
                if time.monotonic() >= deadline:
                    raise TimeoutError('No actual CLI readiness: ' + text)
            live_observation = None
            if getattr(self, 'require_live_prefix', False):
                # A final-only file cannot witness this live checkpoint. Wait
                # for actual complete rows, then continue normal /exit even RED.
                deadline = time.monotonic() + 2
                while True:
                    values = {}
                    for name in ('frames.jsonl', 'pty-io.jsonl'):
                        path = run / name
                        data = path.read_bytes() if path.exists() else b''
                        complete = data[:data.rfind(b'\n') + 1]
                        values[name] = [json.loads(line) for line in complete.splitlines()]
                    frames, io = values['frames.jsonl'], values['pty-io.jsonl']
                    physical_bytes = (run / 'pty.raw').stat().st_size
                    child_pid = json.loads((run / 'start.json').read_text())['childPid']
                    try:
                        os.kill(child_pid, 0)
                        child_alive = True
                    except ProcessLookupError:
                        child_alive = False
                    running = (child_alive and not (run / 'broker-cleanup.json').exists()
                               and command('display-message', '-p', '-t', pane, '#{pane_dead}').strip() == '0')
                    passed = bool(running and frames and io and frames[-1]['native']['captureId'] == launch['captureId']
                                  and 0 < frames[-1]['frameId'] == frames[-1]['native']['spanId']
                                  and frames[-1]['rawEnd'] <= physical_bytes)
                    live_observation = {'passed': passed, 'captureId': launch['captureId'],
                        'frameCount': len(frames), 'ioCount': len(io), 'physicalBytes': physical_bytes,
                        'observedBeforeExitInput': True, 'observedChildAlive': child_alive,
                        'observedBrokerOpen': running, 'framePrefix': frames, 'ioPrefix': io,
                        'binarySha256': digest, 'childPid': child_pid}
                    if passed or time.monotonic() >= deadline:
                        break
                    if command('display-message', '-p', '-t', pane, '#{pane_dead}').strip() == '1':
                        raise RuntimeError('CLI exited before live evidence checkpoint')
                    time.sleep(.02)
                (run / 'live-observation.json').write_text(json.dumps(live_observation) + '\n')
            if getattr(self, 'resize_with_native_receipt', False):
                command('resize-window', '-t', descriptor['target'], '-x', '110', '-y', '34')
                self.assertEqual(command('display-message', '-p', '-t', pane,
                                         '#{pane_width} #{pane_height}').strip(), '110 34')
            if getattr(self, 'fail_expectation_publication', False):
                (run / 'producer-expected-native.json').write_bytes(b'late file must not be overwritten')
            command('send-keys', '-t', pane, '-l', '/exit')
            command('send-keys', '-t', pane, 'Enter')
            deadline = time.monotonic() + 10
            while command('display-message', '-p', '-t', pane, '#{pane_dead}').strip() != '1':
                if time.monotonic() >= deadline:
                    raise TimeoutError('CLI did not close normally')
            (run / 'final-pane.txt').write_text(command('capture-pane', '-p', '-t', pane))
            self.assertTrue((run / 'cleanup.json').is_file(), 'Default broker ignored native journal enrollment')
            cleanup = json.loads((run / 'cleanup.json').read_text())
            if getattr(self, 'fail_expectation_publication', False):
                self.assertFalse(cleanup['normalCompletion'])
                self.assertEqual(cleanup['childExitCode'], 0)
                self.assertTrue(cleanup['physicalEof'] and cleanup['childReaped'])
                self.assertEqual(cleanup['signalsSent'], [])
                self.assertEqual([error['action'] for error in cleanup['cleanupErrors']],
                                 ['save:producer-expected-native.json'])
                self.assertEqual((run / 'producer-expected-native.json').read_bytes(),
                                 b'late file must not be overwritten')
                return
            self.assertTrue(cleanup['normalCompletion'], cleanup)
            if getattr(self, 'resize_with_native_receipt', False):
                io = [json.loads(line) for line in (run / 'pty-io.jsonl').read_bytes().splitlines()]
                resizes = [row for row in io if row['kind'] == 'resize-ack']
                self.assertEqual(len(resizes), 1)
                self.assertEqual((resizes[0]['columns'], resizes[0]['rows']), (110, 34))
                self.assertTrue(resizes[0]['nativeClockCorrelationCovered'],
                                'Actual default broker resize lacks native Mach-clock ioctl brackets')
                self.assertIs(type(resizes[0]['nativeBracket']['entry']), str)
                self.assertIs(type(resizes[0]['nativeBracket']['return']), str)
            self.assertEqual(cleanup['signalsSent'], [])
            start = json.loads((run / 'start.json').read_text())
            (run / 'expected-native.json').write_text(json.dumps({
                'binarySha256': digest, 'captureId': launch['captureId'],
                'childPid': start['childPid'], 'columns': columns, 'rows': rows,
                **({'backend': 'native-shared-slot-v1'} if getattr(self, 'production_broker', False) else {}),
                **({'ioClose': cleanup['ioClose']} if 'ioClose' in cleanup else {}),
                **({'nativeClose': cleanup['nativeClose']} if 'nativeClose' in cleanup else {}),
            }) + '\n')
            packets, offset = [], 0
            saved = (run / 'records.bin').read_bytes()
            while offset < len(saved):
                size = struct.unpack_from('<I', saved, offset)[0]
                offset += 4
                packets.append(saved[offset:offset + size])
                offset += size
            records = journal.decode_records(json.loads((run / 'header.json').read_text()), packets,
                                              json.loads((run / 'registration.json').read_text()), start['childPid'])
            snapshots = [row for row in records if row['kind'] == 11]
            self.assertGreater(len(snapshots), 0, 'Real CLI emitted no immutable frame snapshot')
            self.assertGreater(len([row for row in records if row['kind'] == 10]), 0)
            with self.assertRaisesRegex(journal.JournalError, 'reordered'):
                journal.frame_spans(records)
            spans = journal.frame_spans(records, 'ink-post-write-v1')
            self.assertEqual(len(spans), len(snapshots))
            entries = journal.ink_frame_entries(records, (run / 'raw.bin').read_bytes(),
                                                 launch['captureId'], termios.OPOST | termios.ONLCR)
            self.assertEqual(len(entries), len(snapshots))
            derived = ''.join(json.dumps(entry) + '\n' for entry in entries).encode()
            if getattr(self, 'production_broker', False):
                self.assertEqual((run / 'frames.jsonl').read_bytes(), derived, 'Broker published frames differ from original native records')
            else:
                (run / 'frames.jsonl').write_bytes(derived)
            replay = subprocess.run(['/opt/homebrew/bin/bun', str(SOURCE / 'native-frame-journal-replay.mjs'),
                                     str(run), str(run / 'physical-report.json'), str(run / 'expected-native.json')],
                                    env=env, capture_output=True, timeout=5)
            (run / 'replay.log').write_bytes(replay.stdout + replay.stderr)
            physical = json.loads((run / 'physical-report.json').read_text())
            self.assertEqual(replay.returncode, 0, physical)
            self.assertEqual(physical['verdict'], 'passed')
            self.assertEqual(physical['closure']['verdict'], 'passed')
            self.assertEqual(physical['closure']['buffer'], 'normal')
            self.assertTrue(physical['closure']['cursorVisible'])
            if getattr(self, 'resize_with_native_receipt', False):
                self.assertEqual(len(physical['geometryEvents']), 1)
                self.assertEqual(physical['geometryEvents'][0]['columns'], 110)
                self.assertEqual(physical['geometryEvents'][0]['rows'], 34)
                self.assertTrue(physical['nativeResizeBracketsCovered'])
                proof = physical['nativeGeometryProof']
                self.assertEqual(proof['verdict'], 'passed')
                self.assertEqual((proof['requested'], proof['acknowledged']), (1, 1))
                self.assertEqual([(size['columns'], size['rows']) for size in proof['sizes']], [(110, 34)])
                command('kill-server')
                started = False
                (run / 'expected-native.json').rename(run / 'entry-expected-native.json')
                seal = subprocess.run(['/opt/homebrew/bin/bun', str(SOURCE / 'terminal-capture-driver.mjs'),
                                       'seal', str(run / 'capture-launch.json')], env=env, capture_output=True, timeout=5)
                (run / 'seal.log').write_bytes(seal.stdout + seal.stderr)
                self.assertEqual(seal.returncode, 1)
                sealed = json.loads((run / 'terminal-capture.json').read_text())
                self.assertEqual(sealed['boundedVerdict'], 'passed', sealed)
                self.assertTrue(sealed['nativeResizeBracketsCovered'])
                self.assertEqual(sealed['framePhysicalBoundary'], 'native-frame-end-v1')
                self.assertEqual(sealed['verdict'], 'failed')
                self.assertFalse(sealed['productTimingEquivalent'])
                self.assertFalse(sealed['fullNativeGatePassed'])
                (run / 'bounded-verdict.json').write_text(json.dumps({'verdict': 'passed',
                    'frameCount': len(snapshots), 'nativeResizeBracketsCovered': True,
                    'productTimingEquivalent': False, 'fullNativeGatePassed': False}) + '\n')
                return
            with self.assertRaisesRegex(journal.JournalError, 'identity'):
                journal.ink_frame_entries(records, (run / 'raw.bin').read_bytes(),
                                          'foreign-capture', termios.OPOST | termios.ONLCR)
            with self.assertRaisesRegex(journal.JournalError, 'raw bytes'):
                journal.ink_frame_entries(records, (run / 'raw.bin').read_bytes() + b'foreign',
                                          launch['captureId'], termios.OPOST | termios.ONLCR)
            import base64
            import copy
            tampered = copy.deepcopy(entries)
            first = json.loads(base64.b64decode(tampered[0]['frameBase64']))
            first['cells'][0][2] = 'Z' if first['cells'][0][2] != 'Z' else 'Y'
            tampered[0]['frameBase64'] = base64.b64encode(json.dumps(first).encode()).decode()
            (run / 'tampered-frames.jsonl').write_text(''.join(json.dumps(entry) + '\n' for entry in tampered))
            negative = subprocess.run(['/opt/homebrew/bin/bun', str(SOURCE / 'native-frame-journal-replay.mjs'),
                                        str(run), str(run / 'tampered-report.json'), str(run / 'expected-native.json'), str(run / 'tampered-frames.jsonl')],
                                       env=env, capture_output=True, timeout=5)
            self.assertEqual(negative.returncode, 1)
            self.assertEqual(json.loads((run / 'tampered-report.json').read_text())['verdict'], 'failed')
            self.assertIn('does not match original native ledger', json.loads((run / 'tampered-report.json').read_text())['error'])
            coupled = copy.deepcopy(entries)
            for entry in coupled:
                fake = json.loads(base64.b64decode(entry['frameBase64']))
                fake['cursor'] = {'x': 0, 'y': 0, 'visible': False}
                fake['cells'] = [[x, y, ' ', 1, ''] for y in range(rows) for x in range(columns)]
                entry['frameBase64'] = base64.b64encode(json.dumps(fake).encode()).decode()
                entry['outputBase64'] = base64.b64encode(b'\x1b[?1049h\x1b[0m\x1b[2J\x1b[H\x1b[?25l').decode()
            (run / 'coupled-frames.jsonl').write_text(''.join(json.dumps(entry) + '\n' for entry in coupled))
            coupled_check = subprocess.run(['/opt/homebrew/bin/bun', str(SOURCE / 'native-frame-journal-replay.mjs'),
                                             str(run), str(run / 'coupled-report.json'), str(run / 'expected-native.json'), str(run / 'coupled-frames.jsonl')],
                                            env=env, capture_output=True, timeout=5)
            self.assertEqual(coupled_check.returncode, 1, 'Coupled output/cell rewrite was accepted without native binding')
            self.assertIn('does not match original native ledger', json.loads((run / 'coupled-report.json').read_text())['error'])
            self.assertEqual(hashlib.sha256(binary.read_bytes()).hexdigest(), digest)
            self.assertFalse((run / 'frame-request.fifo').exists())
            self.assertFalse((run / 'frame-response.fifo').exists())
            self.assertFalse((run / 'legacy-frames-must-not-write.jsonl').exists())
            if getattr(self, 'production_broker', False):
                # The real seal must preserve the difference between this
                # bounded entry check and the still-incomplete full gate.
                command('kill-server')
                started = False
                if getattr(self, 'rewrite_final_io', False):
                    self.check_final_io_rewrite_after_native_replay(run, env)
                    return
                if getattr(self, 'rewrite_native_payload', False):
                    self.check_first_seal_native_payload_rewrite(run, env)
                    return
                # Exercise the actual first seal before it can create any
                # expectation. The broker originals remain unchanged.
                import shutil
                import tempfile
                fixture = Path(tempfile.mkdtemp(prefix='first-seal-classification-', dir=run))
                for name in ('launch.json', 'start.json', 'cleanup.json', 'native-initial.json',
                             'registration.json', 'header.json', 'journal.bin', 'records.bin',
                             'raw.bin', 'native-pty.raw', 'pty.raw', 'pty-io.jsonl', 'broker-cleanup.json',
                             'frames.jsonl', 'inputs.jsonl', 'geometry.jsonl', 'observations.jsonl',
                             'initial-termios.txt', 'capture-eof', 'producer-expected-native.json'):
                    if (run / name).exists():
                        shutil.copy2(run / name, fixture / name)
                original_io = (run / 'pty-io.jsonl').read_bytes()
                io = [json.loads(line) for line in original_io.splitlines()]
                removed = next(index for index, row in enumerate(io) if row['kind'] == 'input')
                del io[removed]
                for index, row in enumerate(io, 1):
                    row['ioId'] = index
                shortened = ''.join(json.dumps(row) + '\n' for row in io).encode()
                (fixture / 'pty-io.jsonl').write_bytes(shortened)
                forged = json.loads((run / 'cleanup.json').read_text())
                forged['ioClose'].update(recordCount=len(io), sha256=hashlib.sha256(shortened).hexdigest())
                for name in ('cleanup.json', 'broker-cleanup.json'):
                    (fixture / name).write_text(json.dumps(forged) + '\n')
                descriptor_copy = json.loads((run / 'capture-launch.json').read_text())
                descriptor_copy['run'] = str(fixture)
                (fixture / 'capture-launch.json').write_text(json.dumps(descriptor_copy) + '\n')
                first_seal = subprocess.run(['/opt/homebrew/bin/bun', str(SOURCE / 'terminal-capture-driver.mjs'),
                                             'seal', str(fixture / 'capture-launch.json')],
                                            env=env, capture_output=True, timeout=5)
                (fixture / 'seal.log').write_bytes(first_seal.stdout + first_seal.stderr)
                first_result = json.loads((fixture / 'terminal-capture.json').read_text())
                self.assertEqual(first_seal.returncode, 1)
                self.assertEqual(first_result['boundedVerdict'], 'failed',
                                 'Actual first seal accepted IO/cleanup coupled rewrite before expectation was fixed')
                self.assertIn('Native IO does not match independent close receipt',
                              json.loads((fixture / 'frame-physical-report.json').read_text())['error'])
                producer = (run / 'producer-expected-native.json').read_bytes()
                self.assertEqual((fixture / 'producer-expected-native.json').read_bytes(), producer)
                self.assertEqual(json.loads(producer)['ioClose'], cleanup['ioClose'])
                self.assertEqual((run / 'pty-io.jsonl').read_bytes(), original_io)
                (run / 'expected-native.json').rename(run / 'entry-expected-native.json')
                seal = subprocess.run(['/opt/homebrew/bin/bun', str(SOURCE / 'terminal-capture-driver.mjs'),
                                       'seal', str(run / 'capture-launch.json')], env=env, capture_output=True, timeout=5)
                (run / 'seal.log').write_bytes(seal.stdout + seal.stderr)
                self.assertEqual(seal.returncode, 1)
                sealed = json.loads((run / 'terminal-capture.json').read_text())
                self.assertEqual(sealed['boundedVerdict'], 'passed', sealed)
                self.assertEqual(sealed['verdict'], 'failed')
                self.assertFalse(sealed['productTimingEquivalent'])
                self.assertFalse(sealed['fullNativeGatePassed'])
                if getattr(self, 'require_native_identity', False):
                    bounded = json.loads((run / 'independent-pty-checks.json').read_text())
                    self.assertTrue(bounded['captureIdentityPassed'], 'Valid closed native originals were classified using legacy FIFO identity schema')
                    self.assertEqual(bounded['recheck']['verdict'], 'passed', bounded['recheck'])
                    self.assertFalse(bounded['fullNativeGatePassed'])
                    self.assertFalse(bounded['productTimingEquivalent'])
                    # Exercise identity negatives against the actual held side,
                    # without rewriting any producer original or inventing UI frames.
                    proof = run / 'native-identity-guards.test.mjs'
                    module_url = (SOURCE / 'builtin-terminal-evidence.mjs').as_uri()
                    proof.write_text("import { test, expect } from 'bun:test'\nimport { readFileSync, existsSync } from 'node:fs'\nimport { join } from 'node:path'\nimport { validateNativeTerminalEvidence, validateBuiltinTerminalEvidence } from " + json.dumps(module_url) + ";\nconst side=JSON.parse(readFileSync(" + json.dumps(str(run / 'independent-pty-checks.json')) + ",'utf8')).side;\n" + """
test('actual native identity has no FIFO aliases and remains bounded', () => {
  expect(validateNativeTerminalEvidence(side)).toBe(true)
  expect(validateBuiltinTerminalEvidence(side)).toBe(false)
  expect(existsSync(join(side.run,'native-pty-eof.json'))).toBe(false)
  expect(existsSync(join(side.run,'frame-response.fifo'))).toBe(false)
})
test('native identity rejects edited side identity and required original hashes', () => {
  for (const mutate of [
    value => { value.captureId='foreign' },
    value => { value.binarySha256='b'.repeat(64) },
    value => { value.cleanup.terminalCapture.backend='legacy' },
    value => { delete value.cleanup.terminalCapture.files['records.bin'] },
    value => { value.cleanup.terminalCapture.files['pty-io.jsonl'].sha256='b'.repeat(64) },
    value => { value.cleanup.terminalCapture.files['frames.jsonl'].path='../foreign' },
    value => { value.cleanup.terminalCapture.files['header.json'].bytes+=1 },
    value => { value.cleanup.terminalCapture.frameCount+=1 },
  ]) {
    const changed=structuredClone(side);mutate(changed)
    expect(validateNativeTerminalEvidence(changed)).toBe(false)
  }
})
test('coverage labels cannot upgrade bounded native evidence', () => {
  for (const key of ['productTimingEquivalent','fullNativeGatePassed']) {
    const changed=structuredClone(side);changed.cleanup.terminalCapture[key]=true
    expect(validateNativeTerminalEvidence(changed)).toBe(false)
    expect(validateBuiltinTerminalEvidence(changed)).toBe(false)
  }
})
""")
                    guards = subprocess.run(['/opt/homebrew/bin/bun', 'test', str(proof)], env=env, capture_output=True, timeout=10)
                    (run / 'native-identity-guards.log').write_bytes(guards.stdout + guards.stderr)
                    self.assertEqual(guards.returncode, 0, (guards.stdout + guards.stderr).decode())
                    self.assertIn(b'3 pass', guards.stdout + guards.stderr)
                    self.assertIn(b'0 fail', guards.stdout + guards.stderr)
                if getattr(self, 'require_file_type_guards', False):
                    types = subprocess.run(['python3', str(SOURCE / 'test-native-evidence-file-types.py'),
                        str(run / 'independent-pty-checks.json')], env=env, capture_output=True, timeout=60)
                    (run / 'file-type-guards.log').write_bytes(types.stdout + types.stderr)
                    self.assertEqual(types.returncode, 0, (types.stdout + types.stderr).decode())
                    self.assertIn(b'Ran 8 tests', types.stdout + types.stderr)
                # These mutated copies are adversarial classifier fixtures,
                # never substitute raw/native originals from the actual run.
                import shutil
                import tempfile
                verifier = load('geometry_verifier', 'verify-native-frame-journal.py')
                with tempfile.TemporaryDirectory(prefix='geometry-classification-', dir=run) as directory:
                    fixture = Path(directory)
                    for name in ('launch.json', 'start.json', 'cleanup.json', 'native-initial.json',
                                 'registration.json', 'header.json', 'journal.bin', 'records.bin',
                                 'raw.bin', 'native-pty.raw', 'pty.raw', 'pty-io.jsonl', 'broker-cleanup.json'):
                        shutil.copy2(run / name, fixture / name)
                    expected = json.loads((run / 'entry-expected-native.json').read_text())
                    original_io = (fixture / 'pty-io.jsonl').read_bytes()
                    self.assertGreater(len(verifier.derive_frames(fixture, expected)['entries']), 0)
                    io = [json.loads(line) for line in original_io.splitlines()]
                    first = io[0]
                    self.assertEqual(first['kind'], 'initial-geometry')
                    final = io[-1]
                    for geometry_id, width, height in ((1, 110, 34), (2, columns, rows)):
                        io.append({**final, 'ioId': final['ioId'] + geometry_id,
                            'kind': 'resize-ack', 'geometryId': geometry_id,
                            'columns': width, 'rows': height, 'succeeded': True})
                    (fixture / 'pty-io.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in io))
                    with self.assertRaisesRegex(verifier.journal.JournalError, 'Fixed-geometry replay cannot accept resize'):
                        verifier.derive_frames(fixture, expected)
                    (fixture / 'pty-io.jsonl').write_bytes(original_io)
                    io = [json.loads(line) for line in original_io.splitlines()]
                    io[0]['columns'] += 1
                    (fixture / 'pty-io.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in io))
                    with self.assertRaisesRegex(verifier.journal.JournalError, 'Native IO initial geometry differs'):
                        verifier.derive_frames(fixture, expected)
                    io = [json.loads(line) for line in original_io.splitlines()]
                    (fixture / 'pty-io.jsonl').write_text(json.dumps(io[0]) + '\n')
                    with self.assertRaisesRegex(verifier.journal.JournalError, 'Native IO does not match independent close receipt'):
                        verifier.derive_frames(fixture, expected)
                    (fixture / 'pty-io.jsonl').write_bytes(original_io)
                    original_cleanup = (fixture / 'cleanup.json').read_bytes()
                    original_closed = (fixture / 'broker-cleanup.json').read_bytes()
                    io = [json.loads(line) for line in original_io.splitlines()]
                    removed = next(index for index, row in enumerate(io) if row['kind'] == 'output')
                    del io[removed]
                    for index, row in enumerate(io, 1):
                        row['ioId'] = index
                    shortened = ''.join(json.dumps(row) + '\n' for row in io).encode()
                    (fixture / 'pty-io.jsonl').write_bytes(shortened)
                    forged = json.loads(original_cleanup)
                    forged['ioClose'].update(recordCount=len(io), sha256=hashlib.sha256(shortened).hexdigest())
                    (fixture / 'cleanup.json').write_text(json.dumps(forged))
                    with self.assertRaisesRegex(verifier.journal.JournalError, 'Native IO does not match independent close receipt'):
                        verifier.derive_frames(fixture, expected)
                    (fixture / 'broker-cleanup.json').write_text(json.dumps(forged))
                    with self.assertRaisesRegex(verifier.journal.JournalError, 'Native IO does not match independent close receipt'):
                        verifier.derive_frames(fixture, expected)
                    (fixture / 'cleanup.json').write_bytes(original_cleanup)
                    (fixture / 'broker-cleanup.json').write_bytes(original_closed)
                    # Synthetic close digests below exercise the coverage
                    # classifier; they are never used as native run evidence.
                    io = [json.loads(line) for line in original_io.splitlines()]
                    output = next(row for row in io if row['kind'] == 'output')
                    output['start'] += 1
                    malformed = ''.join(json.dumps(row) + '\n' for row in io).encode()
                    (fixture / 'pty-io.jsonl').write_bytes(malformed)
                    artificial = copy.deepcopy(expected)
                    artificial['ioClose']['sha256'] = hashlib.sha256(malformed).hexdigest()
                    with self.assertRaisesRegex(verifier.journal.JournalError, 'Native IO output coverage is incomplete'):
                        verifier.verify_fixed_geometry_io(fixture, artificial)
                    io = [json.loads(line) for line in original_io.splitlines()]
                    input_row = next(row for row in io if row['kind'] == 'input')
                    input_row['rawOffset'] += 1
                    malformed = ''.join(json.dumps(row) + '\n' for row in io).encode()
                    (fixture / 'pty-io.jsonl').write_bytes(malformed)
                    artificial['ioClose']['sha256'] = hashlib.sha256(malformed).hexdigest()
                    with self.assertRaisesRegex(verifier.journal.JournalError, 'Native IO raw offset moved without output'):
                        verifier.verify_fixed_geometry_io(fixture, artificial)
                    (fixture / 'pty-io.jsonl').unlink()
                    with self.assertRaisesRegex(verifier.journal.JournalError, 'Native IO geometry receipt is missing'):
                        verifier.derive_frames(fixture, expected)
                    self.assertEqual((run / 'pty-io.jsonl').read_bytes(), original_io)
            if getattr(self, 'require_live_prefix', False):
                self.assertTrue(live_observation['passed'], 'Actual native CLI was ready, but no independent frame/IO prefix was available before exit')
                final_frames = [json.loads(line) for line in (run / 'frames.jsonl').read_bytes().splitlines()]
                final_io = [json.loads(line) for line in (run / 'pty-io.jsonl').read_bytes().splitlines()]
                self.assertEqual(final_frames[:live_observation['frameCount']], live_observation['framePrefix'])
                self.assertEqual(final_io[:live_observation['ioCount']], live_observation['ioPrefix'])

            if getattr(self, 'require_native_exit', False):
                driver = load('native_exit_guard', SOURCE.parent / '.claude/skills/release-validation/scripts/run-binary-gate.py')
                passed = driver.terminal_native_exit_passed(run, descriptor['capture'], digest)
                self.assertTrue(passed, 'Actual normal native EOF/reap was rejected by the legacy EOF alias predicate')

            (run / 'bounded-verdict.json').write_text(json.dumps({'verdict': 'passed', 'frameCount': len(snapshots),
                'noFrameFifoAck': True, 'productTimingEquivalent': False, 'fullNativeGatePassed': False}) + '\n')
        finally:
            errors = []
            stopped = not started
            if started:
                try:
                    command('kill-server')
                    stopped = True
                except Exception as error:
                    errors.append(str(error))
            if stopped:
                try:
                    socket.unlink(missing_ok=True)
                except Exception as error:
                    errors.append(str(error))
            (run / 'tmux-calls.json').write_text(json.dumps(calls, indent=2) + '\n')
            (run / 'tmux-cleanup.json').write_text(json.dumps({'errors': errors, 'socketRemoved': not socket.exists()}) + '\n')
            if errors:
                raise RuntimeError('Owned tmux cleanup failed: ' + str(errors))

    def check_first_seal_native_payload_rewrite(self, run, env):
        import base64
        import shutil
        import tempfile
        names = ('launch.json', 'start.json', 'cleanup.json', 'native-initial.json',
                 'registration.json', 'header.json', 'journal.bin', 'records.bin',
                 'raw.bin', 'native-pty.raw', 'pty.raw', 'pty-io.jsonl', 'broker-cleanup.json',
                 'frames.jsonl', 'inputs.jsonl', 'geometry.jsonl', 'observations.jsonl',
                 'initial-termios.txt', 'capture-eof', 'producer-expected-native.json')
        original = {name: hashlib.sha256((run / name).read_bytes()).hexdigest()
                    for name in names if (run / name).exists()}
        fixture = Path(tempfile.mkdtemp(prefix='native-payload-first-seal-', dir=run))
        for name in original:
            shutil.copy2(run / name, fixture / name)
        old, new = b'EsonClaw', b'DsonClaw'
        self.assertIn(old, (run / 'raw.bin').read_bytes())
        for name in ('raw.bin', 'native-pty.raw', 'pty.raw'):
            data = (fixture / name).read_bytes()
            self.assertIn(old, data)
            (fixture / name).write_bytes(data.replace(old, new))
        saved = (run / 'records.bin').read_bytes()
        packets, offset, write_changes, snapshot_changes = [], 0, 0, 0
        while offset < len(saved):
            size = struct.unpack_from('<I', saved, offset)[0]
            offset += 4
            packet = saved[offset:offset + size]
            offset += size
            word = journal.RECORD.unpack_from(packet)
            body = packet[journal.RECORD.size:]
            if word[2] == 1:
                write_changes += body.count(old)
                body = body.replace(old, new)
            elif word[2] == 11:
                value = json.loads(body)
                frame_bytes = base64.b64decode(value['frameBase64'], validate=True)
                cells = json.loads(frame_bytes)['cells']
                changes = []
                for index, cell in enumerate(cells):
                    title = cells[index:index + len(old)]
                    if ''.join(item[2] for item in title) == old.decode() and all(
                            item[0] == cell[0] + step and item[1] == cell[1]
                            for step, item in enumerate(title)):
                        changes.append(cell)
                for x, y, _, *_ in changes:
                    pattern = ('[' + str(x) + ',' + str(y) + ',"E",').encode()
                    replacement = ('[' + str(x) + ',' + str(y) + ',"D",').encode()
                    self.assertEqual(frame_bytes.count(pattern), 1)
                    frame_bytes = frame_bytes.replace(pattern, replacement)
                snapshot_changes += len(changes)
                replacement = base64.b64encode(frame_bytes)
                self.assertEqual(len(replacement), len(value['frameBase64']))
                body = body.replace(value['frameBase64'].encode(), replacement)
            self.assertEqual(len(body), size - journal.RECORD.size)
            packets.append(packet[:journal.RECORD.size] + body)
        self.assertGreater(write_changes, 0)
        self.assertGreater(snapshot_changes, 0)
        forged = b''.join(struct.pack('<I', len(packet)) + packet for packet in packets)
        self.assertEqual(len(forged), len(saved))
        (fixture / 'records.bin').write_bytes(forged)
        start = json.loads((fixture / 'start.json').read_text())
        records = journal.decode_records(json.loads((fixture / 'header.json').read_text()), packets,
                                         json.loads((fixture / 'registration.json').read_text()), start['childPid'])
        producer = json.loads((fixture / 'producer-expected-native.json').read_text())
        entries = journal.ink_frame_entries(records, (fixture / 'raw.bin').read_bytes(),
                                             producer['captureId'], json.loads((fixture / 'native-initial.json').read_text())['outputFlags'])
        (fixture / 'frames.jsonl').write_text(''.join(json.dumps(entry) + '\n' for entry in entries))
        descriptor = json.loads((run / 'capture-launch.json').read_text())
        descriptor['run'] = str(fixture)
        (fixture / 'capture-launch.json').write_text(json.dumps(descriptor) + '\n')
        changed = {'raw.bin', 'native-pty.raw', 'pty.raw', 'records.bin', 'frames.jsonl'}
        fixed = {name: digest for name, digest in original.items() if name not in changed}
        self.assertEqual({name: hashlib.sha256((fixture / name).read_bytes()).hexdigest() for name in fixed}, fixed)
        self.assertFalse((fixture / 'expected-native.json').exists())
        seal = subprocess.run(['/opt/homebrew/bin/bun', str(SOURCE / 'terminal-capture-driver.mjs'),
                               'seal', str(fixture / 'capture-launch.json')],
                              env=env, capture_output=True, timeout=5)
        (fixture / 'seal.log').write_bytes(seal.stdout + seal.stderr)
        report = json.loads((fixture / 'terminal-capture.json').read_text())
        (fixture / 'classification-proof.json').write_text(json.dumps({
            'originalRun': str(run), 'fixedSHA256': fixed, 'changed': sorted(changed),
            'writeChanges': write_changes, 'snapshotChanges': snapshot_changes,
            'sameRawLength': len((fixture / 'raw.bin').read_bytes()) == len((run / 'raw.bin').read_bytes()),
            'sourceOriginalsUnchanged': all(hashlib.sha256((run / name).read_bytes()).hexdigest() == digest
                                             for name, digest in original.items()),
            'firstSealExitCode': seal.returncode, 'boundedVerdict': report['boundedVerdict'],
            'scope': 'adversarial fixture classification; never actual bad product frame'}, indent=2) + '\n')
        self.assertEqual({name: hashlib.sha256((run / name).read_bytes()).hexdigest() for name in original}, original)
        self.assertEqual(seal.returncode, 1)
        self.assertEqual(report['boundedVerdict'], 'failed',
                         'First seal accepted an equal-length raw/write/snapshot coupled rewrite')
        self.assertIn('Native content does not match independent close receipt',
                      json.loads((fixture / 'frame-physical-report.json').read_text())['error'])

        # Decode exactly the checked bytes, even if files disappear after
        # the content check. This copy is never substituted for the real run.
        from unittest.mock import patch
        verifier = load('closed_content_verifier', 'verify-native-frame-journal.py')
        control = Path(tempfile.mkdtemp(prefix='native-content-read-once-', dir=run))
        for name in original:
            shutil.copy2(run / name, control / name)
        real_check = verifier.verify_native_content
        def remove_after_check(*args):
            checked = real_check(*args)
            for name in ('raw.bin', 'records.bin', 'native-initial.json', 'registration.json', 'header.json'):
                (control / name).unlink()
            return checked
        with patch.object(verifier, 'verify_native_content', remove_after_check):
            checked = verifier.derive_frames(control, producer)
        self.assertEqual(checked['entries'], [json.loads(line) for line in (run / 'frames.jsonl').read_text().splitlines()])
        self.assertEqual({name: hashlib.sha256((run / name).read_bytes()).hexdigest() for name in original}, original)

    def check_final_io_rewrite_after_native_replay(self, run, env):
        import shutil
        import tempfile
        fixture = Path(tempfile.mkdtemp(prefix='final-io-first-seal-', dir=run))
        names = ('launch.json', 'start.json', 'cleanup.json', 'native-initial.json',
                 'registration.json', 'header.json', 'journal.bin', 'records.bin',
                 'raw.bin', 'native-pty.raw', 'pty.raw', 'pty-io.jsonl', 'broker-cleanup.json',
                 'frames.jsonl', 'inputs.jsonl', 'geometry.jsonl', 'observations.jsonl',
                 'initial-termios.txt', 'capture-eof', 'producer-expected-native.json')
        original = {name: hashlib.sha256((run / name).read_bytes()).hexdigest()
                    for name in names if (run / name).exists()}
        for name in original:
            shutil.copy2(run / name, fixture / name)
        descriptor = json.loads((run / 'capture-launch.json').read_text())
        descriptor['run'] = str(fixture)
        (fixture / 'capture-launch.json').write_text(json.dumps(descriptor) + '\n')
        script = fixture / 'final-io-fault.test.mjs'
        script.write_text("""import { test, expect, mock } from 'bun:test'
import * as child from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
const run = FIXTURE_PATH
const realExec = child.execFileSync
let injected = 0
mock.module('node:child_process', () => ({ ...child, execFileSync(file, args, ...options) {
  const result = realExec(file, args, ...options)
  if (args[0]?.endsWith('/native-frame-journal-replay.mjs')) {
    const physical = JSON.parse(readFileSync(run + '/frame-physical-report.json', 'utf8'))
    if (physical.verdict !== 'passed') throw Error('Fault did not reach actual successful independent replay')
    const io = readFileSync(run + '/pty-io.jsonl', 'utf8').trimEnd().split('\\n').map(JSON.parse)
    const input = io.findIndex(row => row.kind === 'input')
    if (input < 0) throw Error('Fault fixture has no actual input')
    io.splice(input, 1)
    io.forEach((row, index) => { row.ioId = index + 1 })
    writeFileSync(run + '/pty-io.jsonl', io.map(JSON.stringify).join('\\n') + '\\n')
    injected++
  }
  return result
}}))
test('first seal rejects final IO replacement after actual independent replay', async () => {
  const { sealBuiltinCapture } = await import(SOURCE_PATH)
  const launch = JSON.parse(readFileSync(run + '/capture-launch.json', 'utf8'))
  const result = await sealBuiltinCapture(launch)
  writeFileSync(run + '/final-io-fault-proof.json', JSON.stringify({ injected, boundedVerdict: result.boundedVerdict,
    physicalVerdict: result.framePhysicalVerdict, nativeContentMatched: result.nativeContentMatched, nativeIOMatched: result.nativeIOMatched,
    finalIO: result.files['pty-io.jsonl'], expectedIO: JSON.parse(readFileSync(run + '/producer-expected-native.json', 'utf8')).ioClose }) + '\\n')
  expect(injected).toBe(1)
  expect(result.framePhysicalVerdict).toBe('passed')
  expect(result.nativeContentMatched).toBe(true)
  expect(result.boundedVerdict).toBe('failed')
  expect(result.nativeIOMatched).toBe(false)
})
""".replace('FIXTURE_PATH', json.dumps(str(fixture)))
             .replace('SOURCE_PATH', json.dumps(str(SOURCE / 'builtin-terminal-evidence.mjs'))))
        self.assertFalse((fixture / 'expected-native.json').exists())
        result = subprocess.run(['/opt/homebrew/bin/bun', 'test', '--no-env-file', str(script)],
                                env=env, capture_output=True, timeout=8)
        (fixture / 'fault.log').write_bytes(result.stdout + result.stderr)
        proof = json.loads((fixture / 'final-io-fault-proof.json').read_text())
        self.assertEqual(proof['injected'], 1)
        self.assertEqual(proof['physicalVerdict'], 'passed')
        self.assertNotEqual(proof['finalIO']['sha256'], proof['expectedIO']['sha256'])
        fixed = {name: digest for name, digest in original.items() if name != 'pty-io.jsonl'}
        self.assertEqual({name: hashlib.sha256((fixture / name).read_bytes()).hexdigest() for name in fixed}, fixed)
        self.assertEqual({name: hashlib.sha256((run / name).read_bytes()).hexdigest() for name in original}, original)
        self.assertEqual(proof['boundedVerdict'], 'failed', 'Final seal accepted IO replacement after successful replay')
        self.assertEqual(result.returncode, 0, result.stdout.decode() + result.stderr.decode())

    def test_actual_first_seal_rejects_io_rewrite_after_independent_replay(self):
        self.production_broker = self.rewrite_final_io = True
        try:
            self.test_actual_cli_emits_immutable_frame_journal_without_fifo_ack()
        finally:
            self.production_broker = self.rewrite_final_io = False

    def test_actual_first_seal_rejects_equal_length_native_payload_rewrite(self):
        self.production_broker = self.rewrite_native_payload = True
        try:
            self.test_actual_cli_emits_immutable_frame_journal_without_fifo_ack()
        finally:
            self.production_broker = self.rewrite_native_payload = False

    def test_actual_default_broker_emits_native_journal_without_ack(self):
        self.production_broker = True
        try:
            self.test_actual_cli_emits_immutable_frame_journal_without_fifo_ack()
        finally:
            self.production_broker = False

    def test_actual_default_broker_exposes_live_prefix_bound_to_final_originals(self):
        self.production_broker = self.require_live_prefix = True
        try:
            self.test_actual_cli_emits_immutable_frame_journal_without_fifo_ack()
        finally:
            self.production_broker = self.require_live_prefix = False

    def test_actual_default_broker_classifies_bounded_native_identity_without_legacy_aliases(self):
        self.production_broker = self.require_native_identity = True
        try:
            self.test_actual_cli_emits_immutable_frame_journal_without_fifo_ack()
        finally:
            self.production_broker = self.require_native_identity = False

    def test_actual_closed_native_files_reject_fifo_without_blocking(self):
        self.production_broker = self.require_native_identity = self.require_file_type_guards = True
        try:
            self.test_actual_cli_emits_immutable_frame_journal_without_fifo_ack()
        finally:
            self.production_broker = self.require_native_identity = self.require_file_type_guards = False

    def test_actual_default_broker_normal_exit_uses_native_close_receipts(self):
        self.production_broker = self.require_native_exit = True
        try:
            self.test_actual_cli_emits_immutable_frame_journal_without_fifo_ack()
        finally:
            self.production_broker = self.require_native_exit = False

    def test_actual_default_broker_expectation_publication_failure_is_not_normal(self):
        self.production_broker = self.fail_expectation_publication = True
        try:
            self.test_actual_cli_emits_immutable_frame_journal_without_fifo_ack()
        finally:
            self.production_broker = self.fail_expectation_publication = False

    def test_actual_default_broker_native_resize_uses_real_clock_and_replay(self):
        self.production_broker = self.resize_with_native_receipt = True
        try:
            self.test_actual_cli_emits_immutable_frame_journal_without_fifo_ack()
        finally:
            self.production_broker = self.resize_with_native_receipt = False

    def test_owned_tmux_startup_timeout_still_stops_actual_server(self):
        from unittest.mock import patch
        real_run = subprocess.run
        server = None
        def after_actual_start(argv, **kwargs):
            nonlocal server
            result = real_run(argv, **kwargs)
            if 'new-session' in argv:
                self.assertEqual(result.returncode, 0)
                socket = self.last_cli_run / 'tmux.sock'
                pid = real_run(['/opt/homebrew/bin/tmux', '-S', str(socket), 'display-message', '-p', '#{pid}'],
                               env=kwargs['env'], capture_output=True, timeout=5)
                self.assertEqual(pid.returncode, 0)
                server = int(pid.stdout)
                if getattr(self, 'production_broker', False):
                    installed = real_run(['/opt/homebrew/bin/bun', str(SOURCE / 'terminal-capture-driver.mjs'),
                                          'install', str(self.last_cli_run / 'capture-launch.json')],
                                         env=kwargs['env'], capture_output=True, timeout=5)
                    self.assertEqual(installed.returncode, 0, installed.stderr.decode())
                deadline = time.monotonic() + 3
                while not (self.last_cli_run / 'start.json').exists():
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Fault fixture did not record its actual child')
                raise subprocess.TimeoutExpired(argv, 5)
            return result
        def alive(pid):
            try:
                os.kill(pid, 0)
                return True
            except ProcessLookupError:
                return False
        rescued = []
        try:
            with patch.object(subprocess, 'run', after_actual_start):
                with self.assertRaises(subprocess.TimeoutExpired):
                    self.test_actual_cli_emits_immutable_frame_journal_without_fifo_ack()
            deadline = time.monotonic() + 1
            while server and alive(server) and time.monotonic() < deadline:
                pass
            self.assertIsNotNone(server)
            self.assertFalse(alive(server), 'Owned actual server survived client startup timeout')
        finally:
            if server and alive(server):
                os.kill(server, signal.SIGTERM)
                rescued.append({'pid': server, 'signal': 'SIGTERM'})
            if hasattr(self, 'last_cli_run'):
                run = self.last_cli_run
                deadline = time.monotonic() + 3
                while (run / 'start.json').exists() and not (run / 'cleanup.json').exists():
                    if time.monotonic() >= deadline:
                        child = json.loads((run / 'start.json').read_text())['childPid']
                        try:
                            os.killpg(child, signal.SIGKILL)
                            rescued.append({'pgid': child, 'signal': 'SIGKILL'})
                        except ProcessLookupError:
                            pass
                        break
                (run / 'startup-fault-rescue.json').write_text(json.dumps({'serverPid': server, 'signalsSent': rescued}) + '\n')
                if not rescued:
                    cleanup = json.loads((run / 'cleanup.json').read_text())
                    self.assertTrue(cleanup['childReaped'])
                    self.assertFalse(cleanup['normalCompletion'])
                    self.assertEqual(cleanup['cleanupErrors'], [])
                    self.assertFalse(alive(cleanup['childPid']))

    def test_owned_default_broker_startup_timeout_retains_failure(self):
        self.production_broker = True
        try:
            self.test_owned_tmux_startup_timeout_still_stops_actual_server()
        finally:
            self.production_broker = False


if __name__ == '__main__':
    if sys.argv[1:2] == ['--capture-cli']:
        raise SystemExit(capture_cli(Path(sys.argv[2]).resolve(strict=True)))
    unittest.main()

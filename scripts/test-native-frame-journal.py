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
        def command(*args):
            receipt = {'argv': list(args)}
            calls.append(receipt)
            try:
                result = subprocess.run([*tmux, *args], env=env, capture_output=True, timeout=5)
                receipt['exitCode'] = result.returncode
            except Exception as error:
                receipt['error'] = {'type': type(error).__name__, 'message': str(error)}
                raise
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
            self.assertEqual(cleanup['signalsSent'], [])
            start = json.loads((run / 'start.json').read_text())
            (run / 'expected-native.json').write_text(json.dumps({
                'binarySha256': digest, 'captureId': launch['captureId'],
                'childPid': start['childPid'], 'columns': columns, 'rows': rows,
                **({'backend': 'native-shared-slot-v1'} if getattr(self, 'production_broker', False) else {}),
                **({'ioClose': cleanup['ioClose']} if 'ioClose' in cleanup else {}),
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
            (run / 'frames.jsonl').write_text(''.join(json.dumps(entry) + '\n' for entry in entries))
            replay = subprocess.run(['/opt/homebrew/bin/bun', str(SOURCE / 'native-frame-journal-replay.mjs'),
                                     str(run), str(run / 'physical-report.json'), str(run / 'expected-native.json')],
                                    env=env, capture_output=True, timeout=5)
            (run / 'replay.log').write_bytes(replay.stdout + replay.stderr)
            physical = json.loads((run / 'physical-report.json').read_text())
            self.assertEqual(replay.returncode, 0, physical['frames'])
            self.assertEqual(physical['verdict'], 'passed')
            self.assertEqual(physical['closure']['verdict'], 'passed')
            self.assertEqual(physical['closure']['buffer'], 'normal')
            self.assertTrue(physical['closure']['cursorVisible'])
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
                # These mutated copies are adversarial classifier fixtures,
                # never substitute raw/native originals from the actual run.
                import shutil
                import tempfile
                verifier = load('geometry_verifier', 'verify-native-frame-journal.py')
                with tempfile.TemporaryDirectory(prefix='geometry-classification-', dir=run) as directory:
                    fixture = Path(directory)
                    for name in ('launch.json', 'start.json', 'cleanup.json', 'native-initial.json',
                                 'registration.json', 'header.json', 'journal.bin', 'records.bin',
                                 'raw.bin', 'pty-io.jsonl', 'broker-cleanup.json'):
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

    def test_actual_default_broker_emits_native_journal_without_ack(self):
        self.production_broker = True
        try:
            self.test_actual_cli_emits_immutable_frame_journal_without_fifo_ack()
        finally:
            self.production_broker = False

    def test_actual_default_broker_expectation_publication_failure_is_not_normal(self):
        self.production_broker = self.fail_expectation_publication = True
        try:
            self.test_actual_cli_emits_immutable_frame_journal_without_fifo_ack()
        finally:
            self.production_broker = self.fail_expectation_publication = False

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

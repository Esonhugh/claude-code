"""Adversarial file types over clones of one real closed native run; never UI proof."""
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parent
ORIGINAL = Path(sys.argv.pop(1)).resolve(strict=True)


class NativeFileTypeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.side = json.loads(ORIGINAL.read_text())['side']
        cls.originals = {Path(info['path']): hashlib.sha256(Path(info['path']).read_bytes()).hexdigest()
                         for info in cls.side['cleanup']['terminalCapture']['files'].values()}
        binary = Path(cls.side['run']) / 'bin/claude'
        cls.originals[binary] = hashlib.sha256(binary.read_bytes()).hexdigest()
        cls.receipts = []

    @classmethod
    def tearDownClass(cls):
        assert all(hashlib.sha256(path.read_bytes()).hexdigest() == digest
                   for path, digest in cls.originals.items()), 'Original native capture changed'
        destination = Path(os.environ.get('NATIVE_FILE_TYPE_RECEIPTS', str(ORIGINAL.parent / 'file-type-guard-receipts.json')))
        with destination.open('x') as receipt_file:
            receipt_file.write(json.dumps({
            'scope': 'adversarial clones only; no UI, timing or full acceptance claim',
            'originalsUnchanged': True, 'receipts': cls.receipts,
            }, indent=2) + '\n')

    def fixture(self, run):
        side = copy.deepcopy(self.side)
        side['run'] = str(run)
        for name, info in side['cleanup']['terminalCapture']['files'].items():
            shutil.copy2(info['path'], run / name)
            info['path'] = str(run / name)
        (run / 'bin').mkdir()
        shutil.copy2(Path(self.side['run']) / 'bin/claude', run / 'bin/claude')
        launch = json.loads((run / 'launch.json').read_text())
        launch['command'][0] = str(run / 'bin/claude')
        (run / 'launch.json').write_text(json.dumps(launch) + '\n')
        data = (run / 'launch.json').read_bytes()
        side['cleanup']['terminalCapture']['files']['launch.json'].update(
            bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        (run / 'side.json').write_text(json.dumps(side))
        return side

    def child(self, command, run, expected):
        process = subprocess.Popen(command, cwd=SOURCE.parent, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True)
        receipt = {'command': command, 'pid': process.pid, 'pgid': process.pid,
                   'scope': 'adversarial fixture', 'signalsSent': []}
        try:
            stdout, stderr = process.communicate(timeout=2)
            receipt.update(exitCode=process.returncode, timedOut=False)
        except subprocess.TimeoutExpired:
            receipt['timedOut'] = True
            os.killpg(process.pid, signal.SIGKILL)
            receipt['signalsSent'].append('SIGKILL')
            stdout, stderr = process.communicate(timeout=2)
        finally:
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                receipt['ownedGroupGone'] = True
            except PermissionError as error:
                receipt['ownedGroupGone'] = None
                receipt['groupProbeError'] = str(error)
            else:
                os.killpg(process.pid, signal.SIGKILL)
                receipt['signalsSent'].append('SIGKILL-descendants')
                receipt['ownedGroupGone'] = False
            self.receipts.append(receipt)
            (run / 'guard.log').write_bytes(stdout + stderr)
        self.assertFalse(receipt['timedOut'], 'Nonregular native original blocked the validator')
        self.assertTrue(receipt['ownedGroupGone'], 'Owned guard subprocess survived')
        self.assertEqual(process.returncode, expected, json.dumps({
            'exitCode': process.returncode, 'expected': expected, 'stdoutBytes': len(stdout),
            'stdoutSHA256': hashlib.sha256(stdout).hexdigest(), 'stderrTail': stderr[-1024:].decode(errors='replace'),
        }))

    def validate(self, run, expected, legacy=False):
        validator = "validateBuiltinTerminalEvidence" if legacy else "validateNativeTerminalEvidence"
        code = "import {readFileSync} from 'node:fs';import {" + validator + "} from " + json.dumps((SOURCE / 'builtin-terminal-evidence.mjs').as_uri()) + ";const side=JSON.parse(readFileSync(process.argv[1],'utf8'));process.exitCode=" + validator + "(side)?0:1;"
        self.child(['/opt/homebrew/bin/bun', '--no-env-file', '-e', code, str(run / 'side.json')], run, expected)

    def test_regular_cloned_originals_pass_only_the_bounded_identity_guard(self):
        with tempfile.TemporaryDirectory(prefix='native-type-positive-') as directory:
            run = Path(directory).resolve(); self.fixture(run)
            self.validate(run, 0)

    def test_native_identity_rejects_fifo_before_opening_evidence_or_binary(self):
        for name in ('pty.raw', 'bin/claude'):
            with self.subTest(name=name), tempfile.TemporaryDirectory(prefix='native-type-fifo-') as directory:
                run = Path(directory).resolve(); self.fixture(run)
                (run / name).unlink(); os.mkfifo(run / name, 0o600)
                self.validate(run, 1)

    def test_independent_replay_rejects_fifo_without_blocking(self):
        for name in ('expected-native.json', 'frames.jsonl', 'raw.bin', 'journal.bin', 'bin/claude'):
            with self.subTest(name=name), tempfile.TemporaryDirectory(prefix='native-replay-fifo-') as directory:
                run = Path(directory).resolve(); self.fixture(run)
                (run / name).unlink(); os.mkfifo(run / name, 0o600)
                self.child(['/opt/homebrew/bin/bun', str(SOURCE / 'native-frame-journal-replay.mjs'),
                            str(run), str(run / 'type-report.json'), str(run / 'expected-native.json')], run, 1)

    def test_paste_intent_reads_only_regular_owned_input_file(self):
        with tempfile.TemporaryDirectory(prefix='paste-type-fifo-') as directory:
            run = Path(directory).resolve(); self.fixture(run)
            file = run / 'input.bin'; data = '中文\r'.encode(); file.write_bytes(data)
            target = 'owned:0.0'
            send = {'phase': 'send', 'actionId': 1, 'transport': 'tmux-paste-buffer',
                    'target': target, 'buffer': 'owned', 'inputFile': str(file), 'hex': data.hex(),
                    'bytesSHA256': hashlib.sha256(data).hexdigest(), 'actualCommands': [
                    ['load-buffer', '-b', 'owned', str(file)], ['paste-buffer', '-b', 'owned', '-t', target]]}
            value = {'root': str(run), 'target': target,
                     'inputs': [send, {'phase': 'sent', 'actionId': 1, 'exitCodes': [0, 0]}],
                     'io': [{'kind': 'input', 'hex': data.hex()}]}
            (run / 'intent.json').write_text(json.dumps(value))
            code = "import {readFileSync} from 'node:fs';import {validateCaptureInputs} from " + json.dumps((SOURCE / 'builtin-terminal-evidence.mjs').as_uri()) + ";const v=JSON.parse(readFileSync(process.argv[1],'utf8'));process.exitCode=validateCaptureInputs(v.root,v.target,v.inputs,v.io)?0:1;"
            command = ['/opt/homebrew/bin/bun', '--no-env-file', '-e', code, str(run / 'intent.json')]
            self.child(command, run, 0)
            file.unlink(); os.mkfifo(file, 0o600)
            self.child(command, run, 1)

    def test_legacy_identity_rejects_fifo_without_blocking(self):
        with tempfile.TemporaryDirectory(prefix='legacy-type-fifo-') as directory:
            run = Path(directory).resolve(); self.fixture(run)
            (run / 'pty.raw').unlink(); os.mkfifo(run / 'pty.raw', 0o600)
            self.validate(run, 1, legacy=True)

    def test_legacy_seal_rejects_fifo_without_blocking(self):
        with tempfile.TemporaryDirectory(prefix='legacy-seal-fifo-') as directory:
            run = Path(directory).resolve(); self.fixture(run)
            descriptor = json.loads((ORIGINAL.parent / 'capture-launch.json').read_text())
            descriptor['run'] = str(run); descriptor['capture']['nativeJournal'] = False
            (run / 'capture-launch.json').write_text(json.dumps(descriptor))
            (run / 'pty.raw').unlink(); os.mkfifo(run / 'pty.raw', 0o600)
            code = "import {readFileSync} from 'node:fs';import {sealBuiltinCapture} from " + json.dumps((SOURCE / 'builtin-terminal-evidence.mjs').as_uri()) + ";const result=await sealBuiltinCapture(JSON.parse(readFileSync(process.argv[1],'utf8')));process.exitCode=result.verdict==='failed'?1:0;"
            self.child(['/opt/homebrew/bin/bun', '--no-env-file', '-e', code,
                        str(run / 'capture-launch.json')], run, 1)

    def test_python_replay_rejects_a_type_changed_broker_copy(self):
        for field in ('childPid', 'childExitCode', 'normalCompletion'):
            with self.subTest(field=field), tempfile.TemporaryDirectory(prefix='native-broker-types-') as directory:
                run = Path(directory).resolve(); self.fixture(run)
                value = json.loads((run / 'broker-cleanup.json').read_text())
                value[field] = float(value[field]) if field == 'childPid' else (False if field == 'childExitCode' else 1)
                (run / 'broker-cleanup.json').write_text(json.dumps(value))
                self.child(['python3', str(SOURCE / 'verify-native-frame-journal.py'),
                            str(run), str(run / 'expected-native.json')], run, 1)

    def test_native_first_seal_rejects_fifo_without_blocking(self):
        for name in ('start.json', 'producer-expected-native.json', 'pty.raw'):
            with self.subTest(name=name), tempfile.TemporaryDirectory(prefix='native-seal-fifo-') as directory:
                run = Path(directory).resolve(); self.fixture(run)
                descriptor = json.loads((ORIGINAL.parent / 'capture-launch.json').read_text())
                descriptor['run'] = str(run)
                (run / 'capture-launch.json').write_text(json.dumps(descriptor))
                for generated in ('expected-native.json', 'frame-stream-map.json', 'frame-physical-report.json'):
                    (run / generated).unlink(missing_ok=True)
                (run / name).unlink(); os.mkfifo(run / name, 0o600)
                code = "import {readFileSync} from 'node:fs';import {sealBuiltinCapture} from " + json.dumps((SOURCE / 'builtin-terminal-evidence.mjs').as_uri()) + ";const launch=JSON.parse(readFileSync(process.argv[1],'utf8'));const result=await sealBuiltinCapture(launch);process.exitCode=result.boundedVerdict==='passed'?0:1;"
                self.child(['/opt/homebrew/bin/bun', '--no-env-file', '-e', code,
                            str(run / 'capture-launch.json')], run, 1)


if __name__ == '__main__':
    unittest.main()

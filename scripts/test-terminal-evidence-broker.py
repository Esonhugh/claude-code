#!/usr/bin/env python3
import errno
import fcntl
from contextlib import nullcontext
import json
import os
from pathlib import Path
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time
import unittest


NATIVE = r'''
import json, os, signal, tty
from pathlib import Path
run = Path(os.environ['CLAUDE_CODE_FRAME_BROKER_DIR'])
tty.setraw(0)
request = os.open(run/'frame-request.fifo', os.O_RDWR)
response = os.open(run/'frame-response.fifo', os.O_RDWR)
def boundary(kind, request_id):
    os.write(request, (json.dumps(dict(kind=kind, requestId=request_id, rendererId=1, rootEpoch=1))+'\n').encode())
    value = b''
    while not value.endswith(b'\n'):
        value += os.read(response, 1)
    return json.loads(value)
start = boundary('frame-start', 1)
os.write(1, b'AB\r\n')
end = boundary('frame-end', 2)
(run/'native-ready.json').write_text(json.dumps(dict(pid=os.getpid(), start=start, end=end, signalMask=sorted(map(int, signal.pthread_sigmask(signal.SIG_BLOCK, []))))))
received = b''
while len(received) < 5:
    received += os.read(0, 5-len(received))
os.write(1, b'INPUT:'+received)
(run/'native-input-test.json').write_text(json.dumps(dict(hex=received.hex())))
'''


class BrokerTest(unittest.TestCase):
    def test_actual_native_bytes_resize_boundary_exit_and_owned_cleanup(self):
        evidence = os.environ.get('BROKER_TEST_EVIDENCE_DIR')
        if evidence:
            Path(evidence).mkdir(parents=True, exist_ok=True)
        scope = (nullcontext(tempfile.mkdtemp(prefix='broker-normal-', dir=evidence))
                 if evidence else tempfile.TemporaryDirectory(prefix='broker-test-'))
        with scope as directory:
            run = Path(directory)
            master, slave = os.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
            outer_attrs = termios.tcgetattr(slave)
            command = ['/usr/bin/env', 'python3', str(Path(__file__).with_name('terminal-evidence-broker.py')),
                       '--run', str(run), '--', '/usr/bin/env', 'python3', '-c', NATIVE]
            child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
                                     env={**os.environ, 'CLAUDE_CODE_FRAME_CAPTURE_ID': 'broker-test-capture'})
            os.close(slave)
            raw = bytearray()
            def wait(predicate):
                deadline = time.monotonic()+10
                while time.monotonic() < deadline:
                    readable, _, _ = select.select([master], [], [], 0.02)
                    if readable:
                        try:
                            raw.extend(os.read(master, 65536))
                        except OSError:
                            pass
                    if predicate():
                        return
                    if child.poll() is not None:
                        self.fail('broker exited before observable condition: '+raw.decode(errors='replace'))
                self.fail('broker observable condition timed out: '+raw.decode(errors='replace'))
            try:
                wait(lambda: (run/'native-ready.json').exists())
                ready = json.loads((run/'native-ready.json').read_text())
                self.assertEqual(ready['signalMask'], sorted(map(int,
                    signal.pthread_sigmask(signal.SIG_BLOCK, []))))
                self.assertEqual(ready['start']['rawOffset'], 0)
                self.assertEqual(ready['end']['rawOffset'], 4)
                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
                os.kill(child.pid, signal.SIGWINCH)
                def resized():
                    return any(row['kind']=='resize-ack' and row['columns']==100 and row['rows']==30
                               for row in map(json.loads, (run/'pty-io.jsonl').read_text().splitlines()))
                wait(resized)
                os.write(master, b'exit\r')
                wait(lambda: (run/'native-pty-eof.json').exists())
                self.assertEqual(child.wait(timeout=3), 0)
                wait(lambda: len(raw)==(run/'native-pty.raw').stat().st_size)
                self.assertEqual(bytes(raw), (run/'native-pty.raw').read_bytes())
                self.assertEqual(bytes(raw), b'AB\r\nINPUT:exit\r')
                self.assertEqual(json.loads((run/'native-input-test.json').read_text())['hex'], '657869740d')
                initial = json.loads((run/'native-pty-initial.json').read_text())
                self.assertEqual(initial['pid'], ready['pid'])
                self.assertEqual(initial['pgid'], ready['pid'])
                eof = json.loads((run/'native-pty-eof.json').read_text())
                self.assertEqual(eof['childExitCode'], 0)
                self.assertEqual(eof['rawBytes'], len(raw))
                cleanup = json.loads((run/'broker-cleanup.json').read_text())
                self.assertTrue(cleanup['normalCompletion'])
                self.assertTrue(cleanup['physicalEof'])
                self.assertTrue(cleanup['childReaped'])
                self.assertEqual(cleanup['cleanupErrors'], [])
                self.assertIsNone(cleanup['failure'])
                self.assertIsNone(cleanup['stopReason'])
                self.assertEqual(termios.tcgetattr(master), outer_attrs)
                for name in ['frame-request.fifo', 'frame-response.fifo']:
                    self.assertFalse((run/name).exists())
            finally:
                if child.poll() is None:
                    os.kill(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=4)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=3)
                os.close(master)


class BrokerFailureTest(unittest.TestCase):
    def setUp(self):
        evidence = os.environ.get('BROKER_TEST_EVIDENCE_DIR')
        if evidence:
            Path(evidence).mkdir(parents=True, exist_ok=True)
            self.run = Path(tempfile.mkdtemp(prefix=self._testMethodName+'-', dir=evidence))
        else:
            self.temporary = tempfile.TemporaryDirectory(prefix='broker-lifecycle-')
            self.addCleanup(self.temporary.cleanup)
            self.run = Path(self.temporary.name)
        self.addCleanup(self.save_observation)
        self.master, slave = os.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        self.slave = slave
        self.child = None
        self.native_pid = None
        self.holder_pid = None
        self.output = bytearray()
        self.process_probes = []
        self.addCleanup(self.cleanup)

    def save_observation(self):
        (self.run / 'outer-observed.raw').write_bytes(self.output)
        (self.run / 'test-observation.json').write_text(json.dumps({
            'test': self.id(), 'brokerPid': self.child.pid if self.child else None,
            'brokerExitCode': self.child.returncode if self.child else None,
            'nativePid': self.native_pid, 'holderPid': self.holder_pid,
            'processProbes': self.process_probes,
        })+'\n')

    def await_exit(self, assert_deadline=True, drain=True):
        # Keep draining the real outer PTY while observing broker exit. Blocking
        # wait() can itself stall the broker's traceback on a full PTY buffer.
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            if self.master is not None and drain:
                ready, _, _ = select.select([self.master], [], [], 0.02)
                if ready:
                    try:
                        self.output.extend(os.read(self.master, 65536))
                    except OSError:
                        pass
            if self.child.poll() is not None:
                return self.child.returncode
        if assert_deadline:
            raise subprocess.TimeoutExpired(self.child.args, 4)
        return None

    def cleanup(self):
        if self.child is not None and self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(timeout=4)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait(timeout=3)
        for owned_pid in (self.native_pid, self.holder_pid):
            if owned_pid is None:
                continue
            try:
                os.kill(owned_pid, 0)
            except ProcessLookupError:
                continue
            probe = subprocess.run(['/bin/ps', '-ww', '-p', str(owned_pid),
                                    '-o', 'pid=,pgid=,args='], capture_output=True, text=True)
            self.process_probes.append({'pid': owned_pid, 'exitCode': probe.returncode,
                                        'observed': probe.stdout, 'error': probe.stderr})
            self.assertIn(probe.returncode, (0, 1), 'owned-process probe failed')
            observed = probe.stdout.strip()
            if observed:
                fields = observed.split(None, 2)
                self.assertEqual(fields[:2], [str(owned_pid), str(owned_pid)])
                self.assertIn(str(self.run), fields[2])
                self.assertIn('python', fields[2].lower())
                try:
                    os.killpg(owned_pid, signal.SIGKILL)
                    self.process_probes.append({'pid': owned_pid, 'signal': 'SIGKILL'})
                except ProcessLookupError:
                    pass
        for descriptor in (self.master, self.slave):
            if descriptor is not None:
                os.close(descriptor)

    def launch(self, native, fail_restore=False, observe_syscalls=False, withhold_eof=False, stop_after_fifo_acquire=False, stop_after_waitpid=False, stop_during_terminal_classification=False):
        broker = Path(__file__).with_name('terminal-evidence-broker.py')
        if fail_restore:
            # This wrapper injects only the parent's second tcsetattr (restore).
            # The actual forked native process and PTY syscalls still execute.
            wrapper = self.run / 'restore-failure-wrapper.py'
            wrapper.write_text('''import json, os, runpy, termios
from pathlib import Path
parent = os.getpid()
original = termios.tcsetattr
calls = 0
def restore_failure(fd, when, attrs):
    global calls
    if os.getpid() == parent:
        calls += 1
        if calls == 2:
            Path(%r).write_text(json.dumps({'parentPid': parent, 'call': calls}))
            raise OSError(5, 'controlled outer TTY restore failure')
    return original(fd, when, attrs)
termios.tcsetattr = restore_failure
runpy.run_path(%r, run_name='__main__')
''' % (str(self.run / 'restore-fault-reached.json'), str(broker)))
            broker = wrapper
        if observe_syscalls:
            wrapper = self.run/'syscall-observer-wrapper.py'
            wrapper.write_text('''import errno, inspect, json, os, runpy
from pathlib import Path
parent = os.getpid()
withhold_eof = %r
stop_after_waitpid = %r
original_read, original_write, original_waitpid = os.read, os.write, os.waitpid
run = Path(%r)
def observe_write(fd, data):
    if os.getpid() == parent and fd == 1:
        (run/'outer-write-entered.json').write_text(json.dumps({
            'parentPid': parent, 'bytes': len(data), 'fd': fd}))
    try:
        return original_write(fd, data)
    except BlockingIOError as error:
        caller = inspect.currentframe().f_back
        if os.getpid() == parent and caller.f_locals.get('master') == fd:
            marker = run/'input-backpressure.json'
            pending = run/'input-backpressure.json.tmp'
            pending.write_text(json.dumps({
                'parentPid': parent, 'nativePid': caller.f_locals['child'],
                'errno': error.errno, 'bytes': len(data), 'fd': fd,
                'stopped': caller.f_locals.get('stopped'),
                'stopReason': caller.f_locals.get('stop_reason')}))
            pending.replace(marker)
        raise
def observe_read(fd, size):
    caller = inspect.currentframe().f_back
    owned = os.getpid() == parent and fd == caller.f_locals.get('master')
    try:
        result = original_read(fd, size)
    except OSError as error:
        if not (withhold_eof and owned and error.errno == errno.EIO):
            raise
        result = b''
    if withhold_eof and owned and not result:
        marker = run/'withheld-eof.json'
        if not marker.exists():
            marker.write_text(json.dumps({'parentPid': parent, 'fd': fd,
                                         'actualReadEof': True}))
        raise BlockingIOError(errno.EAGAIN, 'controlled EOF observation failure')
    return result
def observe_waitpid(pid, options):
    result = original_waitpid(pid, options)
    if os.getpid() == parent and result[0]:
        (run/'actual-waitpid.json').write_text(json.dumps({
            'parentPid': parent, 'nativePid': result[0], 'childStatus': result[1]}))
        if stop_after_waitpid:
            import signal
            os.kill(parent, signal.SIGTERM)
    return result
os.read, os.write, os.waitpid = observe_read, observe_write, observe_waitpid
runpy.run_path(%r, run_name='__main__')
''' % (withhold_eof, stop_after_waitpid, str(self.run), str(broker)))
            broker = wrapper
        if stop_after_fifo_acquire:
            wrapper = self.run/'acquisition-stop-wrapper.py'
            wrapper.write_text('''import json, os, runpy, signal
from pathlib import Path
parent = os.getpid()
original = os.mkfifo
first = True
def stop_after_acquire(path, mode=0o666, *, dir_fd=None):
    global first
    original(path, mode, dir_fd=dir_fd)
    if os.getpid() == parent and first:
        first = False
        inode = Path(path).lstat().st_ino
        Path(%r).write_text(json.dumps({'pid': parent, 'path': str(path), 'inode': inode}))
        os.kill(parent, signal.SIGTERM)
os.mkfifo = stop_after_acquire
runpy.run_path(%r, run_name='__main__')
''' % (str(self.run/'actual-fifo-acquisition.json'), str(broker)))
            broker = wrapper
        if stop_during_terminal_classification:
            wrapper = self.run/'terminal-classification-stop-wrapper.py'
            wrapper.write_text('''import inspect, json, os, runpy, signal
from pathlib import Path
parent = os.getpid()
original = os.waitstatus_to_exitcode
run = Path(%r)
def stop_at_terminal_classification(status):
    caller = inspect.currentframe().f_back
    result = original(status)
    if os.getpid() == parent and caller.f_code.co_name == 'main':
        marker = run/'terminal-classification-stop.json'
        if not marker.exists():
            marker.write_text(json.dumps({
                'parentPid': parent, 'childStatus': status, 'childExitCode': result,
                'childReaped': caller.f_locals.get('status') is not None,
                'physicalEof': caller.f_locals.get('eof'),
                'cleanupStarted': caller.f_locals.get('cleanup_started'),
                'terminalOutcomeSealed': caller.f_locals.get('terminal_sealed', False),
                'fifosAbsent': not any((run/name).exists() for name in
                    ['frame-request.fifo', 'frame-response.fifo'])}))
            os.kill(parent, signal.SIGTERM)
    return result
os.waitstatus_to_exitcode = stop_at_terminal_classification
runpy.run_path(%r, run_name='__main__')
''' % (str(self.run), str(broker)))
            broker = wrapper
        command = ['/usr/bin/env', 'python3', str(broker), '--run', str(self.run),
                   '--', '/usr/bin/env', 'python3', '-c', native, str(self.run)]
        self.child = subprocess.Popen(command, stdin=self.slave, stdout=self.slave,
                                      stderr=self.slave, start_new_session=True,
                                      env={**os.environ, 'CLAUDE_CODE_FRAME_CAPTURE_ID': self.run.name})
        os.close(self.slave)
        self.slave = None

    def await_condition(self, condition):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            ready, _, _ = select.select([self.master], [], [], 0.02)
            if ready:
                try:
                    self.output.extend(os.read(self.master, 65536))
                except OSError:
                    pass
            if condition():
                return
            if self.child.poll() is not None:
                self.fail('fixture exited before the required observable state: ' + self.output.decode(errors='replace'))
        self.fail('fixture never reached the required observable state: ' + self.output.decode(errors='replace'))

    def test_restore_failure_does_not_skip_owned_cleanup(self):
        self.launch("import os; os.write(1, b'evidence\\n')", fail_restore=True)
        self.await_condition(lambda: (self.run / 'restore-fault-reached.json').exists())
        self.assertNotEqual(self.await_exit(), 0)
        self.assertTrue((self.run / 'native-pty-eof.json').exists())
        self.assertTrue((self.run / 'broker-cleanup.json').exists())
        cleanup = json.loads((self.run / 'broker-cleanup.json').read_text())
        self.assertTrue(cleanup['childReaped'])
        self.assertEqual(sorted(cleanup['fifoRemoved']), ['frame-request.fifo', 'frame-response.fifo'])
        for name in cleanup['fifoRemoved']:
            self.assertFalse((self.run / name).exists())
        self.assertTrue(cleanup['cleanupErrors'])

    def test_actual_outer_pty_loss_reaps_native_and_preserves_failure(self):
        self.launch(NATIVE)
        self.await_condition(lambda: (self.run / 'native-ready.json').exists())
        initial = json.loads((self.run / 'native-pty-initial.json').read_text())
        ready = json.loads((self.run / 'native-ready.json').read_text())
        self.assertEqual(initial['pid'], ready['pid'])
        self.assertEqual(initial['pgid'], ready['pid'])
        self.native_pid = ready['pid']
        os.close(self.master)
        self.master = None
        # Exercise cleanup after actual transport loss using an owned stop;
        # this does not claim automatic EOF-to-stop behavior was implemented.
        self.child.send_signal(signal.SIGTERM)
        self.assertNotEqual(self.await_exit(), 0)
        self.assertTrue((self.run / 'broker-cleanup.json').exists())
        cleanup = json.loads((self.run / 'broker-cleanup.json').read_text())
        self.assertTrue(cleanup['childReaped'])
        self.assertEqual(sorted(cleanup['fifoRemoved']), ['frame-request.fifo', 'frame-response.fifo'])
        self.assertIn('normalCompletion', cleanup)
        self.assertFalse(cleanup['normalCompletion'])
        self.assertIn(cleanup['stopReason'], ['outer-input-eof', 'SIGTERM'])

    def test_stop_interrupts_actual_native_input_backpressure(self):
        native = r"""
import json, os, signal, tty
from pathlib import Path
run = Path(os.environ['CLAUDE_CODE_FRAME_BROKER_DIR'])
tty.setraw(0)
(run/'native-ready.json').write_text(json.dumps({'pid': os.getpid()}))
while True:
    signal.pause()
"""
        self.launch(native, observe_syscalls=True)
        self.await_condition(lambda: (self.run/'native-ready.json').exists())
        self.native_pid = json.loads((self.run/'native-ready.json').read_text())['pid']
        os.set_blocking(self.master, False)
        deadline = time.monotonic() + 4
        sent = 0
        while not (self.run/'input-backpressure.json').exists() and time.monotonic() < deadline:
            try:
                sent += os.write(self.master, b'x'*65536)
            except BlockingIOError:
                select.select([], [self.master], [], 0.01)
        self.assertTrue((self.run/'input-backpressure.json').exists(),
                        'fixture did not reach actual native write EAGAIN')
        pressure = json.loads((self.run/'input-backpressure.json').read_text())
        self.assertEqual(pressure['nativePid'], self.native_pid)
        self.assertEqual(pressure['parentPid'], self.child.pid)
        self.assertEqual(pressure['errno'], errno.EAGAIN)
        self.assertGreater(pressure['bytes'], 0)
        self.assertGreater(sent, 0)
        self.child.send_signal(signal.SIGTERM)
        code = self.await_exit(assert_deadline=False)
        self.assertIsNotNone(code, 'observed native EAGAIN prevents owned SIGTERM from finishing')
        self.assertNotEqual(code, 0)
        cleanup = json.loads((self.run/'broker-cleanup.json').read_text())
        self.assertTrue(cleanup['childReaped'])
        self.assertFalse(cleanup['normalCompletion'])
        self.assertEqual(cleanup['stopReason'], 'SIGTERM')
        self.assertEqual(cleanup['failure']['type'], 'BrokerStopped')

    def test_stop_interrupts_actual_outer_output_backpressure(self):
        native = r"""
import json, os
from pathlib import Path
run = Path(os.environ['CLAUDE_CODE_FRAME_BROKER_DIR'])
(run/'native-ready.json').write_text(json.dumps({'pid': os.getpid()}))
for _ in range(128):
    os.write(1, b'x'*65536)
"""
        self.launch(native, observe_syscalls=True)
        deadline = time.monotonic() + 4
        queued = 0
        readable = False
        while time.monotonic() < deadline:
            queued = struct.unpack('I', fcntl.ioctl(self.master, termios.FIONREAD,
                                                  struct.pack('I', 0)))[0]
            readable = bool(select.select([self.master], [], [], 0)[0])
            if (self.run/'native-ready.json').exists():
                self.native_pid = json.loads((self.run/'native-ready.json').read_text())['pid']
            if readable and (self.run/'outer-write-entered.json').exists():
                break
            select.select([], [], [], 0.01)
        self.assertTrue(readable, 'fixture never exposed real unread outer PTY output')
        self.assertIsNone(self.child.poll())
        self.assertTrue((self.run/'outer-write-entered.json').exists())
        self.native_pid = json.loads((self.run/'native-ready.json').read_text())['pid']
        entered = json.loads((self.run/'outer-write-entered.json').read_text())
        self.assertEqual(entered['parentPid'], self.child.pid)
        self.assertGreater(entered['bytes'], 0)
        (self.run/'observed-output-backpressure.json').write_text(json.dumps({
            'outerReadableWithoutAnyTestRead': readable, 'fionreadReportedBytes': queued,
            'nativeRawBytes': (self.run/'native-pty.raw').stat().st_size,
            'nativePid': self.native_pid, 'brokerPid': self.child.pid}))
        self.child.send_signal(signal.SIGTERM)
        code = self.await_exit(assert_deadline=False, drain=False)
        self.assertIsNotNone(code, 'unread outer PTY output prevents owned SIGTERM from finishing')
        self.assertNotEqual(code, 0)
        cleanup = json.loads((self.run/'broker-cleanup.json').read_text())
        self.assertTrue(cleanup['childReaped'])
        self.assertFalse(cleanup['normalCompletion'])
        self.assertEqual(cleanup['stopReason'], 'SIGTERM')
        self.assertEqual(cleanup['failure']['type'], 'BrokerStopped')

    def test_stop_bounds_cleanup_when_eof_observation_fails(self):
        native = r"""
import json, os
from pathlib import Path
run = Path(os.environ['CLAUDE_CODE_FRAME_BROKER_DIR'])
(run/'native-ready.json').write_text(json.dumps({'pid': os.getpid()}))
os.write(1, b'actual native bytes\n')
"""
        self.launch(native, observe_syscalls=True, withhold_eof=True)
        self.await_condition(lambda: (self.run/'native-ready.json').exists()
                             and (self.run/'actual-waitpid.json').exists()
                             and (self.run/'withheld-eof.json').exists())
        self.native_pid = json.loads((self.run/'native-ready.json').read_text())['pid']
        actual = json.loads((self.run/'actual-waitpid.json').read_text())
        self.assertEqual(actual['nativePid'], self.native_pid)
        self.assertEqual(actual['childStatus'], 0)
        self.assertTrue(json.loads((self.run/'withheld-eof.json').read_text())['actualReadEof'])
        self.assertFalse((self.run/'native-pty-eof.json').exists())
        self.child.send_signal(signal.SIGTERM)
        code = self.await_exit(assert_deadline=False)
        self.assertIsNotNone(code, 'owned stop never finishes when EOF observation fails')
        self.assertNotEqual(code, 0)
        cleanup = json.loads((self.run/'broker-cleanup.json').read_text())
        self.assertTrue(cleanup['childReaped'])
        self.assertFalse(cleanup['physicalEof'])
        self.assertFalse(cleanup['normalCompletion'])
        self.assertFalse((self.run/'native-pty-eof.json').exists())

    def test_actual_outer_eof_stops_native_without_an_extra_signal(self):
        self.launch(NATIVE)
        self.await_condition(lambda: (self.run / 'native-ready.json').exists())
        self.native_pid = json.loads((self.run/'native-ready.json').read_text())['pid']
        os.close(self.master)
        self.master = None
        self.assertNotEqual(self.await_exit(), 0)
        cleanup = json.loads((self.run/'broker-cleanup.json').read_text())
        self.assertTrue(cleanup['childReaped'])
        self.assertEqual(cleanup['stopReason'], 'outer-input-eof')
        self.assertFalse(cleanup['normalCompletion'])

    def test_runtime_failure_records_the_actual_reap_and_eof(self):
        self.launch(NATIVE)
        self.await_condition(lambda: (self.run / 'native-ready.json').exists())
        self.native_pid = json.loads((self.run/'native-ready.json').read_text())['pid']
        descriptor = os.open(self.run/'frame-request.fifo', os.O_RDWR)
        try:
            os.write(descriptor, b'{"kind":"invalid-boundary"}\n')
        finally:
            os.close(descriptor)
        self.assertNotEqual(self.await_exit(), 0)
        cleanup = json.loads((self.run/'broker-cleanup.json').read_text())
        self.assertTrue(cleanup['childReaped'])
        self.assertTrue(cleanup['physicalEof'])
        self.assertFalse(cleanup['normalCompletion'])
        self.assertEqual(cleanup['failure']['type'], 'ValueError')
        self.assertIn('unexpected frame boundary', cleanup['failure']['message'])
        self.assertEqual(cleanup['cleanupErrors'], [])
        eof = json.loads((self.run/'native-pty-eof.json').read_text())
        self.assertEqual(eof['childPid'], self.native_pid)
        self.assertEqual(eof['childStatus'], cleanup['childStatus'])
        self.assertEqual(eof['rawBytes'], (self.run/'native-pty.raw').stat().st_size)
        self.assertEqual(eof['childExitCode'], -signal.SIGKILL)

    def test_replaced_fifo_is_preserved_and_other_cleanup_still_runs(self):
        self.launch(NATIVE)
        self.await_condition(lambda: (self.run/'native-ready.json').exists())
        self.native_pid = json.loads((self.run/'native-ready.json').read_text())['pid']
        replaced = self.run/'frame-request.fifo'
        replaced.unlink()
        replaced.write_bytes(b'foreign replacement')
        inode = replaced.lstat().st_ino
        os.write(self.master, b'exit\r')
        self.assertNotEqual(self.await_exit(), 0)
        cleanup = json.loads((self.run/'broker-cleanup.json').read_text())
        self.assertTrue(cleanup['childReaped'])
        self.assertFalse(cleanup['normalCompletion'])
        self.assertEqual(cleanup['fifoRemoved'], ['frame-response.fifo'])
        self.assertEqual(cleanup['cleanupErrors'][0]['action'], 'remove-owned-fifo:frame-request.fifo')
        self.assertEqual(replaced.read_bytes(), b'foreign replacement')
        self.assertEqual(replaced.lstat().st_ino, inode)
        self.assertFalse((self.run/'frame-response.fifo').exists())

    def test_stop_after_waitpid_keeps_the_observed_exit_status(self):
        self.launch('raise SystemExit(0)', observe_syscalls=True, stop_after_waitpid=True)
        self.assertNotEqual(self.await_exit(), 0)
        actual = json.loads((self.run/'actual-waitpid.json').read_text())
        self.assertEqual(actual['parentPid'], self.child.pid)
        self.native_pid = actual['nativePid']
        self.assertEqual(actual['childStatus'], 0)
        cleanup = json.loads((self.run/'broker-cleanup.json').read_text())
        self.assertTrue(cleanup['childReaped'])
        self.assertEqual(cleanup['childStatus'], actual['childStatus'])
        self.assertFalse(cleanup['normalCompletion'])
        self.assertEqual(cleanup['stopReason'], 'SIGTERM')
        self.assertEqual(cleanup['failure']['type'], 'BrokerStopped')

    def test_stop_in_acquisition_window_keeps_created_fifo_owned(self):
        self.launch('raise SystemExit(0)', stop_after_fifo_acquire=True)
        self.assertNotEqual(self.await_exit(), 0)
        acquired = json.loads((self.run/'actual-fifo-acquisition.json').read_text())
        self.assertEqual(acquired['pid'], self.child.pid)
        self.assertEqual(acquired['path'], str(self.run/'frame-request.fifo'))
        self.assertFalse((self.run/'frame-request.fifo').exists())
        cleanup = json.loads((self.run/'broker-cleanup.json').read_text())
        self.assertIn('frame-request.fifo', cleanup['fifoRemoved'])
        self.assertEqual(cleanup['stopReason'], 'SIGTERM')
        self.assertEqual(cleanup['failure']['type'], 'BrokerStopped')
        self.assertFalse(cleanup['normalCompletion'])

    def test_stop_after_terminal_seal_keeps_published_outcome_consistent(self):
        self.launch('raise SystemExit(0)', stop_during_terminal_classification=True)
        code = self.await_exit()
        reached = json.loads((self.run/'terminal-classification-stop.json').read_text())
        self.assertEqual(reached['parentPid'], self.child.pid)
        self.assertTrue(reached['childReaped'])
        self.assertTrue(reached['physicalEof'])
        self.assertTrue(reached['cleanupStarted'])
        self.assertTrue(reached['fifosAbsent'])
        self.assertEqual(reached['childStatus'], 0)
        self.assertEqual(reached['childExitCode'], 0)
        cleanup = json.loads((self.run/'broker-cleanup.json').read_text())
        self.assertEqual(code, 0)
        self.assertTrue(cleanup['normalCompletion'])
        self.assertIsNone(cleanup['stopReason'])
        self.assertIsNone(cleanup['failure'])
        self.assertEqual(cleanup['cleanupErrors'], [])
        self.assertTrue(reached['terminalOutcomeSealed'])

    def test_partial_startup_removes_only_the_fifo_it_created(self):
        existing = self.run / 'frame-response.fifo'
        existing.write_bytes(b'preexisting marker')
        inode = existing.lstat().st_ino
        self.launch('raise SystemExit(0)')
        self.assertNotEqual(self.await_exit(), 0)
        self.assertEqual(existing.read_bytes(), b'preexisting marker')
        self.assertEqual(existing.lstat().st_ino, inode)
        self.assertFalse((self.run / 'frame-request.fifo').exists())
        self.assertTrue((self.run / 'broker-cleanup.json').exists())
        cleanup = json.loads((self.run / 'broker-cleanup.json').read_text())
        self.assertEqual(cleanup['fifoRemoved'], ['frame-request.fifo'])
        self.assertIsNone(cleanup['childPid'])
        self.assertFalse((self.run / 'native-pty-eof.json').exists())


class SandboxedArgvTest(unittest.TestCase):
    def test_sandbox_layouts_bind_the_wrapped_native_binary_identity(self):
        broker = str(Path(__file__).with_name('terminal-evidence-broker.py'))
        with tempfile.TemporaryDirectory(prefix='broker-sandbox-argv-') as directory:
            run = Path(directory)
            binary = run / 'native'
            binary.write_bytes(b'wrapped native fixture')
            digest = __import__('hashlib').sha256(binary.read_bytes()).hexdigest()
            layouts = {
                'darwin': ['/usr/bin/sandbox-exec', '-f', str(run / 'sandbox.sb'), str(binary)],
                'linux': ['/usr/bin/python3', str(run / 'linux-sandbox-exec.py'), '--policy', '{}', '--', str(binary)],
            }
            for name, argv in layouts.items():
                for expected, changed in ((digest, False), ('0' * 64, True)):
                    with self.subTest(layout=name, changed=changed):
                        result = subprocess.run(['/usr/bin/env', 'python3', broker, '--run', str(run), '--', *argv, '--flag'],
                                                stdin=subprocess.DEVNULL, capture_output=True, timeout=10,
                                                env={**os.environ, 'CLAUDE_CODE_FRAME_CAPTURE_ID': 'owned-capture',
                                                     'CLAUDE_CODE_FRAME_BINARY_SHA256': expected})
                        self.assertNotEqual(result.returncode, 0)
                        self.assertEqual(b'copied native binary identity changed' in result.stderr, changed,
                                         result.stderr.decode(errors='replace'))
                        for leftover in ('frame-request.fifo', 'frame-response.fifo'):
                            self.assertFalse((run / leftover).exists())


if __name__ == '__main__':
    unittest.main()

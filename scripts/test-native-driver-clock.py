"""Actual Python caller clock, with synthetic enrollment; not CLI/UI acceptance."""
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('clock', Path(__file__).with_name('native-driver-clock.py'))
clock = importlib.util.module_from_spec(spec)
spec.loader.exec_module(clock)


class DriverClockTest(unittest.TestCase):
    def test_actual_mach_clock_and_caller_identity(self):
        with tempfile.TemporaryDirectory(prefix='native-clock-python-') as directory:
            run = Path(directory)
            launch = {'run': str(run), 'driverPid': os.getpid(), 'binarySha256': 'a' * 64,
                      'capture': {'nativeJournal': True, 'captureId': 'synthetic-enrollment-actual-caller-clock'}}
            for name, data in [('registration.json', {'nonce': 'b' * 32}),
                               ('start.json', {'childPid': os.getpid()+1, 'binarySha256': launch['binarySha256']})]:
                (run / name).write_text(json.dumps(data));(run / name).chmod(0o600)
            system = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
            system.mach_absolute_time.restype = ctypes.c_uint64
            before = system.mach_absolute_time();value = clock.read_native_driver_clock(launch)
            after = system.mach_absolute_time();following = clock.read_native_driver_clock(launch)
            self.assertTrue(before <= int(value['tick']) <= after)
            self.assertGreaterEqual(int(following['tick']), int(value['tick']))
            self.assertEqual(value['callerPid'], os.getpid())
            self.assertEqual(value['callerThreadId'], following['callerThreadId'])
            self.assertGreater(int(value['callerThreadId']), 0)
            self.assertGreater(value['timebaseNumer'], 0);self.assertGreater(value['timebaseDenom'], 0)
            evidence = os.environ.get('BROKER_TEST_EVIDENCE_DIR')
            if evidence:
                destination = Path(evidence);destination.mkdir(parents=True, exist_ok=True)
                with (destination / 'actual-python-driver-clock.json').open('x') as output:
                    output.write(json.dumps({'scope': 'actual caller clock; enrollment is synthetic, not CLI/UI proof',
                        'before': str(before), 'clock': value, 'after': str(after), 'next': following})+'\n')
            for bad in [{**launch,'driverPid':os.getpid()+1},
                        {**launch,'capture':{**launch['capture'],'nativeJournal':'1'}}]:
                with self.assertRaisesRegex(ValueError,'original Darwin caller'):clock.read_native_driver_clock(bad)
            (run / 'start.json').write_text(json.dumps({'childPid':os.getpid(),'binarySha256':launch['binarySha256']}))
            with self.assertRaisesRegex(ValueError,'enrollment'):clock.read_native_driver_clock(launch)


    def test_actual_driver_defers_publication_and_preserves_timeout(self):
        from unittest.mock import patch
        import subprocess
        source = Path(__file__).resolve().parent
        spec = importlib.util.spec_from_file_location('clock_command_driver', source.parent / '.claude/skills/release-validation/scripts/run-binary-gate.py')
        driver = importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)
        for failing in (False, True):
            with self.subTest(failing=failing), tempfile.TemporaryDirectory(prefix='native-clock-driver-') as directory:
                run = Path(directory)
                launch = {'run':str(run),'driverPid':os.getpid(),'binarySha256':'a'*64,
                          'target':'owned:0.0','socket':str(run/'synthetic-socket'),
                          'capture':{'nativeJournal':True,'captureId':'synthetic-command-actual-clock'}}
                for name,data in [('registration.json',{'nonce':'b'*32}),
                                  ('start.json',{'childPid':os.getpid()+1,'binarySha256':launch['binarySha256']})]:
                    (run/name).write_text(json.dumps(data));(run/name).chmod(0o600)
                (run/'geometry.jsonl').write_text(json.dumps({'phase':'launch'})+'\n')
                gate = driver.BinaryGate.__new__(driver.BinaryGate);gate.terminal_capture = launch
                gate.terminal_capture_boundary = lambda _:{'lastObservedIoId':1,'lastObservedFrameId':0,'observedRawBytes':0}
                original = subprocess.TimeoutExpired('synthetic-tmux', 1)
                during = []
                def command(*args, **kwargs):
                    during.append(len((run/'geometry.jsonl').read_text().splitlines()))
                    if failing:raise original
                    return subprocess.CompletedProcess(args[0],0,'','')
                count = 0
                def sample(value):
                    nonlocal count
                    count += 1
                    if failing and count == 2:raise RuntimeError('injected post-clock failure')
                    return clock.read_native_driver_clock(value)
                with patch.object(driver,'command',command),patch.object(driver._driver_clock,'read_native_driver_clock',sample):
                    if failing:
                        with self.assertRaises(subprocess.TimeoutExpired) as caught:
                            gate.tmux('resize-window','-t',launch['target'],'-x','109','-y','34')
                        self.assertIs(caught.exception, original)
                    else:gate.tmux('resize-window','-t',launch['target'],'-x','109','-y','34')
                self.assertEqual(during,[1])
                rows = [json.loads(line) for line in (run/'geometry.jsonl').read_text().splitlines()]
                self.assertEqual([row['phase'] for row in rows],['launch','resize-send','resize-return'])
                self.assertEqual(rows[-1]['exitCode'],None if failing else 0)
                if failing:
                    self.assertEqual(rows[-1]['commandError'],'TimeoutExpired')
                    self.assertIn('post-clock failure',rows[-1]['clockError'])
                    self.assertNotIn('nativeDriverClock',rows[-1])
                else:self.assertLessEqual(int(rows[1]['nativeDriverClock']['tick']),int(rows[2]['nativeDriverClock']['tick']))


    def test_publication_error_never_replaces_original_timeout(self):
        from unittest.mock import patch
        from contextlib import redirect_stderr
        import errno
        import io
        import subprocess
        source=Path(__file__).resolve().parent
        spec=importlib.util.spec_from_file_location('clock_publication_driver',source.parent/'.claude/skills/release-validation/scripts/run-binary-gate.py')
        driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)
        with tempfile.TemporaryDirectory(prefix='native-clock-publish-error-') as directory:
            run=Path(directory)
            launch={'run':str(run),'target':'owned:0.0','socket':str(run/'synthetic-socket'),'capture':{'nativeJournal':False}}
            (run/'geometry.jsonl').write_text(json.dumps({'phase':'launch'})+'\n')
            gate=driver.BinaryGate.__new__(driver.BinaryGate);gate.terminal_capture=launch
            gate.terminal_capture_boundary=lambda _:{'lastObservedIoId':1,'lastObservedFrameId':0,'observedRawBytes':0}
            original=subprocess.TimeoutExpired('synthetic-tmux',1)
            def publish(*_):raise OSError(errno.ENOSPC,'injected owned publication failure')
            gate.terminal_append=publish
            diagnostics=io.StringIO()
            with patch.object(driver,'command',side_effect=original),redirect_stderr(diagnostics):
                with self.assertRaises(subprocess.TimeoutExpired) as caught:
                    gate.tmux('resize-window','-t',launch['target'],'-x','109','-y','34')
            self.assertIs(caught.exception,original)
            receipt=json.loads(diagnostics.getvalue())
            self.assertEqual(receipt['phase'],'resize-evidence-publication-failed')
            self.assertEqual(receipt['errno'],errno.ENOSPC)


if __name__ == '__main__':unittest.main(verbosity=2)

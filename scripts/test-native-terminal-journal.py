#!/usr/bin/env python3
"""Native syscall/immutable-slot regressions. Never complete UI acceptance."""
import copy
import ctypes
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pty
import selectors
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unittest

SOURCE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('journal', SOURCE / 'native-terminal-journal.py')
journal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journal)
PROBE = r'''
#include <unistd.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/uio.h>
#include <stdint.h>
#include <dlfcn.h>
#include <pthread.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
static void *other(void *unused){(void)unused;write(1,"thread\n",7);return NULL;}
int main(int argc,char **argv){
 const char *mode=argc>1?argv[1]:"large";
 uint64_t(*mark)(uint64_t,uint64_t,const void*,uint64_t)=dlsym(RTLD_DEFAULT,"cc_terminal_journal_mark");
 char observation[]="ORIGINAL";
 if(mark){mark(10,1,"layout",6);mark(11,1,observation,8);observation[0]='X';mark(12,1,NULL,0);}
 if(!strcmp(mode,"hang")){pause();return 88;}
 if(!strcmp(mode,"threads")){
  pthread_t thread;if(pthread_create(&thread,NULL,other,NULL))return 75;
  if(write(1,"main\n",5)!=5)return 76;
  pthread_join(thread,NULL);
 }else if(!strcmp(mode,"nocancel")){
  ssize_t(*w)(int,const void*,size_t)=dlsym(RTLD_DEFAULT,"write$NOCANCEL");
  ssize_t(*v)(int,const struct iovec*,int)=dlsym(RTLD_DEFAULT,"writev$NOCANCEL");
  struct iovec parts[2]={{"vec",3},{"tor\n",4}};
  if(!w||!v)return 80;
  errno=EALREADY;if(w(1,"plain\n",6)!=6||errno!=EALREADY)return 81;
  errno=EALREADY;if(v(1,parts,2)!=7||errno!=EALREADY)return 82;
 }else if(!strcmp(mode,"bad-memory")){
  errno=0;if(write(1,(const void*)1,8)!=-1||errno!=EFAULT)return 83;
 }else if(!strcmp(mode,"partial")){
  int flags=fcntl(1,F_GETFL);if(flags<0||fcntl(1,F_SETFL,flags|O_NONBLOCK))return 84;
  char bytes[65536];memset(bytes,'B',sizeof(bytes));
  errno=EALREADY;ssize_t n=write(1,bytes,sizeof(bytes));
  if(n<=0||(size_t)n>=sizeof(bytes)||errno!=EALREADY)return 85;
  if(fcntl(1,F_SETFL,flags))return 86;
  int ready=atoi(getenv("PARTIAL_SIGNAL_FD")),resume=atoi(getenv("PARTIAL_CONTINUE_FD"));
  uint64_t returned=(uint64_t)n;char next;
  if(write(ready,&returned,sizeof(returned))!=sizeof(returned)||read(resume,&next,1)!=1)return 87;
 }else if(!strcmp(mode,"reuse")){
  int resume=atoi(getenv("REUSE_CONTINUE_FD"));char next;
  for(int i=0;i<40;i++){
   if(write(1,"reuse\n",6)!=6||read(resume,&next,1)!=1)return 89;
  }
 }else if(!strcmp(mode,"starve")){
  for(int i=0;i<16;i++)if(write(1,"live\n",5)!=5)return 77;
 }else{
  uint64_t *changed=NULL;uint64_t saved_capacity=0;
  if(!strcmp(mode,"corrupt-layout")){
   int fd=open(getenv("CLAUDE_PRIVATE_NATIVE_JOURNAL"),O_RDWR);struct stat file;
   if(fd<0||fstat(fd,&file))return 78;
   changed=mmap(NULL,(size_t)file.st_size,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0);close(fd);
   if(changed==MAP_FAILED)return 79;
   saved_capacity=changed[4];changed[4]=0;
  }
  char bytes[5000];memset(bytes,'A',sizeof(bytes));bytes[4999]='\n';
  errno=EALREADY;if(write(1,bytes,sizeof(bytes))!=sizeof(bytes)||errno!=EALREADY)return 71;
  memset(bytes,'X',sizeof(bytes));
  int alias=dup(1);if(alias<0)return 72;
  struct iovec vectors[2]={{"alias-",6},{"vector\n",7}};
  errno=EALREADY;if(writev(alias,vectors,2)!=13||errno!=EALREADY)return 73;
  close(alias);
  int saved=dup(1);close(1);
  if(write(1,"failure",7)!=-1||errno!=EBADF)return 74;
  dup2(saved,1);close(saved);
  if(changed)changed[4]=saved_capacity;
 }
 if(mark)mark(13,1,NULL,0);
 return 0;
}
'''


class NativeJournalTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix='cc-journal-', dir='/private/tmp'))
        cls.env = {'PATH': '/usr/bin:/bin:/opt/homebrew/bin', 'HOME': str(cls.root),
                   'TMPDIR': str(cls.root), 'CLAUDE_CONFIG_DIR': str(cls.root / 'config'),
                   'DISABLE_TELEMETRY': '1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
                   'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1'}
        (cls.root / 'config').mkdir()
        cls.library = cls.root / 'observer.dylib'
        cls.probe = cls.root / 'probe'
        (cls.root / 'probe.c').write_text(PROBE)
        for command, name in [
            (['/usr/bin/clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
              '-dynamiclib', str(SOURCE / 'native-terminal-journal.c'), '-o', str(cls.library)], 'library'),
            (['/usr/bin/clang', '-std=c11', '-Wall', '-Wextra', '-Werror',
              str(cls.root / 'probe.c'), '-o', str(cls.probe)], 'probe'),
        ]:
            result = subprocess.run(command, env=cls.env, cwd=cls.root,
                                    capture_output=True, timeout=15)
            (cls.root / (name + '-compile.log')).write_bytes(result.stdout + result.stderr)
            if result.returncode:
                raise RuntimeError(result.stderr.decode())
        print(json.dumps({'evidence': str(cls.root), 'librarySHA256':
              hashlib.sha256(cls.library.read_bytes()).hexdigest()}), flush=True)

    def capture(self, mode='large', capacity=64, payload=65536, observed=True, binary=None, fail_after_start=False, fail_after_receipt=False, live=False, fail_after_live_records=0):
        run = self.root / f'case-{len(list(self.root.glob("case-*")))}'
        run.mkdir()
        master = slave = None
        control_fds = []
        consumer = selector = child = None
        raw = bytearray()
        records = packets = []
        eof = False
        error = None
        started = time.monotonic()
        try:
            master, slave = pty.openpty()
            attrs = termios.tcgetattr(slave)
            self.assertEqual(attrs[1], termios.OPOST | termios.ONLCR)
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
            path = run / 'journal.bin'
            registration = journal.create_journal(path, os.fstat(slave), 3, capacity, payload)
            env = dict(self.env)
            if observed:
                env.update(DYLD_INSERT_LIBRARIES=str(self.library), CLAUDE_PRIVATE_NATIVE_JOURNAL=str(path))
            command = [str(binary), '--version'] if binary else [str(self.probe), mode]
            control_fds = []
            partial_expected = None
            partial_released = False
            if mode == 'partial':
                ready_read, ready_write = os.pipe()
                control_fds.extend([ready_read, ready_write])
                resume_read, resume_write = os.pipe()
                control_fds.extend([resume_read, resume_write])
                env.update(PARTIAL_SIGNAL_FD=str(ready_write), PARTIAL_CONTINUE_FD=str(resume_read))
            if mode == 'reuse':
                reuse_read, reuse_write = os.pipe()
                control_fds.extend([reuse_read, reuse_write])
                env['REUSE_CONTINUE_FD'] = str(reuse_read)
            consumer = journal.NativeConsumer(path, registration, self.library) if live else None
            packets = []
            def collect_live():
                while consumer is not None:
                    packet = consumer.consume(len(packets) + 1)
                    if packet is None:
                        break
                    packets.append(packet)
                    if fail_after_live_records and len(packets) == fail_after_live_records:
                        raise RuntimeError('controlled live collector failure')
                    if mode == 'reuse' and journal.RECORD.unpack_from(packet)[2] == 1:
                        # Explicit fixture input; production observer has no wait/ACK.
                        os.write(reuse_write, b'1')
            selector = selectors.DefaultSelector()
            child = subprocess.Popen(command, env=env, cwd=run, stdin=slave,
                                     stdout=slave, stderr=slave, start_new_session=True,
                                     pass_fds=(ready_write, resume_read) if mode == 'partial' else
                                              (reuse_read,) if mode == 'reuse' else ())
            if consumer is not None:
                consumer.bind_producer(child.pid)
            (run / 'start.json').write_text(json.dumps({'childPid': child.pid, 'childPgid': child.pid, 'command': command, 'registration': registration}) + '\n')
            if fail_after_start:
                raise RuntimeError('controlled capture failure')
            if mode == 'partial':
                # Kernel nonblocking result is observed before the PTY is drained.
                # This is a controlled syscall probe, not a product scheduling rule.
                ready_selector = selectors.DefaultSelector()
                try:
                    ready_selector.register(ready_read, selectors.EVENT_READ)
                    if not ready_selector.select(2):
                        raise TimeoutError('Missing original partial syscall receipt')
                    partial_expected = struct.unpack('<Q', os.read(ready_read, 8))[0]
                    if fail_after_receipt:
                        raise RuntimeError('controlled capture failure')
                finally:
                    ready_selector.close()
            os.set_blocking(master, False)
            selector.register(master, selectors.EVENT_READ)
            os.close(slave)
            slave = None
            while not eof and time.monotonic() - started < 10:
                collect_live()
                for key, _ in selector.select(.1):
                    try:
                        chunk = os.read(key.fd, 65536)
                    except OSError as failure:
                        if failure.errno != errno.EIO:
                            raise
                        chunk = b''
                    if not chunk:
                        eof = True
                        break
                    raw.extend(chunk)
                    if mode == 'partial' and not partial_released and len(raw) == partial_expected:
                        os.write(resume_write, b'1')
                        partial_released = True
            if not eof:
                raise TimeoutError('Missing physical native PTY EOF')
            child.wait(timeout=2)
            collect_live()
            self.assertEqual(child.returncode, 0)
            self.assertEqual(termios.tcgetattr(master), attrs)
            header = journal.HEADER.unpack_from(path.read_bytes())
            records = packets if live else []
            result = {'pid': child.pid, 'exitCode': child.returncode, 'eof': eof,
                      'elapsedSeconds': time.monotonic() - started,
                      'observed': observed, 'header': list(header), 'rawBytes': len(raw),
                      'librarySHA256': hashlib.sha256(self.library.read_bytes()).hexdigest(),
                      'binarySHA256': hashlib.sha256(Path(command[0]).read_bytes()).hexdigest(),
                      'registration': registration, 'scope': 'bounded native probe only'}
            (run / 'raw.bin').write_bytes(raw)
            if live:
                header = consumer.header()
                result['finalReaderVerdict'] = 'exclusive-live-copies'
                result['collectionScope'] = 'controlled fixture flow; no UI verdict'
            else:
                try:
                    header, records = journal.final_records(path, registration)
                    result['finalReaderVerdict'] = 'read'
                except journal.JournalError as failure:
                    result['finalReaderVerdict'] = 'failed'
                    result['finalReaderError'] = str(failure)
            (run / 'records.bin').write_bytes(b''.join(struct.pack('<I', len(row)) + row for row in records))
            (run / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
            return header, records, registration, child.pid, bytes(raw)
        except BaseException as failure:
            error = str(failure)
            raise
        finally:
            cleanup_errors = []
            signals_sent = []
            closed_descriptors = []
            def attempt(action, operation):
                try:
                    operation()
                except Exception as failure:
                    cleanup_errors.append({'action': action, 'error': str(failure)})
            if child is not None:
                if child.poll() is None:
                    import signal
                    def stop_owned():
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                            signals_sent.append({'pgid': child.pid, 'signal': 'SIGKILL'})
                        except ProcessLookupError:
                            pass
                    attempt('kill-owned-group', stop_owned)
                attempt('wait-owned-child', lambda: child.wait(timeout=2))
            if consumer is not None:
                attempt('close-native-consumer', consumer.close)
            if selector is not None:
                attempt('close-selector', selector.close)
            owned_fds = [*control_fds, *([master] if master is not None else []),
                         *([slave] if slave is not None else [])]
            for fd in owned_fds:
                def close_fd(fd=fd):
                    os.close(fd)
                    closed_descriptors.append(fd)
                attempt('close-fd-' + str(fd), close_fd)
            (run / 'raw.bin').write_bytes(raw)
            known_packets = packets if live else records
            (run / 'records.bin').write_bytes(b''.join(struct.pack('<I', len(row)) + row for row in known_packets))
            (run / 'cleanup.json').write_text(json.dumps({
                'childPid': child.pid if child else None,
                'childExitCode': child.returncode if child else None,
                'signalsSent': signals_sent,
                'childReaped': child is None or child.poll() is not None,
                'physicalEof': eof, 'error': error,
                'nativeConsumerClosed': consumer is None or consumer.closed,
                'closedDescriptors': closed_descriptors,
                'allDescriptorsClosed': len(closed_descriptors) == len(owned_fds),
                'cleanupErrors': cleanup_errors,
            }) + '\n')
            if cleanup_errors and error is None:
                raise RuntimeError('Native probe cleanup failed: ' + json.dumps(cleanup_errors))

    def test_actual_write_writev_alias_errno_and_immutable_payload(self):
        plain = self.capture(observed=False)
        header, packets, registration, pid, raw = self.capture()
        self.assertEqual(raw, plain[-1])
        records = journal.decode_records(header, packets, registration, pid)
        self.assertEqual(journal.verify_raw(records, raw, termios.OPOST | termios.ONLCR)['verdict'], 'passed')
        writes = [row for row in records if row['kind'] == 1]
        self.assertEqual([row['result'] for row in writes], [5000, 13, -1])
        self.assertEqual(writes[0]['bytes'], b'A' * 4999 + b'\n')
        self.assertEqual(writes[2]['errno'], errno.EBADF)
        self.assertEqual(next(row for row in records if row['kind'] == 11)['bytes'], b'ORIGINAL')
        self.assertEqual(journal.frame_spans(records)[0]['untransformedBytes'], 5013)

    def test_signed_native_device_identity_has_the_same_unsigned_representation(self):
        from types import SimpleNamespace
        endpoint = SimpleNamespace(st_dev=-3, st_ino=123, st_rdev=-1, st_mode=0o20620)
        registration = journal.create_journal(self.root / 'signed-device.bin', endpoint, 3)
        self.assertEqual(registration['header'][14:19],
                         [(1 << 64) - 3, 123, (1 << 64) - 1, 0o20620, 3])

    def test_starved_consumer_never_blocks_original_write_and_loss_fails(self):
        header, packets, registration, pid, raw = self.capture('starve', capacity=2)
        self.assertEqual(raw, b'live\r\n' * 16)
        self.assertGreater(header[10], 0)
        self.assertEqual(packets, [])
        with self.assertRaisesRegex(journal.JournalError, 'reused ring'):
            journal.final_records(registration['path'], registration)
        with self.assertRaisesRegex(journal.JournalError, 'Lost'):
            journal.decode_records(header, packets, registration, pid)

    def test_oversized_payload_is_rejected_without_truncating_product_stdout(self):
        header, packets, registration, pid, raw = self.capture(payload=1024)
        self.assertEqual(raw, self.capture(observed=False)[-1])
        with self.assertRaisesRegex(journal.JournalError, 'Truncated'):
            journal.decode_records(header, packets, registration, pid)

    def test_shared_layout_corruption_does_not_crash_or_skip_original_write(self):
        header, packets, registration, pid, raw = self.capture('corrupt-layout')
        self.assertEqual(raw, self.capture(observed=False)[-1])
        self.assertGreater(header[10], 0)
        with self.assertRaisesRegex(journal.JournalError, 'Lost'):
            journal.decode_records(header, packets, registration, pid)

    def assert_controlled_cleanup(self, mode, **fault):
        before = set(self.root.glob('case-*'))
        with self.assertRaisesRegex(RuntimeError, 'controlled capture failure'):
            self.capture(mode, **fault)
        runs = set(self.root.glob('case-*')) - before
        self.assertEqual(len(runs), 1)
        run = runs.pop()
        cleanup = json.loads((run / 'cleanup.json').read_text())
        self.assertTrue(cleanup['childReaped'])
        self.assertTrue(cleanup['allDescriptorsClosed'])
        self.assertEqual(cleanup['cleanupErrors'], [])
        self.assertEqual(cleanup['error'], 'controlled capture failure')
        with self.assertRaises(ProcessLookupError):
            os.killpg(cleanup['childPid'], 0)

    def test_nonpartial_owned_child_is_reaped_on_capture_failure(self):
        self.assert_controlled_cleanup('hang', fail_after_start=True)

    def test_partial_owned_child_is_reaped_without_rereading_ready_pipe(self):
        self.assert_controlled_cleanup('partial', fail_after_receipt=True)

    def test_live_failure_preserves_the_actual_already_acquired_packet_prefix(self):
        before = set(self.root.glob('case-*'))
        with self.assertRaisesRegex(RuntimeError, 'controlled live collector failure'):
            self.capture('reuse', capacity=4, live=True, fail_after_live_records=4)
        run = (set(self.root.glob('case-*')) - before).pop()
        saved = (run / 'records.bin').read_bytes()
        packets = []
        offset = 0
        while offset < len(saved):
            length = struct.unpack_from('<I', saved, offset)[0]
            offset += 4
            self.assertLessEqual(offset + length, len(saved))
            packets.append(saved[offset:offset + length])
            offset += length
        self.assertEqual(len(packets), 4)
        metadata = [journal.RECORD.unpack_from(row) for row in packets]
        self.assertEqual([row[1] for row in metadata], [1, 2, 3, 4])
        self.assertEqual([row[2] for row in metadata], [10, 11, 12, 1])
        self.assertEqual(packets[1][journal.RECORD.size:], b'ORIGINAL')
        self.assertEqual(packets[3][journal.RECORD.size:], b'reuse\n')
        cleanup = json.loads((run / 'cleanup.json').read_text())
        self.assertEqual(cleanup['error'], 'controlled live collector failure')
        self.assertTrue(cleanup['childReaped'] and cleanup['allDescriptorsClosed'])
        self.assertEqual(cleanup['cleanupErrors'], [])
        self.assertFalse(cleanup['physicalEof'])
        start = json.loads((run / 'start.json').read_text())
        header = journal.HEADER.unpack_from((run / 'journal.bin').read_bytes())
        with self.assertRaisesRegex(journal.JournalError, 'close boundary'):
            journal.decode_records(header, packets, start['registration'], start['childPid'])

    def test_foreign_registration_is_rejected_before_a_slot_is_released(self):
        header, packets, registration, pid, raw = self.capture()
        foreign = copy.deepcopy(registration)
        foreign['header'][7] ^= 1
        with self.assertRaisesRegex(journal.JournalError, 'registration'):
            with journal.NativeConsumer(registration['path'], foreign, self.library):
                pass
        with journal.NativeConsumer(registration['path'], registration, self.library, expected_pid=pid) as consumer:
            self.assertEqual(consumer.consume(2), packets[1])

    def test_native_consume_checks_registered_nonce_and_producer_before_acquire(self):
        header, packets, registration, pid, raw = self.capture()
        library = ctypes.CDLL(str(self.library))
        function = library.cc_terminal_journal_consume
        function.argtypes = [ctypes.c_void_p, ctypes.c_uint64, ctypes.c_uint64,
                             ctypes.c_void_p, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_uint64]
        function.restype = ctypes.c_int
        import mmap
        with open(registration['path'], 'r+b') as file, mmap.mmap(file.fileno(), 0) as mapping:
            pin = (ctypes.c_ubyte * len(mapping)).from_buffer(mapping)
            destination = ctypes.create_string_buffer(journal.RECORD.size + registration['payloadBytes'])
            original = (ctypes.c_uint64 * 32)(*registration['header'])
            foreign = (ctypes.c_uint64 * 32)(*registration['header'])
            foreign[7] ^= 1
            try:
                self.assertEqual(function(pin, len(mapping), 2, destination, len(destination), foreign, pid), -1)
                self.assertEqual(function(pin, len(mapping), 2, destination, len(destination), original, pid + 1), -1)
            finally:
                del pin
        with journal.NativeConsumer(registration['path'], registration, self.library, expected_pid=pid) as consumer:
            self.assertEqual(consumer.consume(2), packets[1])

    def test_first_control_pipe_is_registered_before_second_pipe_failure(self):
        from unittest.mock import patch
        original = os.pipe
        allocated = []
        def fail_second_pipe():
            if allocated:
                raise RuntimeError('second pipe initialization failed')
            fds = original()
            allocated.extend(fds)
            return fds
        before = set(self.root.glob('case-*'))
        with patch.object(os, 'pipe', side_effect=fail_second_pipe):
            with self.assertRaisesRegex(RuntimeError, 'second pipe initialization failed'):
                self.capture('partial')
        for fd in allocated:
            with self.assertRaises(OSError) as context:
                os.fstat(fd)
            self.assertEqual(context.exception.errno, errno.EBADF)
        run = (set(self.root.glob('case-*')) - before).pop()
        cleanup = json.loads((run / 'cleanup.json').read_text())
        self.assertTrue(cleanup['allDescriptorsClosed'])
        self.assertEqual(set(allocated) - set(cleanup['closedDescriptors']), set())
        self.assertEqual(cleanup['cleanupErrors'], [])

    def test_initialized_pty_and_control_fds_close_when_consumer_startup_fails(self):
        from unittest.mock import patch
        before = set(self.root.glob('case-*'))
        with patch.object(journal, 'NativeConsumer', side_effect=RuntimeError('controlled initialization failure')):
            with self.assertRaisesRegex(RuntimeError, 'controlled initialization failure'):
                self.capture('reuse', live=True)
        runs = set(self.root.glob('case-*')) - before
        self.assertEqual(len(runs), 1)
        cleanup = json.loads((runs.pop() / 'cleanup.json').read_text())
        self.assertIsNone(cleanup['childPid'])
        self.assertTrue(cleanup['childReaped'])
        self.assertTrue(cleanup['allDescriptorsClosed'])
        self.assertEqual(cleanup['cleanupErrors'], [])
        self.assertGreaterEqual(len(cleanup['closedDescriptors']), 4)

    def test_same_consumer_rejects_foreign_thread_access_and_close(self):
        import threading
        header, packets, registration, pid, raw = self.capture()
        with journal.NativeConsumer(registration['path'], registration, self.library, expected_pid=pid) as consumer:
            results = []
            def foreign():
                for action in (lambda: consumer.consume(2), consumer.close):
                    try:
                        action()
                    except journal.JournalError as error:
                        results.append(str(error))
                    else:
                        results.append('accepted')
            thread = threading.Thread(target=foreign)
            thread.start()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(len(results), 2)
            self.assertTrue(all('owner thread' in value for value in results))
            self.assertEqual(consumer.consume(2), packets[1])

    def test_actual_live_slot_reuse_preserves_every_exclusive_packet(self):
        header, packets, registration, pid, raw = self.capture('reuse', capacity=4, live=True)
        self.assertEqual(raw, b'reuse\r\n' * 40)
        self.assertEqual(header[10], 0)
        self.assertEqual(header[9], 44)
        records = journal.decode_records(header, packets, registration, pid)
        self.assertEqual(len(records), 44)
        self.assertEqual(len([row for row in records if row['kind'] == 1]), 40)
        journal.verify_raw(records, raw, termios.OPOST | termios.ONLCR)
        with self.assertRaisesRegex(journal.JournalError, 'reused ring'):
            journal.final_records(registration['path'], registration)
        data = (Path(registration['path']).parent / 'records.bin').read_bytes()
        self.assertEqual(data, b''.join(struct.pack('<I', len(row)) + row for row in packets))

    def test_actual_committed_slot_can_be_acquired_by_only_one_consumer(self):
        import threading
        header, packets, registration, pid, raw = self.capture()
        path = Path(registration['path'])
        barrier = threading.Barrier(3)
        results, failures = [], []
        def take():
            try:
                with journal.NativeConsumer(path, registration, self.library, expected_pid=pid) as consumer:
                    barrier.wait(timeout=2)
                    results.append(consumer.consume(2))
            except BaseException as failure:
                failures.append(str(failure))
        threads = [threading.Thread(target=take) for _ in range(2)]
        for thread in threads:
            thread.start()
        barrier.wait(timeout=2)
        for thread in threads:
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
        self.assertEqual(failures, [])
        copied = [row for row in results if row is not None]
        self.assertEqual(len(copied), 1)
        self.assertEqual(copied[0], packets[1])
        with journal.NativeConsumer(path, registration, self.library, expected_pid=pid) as consumer:
            self.assertIsNone(consumer.consume(2))

    def test_saved_packets_are_complete_immutable_native_records(self):
        header, packets, registration, pid, raw = self.capture()
        data = (Path(registration['path']).parent / 'records.bin').read_bytes()
        saved = []
        offset = 0
        while offset < len(data):
            self.assertLessEqual(offset + 4, len(data))
            length = struct.unpack_from('<I', data, offset)[0]
            offset += 4
            self.assertGreaterEqual(length, journal.RECORD.size)
            self.assertLessEqual(offset + length, len(data))
            saved.append(data[offset:offset + length])
            offset += length
        self.assertGreater(len(saved), 0)
        self.assertEqual(saved, packets)
        records = journal.decode_records(header, saved, registration, pid)
        self.assertEqual(next(row for row in records if row['kind'] == 11)['bytes'], b'ORIGINAL')
        journal.verify_raw(records, raw, termios.OPOST | termios.ONLCR)

    def test_actual_bun_cli_version_output_is_covered_by_native_syscalls(self):
        binary = Path(os.environ['JOURNAL_TEST_BINARY']).resolve(strict=True)
        original_sha = hashlib.sha256(binary.read_bytes()).hexdigest()
        plain = self.capture(observed=False, binary=binary)
        header, packets, registration, pid, raw = self.capture(binary=binary)
        self.assertEqual(raw, plain[-1])
        self.assertIn(b'Claude Code', raw)
        records = journal.decode_records(header, packets, registration, pid)
        self.assertGreater(len([row for row in records if row['kind'] == 1]), 0)
        journal.verify_raw(records, raw, termios.OPOST | termios.ONLCR)
        self.assertEqual(hashlib.sha256(binary.read_bytes()).hexdigest(), original_sha)

    def test_actual_nocancel_symbols_preserve_original_errno(self):
        plain = self.capture('nocancel', observed=False)
        header, packets, registration, pid, raw = self.capture('nocancel')
        self.assertEqual(raw, plain[-1])
        records = journal.decode_records(header, packets, registration, pid)
        writes = [row for row in records if row['kind'] == 1]
        self.assertEqual([row['operation'] for row in writes], [3, 4])
        self.assertEqual([row['result'] for row in writes], [6, 7])
        self.assertTrue(all(row['errno'] == errno.EALREADY for row in writes))
        journal.verify_raw(records, raw, termios.OPOST | termios.ONLCR)

    def test_actual_partial_write_retains_only_successful_original_prefix(self):
        header, packets, registration, pid, raw = self.capture('partial')
        records = journal.decode_records(header, packets, registration, pid)
        writes = [row for row in records if row['kind'] == 1]
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0]['requested'], 65536)
        self.assertGreater(writes[0]['result'], 0)
        self.assertLess(writes[0]['result'], 65536)
        self.assertEqual(writes[0]['bytes'], raw)
        self.assertEqual(raw, b'B' * writes[0]['result'])
        journal.verify_raw(records, raw, termios.OPOST | termios.ONLCR)

    def test_actual_invalid_source_does_not_crash_or_change_original_errno(self):
        header, packets, registration, pid, raw = self.capture('bad-memory')
        self.assertEqual(raw, b'')
        metadata = [journal.RECORD.unpack_from(row) for row in packets]
        write = next(row for row in metadata if row[2] == 1)
        self.assertEqual(write[11], (1 << 64) - 1)
        self.assertEqual(write[12], errno.EFAULT)
        with self.assertRaisesRegex(journal.JournalError, 'Truncated'):
            journal.decode_records(header, packets, registration, pid)

    def test_multiple_actual_threads_are_not_given_a_guessed_kernel_order(self):
        header, packets, registration, pid, raw = self.capture('threads')
        records = journal.decode_records(header, packets, registration, pid)
        with self.assertRaisesRegex(journal.JournalError, 'Multiple writers'):
            journal.verify_raw(records, raw, termios.OPOST | termios.ONLCR)

    def test_foreign_missing_corrupted_or_reordered_records_stay_failed(self):
        header, packets, registration, pid, raw = self.capture()
        for changed, records, expected, message in [
            (header, packets, pid + 1, 'Foreign'),
            (tuple([*header[:11], 0, *header[12:]]), packets, pid, 'close'),
            (header, packets[:-1], pid, 'Missing'),
            (header, packets[::-1], pid, 'Foreign'),
        ]:
            with self.subTest(message=message), self.assertRaisesRegex(journal.JournalError, message):
                journal.decode_records(changed, records, registration, expected)
        records = journal.decode_records(header, packets, registration, pid)
        with self.assertRaisesRegex(journal.JournalError, 'Unowned'):
            journal.verify_raw(records, raw + b'foreign', termios.OPOST | termios.ONLCR)
        altered = copy.deepcopy(records)
        writes = [row for row in altered if row['kind'] == 1]
        writes[1]['entry'] = writes[0]['entry']
        with self.assertRaisesRegex(journal.JournalError, 'Overlapping'):
            journal.verify_raw(altered, raw, termios.OPOST | termios.ONLCR)
        altered = copy.deepcopy(records)
        next(row for row in altered if row['kind'] == 12)['return'] = next(row for row in altered if row['kind'] == 1)['return'] + 1
        with self.assertRaisesRegex(journal.JournalError, 'crosses'):
            journal.frame_spans(altered)


if __name__ == '__main__':
    unittest.main()

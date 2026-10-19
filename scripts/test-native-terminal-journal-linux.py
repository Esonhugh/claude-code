#!/usr/bin/env python3
"""Linux seccomp/ptrace native-slot regressions. Never complete UI acceptance."""
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
import signal
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
BUNS = [Path(path) for path in os.environ.get(
    'JOURNAL_TEST_BUNS', '/opt/bun-1.3.14/bin/bun:/root/.bun/bin/bun').split(':') if path]
OUTPUT_FLAGS = termios.OPOST | termios.ONLCR
PROBE = r'''
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/io_uring.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/sendfile.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
extern char **environ;
static long inline_write(int fd,const void *bytes,size_t length){
 long result;
 __asm__ volatile("syscall":"=a"(result):"0"((long)SYS_write),"D"((long)fd),"S"(bytes),"d"(length):"rcx","r11","memory");
 return result;
}
static void *other(void *unused){(void)unused;write(1,"thread\n",7);return NULL;}
static void *numbered(void *value){char line[]="t00\n";int n=(int)(intptr_t)value;line[1]=(char)('0'+n/10);line[2]=(char)('0'+n%10);return write(1,line,4)==4?NULL:(void*)1;}
static int reader_tid;
static void *blocked_reader(void *unused){
 (void)unused;char bytes[128];
 __atomic_store_n(&reader_tid,(int)gettid(),__ATOMIC_RELEASE);
 if(read(0,bytes,sizeof(bytes))!=10||memcmp(bytes,"\x1b[A\x1b[Btest",10))return (void*)1;
 if(write(1,"thread\n",7)!=7)return (void*)1;
 return NULL;
}
static int blocked_in_read(int tid){
 char path[64],line[64];snprintf(path,sizeof(path),"/proc/self/task/%d/syscall",tid);
 int fd=open(path,O_RDONLY);if(fd<0)return 0;
 ssize_t n=read(fd,line,sizeof(line)-1);close(fd);
 return n>1&&line[0]=='0'&&line[1]==' ';
}
static void on_signal(int unused){(void)unused;if(write(1,"sig\n",4)!=4)_exit(122);}
static int uring_write(void){
 struct io_uring_params params;memset(&params,0,sizeof(params));
 int fd=(int)syscall(SYS_io_uring_setup,4,&params);if(fd<0)return -1;
 size_t sq_bytes=params.sq_off.array+params.sq_entries*sizeof(unsigned);
 unsigned char *sq=mmap(NULL,sq_bytes,PROT_READ|PROT_WRITE,MAP_SHARED|MAP_POPULATE,fd,IORING_OFF_SQ_RING);
 struct io_uring_sqe *sqes=mmap(NULL,params.sq_entries*sizeof(struct io_uring_sqe),PROT_READ|PROT_WRITE,MAP_SHARED|MAP_POPULATE,fd,IORING_OFF_SQES);
 if(sq==MAP_FAILED||sqes==MAP_FAILED){close(fd);return -1;}
 unsigned *tail=(unsigned*)(sq+params.sq_off.tail),*mask=(unsigned*)(sq+params.sq_off.ring_mask),*array=(unsigned*)(sq+params.sq_off.array);
 unsigned index=*tail&*mask;struct io_uring_sqe *sqe=sqes+index;memset(sqe,0,sizeof(*sqe));
 sqe->opcode=IORING_OP_WRITE;sqe->fd=1;sqe->addr=(uint64_t)(uintptr_t)"uring\n";sqe->len=6;sqe->off=(uint64_t)-1;
 array[index]=index;__atomic_store_n(tail,*tail+1,__ATOMIC_RELEASE);
 int submitted=(int)syscall(SYS_io_uring_enter,fd,1,1,IORING_ENTER_GETEVENTS,NULL,0);
 close(fd);return submitted;
}
int main(int argc,char **argv){
 const char *mode=argc>1?argv[1]:"large",*path=getenv("CLAUDE_PRIVATE_NATIVE_JOURNAL_LIBRARY");
 void *library=path?dlopen(path,RTLD_NOW):NULL;
 uint64_t(*mark)(uint64_t,uint64_t,const void*,uint64_t)=library?(uint64_t(*)(uint64_t,uint64_t,const void*,uint64_t))dlsym(library,"cc_terminal_journal_mark"):NULL;
 char observation[]="ORIGINAL";
 void *volatile bad=(void*)1;
 if(path&&!mark)return 70;
 if(mark){mark(10,1,"layout",6);mark(11,1,observation,8);observation[0]='X';mark(12,1,NULL,0);}
 if(!strcmp(mode,"hang")){pause();return 88;}
 if(!strcmp(mode,"threads")){
  pthread_t thread;if(pthread_create(&thread,NULL,other,NULL))return 75;
  if(write(1,"main\n",5)!=5)return 76;
  pthread_join(thread,NULL);
 }else if(!strcmp(mode,"threads-many")){
  // New threads write immediately: their first stops race the CLONE events.
  pthread_t threads[16];void *failed=NULL;
  for(int i=0;i<16;i++)if(pthread_create(threads+i,NULL,numbered,(void*)(intptr_t)i))return 75;
  for(int i=0;i<16;i++)if(pthread_join(threads[i],&failed)||failed)return 76;
 }else if(!strcmp(mode,"threads-overlap")){
  pthread_t thread;void *failed=NULL;if(pthread_create(&thread,NULL,blocked_reader,NULL))return 75;
  int tid;while(!(tid=__atomic_load_n(&reader_tid,__ATOMIC_ACQUIRE)))usleep(1000);
  while(!blocked_in_read(tid))usleep(1000);
  if(write(1,"main\n",5)!=5||write(1,"input-ready\n",12)!=12)return 76;
  if(pthread_join(thread,&failed)||failed)return 77;
 }else if(!strcmp(mode,"restart")||!strcmp(mode,"norestart")){
  struct sigaction action;memset(&action,0,sizeof(action));action.sa_handler=on_signal;
  action.sa_flags=!strcmp(mode,"restart")?SA_RESTART:0;
  if(sigaction(SIGUSR1,&action,NULL))return 118;
  int fd=dup(0);char bytes[128];if(fd<0)return 119;
  if(write(1,"input-ready\n",12)!=12)return 119;
  ssize_t returned=read(fd,bytes,sizeof(bytes));
  if(!strcmp(mode,"restart")){if(returned!=10||memcmp(bytes,"\x1b[A\x1b[Btest",10))return 120;}
  else if(returned!=-1||errno!=EINTR||write(1,"eintr\n",6)!=6)return 121;
  close(fd);
 }else if(!strncmp(mode,"input-",6)){
  int fd=dup(0);if(fd<0)return 101;
  char bytes[256];memset(bytes,'X',sizeof(bytes));
  ssize_t returned;errno=EALREADY;
  if(!strcmp(mode,"input-foreign")){
   int pipefd[2];if(pipe(pipefd))return 114;
   if(write(pipefd[1],"foreign",7)!=7)return 115;
   close(pipefd[1]);
   errno=EALREADY;if(read(pipefd[0],bytes,128)!=7||errno!=EALREADY||memcmp(bytes,"foreign",7))return 116;
   errno=EALREADY;if(read(pipefd[0],bytes,128)||errno!=EALREADY)return 117;close(pipefd[0]);
  }else if(!strcmp(mode,"input-empty")||!strcmp(mode,"input-emptyv")){
   returned=!strcmp(mode,"input-emptyv")?readv(fd,NULL,0):read(fd,bytes,0);
   if(returned!=0||errno!=EALREADY)return 102;
  }else if(!strcmp(mode,"input-failed")){
   int flags=fcntl(fd,F_GETFL);if(flags<0||fcntl(fd,F_SETFL,flags|O_NONBLOCK))return 103;
   errno=EALREADY;if(read(fd,bytes,1)!=-1||errno!=EAGAIN)return 104;
   if(fcntl(fd,F_SETFL,flags))return 105;
   struct iovec part={bytes,1};
   if(pread(fd,bytes,1,0)!=-1||errno!=ESPIPE)return 123;
   if(preadv(fd,&part,1,0)!=-1||errno!=ESPIPE)return 124;
   int saved=dup(0);if(saved<0)return 106;close(0);
   if(read(0,bytes,1)!=-1||errno!=EBADF)return 107;
   if(dup2(saved,0)<0)return 108;
   close(saved);
  }else{
   if(write(1,"input-ready\n",12)!=12)return 109;
   errno=EALREADY;
   if(!strcmp(mode,"input-readv")||!strcmp(mode,"input-preadv2")){
    struct iovec parts[2]={{bytes,3},{bytes+3,125}};
    returned=!strcmp(mode,"input-readv")?readv(fd,parts,2):preadv2(fd,parts,2,-1,0);
   }else if(!strcmp(mode,"input-preadv2-nowait")){
    // Bun's stdin path: libc syscall() preadv2(..., -1, RWF_NOWAIT) after
    // readiness, falling back to read() where the file lacks FMODE_NOWAIT.
    struct iovec part={bytes,128};struct pollfd ready={fd,POLLIN,0};
    if(poll(&ready,1,5000)!=1)return 110;
    errno=EALREADY;returned=syscall(SYS_preadv2,fd,&part,1,-1L,0L,RWF_NOWAIT);
    if(returned==-1&&errno==EOPNOTSUPP){errno=EALREADY;returned=read(fd,bytes,128);}
   }else if(!strcmp(mode,"input-bad-memory")||!strcmp(mode,"input-bad-iov")){
    returned=!strcmp(mode,"input-bad-iov")?readv(fd,(const struct iovec*)bad,1):read(fd,bad,128);if(returned!=-1||errno!=EFAULT)return 111;
   }else{
    returned=read(fd,bytes,128);
   }
   if(strcmp(mode,"input-bad-memory")&&strcmp(mode,"input-bad-iov")&&
      (returned!=(!strcmp(mode,"input-eof")?0:10)||errno!=EALREADY))return 112;
   if(returned>0&&memcmp(bytes,"\x1b[A\x1b[Btest",10))return 113;
   memset(bytes,'Y',sizeof(bytes));
  }
  close(fd);
 }else if(!strcmp(mode,"termios-cycle")||!strcmp(mode,"termios-output-cycle")){
  struct termios original,changed;
  if(tcgetattr(1,&original))return 90;
  changed=original;
  if(!strcmp(mode,"termios-output-cycle"))changed.c_oflag&=~OPOST;else changed.c_lflag^=ECHO;
  errno=EALREADY;if(tcsetattr(1,TCSANOW,&changed)||errno!=EALREADY)return 91;
  if(write(1,"mode\n",5)!=5)return 92;
  errno=EALREADY;if(tcsetattr(1,TCSANOW,&original)||errno!=EALREADY)return 93;
  if(write(1,"restored\n",9)!=9)return 94;
 }else if(!strcmp(mode,"termios-failed")){
  // glibc rejects an unknown action before the kernel; a bad pointer reaches it.
  errno=EALREADY;if(ioctl(1,TCSETS,(void*)1)!=-1||errno!=EFAULT)return 96;
  if(write(1,"failed-mode\n",12)!=12)return 97;
 }else if(!strcmp(mode,"raw-syscalls")){
  struct iovec parts[2]={{"vec",3},{"tor\n",4}};
  errno=EALREADY;if(inline_write(1,"inline\n",7)!=7||errno!=EALREADY)return 80;
  errno=EALREADY;if(write(1,"libc\n",5)!=5||errno!=EALREADY)return 81;
  if(pwrite(1,"pwrite\n",7,0)!=-1||errno!=ESPIPE)return 82;
  if(pwritev(1,parts,2,0)!=-1||errno!=ESPIPE)return 83;
  errno=EALREADY;if(pwritev2(1,parts,2,-1,0)!=7||errno!=EALREADY)return 84;
 }else if(!strcmp(mode,"bad-memory")){
  errno=0;if(write(1,bad,8)!=-1||errno!=EFAULT)return 83;
 }else if(!strcmp(mode,"partial")){
  int flags=fcntl(1,F_GETFL);if(flags<0||fcntl(1,F_SETFL,flags|O_NONBLOCK))return 84;
  static char bytes[65536];memset(bytes,'B',sizeof(bytes));
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
 }else if(!strcmp(mode,"child-endpoint")){
  pid_t child=fork();if(child<0)return 130;
  if(!child)_exit(write(1,"child\n",6)==6?0:1);
  int status;if(waitpid(child,&status,0)!=child||!WIFEXITED(status)||WEXITSTATUS(status))return 131;
  if(write(1,"parent\n",7)!=7)return 132;
 }else if(!strcmp(mode,"child-pipe")){
  int pipefd[2];if(pipe(pipefd))return 133;
  posix_spawn_file_actions_t actions;pid_t child;char bytes[64];ssize_t total=0,n;
  char *child_argv[]={"echo","piped",NULL};
  if(posix_spawn_file_actions_init(&actions)||posix_spawn_file_actions_adddup2(&actions,pipefd[1],1)||
     posix_spawn_file_actions_addclose(&actions,pipefd[0])||
     posix_spawn(&child,"/bin/echo",&actions,NULL,child_argv,environ))return 134;
  close(pipefd[1]);
  while((n=read(pipefd[0],bytes+total,sizeof(bytes)-(size_t)total))>0)total+=n;
  int status;if(waitpid(child,&status,0)!=child||!WIFEXITED(status)||WEXITSTATUS(status))return 135;
  if(total!=6||memcmp(bytes,"piped\n",6)||write(1,"child-pipe-ok\n",14)!=14)return 136;
 }else if(!strcmp(mode,"sendfile")){
  int fd=open("sendfile.txt",O_RDWR|O_CREAT|O_TRUNC,0600);
  if(fd<0||write(fd,"sendfile\n",9)!=9||lseek(fd,0,SEEK_SET))return 140;
  if(sendfile(1,fd,NULL,9)!=9)return 141;
 }else if(!strcmp(mode,"splice")){
  int pipefd[2];if(pipe(pipefd)||write(pipefd[1],"splice\n",7)!=7)return 142;
  if(splice(pipefd[0],NULL,1,NULL,7,0)!=7)return 143;
 }else if(!strcmp(mode,"io-uring")){
  uring_write();
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
DENY_PTRACE = r'''
#define _GNU_SOURCE
#include <errno.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>
int main(int argc,char **argv){
 struct sock_filter program[]={
  BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
  BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,SYS_ptrace,0,1),
  BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
  BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)};
 struct sock_fprog filter={4,program};
 if(argc<2||prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)||prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&filter))return 126;
 execv(argv[1],argv+1);return 127;
}
'''


def blocked_in_read(pid):
    try:
        return Path(f'/proc/{pid}/syscall').read_text().split()[0] == '0'
    except (OSError, IndexError):
        return False


@unittest.skipUnless(sys.platform.startswith('linux'), 'Linux observer only')
class LinuxNativeJournalTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix='cc-journal-linux-'))
        cls.env = {'PATH': '/usr/bin:/bin', 'HOME': str(cls.root),
                   'TMPDIR': str(cls.root), 'CLAUDE_CONFIG_DIR': str(cls.root / 'config'),
                   'DISABLE_TELEMETRY': '1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
                   'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1'}
        (cls.root / 'config').mkdir()
        cls.library = cls.root / 'observer.so'
        cls.observer = cls.root / 'observer-exec'
        cls.probe = cls.root / 'probe'
        cls.deny_ptrace = cls.root / 'deny-ptrace'
        (cls.root / 'probe.c').write_text(PROBE)
        (cls.root / 'deny-ptrace.c').write_text(DENY_PTRACE)
        source = str(SOURCE / 'native-terminal-journal-linux.c')
        strict = ['/usr/bin/cc', '-std=c11', '-Wall', '-Wextra', '-Werror']
        for command, name in [
            ([*strict, '-O2', '-fPIC', '-shared', source, '-o', str(cls.library)], 'library'),
            ([*strict, '-O2', '-DCC_OBSERVER_EXEC', source, '-o', str(cls.observer)], 'observer-exec'),
            ([*strict, str(cls.root / 'probe.c'), '-o', str(cls.probe), '-lpthread', '-ldl'], 'probe'),
            ([*strict, str(cls.root / 'deny-ptrace.c'), '-o', str(cls.deny_ptrace)], 'deny-ptrace'),
        ]:
            result = subprocess.run(command, env=cls.env, cwd=cls.root,
                                    capture_output=True, timeout=30)
            (cls.root / (name + '-compile.log')).write_bytes(result.stdout + result.stderr)
            if result.returncode:
                raise RuntimeError(result.stderr.decode())
        # observer-exec double-forks its tracer; this process reaps it.
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(36, 1, 0, 0, 0):  # PR_SET_CHILD_SUBREAPER
            raise OSError(ctypes.get_errno(), 'PR_SET_CHILD_SUBREAPER')
        print(json.dumps({'evidence': str(cls.root),
                          'librarySHA256': hashlib.sha256(cls.library.read_bytes()).hexdigest(),
                          'observerExecSHA256': hashlib.sha256(cls.observer.read_bytes()).hexdigest()}),
              flush=True)

    def test_native_resize_brackets_real_ioctl_and_preserves_errno(self):
        library = ctypes.CDLL(str(self.library), use_errno=True)
        function = library.cc_terminal_native_resize
        function.argtypes = [ctypes.c_int, ctypes.c_uint64, ctypes.POINTER(ctypes.c_uint64)]
        function.restype = ctypes.c_int
        master, slave = pty.openpty()
        try:
            original = struct.pack('HHHH', 30, 100, 0, 0)
            requested = struct.pack('HHHH', 34, 110, 0, 0)
            fcntl.ioctl(slave, termios.TIOCSWINSZ, original)
            receipt = (ctypes.c_uint64 * 12)()
            ctypes.set_errno(errno.EALREADY)
            before = time.clock_gettime_ns(time.CLOCK_MONOTONIC)
            result = function(master, struct.unpack('<Q', requested)[0], receipt)
            after = time.clock_gettime_ns(time.CLOCK_MONOTONIC)
            self.assertEqual(result, 0)
            self.assertEqual(ctypes.get_errno(), errno.EALREADY)
            self.assertTrue(before <= receipt[0] <= receipt[1] <= after)
            self.assertEqual(receipt[2:4], [0, errno.EALREADY])
            self.assertEqual(receipt[4:6], [struct.unpack('<Q', original)[0], struct.unpack('<Q', requested)[0]])
            self.assertEqual(receipt[6:10], [0, errno.EALREADY, 0, errno.EALREADY])
            self.assertEqual(receipt[10:12], [1, 1])
            self.assertEqual(fcntl.ioctl(slave, termios.TIOCGWINSZ, b'\0' * 8), requested)
            failed = (ctypes.c_uint64 * 12)()
            self.assertEqual(function(-1, struct.unpack('<Q', requested)[0], failed), -1)
            self.assertEqual(ctypes.get_errno(), errno.EBADF)
            self.assertEqual(failed[2], (1 << 64) - 1)
            self.assertEqual(failed[3], errno.EBADF)
            self.assertEqual(failed[6], (1 << 64) - 1)
            self.assertEqual(failed[8], (1 << 64) - 1)
        finally:
            os.close(master)
            os.close(slave)

    def capture(self, mode='large', capacity=64, payload=65536, observed=True, binary=None, arguments=None,
                registered=None, prefix=(), platform='linux', extra_env=None, exit_code=0, interact=None,
                fail_after_start=False, fail_after_receipt=False, live=False, fail_after_live_records=0,
                input_bytes=None):
        run = self.root / f'case-{len(list(self.root.glob("case-*")))}'
        run.mkdir()
        master = slave = None
        control_fds = []
        consumer = selector = child = None
        tracer = tracer_status = None
        raw = bytearray()
        records = packets = []
        eof = False
        error = None
        started = time.monotonic()
        self.tracer = None
        try:
            master, slave = pty.openpty()
            attrs = termios.tcgetattr(slave)
            self.assertEqual(attrs[1], OUTPUT_FLAGS)
            if mode.startswith('input-') or mode in ('restart', 'norestart', 'threads-overlap'):
                attrs[3] &= ~termios.ECHO
                if mode != 'input-eof':
                    attrs[0] &= ~(termios.ICRNL | termios.IXON)
                    attrs[3] &= ~(termios.ICANON | termios.IEXTEN)
                    attrs[6][termios.VMIN] = 1
                    attrs[6][termios.VTIME] = 0
                termios.tcsetattr(slave, termios.TCSANOW, attrs)
                attrs = termios.tcgetattr(slave)
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
            path = run / 'journal.bin'
            registration = journal.create_journal(path, os.fstat(slave), 3, capacity, payload, platform)
            env = dict(self.env, **(extra_env or {}))
            product = [str(binary or self.probe), *(arguments if arguments is not None else [mode])]
            command = product
            pass_fds = []
            if observed:
                report_read, report_write = os.pipe()
                control_fds.extend([report_read, report_write])
                pass_fds.append(report_write)
                env.update(CLAUDE_PRIVATE_NATIVE_JOURNAL=str(path),
                           CLAUDE_PRIVATE_NATIVE_JOURNAL_LIBRARY=str(self.library))
                command = [*map(str, prefix), str(self.observer), '--journal', str(path),
                           '--binary', str(registered or product[0]),
                           '--tracer-pid-fd', str(report_write), '--', *product]
            partial_expected = None
            partial_released = False
            input_sent = False
            if mode == 'partial':
                ready_read, ready_write = os.pipe()
                control_fds.extend([ready_read, ready_write])
                resume_read, resume_write = os.pipe()
                control_fds.extend([resume_read, resume_write])
                env.update(PARTIAL_SIGNAL_FD=str(ready_write), PARTIAL_CONTINUE_FD=str(resume_read))
                pass_fds.extend([ready_write, resume_read])
            if mode == 'reuse':
                reuse_read, reuse_write = os.pipe()
                control_fds.extend([reuse_read, reuse_write])
                env['REUSE_CONTINUE_FD'] = str(reuse_read)
                pass_fds.append(reuse_read)
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
                                     pass_fds=pass_fds)
            if observed:
                os.close(report_write)
                control_fds.remove(report_write)
                report = b''
                with selectors.DefaultSelector() as report_selector:
                    report_selector.register(report_read, selectors.EVENT_READ)
                    while time.monotonic() - started < 5 and report_selector.select(5):
                        chunk = os.read(report_read, 64)
                        if not chunk:
                            break
                        report += chunk
                tracer = int(report) if report.strip() else None
                self.tracer = {'pid': tracer}
            if consumer is not None:
                consumer.bind_producer(child.pid)
            (run / 'start.json').write_text(json.dumps({'childPid': child.pid, 'childPgid': child.pid,
                                                        'tracerPid': tracer, 'command': command,
                                                        'registration': registration}) + '\n')
            if fail_after_start:
                raise RuntimeError('controlled capture failure')
            if mode == 'partial':
                ready_selector = selectors.DefaultSelector()
                try:
                    ready_selector.register(ready_read, selectors.EVENT_READ)
                    if not ready_selector.select(5):
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
            context = {'raw': raw, 'child': child, 'master': master, 'tracer': tracer, 'path': path}
            while not eof and time.monotonic() - started < 20:
                collect_live()
                if interact is not None:
                    interact(context)
                for key, _ in selector.select(.05):
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
                    if input_bytes is not None and not input_sent and b'input-ready\r\n' in raw:
                        self.assertEqual(os.write(master, input_bytes), len(input_bytes))
                        input_sent = True
                    if mode == 'partial' and not partial_released and len(raw) == partial_expected:
                        os.write(resume_write, b'1')
                        partial_released = True
            if not eof:
                raise TimeoutError('Missing physical native PTY EOF')
            child.wait(timeout=5)
            collect_live()
            if tracer is not None:
                tracer_status = self.reap(tracer, 5)
                self.tracer['status'] = tracer_status
            if exit_code is not None:
                self.assertEqual(child.returncode, exit_code, bytes(raw))
            self.assertEqual(termios.tcgetattr(master), attrs)
            header = journal.HEADER.unpack_from(path.read_bytes())
            records = packets if live else []
            result = {'pid': child.pid, 'exitCode': child.returncode, 'eof': eof,
                      'tracerPid': tracer, 'tracerStatus': tracer_status,
                      'elapsedSeconds': time.monotonic() - started,
                      'observed': observed, 'header': list(header), 'rawBytes': len(raw),
                      'librarySHA256': hashlib.sha256(self.library.read_bytes()).hexdigest(),
                      'observerExecSHA256': hashlib.sha256(self.observer.read_bytes()).hexdigest(),
                      'binarySHA256': hashlib.sha256(Path(product[0]).read_bytes()).hexdigest(),
                      'registration': registration, 'scope': 'bounded native probe only',
                      'inputBytesHex': input_bytes.hex() if input_bytes is not None else None,
                      'inputSent': input_sent}
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
                    def stop_owned():
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                            signals_sent.append({'pgid': child.pid, 'signal': 'SIGKILL'})
                        except ProcessLookupError:
                            pass
                    attempt('kill-owned-group', stop_owned)
                attempt('wait-owned-child', lambda: child.wait(timeout=5))
            if tracer is not None and tracer_status is None:
                def stop_tracer():
                    nonlocal tracer_status
                    tracer_status = self.reap(tracer, 2, kill=True)
                attempt('reap-tracer', stop_tracer)
            attempt('reap-orphans', self.reap_orphans)
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
                'tracerPid': tracer, 'tracerStatus': tracer_status,
                'tracerReaped': tracer is None or tracer_status is not None,
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

    @staticmethod
    def reap(pid, timeout, kill=False):
        deadline = time.monotonic() + timeout
        while True:
            reaped, status = os.waitpid(pid, os.WNOHANG)
            if reaped == pid:
                return os.waitstatus_to_exitcode(status)
            if time.monotonic() > deadline:
                if not kill:
                    raise TimeoutError('Native tracer did not exit')
                os.kill(pid, signal.SIGKILL)
                kill = False
                deadline = time.monotonic() + timeout
            time.sleep(.01)

    @staticmethod
    def reap_orphans():
        while True:
            try:
                if os.waitpid(-1, os.WNOHANG)[0] == 0:
                    return
            except ChildProcessError:
                return

    def decode(self, mode='large', kind=None, **options):
        header, packets, registration, pid, raw = self.capture(mode, **options)
        records = journal.decode_records(header, packets, registration, pid)
        return [row for row in records if kind is None or row['kind'] == kind], records, raw

    def test_actual_child_read_retains_returned_input_prefix_before_caller_mutation(self):
        incoming = b'\x1b[A\x1b[Btest'
        reads, records, raw = self.decode('input-read', 3, input_bytes=incoming)
        self.assertEqual(raw, b'input-ready\r\n')
        self.assertEqual(len(reads), 1, 'Native child read must be observed independently of parent sent bytes')
        self.assertEqual(reads[0]['bytes'], incoming)
        self.assertEqual((reads[0]['operation'], reads[0]['requested'], reads[0]['result'], reads[0]['errno']),
                         (1, 128, 10, 0))
        self.assertGreater(reads[0]['fd'], 2, 'Duplicated stdin PTY descriptor must retain ownership')
        self.assertEqual(self.tracer['status'], 0)

    def test_actual_read_families_preserve_short_prefix_with_large_request(self):
        incoming = b'\x1b[A\x1b[Btest'
        for mode, operation in [('input-read', 1), ('input-readv', 2), ('input-preadv2', 7)]:
            with self.subTest(mode=mode):
                plain = self.capture(mode, observed=False, input_bytes=incoming)
                header, packets, registration, pid, raw = self.capture(mode, payload=16, input_bytes=incoming)
                self.assertEqual(raw, plain[-1])
                records = journal.decode_records(header, packets, registration, pid)
                reads = [row for row in records if row['kind'] == 3]
                self.assertEqual(len(reads), 1, 'Nested libc calls must not duplicate the original read')
                read = reads[0]
                self.assertEqual((read['operation'], read['inputMask'], read['outputMask']), (operation, 4, 0))
                self.assertEqual((read['requested'], read['result'], read['errno']), (128, 10, 0))
                self.assertEqual(read['bytes'], incoming)
                self.assertEqual(journal.verify_raw(records, raw, OUTPUT_FLAGS)['verdict'], 'passed')

    def test_preadv2_nowait_stdin_path_is_captured_with_its_kernel_result(self):
        incoming = b'\x1b[A\x1b[Btest'
        plain = self.capture('input-preadv2-nowait', observed=False, input_bytes=incoming)
        reads, records, raw = self.decode('input-preadv2-nowait', 3, input_bytes=incoming)
        self.assertEqual(raw, plain[-1])
        self.assertEqual((reads[0]['operation'], reads[0]['fd'] > 2, reads[0]['requested']), (7, True, 128))
        if len(reads) == 2:
            # No FMODE_NOWAIT on this TTY: the original EOPNOTSUPP is kept, then read().
            self.assertEqual((reads[0]['result'], reads[0]['errno'], reads[0]['bytes']), (-1, errno.EOPNOTSUPP, b''))
            self.assertEqual((reads[1]['operation'], reads[1]['result'], reads[1]['bytes']), (1, 10, incoming))
        else:
            self.assertEqual((len(reads), reads[0]['result'], reads[0]['bytes']), (1, 10, incoming))
        journal.verify_raw(records, raw, OUTPUT_FLAGS)

    def test_actual_read_eof_zero_request_and_zero_iovec_have_distinct_results(self):
        # Linux readv(fd, NULL, 0) returns 0 instead of Darwin's EINVAL.
        for mode, incoming, operation in [('input-eof', b'\x04', 1), ('input-empty', None, 1),
                                          ('input-emptyv', None, 2)]:
            with self.subTest(mode=mode):
                reads, records, raw = self.decode(mode, 3, input_bytes=incoming)
                self.assertEqual(len(reads), 1)
                self.assertEqual((reads[0]['operation'], reads[0]['requested'], reads[0]['result'],
                                  reads[0]['errno'], reads[0]['bytes']),
                                 (operation, 128 if mode == 'input-eof' else 0, 0, 0, b''))

    def test_actual_failed_reads_keep_eagain_espipe_ebadf_and_efault_without_fake_input(self):
        reads, records, raw = self.decode('input-failed', 3)
        self.assertEqual([(row['operation'], row['result'], row['errno'], row['bytes']) for row in reads],
                         [(1, -1, errno.EAGAIN, b''), (5, -1, errno.ESPIPE, b''),
                          (6, -1, errno.ESPIPE, b''), (1, -1, errno.EBADF, b'')])
        self.assertEqual(reads[3]['fd'], 0)
        reads, records, raw = self.decode('input-bad-memory', 3, input_bytes=b'input')
        self.assertEqual([(row['result'], row['errno'], row['bytes']) for row in reads], [(-1, errno.EFAULT, b'')])

    def test_actual_read_payload_overflow_preserves_input_and_rejects_truncated_evidence(self):
        incoming = b'\x1b[A\x1b[Btest'
        plain = self.capture('input-read', observed=False, input_bytes=incoming)
        header, packets, registration, pid, raw = self.capture('input-read', payload=8, input_bytes=incoming)
        self.assertEqual(raw, plain[-1])
        read = next(journal.RECORD.unpack_from(row) for row in packets if journal.RECORD.unpack_from(row)[2] == 3)
        self.assertEqual((read[10], read[11], read[13], read[14]), (128, 10, 1, 0))
        with self.assertRaisesRegex(journal.JournalError, 'Truncated or unsupported'):
            journal.decode_records(header, packets, registration, pid)
        header, packets, registration, pid, raw = self.capture('input-read', capacity=2, input_bytes=incoming)
        self.assertEqual(raw, plain[-1], 'Full observer ring must not prevent the original read')
        self.assertGreater(header[10], 0)
        with self.assertRaisesRegex(journal.JournalError, 'Lost'):
            journal.decode_records(header, packets, registration, pid)

    def test_invalid_readv_metadata_preserves_original_efault_and_refuses_unproven_prefix(self):
        header, packets, registration, pid, raw = self.capture('input-bad-iov', input_bytes=b'input')
        read = next(journal.RECORD.unpack_from(row) for row in packets if journal.RECORD.unpack_from(row)[2] == 3)
        self.assertEqual((read[9], read[11], read[12], read[13], read[14]), (2, 2 ** 64 - 1, errno.EFAULT, 1, 0))
        with self.assertRaisesRegex(journal.JournalError, 'Truncated or unsupported'):
            journal.decode_records(header, packets, registration, pid)

    def test_control_pipe_reads_are_not_attributed_to_registered_stdin(self):
        reads, records, raw = self.decode('input-foreign', 3)
        self.assertEqual(reads, [])
        self.assertEqual(raw, b'')

    def test_read_decoder_rejects_foreign_channel_operation_span_result_and_errno(self):
        header, packets, registration, pid, raw = self.capture('input-read', input_bytes=b'\x1b[A\x1b[Btest')
        index = next(index for index, row in enumerate(packets) if journal.RECORD.unpack_from(row)[2] == 3)
        for field, value in [(8, 3), (9, 3), (9, 4), (15, 1), (7, 1 << 31), (10, 9), (11, 9)]:
            with self.subTest(field=field, value=value):
                changed = list(packets)
                words = list(journal.RECORD.unpack_from(changed[index]));words[field] = value
                changed[index] = journal.RECORD.pack(*words) + changed[index][journal.RECORD.size:]
                with self.assertRaisesRegex(journal.JournalError, 'Original read result/prefix mismatch'):
                    journal.decode_records(header, changed, registration, pid)
        for error in [1 << 31, (1 << 32) - 7, 1 << 63]:
            changed = list(packets);words = list(journal.RECORD.unpack_from(changed[index]));words[12] = error
            changed[index] = journal.RECORD.pack(*words) + changed[index][journal.RECORD.size:]
            with self.subTest(error=error), self.assertRaisesRegex(journal.JournalError, 'Noncanonical native read errno'):
                journal.decode_records(header, changed, registration, pid)
        header, packets, registration, pid, raw = self.capture('input-failed')
        index = next(index for index, row in enumerate(packets) if journal.RECORD.unpack_from(row)[2] == 3)
        changed = list(packets);words = list(journal.RECORD.unpack_from(changed[index]));words[12] = 0
        changed[index] = journal.RECORD.pack(*words) + changed[index][journal.RECORD.size:]
        with self.assertRaisesRegex(journal.JournalError, 'Failed read lacks original errno'):
            journal.decode_records(header, changed, registration, pid)

    def test_actual_write_writev_alias_errno_and_immutable_payload(self):
        plain = self.capture(observed=False)
        header, packets, registration, pid, raw = self.capture()
        self.assertEqual(raw, plain[-1])
        self.assertEqual(self.tracer['status'], 0)
        self.assertEqual((header[11], header[12], header[13], header[20], header[22], header[23]),
                         (1, 1, 1, journal.LINUX_V1, 0, 0))
        records = journal.decode_records(header, packets, registration, pid)
        self.assertEqual(journal.verify_raw(records, raw, OUTPUT_FLAGS)['verdict'], 'passed')
        writes = [row for row in records if row['kind'] == 1]
        self.assertEqual([row['result'] for row in writes], [5000, 13, -1])
        self.assertEqual([row['operation'] for row in writes], [1, 2, 1])
        self.assertEqual(writes[0]['bytes'], b'A' * 4999 + b'\n')
        self.assertEqual(writes[2]['errno'], errno.EBADF)
        self.assertEqual(next(row for row in records if row['kind'] == 11)['bytes'], b'ORIGINAL')
        self.assertEqual(journal.frame_spans(records)[0]['untransformedBytes'], 5013)
        self.assertEqual({row['pid'] for row in records}, {pid})
        self.assertEqual({row['threadId'] for row in records}, {pid})

    def test_inline_syscall_libc_and_positional_writes_are_captured(self):
        plain = self.capture('raw-syscalls', observed=False)
        header, packets, registration, pid, raw = self.capture('raw-syscalls')
        self.assertEqual(raw, plain[-1])
        self.assertEqual(raw, b'inline\r\nlibc\r\nvector\r\n')
        records = journal.decode_records(header, packets, registration, pid)
        writes = [row for row in records if row['kind'] == 1]
        self.assertEqual([(row['operation'], row['result'], row['errno']) for row in writes],
                         [(1, 7, 0), (1, 5, 0), (5, -1, errno.ESPIPE), (6, -1, errno.ESPIPE), (7, 7, 0)])
        self.assertEqual([row['bytes'] for row in writes], [b'inline\n', b'libc\n', b'', b'', b'vector\n'])
        journal.verify_raw(records, raw, OUTPUT_FLAGS)

    def test_real_termios_cycle_is_recorded_even_when_final_attrs_and_raw_match(self):
        plain = self.capture('termios-cycle', observed=False)
        header, packets, registration, pid, raw = self.capture('termios-cycle')
        self.assertEqual(raw, plain[-1])
        self.assertEqual(raw, b'mode\r\nrestored\r\n')
        records = journal.decode_records(header, packets, registration, pid)
        self.assertEqual(journal.verify_raw(records, raw, OUTPUT_FLAGS)['verdict'], 'passed')
        modes = [row for row in records if row['kind'] == 2]
        self.assertEqual(len(modes), 2, 'Final termios equality hides real ECHO disable/restore history')
        self.assertEqual([row['operation'] for row in modes], [0, 0])
        self.assertEqual([row['result'] for row in modes], [0, 0])
        self.assertEqual([row['errno'] for row in modes], [0, 0])
        self.assertEqual(len(modes[0]['modeAfter']['controlChars']), 19)
        self.assertEqual(modes[0]['modeBefore']['localFlags'] ^ modes[0]['modeAfter']['localFlags'], termios.ECHO)
        self.assertEqual(modes[0]['modeRequested'], modes[0]['modeAfter'])
        self.assertEqual(modes[1]['modeBefore'], modes[0]['modeAfter'])
        self.assertEqual(modes[1]['modeRequested'], modes[1]['modeAfter'])
        self.assertEqual(modes[1]['modeAfter'], modes[0]['modeBefore'])

    def test_real_output_mode_cycle_replays_each_write_with_actual_kernel_flags(self):
        plain = self.capture('termios-output-cycle', observed=False)
        header, packets, registration, pid, raw = self.capture('termios-output-cycle')
        self.assertEqual(raw, plain[-1])
        self.assertEqual(raw, b'mode\nrestored\r\n')
        records = journal.decode_records(header, packets, registration, pid)
        self.assertEqual(len([row for row in records if row['kind'] == 2]), 2)
        self.assertEqual(journal.verify_raw(records, raw, OUTPUT_FLAGS)['verdict'], 'passed')

    def test_failed_termios_preserves_actual_errno_and_refuses_unread_request(self):
        plain = self.capture('termios-failed', observed=False)
        header, packets, registration, pid, raw = self.capture('termios-failed')
        self.assertEqual(raw, plain[-1])
        mode = next(journal.RECORD.unpack_from(row) for row in packets if journal.RECORD.unpack_from(row)[2] == 2)
        self.assertEqual((mode[9], mode[11], mode[12], mode[13]), (0, 2 ** 64 - 1, errno.EFAULT, 1))
        with self.assertRaisesRegex(journal.JournalError, 'Truncated or unsupported'):
            journal.decode_records(header, packets, registration, pid)

    def test_termios_observation_overflow_preserves_original_mode_changes(self):
        plain = self.capture('termios-output-cycle', observed=False)
        header, packets, registration, pid, raw = self.capture('termios-output-cycle', payload=128)
        self.assertEqual(raw, plain[-1])
        self.assertEqual(raw, b'mode\nrestored\r\n')
        with self.assertRaisesRegex(journal.JournalError, 'Truncated or unsupported'):
            journal.decode_records(header, packets, registration, pid)

    def test_termios_write_order_and_unknown_output_transform_are_rejected(self):
        modes, records, raw = self.decode('termios-output-cycle')
        self.assertEqual(journal.verify_raw(records, raw, OUTPUT_FLAGS)['verdict'], 'passed')
        for mutation, message in (('before', 'before-state'), ('overlap', 'Overlapping'), ('transform', 'Unproved')):
            changed = copy.deepcopy(records)
            mode = next(row for row in changed if row['kind'] == 2)
            if mutation == 'before':
                mode['modeBefore']['outputFlags'] ^= termios.OPOST
            elif mutation == 'overlap':
                write = next(row for row in changed if row['kind'] == 1)
                mode['return'] = write['return']
            else:
                mode['modeAfter']['outputFlags'] = termios.OPOST
            with self.subTest(mutation=mutation), self.assertRaisesRegex(journal.JournalError, message):
                journal.verify_raw(changed, raw, OUTPUT_FLAGS)

    def test_signed_native_device_identity_has_the_same_unsigned_representation(self):
        from types import SimpleNamespace
        endpoint = SimpleNamespace(st_dev=-3, st_ino=123, st_rdev=-1, st_mode=0o20620)
        registration = journal.create_journal(self.root / 'signed-device.bin', endpoint, 3, platform='linux')
        self.assertEqual(registration['header'][14:21],
                         [(1 << 64) - 3, 123, (1 << 64) - 1, 0o20620, 3, 0, journal.LINUX_V1])

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
        self.assertTrue(cleanup['tracerReaped'])
        self.assertIsNotNone(cleanup['tracerPid'])
        self.assertTrue(cleanup['allDescriptorsClosed'])
        self.assertEqual(cleanup['cleanupErrors'], [])
        self.assertEqual(cleanup['error'], 'controlled capture failure')
        with self.assertRaises(ProcessLookupError):
            os.killpg(cleanup['childPid'], 0)
        with self.assertRaises(ProcessLookupError):
            os.kill(cleanup['tracerPid'], 0)

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
        self.assertTrue(cleanup['childReaped'] and cleanup['allDescriptorsClosed'] and cleanup['tracerReaped'])
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

    def test_native_consume_checks_registered_nonce_platform_and_producer_before_acquire(self):
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
            darwin = (ctypes.c_uint64 * 32)(*registration['header'])
            darwin[20] = 0
            try:
                self.assertEqual(function(pin, len(mapping), 2, destination, len(destination), foreign, pid), -1)
                self.assertEqual(function(pin, len(mapping), 2, destination, len(destination), darwin, pid), -1)
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
        self.assertGreaterEqual(len(cleanup['closedDescriptors']), 6)

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
        journal.verify_raw(records, raw, OUTPUT_FLAGS)
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
        journal.verify_raw(records, raw, OUTPUT_FLAGS)

    def test_bun_stdout_console_and_write_sync_are_fully_captured(self):
        script = "process.stdout.write('alpha\\n');console.log('beta');require('fs').writeSync(1,'gamma\\n')"
        buns = [bun for bun in BUNS if bun.is_file()]
        self.assertTrue(buns, 'No Bun runtime available for Linux coverage')
        for bun in buns:
            with self.subTest(bun=str(bun)):
                version = subprocess.run([str(bun), '--version'], env=self.env, capture_output=True,
                                         timeout=15, check=True).stdout.decode().strip()
                plain = self.capture(observed=False, binary=bun, arguments=['-e', script])
                header, packets, registration, pid, raw = self.capture(binary=bun, arguments=['-e', script])
                self.assertEqual(raw, plain[-1])
                self.assertEqual(raw, b'alpha\r\nbeta\r\ngamma\r\n')
                self.assertEqual(self.tracer['status'], 0)
                records = journal.decode_records(header, packets, registration, pid)
                writes = [row for row in records if row['kind'] == 1]
                self.assertEqual(b''.join(row['bytes'] for row in writes), b'alpha\nbeta\ngamma\n')
                self.assertEqual(journal.verify_raw(records, raw, OUTPUT_FLAGS)['verdict'], 'passed')
                print(json.dumps({'bun': str(bun), 'version': version, 'writes': len(writes),
                                  'operations': [row['operation'] for row in writes],
                                  'fds': [row['fd'] for row in writes], 'rawBytes': len(raw)}), flush=True)

    @unittest.skipUnless(os.environ.get('JOURNAL_TEST_BINARY'), 'JOURNAL_TEST_BINARY not set')
    def test_actual_bun_cli_version_output_is_covered_by_native_syscalls(self):
        binary = Path(os.environ['JOURNAL_TEST_BINARY']).resolve(strict=True)
        original_sha = hashlib.sha256(binary.read_bytes()).hexdigest()
        dummy = {'ANTHROPIC_API_KEY': 'dummy'}
        plain = self.capture(observed=False, binary=binary, arguments=['--version'], extra_env=dummy)
        header, packets, registration, pid, raw = self.capture(binary=binary, arguments=['--version'], extra_env=dummy)
        self.assertEqual(raw, plain[-1])
        self.assertIn(b'Claude Code', raw)
        records = journal.decode_records(header, packets, registration, pid)
        self.assertGreater(len([row for row in records if row['kind'] == 1]), 0)
        journal.verify_raw(records, raw, OUTPUT_FLAGS)
        self.assertEqual(hashlib.sha256(binary.read_bytes()).hexdigest(), original_sha)

    def test_actual_partial_write_retains_only_successful_original_prefix(self):
        writes, records, raw = self.decode('partial', 1)
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0]['requested'], 65536)
        self.assertGreater(writes[0]['result'], 0)
        self.assertLess(writes[0]['result'], 65536)
        self.assertEqual(writes[0]['bytes'], raw)
        self.assertEqual(raw, b'B' * writes[0]['result'])
        journal.verify_raw(records, raw, OUTPUT_FLAGS)

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
        writes, records, raw = self.decode('threads', 1)
        self.assertEqual(len({row['threadId'] for row in writes}), 2)
        with self.assertRaisesRegex(journal.JournalError, 'Multiple writers'):
            journal.verify_raw(records, raw, OUTPUT_FLAGS)

    def test_every_new_thread_write_is_recorded_once(self):
        for attempt in range(5):
            with self.subTest(attempt=attempt):
                writes, records, raw = self.decode('threads-many', 1)
                self.assertEqual(sorted(row['bytes'] for row in writes), [b't%02d\n' % i for i in range(16)])
                self.assertEqual(len({row['threadId'] for row in writes}), 16)
                self.assertEqual(sorted(raw.split(b'\r\n')[:-1]), [b't%02d' % i for i in range(16)])

    def test_overlapping_calls_on_two_threads_keep_their_real_kernel_brackets(self):
        records = self.decode('threads-overlap', input_bytes=b'\x1b[A\x1b[Btest')[1]
        read = next(row for row in records if row['kind'] == 3)
        main = next(row for row in records if row['kind'] == 1 and row['bytes'] == b'main\n')
        self.assertNotEqual(read['threadId'], main['threadId'])
        self.assertEqual(read['bytes'], b'\x1b[A\x1b[Btest')
        self.assertTrue(read['entry'] < main['entry'] <= main['return'] < read['return'],
                        'The blocked read must bracket the concurrent write')
        self.assertLess(main['sequence'], read['sequence'], 'Reads reserve only at return')
        with self.assertRaisesRegex(journal.JournalError, 'Multiple writers'):
            journal.verify_raw(records, b'main\r\ninput-ready\r\nthread\r\n', OUTPUT_FLAGS)
        with self.assertRaisesRegex(journal.JournalError, 'multiple-thread'):
            journal.frame_spans(records)

    def signal_read(self, restart):
        incoming = b'\x1b[A\x1b[Btest'
        state = {'signalled': False, 'sent': False}
        def interact(context):
            raw, pid = context['raw'], context['child'].pid
            if not state['signalled'] and b'input-ready\r\n' in raw and blocked_in_read(pid):
                os.kill(pid, signal.SIGUSR1)
                state['signalled'] = True
            if restart and not state['sent'] and b'sig\r\n' in raw:
                os.write(context['master'], incoming)
                state['sent'] = True
        reads, records, raw = self.decode('restart' if restart else 'norestart', interact=interact)
        return [row for row in records if row['kind'] == 3], records, raw

    def test_sa_restart_interruption_produces_one_read_record(self):
        reads, records, raw = self.signal_read(True)
        self.assertEqual(raw, b'input-ready\r\nsig\r\n')
        self.assertEqual(len(reads), 1)
        self.assertEqual((reads[0]['result'], reads[0]['errno'], reads[0]['bytes']), (10, 0, b'\x1b[A\x1b[Btest'))
        handler = next(row for row in records if row['kind'] == 1 and row['bytes'] == b'sig\n')
        self.assertLess(handler['return'], reads[0]['entry'], 'The restarted call is a new kernel event')
        journal.verify_raw(records, raw, OUTPUT_FLAGS)

    def test_interruption_without_sa_restart_produces_one_eintr_record(self):
        reads, records, raw = self.signal_read(False)
        self.assertEqual(raw, b'input-ready\r\nsig\r\neintr\r\n')
        self.assertEqual(len(reads), 1)
        self.assertEqual((reads[0]['result'], reads[0]['errno'], reads[0]['bytes']), (-1, errno.EINTR, b''))
        handler = next(row for row in records if row['kind'] == 1 and row['bytes'] == b'sig\n')
        self.assertLessEqual(reads[0]['return'], handler['entry'])
        journal.verify_raw(records, raw, OUTPUT_FLAGS)

    def test_descendant_writing_the_endpoint_is_counted_foreign(self):
        header, packets, registration, pid, raw = self.capture('child-endpoint')
        self.assertEqual(raw, b'child\r\nparent\r\n', 'Foreign accounting must not block the original write')
        self.assertGreater(header[22], 0)
        self.assertEqual(header[23], 0)
        with self.assertRaisesRegex(journal.JournalError, 'Foreign native endpoint writer'):
            journal.decode_records(header, packets, registration, pid)

    def test_descendant_writing_a_pipe_is_ignored_and_still_traced(self):
        header, packets, registration, pid, raw = self.capture('child-pipe')
        self.assertEqual(raw, b'child-pipe-ok\r\n')
        self.assertEqual((header[22], header[23]), (0, 0))
        records = journal.decode_records(header, packets, registration, pid)
        self.assertEqual(journal.verify_raw(records, raw, OUTPUT_FLAGS)['verdict'], 'passed')
        self.assertEqual(self.tracer['status'], 0)

    def test_sendfile_splice_and_io_uring_to_the_endpoint_are_unsupported(self):
        for mode, output in [('sendfile', b'sendfile\r\n'), ('splice', b'splice\r\n'), ('io-uring', None)]:
            with self.subTest(mode=mode):
                header, packets, registration, pid, raw = self.capture(mode)
                # io_uring may be disabled by the host; when enabled its write still lands.
                self.assertIn(raw, (output,) if output else (b'', b'uring\r\n'),
                              'Unsupported accounting must not block the original call')
                self.assertGreater(header[23], 0)
                with self.assertRaisesRegex(journal.JournalError, 'Unsupported native endpoint transfer'):
                    journal.decode_records(header, packets, registration, pid)

    def test_exec_of_an_unregistered_binary_is_rejected(self):
        header, packets, registration, pid, raw = self.capture(binary='/bin/echo', arguments=['unregistered'],
                                                               registered=self.probe)
        self.assertEqual(raw, b'unregistered\r\n')
        self.assertEqual(self.tracer['status'], 3)
        self.assertEqual((header[8], header[9], header[11]), (0, 0, 0))
        self.assertGreater(header[10], 0)
        with self.assertRaisesRegex(journal.JournalError, 'Foreign or absent native producer'):
            journal.decode_records(header, packets, registration, pid)

    def test_killing_the_tracer_kills_the_product_without_a_close_boundary(self):
        state = {'killed': False}
        def interact(context):
            header = journal.HEADER.unpack_from(context['path'].read_bytes())
            if not state['killed'] and header[9] >= 3:
                os.kill(context['tracer'], signal.SIGKILL)
                state['killed'] = True
        header, packets, registration, pid, raw = self.capture('hang', exit_code=-signal.SIGKILL, interact=interact)
        self.assertTrue(state['killed'])
        self.assertEqual(self.tracer['status'], -signal.SIGKILL)
        self.assertEqual((header[8], header[11], header[21]), (pid, 0, 0))
        with self.assertRaisesRegex(journal.JournalError, 'close boundary'):
            journal.decode_records(header, packets, registration, pid)

    def test_ptrace_eperm_fails_observer_exec_at_startup(self):
        header, packets, registration, pid, raw = self.capture(prefix=[self.deny_ptrace], exit_code=125)
        self.assertIn(b'ptrace seize failed: Operation not permitted', raw)
        self.assertNotIn(b'AAAA', raw, 'The product must not run unobserved')
        self.assertIsNone(self.tracer['pid'])
        self.assertEqual((header[8], header[9]), (0, 0))

    def test_darwin_registration_is_refused_by_the_linux_tracer(self):
        header, packets, registration, pid, raw = self.capture(platform='darwin', exit_code=125)
        self.assertIn(b'invalid Linux journal registration', raw)
        self.assertNotIn(b'AAAA', raw)
        self.assertEqual(header[8], 0)

    def test_darwin_and_linux_method_sets_are_never_mixed(self):
        header, packets, registration, pid, raw = self.capture()
        records = journal.decode_records(header, packets, registration, pid)
        darwin = copy.deepcopy(registration)
        darwin['header'][20] = 0
        with self.assertRaisesRegex(journal.JournalError, 'Native registration changed'):
            journal.decode_records(header, packets, darwin, pid)
        unknown = copy.deepcopy(registration)
        unknown['header'][20] = journal.MAGIC
        with self.assertRaisesRegex(journal.JournalError, 'Unknown native observer platform'):
            journal.decode_records(header, packets, unknown, pid)
        with self.assertRaisesRegex(journal.JournalError, 'Unknown native observer platform'):
            journal.NativeConsumer(registration['path'], unknown, self.library)
        index = next(index for index, row in enumerate(packets) if journal.RECORD.unpack_from(row)[2] == 1)
        for operation in (3, 4):
            changed = list(packets);words = list(journal.RECORD.unpack_from(changed[index]));words[9] = operation
            changed[index] = journal.RECORD.pack(*words) + changed[index][journal.RECORD.size:]
            with self.subTest(operation=operation), self.assertRaisesRegex(journal.JournalError, 'write result'):
                journal.decode_records(header, changed, registration, pid)
        for word, value, message in [(22, 1, 'Foreign native endpoint writer'),
                                     (23, 1, 'Unsupported native endpoint transfer'),
                                     (12, 125, 'monotonic'), (20, 0, 'registration changed')]:
            changed = list(header);changed[word] = value
            with self.subTest(word=word), self.assertRaisesRegex(journal.JournalError, message):
                journal.decode_records(tuple(changed), packets, registration, pid)
        header, packets, registration, pid, raw = self.capture('termios-cycle')
        index = next(index for index, row in enumerate(packets) if journal.RECORD.unpack_from(row)[2] == 2)
        darwin_prefix = journal.TERMIOS_PREFIX.pack(1, 20, 0, 0, 0, 0)
        start = journal.RECORD.size
        changed = list(packets)
        changed[index] = packets[index][:start] + darwin_prefix + packets[index][start + journal.TERMIOS_PREFIX.size:]
        with self.assertRaisesRegex(journal.JournalError, 'termios kernel query failed'):
            journal.decode_records(header, changed, registration, pid)
        self.assertTrue(all(row['nativeClock']['observer'] == journal.LINUX_OBSERVER
                            for row in records if 'nativeClock' in row))

    def test_linux_frame_span_and_resize_methods_follow_the_registered_platform(self):
        import base64
        header, packets, registration, pid, raw = self.capture()
        master, slave = pty.openpty()
        try:
            with journal.NativeConsumer(registration['path'], registration, self.library, expected_pid=pid) as consumer:
                receipt = consumer.resize(master, struct.pack('HHHH', 33, 101, 0, 0))
            self.assertEqual((receipt['method'], receipt['timebaseNumer'], receipt['timebaseDenom']),
                             ('native-linux-ioctl-resize-v1', 1, 1))
        finally:
            os.close(master)
            os.close(slave)
        identity = {'profile': 'ink-post-write-v1', 'captureId': 'capture', 'spanId': 1,
                    'rendererId': 1, 'rootEpoch': 1, 'columns': 2, 'rows': 1}
        frame = base64.b64encode(json.dumps({'viewport': {'width': 2, 'height': 1},
                                             'cursor': {'visible': True}}).encode()).decode()
        snapshot = json.dumps({'native': identity, 'rootReset': False, 'cursorVisible': True,
                               'frameBase64': frame}).encode()
        marker = json.dumps(identity).encode()
        for clock, method in [({'pid': pid, 'observer': journal.LINUX_OBSERVER}, 'native-linux-frame-span-v1'),
                              ({'pid': pid}, 'native-mach-frame-span-v1')]:
            rows = [{'sequence': sequence, 'kind': kind, 'entry': entry, 'return': entry + 1, 'spanId': 1,
                     'threadId': pid, 'bytes': data, 'result': len(data), 'errno': 0,
                     **({} if kind == 1 else {'nativeClock': clock})}
                    for sequence, kind, entry, data in [(1, 10, 10, marker), (2, 12, 20, marker), (3, 1, 30, b'x'),
                                                        (4, 13, 40, marker), (5, 11, 50, snapshot)]]
            with self.subTest(method=method):
                entries = journal.ink_frame_entries(rows, b'x', 'capture', 0)
                self.assertEqual(entries[0]['nativeSpan']['method'], method)

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
            journal.verify_raw(records, raw + b'foreign', OUTPUT_FLAGS)
        altered = copy.deepcopy(records)
        writes = [row for row in altered if row['kind'] == 1]
        writes[1]['entry'] = writes[0]['entry']
        with self.assertRaisesRegex(journal.JournalError, 'Overlapping'):
            journal.verify_raw(altered, raw, OUTPUT_FLAGS)
        altered = copy.deepcopy(records)
        next(row for row in altered if row['kind'] == 12)['return'] = next(row for row in altered if row['kind'] == 1)['return'] + 1
        with self.assertRaisesRegex(journal.JournalError, 'crosses'):
            journal.frame_spans(altered)


if __name__ == '__main__':
    unittest.main()

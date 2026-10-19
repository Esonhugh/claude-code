// Private Linux observer: the same immutable shared-slot ring as the Darwin
// observer. observer-exec (-DCC_OBSERVER_EXEC) is a seccomp RET_TRACE + ptrace
// side tracer that records the product's endpoint syscalls; observer.so holds
// the in-process frame marks and the collector API. Neither waits on a consumer.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <time.h>
#include <unistd.h>
#define MAGIC UINT64_C(0x314c4e4a544343)
// Registered header[20]: "LINUX_V1" little-endian. Darwin keeps this word 0.
#define LINUX_V1 UINT64_C(0x31565f58554e494c)
#define HEADER_WORDS 32
#define RECORD_WORDS 20
#define MAX_IOVECS 1024
_Static_assert(__atomic_always_lock_free(8, 0), "Observer requires lock-free 64-bit atomics");
static uint64_t *journal;
static size_t mapped_bytes;
static size_t slot_stride,slot_capacity,payload_capacity;
static uint64_t endpoint_identity[5];
static uint64_t load_word(uint64_t *word){return __atomic_load_n(word,__ATOMIC_ACQUIRE);}
static void lose(void){if(journal)__atomic_fetch_add(journal+10,1,__ATOMIC_RELAXED);}
static uint64_t now(void){
 struct timespec value;clock_gettime(CLOCK_MONOTONIC,&value);
 return (uint64_t)value.tv_sec*UINT64_C(1000000000)+(uint64_t)value.tv_nsec;
}
static int same_endpoint(const struct stat *identity){
 return (uint64_t)identity->st_dev==endpoint_identity[0] && (uint64_t)identity->st_ino==endpoint_identity[1] &&
        (uint64_t)identity->st_rdev==endpoint_identity[2] && (uint64_t)identity->st_mode==endpoint_identity[3];
}
// process_vm_readv never faults the caller, like mach_vm_read_overwrite.
static size_t copy_memory(pid_t pid,uint64_t address,size_t bytes,void *target){
 if(!bytes)return 0;
 struct iovec local={target,bytes},remote={(void*)(uintptr_t)address,bytes};
 ssize_t copied=process_vm_readv(pid,&local,1,&remote,1,0);
 return copied<0?0:(size_t)copied;
}
// Same file and layout rules as the Darwin constructor, plus the Linux word.
static int map_journal(const char *path){
 int fd=open(path,O_RDWR|O_CLOEXEC|O_NOFOLLOW);
 struct stat file;
 if(fd<0)return -1;
 if(fstat(fd,&file) || !S_ISREG(file.st_mode) || file.st_uid!=getuid() ||
    (file.st_mode&0777)!=0600 || file.st_nlink!=1 || file.st_size<HEADER_WORDS*8)goto invalid;
 mapped_bytes=(size_t)file.st_size;
 journal=mmap(NULL,mapped_bytes,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0);
 if(journal==MAP_FAILED){journal=NULL;goto invalid;}
 if(journal[0]!=MAGIC || journal[1]!=1 || journal[2]!=HEADER_WORDS*8 ||
    !journal[4] || journal[4]>4096 || !journal[5] || journal[5]>1048576 ||
    journal[3]<RECORD_WORDS*8+journal[5] || journal[3]%64 ||
    journal[4]>(SIZE_MAX-journal[2])/journal[3] ||
    journal[2]+journal[3]*journal[4]!=mapped_bytes || journal[20]!=LINUX_V1)goto invalid;
 slot_stride=journal[3];slot_capacity=journal[4];payload_capacity=journal[5];
 memcpy(endpoint_identity,journal+14,sizeof(endpoint_identity));
 return fd;
invalid:
 if(journal){munmap(journal,mapped_bytes);journal=NULL;}
 close(fd);
 return -1;
}
static int attached(void){
 struct stat output;
 for(int fd=1;fd<=2;fd++)if(!fstat(fd,&output)&&same_endpoint(&output))return 1;
 return 0;
}
static uint64_t *reserve(uint64_t kind,uint64_t span,uint64_t pid,uint64_t thread){
 if(!journal)return NULL;
 if(journal[0]!=MAGIC || journal[1]!=1 || journal[2]!=HEADER_WORDS*8 || journal[3]!=slot_stride ||
    journal[4]!=slot_capacity || journal[5]!=payload_capacity || journal[20]!=LINUX_V1 ||
    load_word(journal+8)!=pid || load_word(journal+11)){lose();return NULL;}
 uint64_t sequence=__atomic_fetch_add(journal+9,1,__ATOMIC_RELAXED)+1;
 uint64_t *slot=(uint64_t*)((unsigned char*)journal+HEADER_WORDS*8+((sequence-1)%slot_capacity)*slot_stride);
 uint64_t expected=0;
 if(!__atomic_compare_exchange_n(slot,&expected,1,0,__ATOMIC_ACQUIRE,__ATOMIC_RELAXED)){lose();return NULL;}
 memset(slot+1,0,(RECORD_WORDS-1)*sizeof(uint64_t));
 slot[1]=sequence;slot[2]=kind;slot[3]=pid;slot[4]=thread;slot[15]=span;
 return slot;
}
static void publish(uint64_t *slot){__atomic_store_n(slot,2,__ATOMIC_RELEASE);}

#ifndef CC_OBSERVER_EXEC
// Metadata only. It never writes stdout, flushes a stream or waits on a consumer.
uint64_t cc_terminal_journal_mark(uint64_t kind,uint64_t span,const void *bytes,uint64_t length){
 int saved=errno;
 if(!journal){errno=saved;return 0;}
 uint64_t *slot=reserve(kind,span,(uint64_t)getpid(),(uint64_t)gettid());
 if(!slot){errno=saved;return 0;}
 slot[5]=now();slot[10]=length;
 if(kind<10 || kind>20 || length>payload_capacity)slot[13]=1;
 else{
  size_t copied=copy_memory(getpid(),(uint64_t)(uintptr_t)bytes,(size_t)length,slot+RECORD_WORDS);
  slot[14]=copied;if(copied!=length)slot[13]=1;
 }
 slot[6]=now();uint64_t sequence=slot[1];publish(slot);errno=saved;return sequence;
}
// Collector-only API: acquire a whole committed record, then release its slot.
// A missing/foreign sequence is never synthesized from a later record.
static int registered_header(uint64_t *header,const uint64_t *expected){
 for(int i=0;i<HEADER_WORDS;i++){
  if(i==8||i==9||i==10||i==11||i==12||i==13||i==19||i==21||i==22||i==23)continue;
  if(load_word(header+i)!=expected[i])return 0;
 }
 return 1;
}
// The collector performs the real resize here, on the producer records' clock.
int cc_terminal_native_resize(int fd,uint64_t packed_size,uint64_t *receipt){
 struct winsize requested,before={0},after={0};
 _Static_assert(sizeof(struct winsize)==8,"Linux winsize receipt must be eight bytes");
 memcpy(&requested,&packed_size,sizeof(requested));
 if(!receipt)return ioctl(fd,TIOCSWINSZ,&requested);
 int incoming=errno;memset(receipt,0,12*sizeof(uint64_t));
 receipt[10]=1;receipt[11]=1;
 errno=incoming;int prior=ioctl(fd,TIOCGWINSZ,&before);int prior_errno=errno;
 errno=incoming;receipt[0]=now();
 int returned=ioctl(fd,TIOCSWINSZ,&requested);int outcome=errno;
 receipt[1]=now();
 errno=outcome;int confirmed=ioctl(fd,TIOCGWINSZ,&after);int confirmed_errno=errno;
 receipt[2]=(uint64_t)(int64_t)returned;receipt[3]=(uint64_t)outcome;
 memcpy(receipt+4,&before,sizeof(before));memcpy(receipt+5,&after,sizeof(after));
 receipt[6]=(uint64_t)(int64_t)prior;receipt[7]=(uint64_t)prior_errno;
 receipt[8]=(uint64_t)(int64_t)confirmed;receipt[9]=(uint64_t)confirmed_errno;
 errno=outcome;return returned;
}
int cc_terminal_journal_consume(void *base,uint64_t mapped_length,uint64_t sequence,void *destination,uint64_t capacity,const uint64_t *registration,uint64_t producer_pid){
 if(!base || !destination || !registration || mapped_length<HEADER_WORDS*8 || !sequence || !producer_pid)return -1;
 uint64_t *header=base,layout[6];
 if(!registered_header(header,registration))return -1;
 uint64_t actual_pid=load_word(header+8);
 if(!actual_pid)return 0;
 if(actual_pid!=producer_pid)return -1;
 for(int i=0;i<6;i++)layout[i]=registration[i];
 if(layout[0]!=MAGIC || layout[1]!=1 || layout[2]!=HEADER_WORDS*8 || !layout[4] ||
    layout[4]>4096 || !layout[5] || layout[5]>1048576 || layout[3]<RECORD_WORDS*8+layout[5] ||
    layout[3]%64 || layout[4]>(UINT64_MAX-layout[2])/layout[3] ||
    layout[2]+layout[3]*layout[4]!=mapped_length)return -1;
 uint64_t *slot=(uint64_t*)((unsigned char*)base+layout[2]+((sequence-1)%layout[4])*layout[3]);
 uint64_t expected=2;
 if(!__atomic_compare_exchange_n(slot,&expected,3,0,__ATOMIC_ACQUIRE,__ATOMIC_RELAXED))return 0;
 if(!registered_header(header,registration) || load_word(header+8)!=producer_pid ||
    slot[1]!=sequence || slot[3]!=producer_pid || slot[14]>layout[5] || capacity<RECORD_WORDS*8+slot[14]){
  __atomic_store_n(slot,2,__ATOMIC_RELEASE);return -1;
 }
 memcpy(destination,slot,RECORD_WORDS*8+slot[14]);
 ((uint64_t*)destination)[0]=2;
 __atomic_store_n(slot,0,__ATOMIC_RELEASE);return 1;
}
// The tracer binds header[8] at exec; marks only need the mapping. A process
// that is not the bound producer loses every mark through reserve().
__attribute__((constructor)) static void open_journal(void){
 int saved=errno;const char *path=getenv("CLAUDE_PRIVATE_NATIVE_JOURNAL");
 if(!path){errno=saved;return;}
 int fd=map_journal(path);
 if(fd>=0){
  close(fd);
  if(!attached()){munmap(journal,mapped_bytes);journal=NULL;}
 }
 errno=saved;
}
#else
#include <dirent.h>
#include <limits.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>
#include <sys/ucontext.h>
#include <sys/user.h>
#include <sys/wait.h>
#define X32_SYSCALL_BIT 0x40000000u
#define ERESTARTSYS 512
#define ERESTARTNOINTR 513
#define ERESTARTNOHAND 514
#define ERESTART_RESTARTBLOCK 516
// Kernel struct termios (TCGETS/TCSETS*): no speed words, NCCS 19.
struct kernel_termios{uint32_t c_iflag,c_oflag,c_cflag,c_lflag;uint8_t c_line,c_cc[19];};
struct kernel_termios2{struct kernel_termios mode;uint32_t c_ispeed,c_ospeed;};
_Static_assert(sizeof(struct kernel_termios)==36 && sizeof(struct kernel_termios2)==44,"Linux termios layout changed");
#define TERMIOS2_SET _IOW('T',0x2B,struct kernel_termios2)
#define TERMIOS2_SET_DRAIN _IOW('T',0x2C,struct kernel_termios2)
#define TERMIOS2_SET_FLUSH _IOW('T',0x2D,struct kernel_termios2)
#define TERMIOS_VALUE_BYTES (6*sizeof(uint64_t)+19)
#define TERMIOS_PAYLOAD_BYTES (6*sizeof(uint64_t)+3*TERMIOS_VALUE_BYTES)
#define OPTIONS (PTRACE_O_EXITKILL|PTRACE_O_TRACESECCOMP|PTRACE_O_TRACECLONE|PTRACE_O_TRACEFORK|\
                 PTRACE_O_TRACEVFORK|PTRACE_O_TRACEEXEC|PTRACE_O_TRACEEXIT|PTRACE_O_TRACESYSGOOD)
// Per thread: an endpoint syscall waiting for its exit (or restart outcome).
struct tracee{
 pid_t tid,tgid;int pidfd,active,restart,stepping,dupfd,count;
 uint64_t nr,kind,operation,fd,channel,requested,truncated,address,entry,returned_at;
 uint64_t prefix[6];struct kernel_termios before,requested_mode;
 unsigned char *buffer;struct iovec *vectors;
};
static struct tracee *tracees;
static size_t tracee_count,tracee_room;
static pid_t product;
static int accepted,rejected,internal_error;
static _Noreturn void fail(const char *reason,int error){
 if(error)dprintf(2,"observer-exec: %s: %s\n",reason,strerror(error));
 else dprintf(2,"observer-exec: %s\n",reason);
 _exit(125);
}
static pid_t thread_group(pid_t tid){
 char path[64],line[256];pid_t tgid=0;
 snprintf(path,sizeof(path),"/proc/%d/status",(int)tid);
 FILE *status=fopen(path,"re");
 if(!status)return 0;
 while(fgets(line,sizeof(line),status))if(sscanf(line,"Tgid: %d",&tgid)==1)break;
 fclose(status);return tgid;
}
static void forget(struct tracee *tracee){
 if(tracee->dupfd>=0)close(tracee->dupfd);
 tracee->dupfd=-1;tracee->active=tracee->restart=0;
}
static struct tracee *find(pid_t tid){
 for(size_t i=0;i<tracee_count;i++)if(tracees[i].tid==tid)return tracees+i;
 return NULL;
}
static void remove_tracee(pid_t tid){
 struct tracee *tracee=find(tid);
 if(!tracee)return;
 forget(tracee);
 if(tracee->pidfd>=0)close(tracee->pidfd);
 free(tracee->buffer);free(tracee->vectors);
 *tracee=tracees[--tracee_count];
}
static struct tracee *track(pid_t tid){
 struct tracee *tracee=find(tid);
 if(tracee)return tracee;
 if(tracee_count==tracee_room){
  size_t room=tracee_room?tracee_room*2:16;
  struct tracee *grown=realloc(tracees,room*sizeof(*grown));
  if(!grown)return NULL;
  tracees=grown;tracee_room=room;
 }
 tracee=tracees+tracee_count++;
 memset(tracee,0,sizeof(*tracee));
 tracee->tid=tid;tracee->tgid=thread_group(tid);tracee->pidfd=tracee->dupfd=-1;
 return tracee;
}
// 1 endpoint, 0 other, -2 closed descriptor, -1 unknown. The descriptor copy
// is kept only when requested (termios queries on the product's own file).
static int endpoint(struct tracee *tracee,uint64_t fd,int *copy_out){
 if(fd>INT_MAX)return 0;
 if(tracee->pidfd<0){
  tracee->pidfd=(int)syscall(SYS_pidfd_open,tracee->tid,O_EXCL);
  if(tracee->pidfd<0)tracee->pidfd=(int)syscall(SYS_pidfd_open,tracee->tgid,0);
  if(tracee->pidfd<0)return -1;
 }
 int copy=(int)syscall(SYS_pidfd_getfd,tracee->pidfd,(int)fd,0);
 if(copy<0)return errno==EBADF?-2:-1;
 struct stat identity;int matched=!fstat(copy,&identity)&&same_endpoint(&identity);
 if(matched && copy_out)*copy_out=copy;else close(copy);
 return matched;
}
static void count_word(int index){__atomic_fetch_add(journal+index,1,__ATOMIC_RELAXED);}
static void unsupported_if_endpoint(struct tracee *tracee,uint64_t first,uint64_t second){
 int a=endpoint(tracee,first,NULL),b=second==first?a:endpoint(tracee,second,NULL);
 if(a==1||b==1)count_word(23);
 else if(a==-1||b==-1)lose();
}
// 1 when any descriptor of the thread group is the endpoint, -1 when unknown.
static int holds_endpoint(pid_t tgid){
 char path[64];snprintf(path,sizeof(path),"/proc/%d/fd",(int)tgid);
 DIR *fds=opendir(path);
 if(!fds)return -1;
 int held=0;struct dirent *entry;struct stat identity;
 while(!held && (entry=readdir(fds))){
  if(entry->d_name[0]=='.')continue;
  if(fstatat(dirfd(fds),entry->d_name,&identity,0))continue;
  held=same_endpoint(&identity);
 }
 closedir(fds);return held;
}
static int kernel_termios(int fd,struct kernel_termios *mode){return ioctl(fd,TCGETS,mode);}
static void pack_termios(unsigned char *target,const struct kernel_termios *value){
 // Linux keeps baud rates in c_cflag (CBAUD/CIBAUD); the speed words stay 0.
 uint64_t flags[6]={value->c_iflag,value->c_oflag,value->c_cflag,value->c_lflag,0,0};
 memcpy(target,flags,sizeof(flags));memcpy(target+sizeof(flags),value->c_cc,19);
}
// Copies payload at entry (writes), exactly like the Darwin pre-call copy.
static void capture_vectors(struct tracee *tracee,int output){
 int count=tracee->count;size_t requested=0,copied=0;
 if(!tracee->vectors && !(tracee->vectors=malloc(MAX_IOVECS*sizeof(struct iovec)))){tracee->truncated=1;return;}
 if(count<0 || count>MAX_IOVECS ||
    copy_memory(tracee->tid,tracee->address,(size_t)count*sizeof(struct iovec),tracee->vectors)!=(size_t)count*sizeof(struct iovec)){
  tracee->truncated=1;tracee->count=0;return;
 }
 for(int i=0;i<count;i++){
  if(tracee->vectors[i].iov_len>SIZE_MAX-requested){tracee->truncated=1;break;}
  requested+=tracee->vectors[i].iov_len;
  if(!output)continue;
  if(requested>payload_capacity)tracee->truncated=1;
  if(!tracee->truncated){
   size_t n=copy_memory(tracee->tid,(uint64_t)(uintptr_t)tracee->vectors[i].iov_base,tracee->vectors[i].iov_len,tracee->buffer+copied);
   copied+=n;if(n!=tracee->vectors[i].iov_len)tracee->truncated=1;
  }
 }
 tracee->requested=requested;
}
// Returns the resume request. Only product endpoint syscalls wait for exit.
static int syscall_entry(struct tracee *tracee){
 struct __ptrace_syscall_info info;
 forget(tracee);
 if(ptrace(PTRACE_GET_SYSCALL_INFO,tracee->tid,sizeof(info),&info)<=0 || info.op!=PTRACE_SYSCALL_INFO_SECCOMP){
  if(accepted)lose();
  return PTRACE_CONT;
 }
 if(!accepted)return PTRACE_CONT;
 if(info.arch!=AUDIT_ARCH_X86_64 || (info.seccomp.nr&X32_SYSCALL_BIT)){count_word(23);return PTRACE_CONT;}
 uint64_t nr=info.seccomp.nr,*arg=info.seccomp.args,kind=0,operation=0;int vector=0;
 switch(nr){
  case SYS_write:kind=1;operation=1;break;
  case SYS_writev:kind=1;operation=2;vector=1;break;
  case SYS_pwrite64:kind=1;operation=5;break;
  case SYS_pwritev:kind=1;operation=6;vector=1;break;
  case SYS_pwritev2:kind=1;operation=7;vector=1;break;
  case SYS_read:kind=3;operation=1;break;
  case SYS_readv:kind=3;operation=2;vector=1;break;
  case SYS_pread64:kind=3;operation=5;break;
  case SYS_preadv:kind=3;operation=6;vector=1;break;
  case SYS_preadv2:kind=3;operation=7;vector=1;break;
  case SYS_ioctl:
   switch((uint32_t)arg[1]){
    case TCSETS:kind=2;operation=0;break;
    case TCSETSW:kind=2;operation=1;break;
    case TCSETSF:kind=2;operation=2;break;
    default:unsupported_if_endpoint(tracee,arg[0],arg[0]);return PTRACE_CONT;
   }
   break;
  case SYS_sendfile:case SYS_tee:unsupported_if_endpoint(tracee,arg[0],arg[1]);return PTRACE_CONT;
  case SYS_splice:case SYS_copy_file_range:unsupported_if_endpoint(tracee,arg[0],arg[2]);return PTRACE_CONT;
  case SYS_vmsplice:unsupported_if_endpoint(tracee,arg[0],arg[0]);return PTRACE_CONT;
  // Submissions live in shared rings or user iocbs; v1 never claims them. A
  // descendant without an endpoint descriptor (a helper with piped stdio) is
  // ignored like its other I/O; raw byte equality still covers its output.
  case SYS_io_uring_setup:case SYS_io_uring_enter:case SYS_io_submit:{
   int held=tracee->tgid==product?1:holds_endpoint(tracee->tgid);
   if(held==1)count_word(23);
   else if(held<0)lose();
   return PTRACE_CONT;
  }
  default:return PTRACE_CONT;
 }
 int copy=-1,matched=endpoint(tracee,arg[0],kind==2?&copy:NULL);
 if(matched==-1){lose();return PTRACE_CONT;}
 if(tracee->tgid!=product){if(matched==1)count_word(22);if(copy>=0)close(copy);return PTRACE_CONT;}
 // A closed stdio descriptor still belongs to the endpoint, as on Darwin.
 int closed_stdio=matched==-2&&(kind==3?arg[0]==0:arg[0]==1||arg[0]==2);
 uint64_t channel=matched==1||closed_stdio?(kind==3?4:endpoint_identity[4]):0;
 if(!channel)return PTRACE_CONT;
 tracee->nr=nr;tracee->kind=kind;tracee->operation=operation;tracee->fd=arg[0];tracee->channel=channel;
 tracee->address=arg[1];tracee->truncated=0;tracee->requested=arg[2];tracee->count=(int)arg[2];tracee->dupfd=copy;
 if(kind==1 && !tracee->buffer && !(tracee->buffer=malloc(payload_capacity)))tracee->truncated=1;
 if(kind==1 && !tracee->truncated){
  if(vector)capture_vectors(tracee,1);
  else if(tracee->requested>payload_capacity)tracee->truncated=1;
  else if(copy_memory(tracee->tid,tracee->address,(size_t)tracee->requested,tracee->buffer)!=tracee->requested)tracee->truncated=1;
 }else if(kind==3 && vector)capture_vectors(tracee,0);
 else if(kind==2){
  tracee->address=arg[2];tracee->requested=TERMIOS_PAYLOAD_BYTES;
  uint64_t prefix[6]={2,19,0,0,0,0};
  if(TERMIOS_PAYLOAD_BYTES>payload_capacity || copy<0)tracee->truncated=1;
  else{
   int queried=kernel_termios(copy,&tracee->before);prefix[2]=(uint64_t)(int64_t)queried;prefix[3]=queried?(uint64_t)errno:0;
   if(queried || copy_memory(tracee->tid,tracee->address,sizeof(tracee->requested_mode),&tracee->requested_mode)!=sizeof(tracee->requested_mode))tracee->truncated=1;
  }
  memcpy(tracee->prefix,prefix,sizeof(prefix));
 }
 tracee->active=1;tracee->entry=now();
 return PTRACE_SYSCALL;
}
static void commit(struct tracee *tracee,int64_t value){
 uint64_t *slot=reserve(tracee->kind,0,(uint64_t)product,(uint64_t)tracee->tid);
 if(slot){
  int failed=value<0 && value>=-4095;int64_t returned=failed?-1:value;
  unsigned char *payload=(unsigned char*)(slot+RECORD_WORDS);
  slot[5]=tracee->entry;slot[6]=tracee->returned_at;slot[7]=tracee->fd;slot[8]=tracee->channel;
  slot[9]=tracee->operation;slot[10]=tracee->requested;slot[11]=(uint64_t)returned;
  slot[12]=failed?(uint64_t)-value:0;slot[13]=tracee->truncated;
  if(tracee->kind==1 && returned>0 && !slot[13]){
   if((uint64_t)returned>tracee->requested)slot[13]=1;
   else{memcpy(payload,tracee->buffer,(size_t)returned);slot[14]=(uint64_t)returned;}
  }else if(tracee->kind==3 && returned>0 && !slot[13]){
   if((uint64_t)returned>tracee->requested || (uint64_t)returned>payload_capacity)slot[13]=1;
   else if(tracee->operation==2||tracee->operation==6||tracee->operation==7){
    size_t remaining=(size_t)returned,copied=0;
    for(int i=0;i<tracee->count && remaining;i++){
     size_t length=tracee->vectors[i].iov_len<remaining?tracee->vectors[i].iov_len:remaining;
     size_t n=copy_memory(tracee->tid,(uint64_t)(uintptr_t)tracee->vectors[i].iov_base,length,payload+copied);
     copied+=n;if(n!=length){slot[13]=1;break;}remaining-=length;
    }
    slot[14]=copied;if(remaining)slot[13]=1;
   }else{
    slot[14]=copy_memory(tracee->tid,tracee->address,(size_t)returned,payload);
    if(slot[14]!=(uint64_t)returned)slot[13]=1;
   }
  }else if(tracee->kind==2 && !slot[13]){
   struct kernel_termios after;
   int queried=kernel_termios(tracee->dupfd,&after);
   tracee->prefix[4]=(uint64_t)(int64_t)queried;tracee->prefix[5]=queried?(uint64_t)errno:0;
   if(queried)slot[13]=1;
   else{
    memcpy(payload,tracee->prefix,sizeof(tracee->prefix));payload+=sizeof(tracee->prefix);
    pack_termios(payload,&tracee->before);pack_termios(payload+TERMIOS_VALUE_BYTES,&tracee->requested_mode);
    pack_termios(payload+2*TERMIOS_VALUE_BYTES,&after);
    slot[14]=TERMIOS_PAYLOAD_BYTES;
   }
  }
  publish(slot);
 }
 forget(tracee);
}
static void syscall_exit(struct tracee *tracee){
 struct __ptrace_syscall_info info;
 uint64_t returned_at=now();
 if(!tracee->active)return;
 if(ptrace(PTRACE_GET_SYSCALL_INFO,tracee->tid,sizeof(info),&info)<=0 || info.op!=PTRACE_SYSCALL_INFO_EXIT){
  lose();forget(tracee);return;
 }
 tracee->returned_at=returned_at;
 int64_t value=info.exit.rval;
 // The kernel either restarts (a new seccomp event) or turns this into EINTR
 // while delivering a signal; stepped_trap() decides which.
 if(value==-ERESTARTSYS || value==-ERESTARTNOINTR || value==-ERESTARTNOHAND || value==-ERESTART_RESTARTBLOCK){
  tracee->restart=1;return;
 }
 commit(tracee,value);
}
// Returns 1 for the trap our single step caused (a kernel si_code; a user
// SIGTRAP is delivered). At a handler (si_code SIGTRAP) the frame at rdx holds
// the interrupted context's saved rax: -EINTR, or the syscall nr to restart.
static int stepped_trap(struct tracee *tracee){
 siginfo_t info;struct user_regs_struct regs;uint64_t saved=0;
 if(ptrace(PTRACE_GETSIGINFO,tracee->tid,0,&info) || info.si_code<=0)return 0;
 if(info.si_code!=SIGTRAP || !tracee->restart)return 1;
 if(ptrace(PTRACE_GETREGS,tracee->tid,0,&regs) ||
    copy_memory(tracee->tid,regs.rdx+offsetof(ucontext_t,uc_mcontext.gregs[REG_RAX]),sizeof(saved),&saved)!=sizeof(saved)){
  lose();forget(tracee);return 1;
 }
 if(saved==(uint64_t)-EINTR)commit(tracee,-EINTR);
 else if(saved!=tracee->nr){lose();forget(tracee);}
 return 1;
}
static void exec_event(pid_t tid,const struct stat *binary){
 unsigned long former=0;
 if(!ptrace(PTRACE_GETEVENTMSG,tid,0,&former) && (pid_t)former!=tid)remove_tracee((pid_t)former);
 struct tracee *tracee=find(tid);
 if(!tracee)return;
 forget(tracee);tracee->tgid=tid;
 if(tid!=product)return;
 if(accepted||rejected){lose();return;}
 char path[64];struct stat executable;uint64_t expected=0;
 snprintf(path,sizeof(path),"/proc/%d/exe",(int)product);
 if(stat(path,&executable) || executable.st_dev!=binary->st_dev || executable.st_ino!=binary->st_ino ||
    !__atomic_compare_exchange_n(journal+8,&expected,(uint64_t)product,0,__ATOMIC_ACQ_REL,__ATOMIC_ACQUIRE)){
  rejected=1;lose();return;
 }
 journal[12]=1;journal[13]=1;journal[19]=now();accepted=1;
}
static int trace(const struct stat *binary){
 if(!track(product))return 4;
 for(;;){
  siginfo_t peek;memset(&peek,0,sizeof(peek));
  if(waitid(P_ALL,0,&peek,WEXITED|WSTOPPED|__WALL|WNOWAIT)){
   if(errno==EINTR)continue;
   break;
  }
  // Close before the reap: the real parent cannot observe this exit earlier.
  if(peek.si_pid==product && peek.si_code==CLD_EXITED && accepted && load_word(journal+8)==(uint64_t)product){
   journal[21]=now();__atomic_store_n(journal+11,1,__ATOMIC_RELEASE);
  }
  int status;pid_t tid=waitpid(peek.si_pid,&status,__WALL);
  if(tid<0)continue;
  if(WIFEXITED(status)||WIFSIGNALED(status)){remove_tracee(tid);continue;}
  if(!WIFSTOPPED(status))continue;
  struct tracee *tracee=track(tid);
  if(!tracee){internal_error=1;break;}
  int signal=WSTOPSIG(status),event=status>>16,request=PTRACE_CONT,stepped=tracee->stepping;
  long data=0;unsigned long child=0;
  tracee->stepping=0;
  switch(event){
   case PTRACE_EVENT_SECCOMP:request=syscall_entry(tracee);break;
   case PTRACE_EVENT_EXEC:exec_event(tid,binary);break;
   case PTRACE_EVENT_CLONE:case PTRACE_EVENT_FORK:case PTRACE_EVENT_VFORK:
    // The child's own first stop may already have been handled; keep its state.
    if(!ptrace(PTRACE_GETEVENTMSG,tid,0,&child) && !track((pid_t)child))internal_error=1;
    break;
   case PTRACE_EVENT_STOP:
    if(signal==SIGSTOP||signal==SIGTSTP||signal==SIGTTIN||signal==SIGTTOU)request=PTRACE_LISTEN;
    break;
   case 0:
    if(signal==(SIGTRAP|0x80))syscall_exit(tracee);
    else if(!(signal==SIGTRAP && stepped && stepped_trap(tracee))){
     data=signal;
     if(tracee->restart){request=PTRACE_SINGLESTEP;tracee->stepping=1;}
    }
    break;
   default:break;
  }
  if(ptrace(request,tid,0,data) && errno!=ESRCH)internal_error=1;
 }
 return internal_error?4:rejected?3:accepted?0:5;
}
static int install_filter(void){
 static const uint32_t traced[]={SYS_write,SYS_writev,SYS_pwrite64,SYS_pwritev,SYS_pwritev2,
  SYS_read,SYS_readv,SYS_pread64,SYS_preadv,SYS_preadv2,SYS_sendfile,SYS_splice,SYS_tee,
  SYS_vmsplice,SYS_copy_file_range,SYS_io_uring_setup,SYS_io_uring_enter,SYS_io_submit};
 static const uint32_t modes[]={TCSETS,TCSETSW,TCSETSF,TERMIOS2_SET,TERMIOS2_SET_DRAIN,TERMIOS2_SET_FLUSH,
  TCSETA,TCSETAW,TCSETAF};
 enum{TRACED=sizeof(traced)/sizeof(traced[0]),MODES=sizeof(modes)/sizeof(modes[0]),TRACE=5+TRACED+2+MODES};
 struct sock_filter program[TRACE+2];unsigned n=0;
 // Any other ABI (i386 int 0x80, x32) is traced and fails closed as unsupported.
 program[n++]=(struct sock_filter)BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch));
 program[n++]=(struct sock_filter)BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,AUDIT_ARCH_X86_64,1,0);
 program[n++]=(struct sock_filter)BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_TRACE);
 program[n++]=(struct sock_filter)BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr));
 program[n]=(struct sock_filter)BPF_JUMP(BPF_JMP|BPF_JGE|BPF_K,X32_SYSCALL_BIT,TRACE-n-1,0);n++;
 for(unsigned i=0;i<TRACED;i++,n++)program[n]=(struct sock_filter)BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,traced[i],TRACE-n-1,0);
 program[n]=(struct sock_filter)BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,SYS_ioctl,0,TRACE-n);n++;
 // ioctl: the kernel uses only the low 32 bits of the request.
 program[n++]=(struct sock_filter)BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[1]));
 for(unsigned i=0;i<MODES;i++,n++)program[n]=(struct sock_filter)BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,modes[i],TRACE-n-1,i+1==MODES);
 program[n++]=(struct sock_filter)BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_TRACE);
 program[n++]=(struct sock_filter)BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW);
 struct sock_fprog filter={(unsigned short)n,program};
 return prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&filter);
}
static int transfer(int fd,void *bytes,size_t length,int output){
 size_t done=0;
 while(done<length){
  ssize_t n=output?write(fd,(char*)bytes+done,length-done):read(fd,(char*)bytes+done,length-done);
  if(n<0&&errno==EINTR)continue;
  if(n<=0)return -1;
  done+=(size_t)n;
 }
 return 0;
}
// T2 keeps no inherited descriptor: the PTY and caller pipes stay the product's.
static _Noreturn void tracer(const struct stat *binary,int up,int down){
 int null=open("/dev/null",O_RDWR);
 if(null<0)_exit(2);
 for(int fd=0;fd<=2;fd++)if(dup2(null,fd)<0)_exit(2);
 int high_up=fcntl(up,F_DUPFD,64),high_down=fcntl(down,F_DUPFD,64);
 if(high_up<0||high_down<0||dup2(high_up,3)<0||dup2(high_down,4)<0||close_range(5,~0U,0))_exit(2);
 up=3;down=4;
 pid_t self=getpid();char go;int status=0;
 if(transfer(up,&self,sizeof(self),1)||transfer(down,&go,1,0))_exit(2);
 if(ptrace(PTRACE_SEIZE,product,0,OPTIONS))status=errno;
 if(transfer(up,&status,sizeof(status),1)||status)_exit(2);
 close(up);close(down);
 _exit(trace(binary));
}
static pid_t tracer_of_self(void){
 char line[256];pid_t tracer=0;FILE *status=fopen("/proc/self/status","re");
 if(!status)return 0;
 while(fgets(line,sizeof(line),status))if(sscanf(line,"TracerPid: %d",&tracer)==1)break;
 fclose(status);return tracer;
}
int main(int argc,char **argv){
 const char *path=NULL,*binary_path=NULL;int report=-1,index=1;
 for(;index<argc;index++){
  if(!strcmp(argv[index],"--")){index++;break;}
  if(index+1>=argc)fail("usage: observer-exec --journal PATH --binary PATH [--tracer-pid-fd FD] -- ARGV...",0);
  if(!strcmp(argv[index],"--journal"))path=argv[++index];
  else if(!strcmp(argv[index],"--binary"))binary_path=argv[++index];
  else if(!strcmp(argv[index],"--tracer-pid-fd"))report=atoi(argv[++index]);
  else fail("unknown option",0);
 }
 if(!path||!binary_path||index>=argc)fail("usage: observer-exec --journal PATH --binary PATH [--tracer-pid-fd FD] -- ARGV...",0);
 int fd=map_journal(path);
 if(fd<0)fail("invalid Linux journal registration",0);
 if(load_word(journal+8))fail("journal producer is already bound",0);
 if(!attached())fail("stdout/stderr are not the registered endpoint",0);
 struct stat binary;
 if(stat(binary_path,&binary)||!S_ISREG(binary.st_mode))fail("registered binary is not a regular file",errno);
 int up[2],down[2];
 if(pipe2(up,O_CLOEXEC)||pipe2(down,O_CLOEXEC))fail("pipe",errno);
 product=getpid();
 pid_t first=fork();
 if(first<0)fail("fork",errno);
 if(!first){
  // Own session: terminal signals for the product's group never reach T2.
  if(setsid()<0)_exit(1);
  pid_t second=fork();
  if(second<0)_exit(1);
  if(!second)tracer(&binary,up[1],down[0]);
  _exit(0);
 }
 int status=0;
 if(waitpid(first,&status,0)!=first||!WIFEXITED(status)||WEXITSTATUS(status))fail("tracer fork failed",0);
 close(up[1]);close(down[0]);
 pid_t tracer=0;int seized=0;
 if(transfer(up[0],&tracer,sizeof(tracer),0))fail("tracer did not start",0);
 if(prctl(PR_SET_PTRACER,(unsigned long)tracer,0,0,0)&&errno!=EINVAL)fail("PR_SET_PTRACER",errno);
 if(transfer(down[1],"1",1,1)||transfer(up[0],&seized,sizeof(seized),0))fail("tracer did not attach",0);
 if(seized)fail("ptrace seize failed",seized);
 if(tracer_of_self()!=tracer)fail("TracerPid differs from the observer tracer",0);
 if(report>=0){
  if(dprintf(report,"%d\n",(int)tracer)<0)fail("tracer pid report",errno);
  close(report);
 }
 close(up[0]);close(down[1]);munmap(journal,mapped_bytes);journal=NULL;close(fd);
 if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0))fail("PR_SET_NO_NEW_PRIVS",errno);
 if(install_filter())fail("seccomp filter",errno);
 execv(argv[index],argv+index);
 dprintf(2,"observer-exec: execv %s: %s\n",argv[index],strerror(errno));
 _exit(127);
}
#endif

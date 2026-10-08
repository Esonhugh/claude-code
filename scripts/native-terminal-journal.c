// Private Darwin observer: immutable shared slots, no collector ACK or hot-path I/O.
// Original writes still run exactly once, even when the journal is invalid/full.
#include <unistd.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <fcntl.h>
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <mach/mach_vm.h>
#define MAGIC UINT64_C(0x314c4e4a544343)
#define HEADER_WORDS 32
#define RECORD_WORDS 20
#define MAX_IOVECS 1024
_Static_assert(__atomic_always_lock_free(8, 0), "Observer requires lock-free 64-bit atomics");
extern ssize_t write_nocancel(int,const void*,size_t) __asm("_write$NOCANCEL");
extern ssize_t writev_nocancel(int,const struct iovec*,int) __asm("_writev$NOCANCEL");
static uint64_t *journal;
static size_t mapped_bytes;
static int journal_fd=-1;
static size_t slot_stride,slot_capacity,payload_capacity;
static uint64_t endpoint_identity[5];
static _Thread_local unsigned inside_write;
static _Thread_local struct iovec vectors[MAX_IOVECS];
static uint64_t load_word(uint64_t *word){return __atomic_load_n(word,__ATOMIC_ACQUIRE);}
static void lose(void){if(journal)__atomic_fetch_add(journal+10,1,__ATOMIC_RELAXED);}
static int same_endpoint(const struct stat *identity){
 return (uint64_t)identity->st_dev==endpoint_identity[0] && (uint64_t)identity->st_ino==endpoint_identity[1] &&
        (uint64_t)identity->st_rdev==endpoint_identity[2] && (uint64_t)identity->st_mode==endpoint_identity[3];
}
static int output_channel(int fd){
 if(!journal || inside_write || fd==journal_fd)return 0;
 struct stat identity;int mask=0;
 if(fstat(fd,&identity)){return (fd==1||fd==2)?(int)endpoint_identity[4]:0;}
 if(same_endpoint(&identity))mask=(int)endpoint_identity[4];
 return mask;
}
static uint64_t *reserve(uint64_t kind,uint64_t span){
 if(!journal)return NULL;
 if(journal[0]!=MAGIC || journal[1]!=1 || journal[2]!=HEADER_WORDS*8 || journal[3]!=slot_stride ||
    journal[4]!=slot_capacity || journal[5]!=payload_capacity ||
    journal[8]!=(uint64_t)getpid() || load_word(journal+11)){lose();return NULL;}
 uint64_t sequence=__atomic_fetch_add(journal+9,1,__ATOMIC_RELAXED)+1;
 uint64_t *slot=(uint64_t*)((unsigned char*)journal+HEADER_WORDS*8+((sequence-1)%slot_capacity)*slot_stride);
 uint64_t expected=0;
 if(!__atomic_compare_exchange_n(slot,&expected,1,0,__ATOMIC_ACQUIRE,__ATOMIC_RELAXED)){lose();return NULL;}
 memset(slot+1,0,(RECORD_WORDS-1)*sizeof(uint64_t));
 uint64_t thread=0;pthread_threadid_np(NULL,&thread);
 slot[1]=sequence;slot[2]=kind;slot[3]=(uint64_t)getpid();slot[4]=thread;slot[15]=span;
 return slot;
}
static size_t copy_memory(const void *source,size_t bytes,void *target){
 mach_vm_size_t copied=0;
 if(!bytes)return 0;
 if(mach_vm_read_overwrite(mach_task_self(),(mach_vm_address_t)source,bytes,(mach_vm_address_t)target,&copied)!=KERN_SUCCESS)return 0;
 return (size_t)copied;
}
static void publish(uint64_t *slot){__atomic_store_n(slot,2,__ATOMIC_RELEASE);}
// Metadata only. It never writes stdout, flushes a stream or waits on a consumer.
uint64_t cc_terminal_journal_mark(uint64_t kind,uint64_t span,const void *bytes,uint64_t length){
 int saved=errno;
 if(!journal){errno=saved;return 0;}
 uint64_t *slot=reserve(kind,span);
 if(!slot){errno=saved;return 0;}
 slot[5]=mach_absolute_time();slot[10]=length;
 if(kind<10 || kind>20 || length>payload_capacity)slot[13]=1;
 else{
  size_t copied=copy_memory(bytes,(size_t)length,slot+RECORD_WORDS);
  slot[14]=copied;if(copied!=length)slot[13]=1;
 }
 slot[6]=mach_absolute_time();uint64_t sequence=slot[1];publish(slot);errno=saved;return sequence;
}
// Collector-only API: acquire a whole committed record, then release its slot.
// A missing/foreign sequence is never synthesized from a later record.
static int registered_header(uint64_t *header,const uint64_t *expected){
 for(int i=0;i<HEADER_WORDS;i++){
  if(i==8||i==9||i==10||i==11||i==12||i==13||i==19||i==21)continue;
  if(load_word(header+i)!=expected[i])return 0;
 }
 return 1;
}
// The collector performs the real resize here. These are the same kernel clock
// and timebase as producer write records, not a Python clock approximation.
int cc_terminal_native_resize(int fd,uint64_t packed_size,uint64_t *receipt){
 struct winsize requested,before={0},after={0};
 _Static_assert(sizeof(struct winsize)==8,"Darwin winsize receipt must be eight bytes");
 memcpy(&requested,&packed_size,sizeof(requested));
 if(!receipt)return ioctl(fd,TIOCSWINSZ,&requested);
 int incoming=errno;memset(receipt,0,12*sizeof(uint64_t));
 mach_timebase_info_data_t clock={0};mach_timebase_info(&clock);
 receipt[10]=clock.numer;receipt[11]=clock.denom;
 errno=incoming;int prior=ioctl(fd,TIOCGWINSZ,&before);int prior_errno=errno;
 errno=incoming;receipt[0]=mach_absolute_time();
 int returned=ioctl(fd,TIOCSWINSZ,&requested);int outcome=errno;
 receipt[1]=mach_absolute_time();
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
__attribute__((constructor)) static void open_journal(void){
 int saved=errno;const char *path=getenv("CLAUDE_PRIVATE_NATIVE_JOURNAL");
 if(!path){errno=saved;return;}
 journal_fd=open(path,O_RDWR|O_CLOEXEC|O_NOFOLLOW);
 struct stat file;
 if(journal_fd<0 || fstat(journal_fd,&file) || !S_ISREG(file.st_mode) || file.st_uid!=getuid() ||
    (file.st_mode&0777)!=0600 || file.st_nlink!=1 || file.st_size<HEADER_WORDS*8)goto invalid;
 mapped_bytes=(size_t)file.st_size;
 journal=mmap(NULL,mapped_bytes,PROT_READ|PROT_WRITE,MAP_SHARED,journal_fd,0);
 if(journal==MAP_FAILED){journal=NULL;goto invalid;}
 if(journal[0]!=MAGIC || journal[1]!=1 || journal[2]!=HEADER_WORDS*8 ||
    !journal[4] || journal[4]>4096 || !journal[5] || journal[5]>1048576 ||
    journal[3]<RECORD_WORDS*8+journal[5] || journal[3]%64 ||
    journal[4]>(SIZE_MAX-journal[2])/journal[3] ||
    journal[2]+journal[3]*journal[4]!=mapped_bytes)goto invalid;
 slot_stride=journal[3];slot_capacity=journal[4];payload_capacity=journal[5];
 memcpy(endpoint_identity,journal+14,sizeof(endpoint_identity));
 // Descendants with different pipe endpoints are outside this main-PTY scope.
 struct stat output;int attached=0;
 for(int fd=1;fd<=2;fd++)if(!fstat(fd,&output)&&same_endpoint(&output))attached|=1<<(fd-1);
 if(!attached)goto invalid;
 uint64_t expected=0;
 if(!__atomic_compare_exchange_n(journal+8,&expected,(uint64_t)getpid(),0,__ATOMIC_ACQ_REL,__ATOMIC_ACQUIRE)){
  lose();goto invalid;
 }
 mach_timebase_info_data_t clock;mach_timebase_info(&clock);
 journal[12]=clock.numer;journal[13]=clock.denom;journal[19]=mach_absolute_time();
 errno=saved;return;
invalid:
 if(journal){munmap(journal,mapped_bytes);journal=NULL;}
 if(journal_fd>=0){close(journal_fd);journal_fd=-1;}
 errno=saved;
}
__attribute__((destructor)) static void close_journal(void){
 int saved=errno;
 if(journal){
  if(journal[8]==(uint64_t)getpid()){
   journal[21]=mach_absolute_time();__atomic_store_n(journal+11,1,__ATOMIC_RELEASE);
  }
  // Keep the mapping valid for any in-flight original syscall. The process
  // owns this mapping for its entire lifetime; kernel exit releases it.
 }
 if(journal_fd>=0){close(journal_fd);journal_fd=-1;}
 errno=saved;
}
static ssize_t record_write(int fd,const void *bytes,size_t count,ssize_t(*original)(int,const void*,size_t),uint64_t operation){
 int incoming=errno,channel=output_channel(fd);errno=incoming;
 if(!channel)return original(fd,bytes,count);
 uint64_t *slot=reserve(1,0);
 if(slot){
  slot[7]=(uint64_t)fd;slot[8]=(uint64_t)channel;slot[9]=operation;slot[10]=count;
  if(count>payload_capacity)slot[13]=1;
  else if(copy_memory(bytes,count,slot+RECORD_WORDS)!=count)slot[13]=1;
 }
 errno=incoming;inside_write++;
 if(slot)slot[5]=mach_absolute_time();
 ssize_t returned=original(fd,bytes,count);int outcome=errno;
 if(slot){slot[6]=mach_absolute_time();slot[11]=(uint64_t)returned;slot[12]=(uint64_t)outcome;
  if(returned>0 && !slot[13])slot[14]=(uint64_t)returned;publish(slot);}
 inside_write--;errno=outcome;return returned;
}
static ssize_t record_writev(int fd,const struct iovec *iov,int count,ssize_t(*original)(int,const struct iovec*,int),uint64_t operation){
 int incoming=errno,channel=output_channel(fd);errno=incoming;
 if(!channel)return original(fd,iov,count);
 uint64_t *slot=reserve(1,0);size_t requested=0,copied=0;
 if(slot){
  slot[7]=(uint64_t)fd;slot[8]=(uint64_t)channel;slot[9]=operation;
  if(count<0 || count>MAX_IOVECS || copy_memory(iov,(size_t)count*sizeof(struct iovec),vectors)!=(size_t)count*sizeof(struct iovec))slot[13]=1;
  else for(int i=0;i<count;i++){
   if(vectors[i].iov_len>SIZE_MAX-requested){slot[13]=1;break;}
   requested+=vectors[i].iov_len;
   if(requested>payload_capacity)slot[13]=1;
   if(!slot[13]){
    size_t n=copy_memory(vectors[i].iov_base,vectors[i].iov_len,(unsigned char*)(slot+RECORD_WORDS)+copied);
    copied+=n;if(n!=vectors[i].iov_len)slot[13]=1;
   }
  }
  slot[10]=requested;
 }
 errno=incoming;inside_write++;
 if(slot)slot[5]=mach_absolute_time();
 ssize_t returned=original(fd,iov,count);int outcome=errno;
 if(slot){slot[6]=mach_absolute_time();slot[11]=(uint64_t)returned;slot[12]=(uint64_t)outcome;
  if(returned>0 && !slot[13])slot[14]=(uint64_t)returned;publish(slot);}
 inside_write--;errno=outcome;return returned;
}
static ssize_t observed_write(int fd,const void *bytes,size_t length){return record_write(fd,bytes,length,write,1);}
static ssize_t observed_writev(int fd,const struct iovec *iov,int count){return record_writev(fd,iov,count,writev,2);}
static ssize_t observed_write_nocancel(int fd,const void *bytes,size_t length){return record_write(fd,bytes,length,write_nocancel,3);}
static ssize_t observed_writev_nocancel(int fd,const struct iovec *iov,int count){return record_writev(fd,iov,count,writev_nocancel,4);}
// Canonical fields omit struct padding and retain Darwin's full 64-bit flags.
static void pack_termios(unsigned char *target,const struct termios *value){
 uint64_t flags[6]={value->c_iflag,value->c_oflag,value->c_cflag,value->c_lflag,value->c_ispeed,value->c_ospeed};
 memcpy(target,flags,sizeof(flags));memcpy(target+sizeof(flags),value->c_cc,NCCS);
}
static int observed_tcsetattr(int fd,int action,const struct termios *requested){
 int incoming=errno,channel=output_channel(fd);errno=incoming;
 if(!channel)return tcsetattr(fd,action,requested);
 _Static_assert(sizeof(tcflag_t)==8 && sizeof(speed_t)==8 && NCCS==20,"Darwin termios field sizes changed");
 uint64_t *slot=reserve(2,0),prefix[6]={1,NCCS,0,0,0,0};
 struct termios before={0},copied={0},after={0};
 const size_t value_bytes=6*sizeof(uint64_t)+NCCS,payload_bytes=sizeof(prefix)+3*value_bytes;
 if(slot){
  slot[7]=(uint64_t)fd;slot[8]=(uint64_t)channel;slot[9]=(uint64_t)(int64_t)action;slot[10]=payload_bytes;
  if(payload_bytes>payload_capacity)slot[13]=1;
  else{
   errno=incoming;int queried=tcgetattr(fd,&before);prefix[2]=(uint64_t)(int64_t)queried;prefix[3]=(uint64_t)errno;
   if(queried || copy_memory(requested,sizeof(copied),&copied)!=sizeof(copied))slot[13]=1;
  }
 }
 errno=incoming;if(slot)slot[5]=mach_absolute_time();
 int returned=tcsetattr(fd,action,requested);int outcome=errno;
 if(slot){
  slot[6]=mach_absolute_time();slot[11]=(uint64_t)(int64_t)returned;slot[12]=(uint64_t)outcome;
  if(!slot[13]){
   errno=outcome;int queried=tcgetattr(fd,&after);prefix[4]=(uint64_t)(int64_t)queried;prefix[5]=(uint64_t)errno;
   if(queried)slot[13]=1;
   else{
    unsigned char *payload=(unsigned char*)(slot+RECORD_WORDS);
    memcpy(payload,prefix,sizeof(prefix));payload+=sizeof(prefix);
    pack_termios(payload,&before);pack_termios(payload+value_bytes,&copied);pack_termios(payload+2*value_bytes,&after);
    slot[14]=payload_bytes;
   }
  }
  publish(slot);
 }
 errno=outcome;return returned;
}
#define INTERPOSE(replacement,original) __attribute__((used)) static struct {const void *replacement;const void *original;} interpose_##original __attribute__((section("__DATA,__interpose")))={(const void*)replacement,(const void*)original}
INTERPOSE(observed_write,write);
INTERPOSE(observed_writev,writev);
INTERPOSE(observed_write_nocancel,write_nocancel);
INTERPOSE(observed_writev_nocancel,writev_nocancel);
INTERPOSE(observed_tcsetattr,tcsetattr);

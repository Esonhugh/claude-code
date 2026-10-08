// Darwin verification observer. No ACK, product fd redirection or format prediction.
// Incomplete captures must fail validation; this is not a UI/frame acceptance oracle.
#include <unistd.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/uio.h>
#include <sys/stat.h>
#include <pthread.h>
#include <fcntl.h>
#include <errno.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <mach/mach.h>
#include <mach/mach_vm.h>
#define LIMIT 4096
#define MAGIC UINT64_C(0x34434c4c41435754)
extern ssize_t write_nocancel(int,const void*,size_t) __asm("_write$NOCANCEL");
extern ssize_t writev_nocancel(int,const struct iovec*,int) __asm("_writev$NOCANCEL");
static _Thread_local unsigned inside_write=0;
static int observer_fd=-1;
static _Atomic uint64_t next_id=0, dropped=0;
static struct stat output_identity[2];
static int output_identity_valid[2]={0,0};
static _Thread_local unsigned char snapshot[LIMIT];
static _Thread_local struct iovec vectors[1024];
static void emit(uint64_t kind,uint64_t id,int fd,size_t requested,ssize_t result,uint64_t flags,const void *bytes,size_t length,uint64_t operation,uint64_t output_mask,int outcome_errno) {
 int saved=errno;
 // Darwin's default Unix datagram payload budget can be smaller than a write.
 // Every fragment is nonblocking and contains the same original syscall result.
 size_t offset=0;
 do {
  size_t part=length-offset;if(part>1024)part=1024;
  uint64_t thread_id=0;pthread_threadid_np(NULL,&thread_id);
  uint64_t header[15]={MAGIC,kind,(uint64_t)getpid(),id,(uint64_t)fd,(uint64_t)requested,(uint64_t)result,flags,operation,offset,length,part,output_mask,(uint64_t)outcome_errno,thread_id};
  struct iovec v[2]={{header,sizeof(header)},{(void*)(part?(const unsigned char*)bytes+offset:NULL),part}};
  struct msghdr message={0};message.msg_iov=v;message.msg_iovlen=part?2:1;
  if(observer_fd<0 || sendmsg(observer_fd,&message,MSG_DONTWAIT)!=(ssize_t)(sizeof(header)+part))atomic_fetch_add(&dropped,1);
  offset+=part;
 } while(offset<length);
 errno=saved;
}
static size_t copy_memory(const void *pointer,size_t count,void *target) {
 mach_vm_size_t actual=0;
 if(!count) return 0;
 if(mach_vm_read_overwrite(mach_task_self(),(mach_vm_address_t)pointer,count,(mach_vm_address_t)target,&actual)!=KERN_SUCCESS) return 0;
 return (size_t)actual;
}
__attribute__((constructor)) static void start_observer(void) {
 int saved=errno;for(int i=0;i<2;i++)output_identity_valid[i]=fstat(i+1,&output_identity[i])==0;
 const char *path=getenv("CLAUDE_PRIVATE_SYSCALL_WITNESS_SOCKET");
 if(path && strlen(path)<sizeof(((struct sockaddr_un*)0)->sun_path)) {
  struct sockaddr_un address={0};address.sun_family=AF_UNIX;strcpy(address.sun_path,path);
  observer_fd=socket(AF_UNIX,SOCK_DGRAM,0);
  if(observer_fd>=0) {
   if(fcntl(observer_fd,F_SETFD,FD_CLOEXEC)==-1 ||
      fcntl(observer_fd,F_SETFL,O_NONBLOCK)==-1 ||
      connect(observer_fd,(struct sockaddr*)&address,sizeof(address))!=0){close(observer_fd);observer_fd=-1;}
  }
  emit(0,0,0,0,0,0,NULL,0,0,0,0);
 }
 errno=saved;
}
__attribute__((destructor)) static void close_observer(void) {
 int saved=errno;
 if(observer_fd>=0){emit(2,atomic_load(&next_id),0,0,0,atomic_load(&dropped),NULL,0,0,0,0);close(observer_fd);observer_fd=-1;}
 errno=saved;
}
static int output_channel(int fd){
 if(fd<0||fd==observer_fd)return 0;
 struct stat candidate;
 if(fstat(fd,&candidate))return fd==1?1:fd==2?2:0;
 int mask=0;
 for(int channel=0;channel<2;channel++){
  const struct stat *output=&output_identity[channel];
  if(output_identity_valid[channel]&&candidate.st_dev==output->st_dev&&candidate.st_ino==output->st_ino&&candidate.st_mode==output->st_mode&&candidate.st_rdev==output->st_rdev)mask|=1<<channel;
 }
 return mask;
}
static ssize_t record_write(int fd,const void *buffer,size_t count,ssize_t (*writer)(int,const void*,size_t),uint64_t operation) {
 int incoming=errno;int channel=observer_fd<0||inside_write?0:output_channel(fd);errno=incoming;
 if(!channel)return writer(fd,buffer,count);uint64_t id=atomic_fetch_add(&next_id,1)+1;
 size_t bounded=count>LIMIT?LIMIT:count, copied=copy_memory(buffer,bounded,snapshot);
 uint64_t flags=(count>LIMIT || copied!=bounded)?1:0;
 errno=incoming;
 inside_write++;ssize_t result=writer(fd,buffer,count);int outcome_errno=errno;inside_write--;
 size_t emitted=result>0?(size_t)result:0;if(emitted>copied){emitted=copied;flags|=1;}
 emit(1,id,fd,count,result,flags,snapshot,emitted,operation,channel,outcome_errno);
 errno=outcome_errno;return result;
}
static ssize_t record_writev(int fd,const struct iovec *iov,int count,ssize_t (*writer)(int,const struct iovec*,int),uint64_t operation) {
 int incoming=errno;int channel=observer_fd<0||inside_write?0:output_channel(fd);errno=incoming;
 if(!channel)return writer(fd,iov,count);uint64_t id=atomic_fetch_add(&next_id,1)+1;
 uint64_t flags=0;size_t requested=0,copied=0;
 if(count<0 || count>1024 || copy_memory(iov,(size_t)count*sizeof(struct iovec),vectors)!=(size_t)count*sizeof(struct iovec)) flags=1;
 else for(int i=0;i<count;i++) {
  if(vectors[i].iov_len>SIZE_MAX-requested){flags=1;break;}
  requested+=vectors[i].iov_len;size_t room=LIMIT-copied,take=vectors[i].iov_len<room?vectors[i].iov_len:room;
  if(take){size_t n=copy_memory(vectors[i].iov_base,take,snapshot+copied);copied+=n;if(n!=take)flags=1;}
  if(vectors[i].iov_len>take) flags=1;
 }
 errno=incoming;inside_write++;ssize_t result=writer(fd,iov,count);int outcome_errno=errno;inside_write--;
 size_t emitted=result>0?(size_t)result:0;if(emitted>copied){emitted=copied;flags|=1;}
 emit(1,id,fd,requested,result,flags,snapshot,emitted,operation,channel,outcome_errno);
 errno=outcome_errno;return result;
}
static ssize_t observed_write(int fd,const void *buffer,size_t count){return record_write(fd,buffer,count,write,1);}
static ssize_t observed_writev(int fd,const struct iovec *iov,int count){return record_writev(fd,iov,count,writev,2);}
static ssize_t observed_write_nocancel(int fd,const void *buffer,size_t count){return record_write(fd,buffer,count,write_nocancel,3);}
static ssize_t observed_writev_nocancel(int fd,const struct iovec *iov,int count){return record_writev(fd,iov,count,writev_nocancel,4);}
__attribute__((used,section("__DATA,__interpose"))) static const struct {const void *replacement,*original;} interposers[]={
 {(const void*)observed_write,(const void*)write},{(const void*)observed_writev,(const void*)writev},
 {(const void*)observed_write_nocancel,(const void*)write_nocancel},{(const void*)observed_writev_nocancel,(const void*)writev_nocancel}
};

import { dlopen, FFIType, ptr } from 'bun:ffi'
import { join } from 'node:path'
import { readOwnedNativeFile } from './native-evidence-files.mjs'

let system, libc
/** Actual caller clock; enrollment identity never substitutes for caller identity. */
export function readNativeDriverClock(launch) {
  const linux = process.platform === 'linux'
  if ((process.platform !== 'darwin' && !linux) || launch.capture?.nativeJournal !== true ||
      launch.driverPid !== process.pid ||
      launch.capture.observer !== (linux ? 'linux-seccomp-ptrace-v1' : undefined))
    throw Error(`Native driver clock requires the original ${linux ? 'Linux' : 'Darwin'} caller`)
  const registration = JSON.parse(readOwnedNativeFile(join(launch.run, 'registration.json'), 0o600)),
    start = JSON.parse(readOwnedNativeFile(join(launch.run, 'start.json'), 0o600))
  if (!/^[a-f0-9]{64}$/.test(launch.binarySha256 ?? '') ||
      !/^[a-f0-9]{32}$/.test(registration.nonce ?? '') ||
      !Number.isSafeInteger(start.childPid) || start.childPid <= 0 || start.childPid === process.pid ||
      start.binarySha256 !== launch.binarySha256 || typeof launch.capture.captureId !== 'string' || !launch.capture.captureId)
    throw Error('Native driver clock enrollment differs from prepared capture')
  if (linux) return linuxDriverClock(launch, registration, start)
  system ??= dlopen('/usr/lib/libSystem.B.dylib', {
    mach_absolute_time: { args: [], returns: FFIType.u64 },
    mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 },
    pthread_threadid_np: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  })
  const timebase = Buffer.alloc(8), thread = Buffer.alloc(8)
  if (system.symbols.mach_timebase_info(ptr(timebase)) !== 0 ||
      system.symbols.pthread_threadid_np(null, ptr(thread)) !== 0)
    throw Error('Actual native driver clock identity is unavailable')
  const timebaseNumer = timebase.readUInt32LE(0), timebaseDenom = timebase.readUInt32LE(4),
    callerThreadId = thread.readBigUInt64LE(0).toString(), tick = system.symbols.mach_absolute_time()
  if (!timebaseNumer || !timebaseDenom || callerThreadId === '0' ||
      (typeof tick === 'number' && !Number.isSafeInteger(tick)))
    throw Error('Actual native driver clock cannot be represented exactly')
  return { method: 'driver-mach-absolute-time-v1', tick: BigInt(tick).toString(),
    captureId: launch.capture.captureId, nonce: registration.nonce, childPid: start.childPid,
    callerPid: process.pid, callerThreadId, timebaseNumer, timebaseDenom }
}

// Same CLOCK_MONOTONIC nanoseconds as the Linux observer (header[12]=[13]=1).
function linuxDriverClock(launch, registration, start) {
  libc ??= dlopen('libc.so.6', {
    clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    gettid: { args: [], returns: FFIType.i32 },
  })
  const time = Buffer.alloc(16), thread = libc.symbols.gettid()
  if (libc.symbols.clock_gettime(1, ptr(time)) !== 0 || thread <= 0) // CLOCK_MONOTONIC
    throw Error('Actual native driver clock identity is unavailable')
  const tick = time.readBigInt64LE(0) * 1000000000n + time.readBigInt64LE(8)
  if (tick <= 0n || tick >= 2n ** 64n)
    throw Error('Actual native driver clock cannot be represented exactly')
  return { method: 'driver-linux-monotonic-v1', tick: tick.toString(),
    captureId: launch.capture.captureId, nonce: registration.nonce, childPid: start.childPid,
    callerPid: process.pid, callerThreadId: String(thread), timebaseNumer: 1, timebaseDenom: 1 }
}

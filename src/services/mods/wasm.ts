import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

// Official 2.1.329: a binary for $.wasm.compile, as bytes or a file, holds at most 64 MiB.
export const MOD_WASM_MAX_BYTES = 67108864

export type ModWasmSandbox = {
  copyOf(source: unknown): Uint8Array
  compile(bytes: Uint8Array): Promise<WebAssembly.Module>
}

// Executed first inside the VM of a hooks module that calls $.wasm.compile,
// before its other globals: the standard API less every other way to compile.
// `real` is that VM's own WebAssembly; plugin values are read by internal slot only.
export function createModWasmSandbox(real: typeof WebAssembly) {
  return (isRefused: (bytes: Uint8Array) => boolean): ModWasmSandbox => {
    const cap = 67108864
    const { apply } = Reflect
    const { create, defineProperty, freeze, getOwnPropertyDescriptor, getOwnPropertyNames, getOwnPropertySymbols, getPrototypeOf, setPrototypeOf } = Object
    const Bytes = Uint8Array
    const TypedArray = getPrototypeOf(Bytes.prototype)
    const getter = (target: object, key: string) => getOwnPropertyDescriptor(target, key)!.get!
    const typedBuffer = getter(TypedArray, 'buffer'), typedOffset = getter(TypedArray, 'byteOffset'), typedLength = getter(TypedArray, 'byteLength')
    const viewBuffer = getter(DataView.prototype, 'buffer'), viewOffset = getter(DataView.prototype, 'byteOffset'), viewLength = getter(DataView.prototype, 'byteLength')
    const bufferLength = getter(ArrayBuffer.prototype, 'byteLength')
    const isView = ArrayBuffer.isView
    const set = TypedArray.set as (this: Uint8Array, source: ArrayLike<number>) => void
    const has = WeakSet.prototype.has, add = WeakSet.prototype.add
    const { CompileError, Instance, Module: RealModule, Memory: RealMemory } = real
    const realCompile = real.compile, realValidate = real.validate
    const compiled = new WeakSet<object>()
    const lengthOf = (bytes: Uint8Array): number => apply(typedLength, bytes, [])

    // A detached buffer, or one shrunk beneath its view, reads as empty.
    const over = (value: unknown, message: string): Uint8Array => {
      if (isView(value)) {
        let typed = true
        try { apply(typedLength, value, []) } catch { typed = false }
        try {
          const buffer = apply(typed ? typedBuffer : viewBuffer, value, [])
          const offset = apply(typed ? typedOffset : viewOffset, value, [])
          const length = apply(typed ? typedLength : viewLength, value, [])
          return length ? new Bytes(buffer, offset, length) : new Bytes(0)
        } catch { return new Bytes(0) }
      }
      let length: number
      try { length = apply(bufferLength, value, []) } catch { throw new TypeError(message) }
      try { return length ? new Bytes(value as ArrayBuffer, 0, length) : new Bytes(0) } catch { return new Bytes(0) }
    }
    const copied = (view: Uint8Array): Uint8Array => {
      const own = new Bytes(lengthOf(view))
      apply(set, own, [view])
      return own
    }
    const refusal = (name: string) => new CompileError(`${name} does not compile here: await $.wasm.compile(source) answers the module`)

    const Module = function Module() { throw refusal('new WebAssembly.Module') }
    for (const key of ['customSections', 'exports', 'imports'] as const)
      defineProperty(Module, key, { value: RealModule[key], writable: true, enumerable: false, configurable: true })
    defineProperty(Module, 'prototype', { value: RealModule.prototype, writable: false, enumerable: false, configurable: false })
    defineProperty(RealModule.prototype, 'constructor', { value: Module, writable: true, enumerable: false, configurable: true })

    const Memory = function Memory(this: unknown, descriptor: WebAssembly.MemoryDescriptor & { shared?: boolean; address?: string; minimum?: number }) {
      if (new.target === undefined) throw new TypeError("WebAssembly.Memory is called with 'new'")
      if (descriptor === null || (typeof descriptor !== 'object' && typeof descriptor !== 'function'))
        throw new TypeError('WebAssembly.Memory takes a descriptor object')
      const own = create(null)
      const keys = ['address', 'initial', 'minimum', 'maximum'] as const
      for (let i = 0; i < keys.length; i++) {
        const value = descriptor[keys[i]!]
        if (value !== undefined) own[keys[i]!] = value
      }
      if (descriptor.shared) throw new TypeError('WebAssembly.Memory is never shared in a hooks module')
      const memory = new RealMemory(own)
      setPrototypeOf(memory, new.target.prototype)
      return memory
    }
    defineProperty(Memory, 'prototype', { value: RealMemory.prototype, writable: false, enumerable: false, configurable: false })
    defineProperty(RealMemory.prototype, 'constructor', { value: Memory, writable: true, enumerable: false, configurable: true })

    const members: Record<string, unknown> = {
      Module, Memory,
      compile: async function compile() { throw refusal('WebAssembly.compile') },
      instantiate: async function instantiate(source: unknown, imports?: WebAssembly.Imports) {
        if (!apply(has, compiled, [source])) throw refusal('WebAssembly.instantiate over anything but a module')
        return new Instance(source as WebAssembly.Module, imports)
      },
      validate: function validate(bytes: unknown) {
        const view = over(bytes, 'WebAssembly.validate takes an ArrayBuffer or a view of one')
        if (lengthOf(view) > cap) return false
        const own = copied(view)
        if (!apply(realValidate, real, [own])) return false
        try { return isRefused(own) === false } catch { throw new RangeError('Maximum call stack size exceeded.') }
      },
    }
    for (const name of ['Instance', 'Table', 'Global', 'Tag', 'Exception', 'JSTag', 'Suspending', 'promising', 'CompileError', 'LinkError', 'RuntimeError', 'SuspendError'])
      if (name in real) members[name] = (real as unknown as Record<string, unknown>)[name]
    // A frozen prototype's name and message would refuse a subclass instance's own.
    for (const name of ['CompileError', 'LinkError', 'RuntimeError', 'SuspendError']) {
      const prototype = (members[name] as { prototype?: object } | undefined)?.prototype
      if (!prototype) continue
      for (const key of ['name', 'message', 'constructor']) {
        const value = getOwnPropertyDescriptor(prototype, key)?.value
        defineProperty(prototype, key, {
          get() { return value },
          set(this: object, next: unknown) { defineProperty(this, key, { value: next, writable: true, enumerable: true, configurable: true }) },
          enumerable: false, configurable: true,
        })
      }
    }
    const frozen = (value: unknown) => {
      if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return
      for (const target of [value, (value as { prototype?: unknown }).prototype]) {
        if (target === null || (typeof target !== 'object' && typeof target !== 'function')) continue
        for (const key of [...getOwnPropertyNames(target), ...getOwnPropertySymbols(target)]) {
          const { get, set } = getOwnPropertyDescriptor(target, key)!
          if (get) freeze(get)
          if (set) freeze(set)
        }
        freeze(target)
      }
    }
    const namespace = create(getPrototypeOf(real))
    for (const [name, value] of Object.entries(members)) {
      frozen(value)
      defineProperty(namespace, name, { value, writable: true, enumerable: false, configurable: true })
    }
    defineProperty(namespace, Symbol.toStringTag, { value: 'WebAssembly', writable: false, enumerable: false, configurable: true })
    freeze(namespace)
    defineProperty(globalThis, 'WebAssembly', { value: namespace, writable: true, enumerable: false, configurable: true })

    return freeze({
      copyOf(source: unknown) {
        const view = over(source, '$.wasm.compile takes a literal path, or bytes as an ArrayBuffer or a view of one')
        if (lengthOf(view) > cap) throw new RangeError('$.wasm.compile takes at most 67108864 bytes')
        return copied(view)
      },
      async compile(bytes: Uint8Array) {
        const module = await apply(realCompile, real, [bytes]) as WebAssembly.Module
        apply(add, compiled, [module])
        return module
      },
    })
  }
}

class Unread extends Error {}
const unreadable = "the module's imports or memories are encoded in a way this build does not read, so it cannot be told to hold no shared memory"

/** Why a binary may not compile in a hooks module: it defines or imports a shared memory, or cannot be read to tell. */
export function modWasmSharedMemoryReason(bytes: Uint8Array): string | undefined {
  let at = 8
  const byte = () => {
    if (at >= bytes.length) throw new Unread()
    return bytes[at++]!
  }
  const u32 = () => {
    let value = 0
    for (let shift = 0; shift < 70; shift += 7) {
      const next = byte()
      value += (next & 0x7f) * 2 ** shift
      if (!(next & 0x80)) return value
    }
    throw new Unread()
  }
  const name = () => {
    const length = u32()
    if (at + length > bytes.length) throw new Unread()
    at += length
  }
  // Limits answer whether they are shared.
  const limits = () => {
    const flags = byte()
    if (flags > 7) throw new Unread()
    u32()
    if (flags & 1) u32()
    return (flags & 2) !== 0
  }
  const valueType = () => {
    const type = byte()
    if (type === 99 || type === 100) u32()
    else if (!(type >= 123 && type <= 127) && !(type >= 105 && type <= 116)) throw new Unread()
  }
  const importIsShared = () => {
    name()
    name()
    switch (byte()) {
      case 0: u32(); return false
      case 1: valueType(); return limits()
      case 2: return limits()
      case 3: valueType(); if (byte() > 1) throw new Unread(); return false
      case 4: if (byte() !== 0) throw new Unread(); u32(); return false
      default: throw new Unread()
    }
  }
  try {
    while (at < bytes.length) {
      const id = byte()
      const end = u32() + at
      if (id === 2 || id === 5) {
        for (let count = u32(); count > 0; count -= 1)
          if (id === 2 ? importIsShared() : limits()) return 'the module declares a shared memory, which no hooks module may hold'
        if (at !== end) return unreadable
      }
      at = end
    }
  } catch (error) {
    if (error instanceof Unread) return unreadable
    throw error
  }
  return at === bytes.length ? undefined : unreadable
}

/** Why a hook's `base64` is no binary for $.wasm.compile, or undefined. */
export function modWasmBase64Problem(base64: unknown): string | undefined {
  if (typeof base64 !== 'string') return 'a base64 that is not a string'
  if (base64.length > Math.ceil(MOD_WASM_MAX_BYTES / 3) * 4) return `a base64 of more than ${MOD_WASM_MAX_BYTES} bytes`
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return 'a base64 that does not decode'
  if (Buffer.byteLength(base64, 'base64') > MOD_WASM_MAX_BYTES) return `a base64 of more than ${MOD_WASM_MAX_BYTES} bytes`
}

// Official 2.1.329: a folder of that name may have been overwritten by the MCP bundle unpacker.
const mcpbCache = "it leads into .mcpb-cache, which Claude Code may have overwritten when it unpacked the plugin's MCP bundles; the plugin's author needs to move it to another folder"
const isInMcpbCache = (base: string, path: string) => relative(base, path).split(sep).some(segment =>
  segment.replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, '').toUpperCase().toLowerCase().replace(/[. ]+$/, '') === '.mcpb-cache')
const hooksError = (message: string, cause?: string) => Object.assign(new Error(message, cause ? { cause } : undefined), { name: 'HooksError' })

/** Reads a scanned `.wasm` file of the plugin (a `/`-separated path under its root) as base64, as the official build does. */
export async function readModWasmFile(root: string, path: string, plugin: string, signal?: AbortSignal): Promise<string> {
  const file = resolve(root, ...path.split('/'))
  const changed = () => hooksError(`${plugin}: ${file}: changed while it was read`)
  const over = () => hooksError(`${plugin}: ${file} is over ${MOD_WASM_MAX_BYTES} bytes and was not read`)
  const failed = (error: unknown) => {
    const code = (error as NodeJS.ErrnoException)?.code ?? 'EIO'
    return code === 'EMFILE' || code === 'ENFILE'
      ? hooksError(`${plugin}: ${file}: not read, no file descriptor free (${code})`, code)
      : hooksError(`${plugin}: ${file}: no such file`, code)
  }
  let rootReal: string
  try { rootReal = await realpath(root) } catch (error) {
    throw hooksError(`${plugin}: ${basename(root)}: not readable (${(error as NodeJS.ErrnoException)?.code ?? 'EIO'})`)
  }
  let real: string
  try { real = await realpath(file) } catch (error) { throw failed(error) }
  const rel = relative(rootReal, real)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw hooksError(`${plugin}: ${file}: ${real} resolves outside the plugin's folder`)
  if (isInMcpbCache(root, file) || isInMcpbCache(rootReal, real)) throw hooksError(`${plugin}: ${file}: ${mcpbCache}`)
  let entry
  try { entry = await lstat(real) } catch (error) { throw failed(error) }
  if (!entry.isFile()) throw hooksError(`${plugin}: ${file}: not a regular file`)
  if (!real.endsWith('.wasm')) throw hooksError(`${plugin}: ${file} is a link to a file not named .wasm and was not read`)
  if (entry.size > MOD_WASM_MAX_BYTES) throw over()
  signal?.throwIfAborted()
  let handle
  try { handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
    throw (error as NodeJS.ErrnoException)?.code === 'ELOOP' ? changed() : failed(error)
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) throw changed()
    let again: string
    try { again = await realpath(real) } catch { throw changed() }
    if (again !== real) throw changed()
    if (opened.size > MOD_WASM_MAX_BYTES) throw over()
    // One byte past the size shows a file that grew after the stat.
    const bytes = Buffer.allocUnsafe(opened.size + 1)
    let length = 0
    while (length < bytes.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > MOD_WASM_MAX_BYTES) throw over()
    if (length !== opened.size) throw changed()
    return bytes.subarray(0, length).toString('base64')
  } finally { await handle.close() }
}

import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime, type ModDiagnostic } from './runtime.js'
import { modWasmSharedMemoryReason } from './wasm.js'

const head = [0, 97, 115, 109, 1, 0, 0, 0]
// (func (export "answer") (result i32) i32.const 42)
const answer = (value = 42) => Uint8Array.from([...head, 1, 5, 1, 0x60, 0, 1, 0x7f, 3, 2, 1, 0,
  7, 10, 1, 6, 97, 110, 115, 119, 101, 114, 0, 0, 10, 6, 1, 4, 0, 0x41, value, 0x0b])
const definesShared = Uint8Array.from([...head, 5, 4, 1, 3, 1, 1])
const importsShared = Uint8Array.from([...head, 2, 9, 1, 1, 101, 1, 109, 2, 3, 1, 1])
const list = (bytes: Uint8Array) => `[${[...bytes].join(',')}]`

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(files: Record<string, string | Uint8Array>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mods-wasm-')))
  roots.push(root)
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true })
    await writeFile(join(root, name), content)
  }
  return root
}
const hook = (body: string) => `export function register(on){on('tool.call', async $ => { ${body} })}`

test('the shared-memory reader matches the official refusals', () => {
  expect(modWasmSharedMemoryReason(answer())).toBeUndefined()
  expect(modWasmSharedMemoryReason(Uint8Array.from(head))).toBeUndefined()
  expect(modWasmSharedMemoryReason(definesShared)).toBe('the module declares a shared memory, which no hooks module may hold')
  expect(modWasmSharedMemoryReason(importsShared)).toBe('the module declares a shared memory, which no hooks module may hold')
  // An unshared memory and a function import.
  expect(modWasmSharedMemoryReason(Uint8Array.from([...head, 5, 4, 1, 1, 1, 2, 2, 7, 1, 1, 101, 1, 102, 0, 0]))).toBeUndefined()
  expect(modWasmSharedMemoryReason(Uint8Array.from([...head, 5, 9, 1, 0]))).toMatch(/cannot be told to hold no shared memory/)
  expect(modWasmSharedMemoryReason(Uint8Array.from([...head, 2, 3, 1, 1, 101, 1]))).toMatch(/cannot be told to hold no shared memory/)
})

// What the runtime reported during the last run, after its plugins loaded.
let reported: ModDiagnostic[] = []
async function run(plugins: { name: string; files: Record<string, string | Uint8Array> }[], prepare?: (roots: string[]) => Promise<void>) {
  const diagnostics: ModDiagnostic[] = []
  const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event) })
  const pluginRoots = await Promise.all(plugins.map(plugin => fixture(plugin.files)))
  try {
    await runtime.bind({ cwd: pluginRoots[0]!, sessionId: 'wasm-329', isInteractive: false, surface: null })
    await runtime.reconcile(plugins.map((plugin, i) => ({
      name: plugin.name, storageId: `${plugin.name}@fixture`, entrypoints: [join(pluginRoots[i]!, 'entry.mjs')], pluginRoot: pluginRoots[i]!,
    })))
    expect(diagnostics).toEqual([])
    reported = diagnostics
    await prepare?.(pluginRoots)
    return (await runtime.dispatch('tool.call', {}, async () => ({ result: null })) as { result: unknown }).result
  } finally { await runtime.dispose() }
}
const settle = (call: string) => `await (async () => { try { const value = await ${call}; return value } catch (e) { return {name: e?.name, message: e?.message, isCompileError: e instanceof WebAssembly.CompileError} } })()`

test('only a module that calls compile has a WebAssembly global, the standard API less every other way to compile', async () => {
  const result = await run([
    { name: 'other', files: { 'entry.mjs': `export function register(on){on('tool.call', async ($, e, next) => typeof WebAssembly === 'undefined' ? next(e) : { result: 'other sees WebAssembly' })}` } },
    { name: 'probe', files: {
      'answer.wasm': answer(),
      'entry.mjs': `const bytes = Uint8Array.from(${list(answer())});
      ${hook(`
        const module = await $.wasm.compile('./answer.wasm');
        const { exports } = await WebAssembly.instantiate(module);
        const direct = new WebAssembly.Instance(module).exports.answer();
        return { result: {
          answer: exports.answer(), direct, isModule: module instanceof WebAssembly.Module && module.constructor === WebAssembly.Module,
          tag: Object.prototype.toString.call(WebAssembly), frozen: Object.isFrozen(WebAssembly) && Object.isFrozen(WebAssembly.Instance.prototype),
          shared: typeof SharedArrayBuffer + ' ' + typeof Atomics,
          keys: Object.getOwnPropertyNames(WebAssembly).filter(key => /compile|instantiate|Streaming/.test(key)).sort(),
          compile: ${settle('WebAssembly.compile(bytes)')},
          instantiate: ${settle('WebAssembly.instantiate(bytes)')},
          construct: ${settle('(async () => new WebAssembly.Module(bytes))()')},
          validate: [WebAssembly.validate(bytes), WebAssembly.validate(Uint8Array.from(${list(definesShared)})), WebAssembly.validate(Uint8Array.from(${list(Uint8Array.from(head))}))],
          validateType: ${settle('(async () => WebAssembly.validate("x"))()')},
          sharedMemory: ${settle('(async () => new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }))()')},
          call: ${settle('(async () => WebAssembly.Memory({ initial: 1 }))()')},
          memory: new WebAssembly.Memory({ initial: 1 }).buffer.byteLength,
        } }`)}`,
    } },
  ])
  expect(result).toEqual({
    answer: 42, direct: 42, isModule: true, tag: '[object WebAssembly]', frozen: true, shared: 'undefined undefined',
    keys: ['compile', 'instantiate'],
    compile: { name: 'CompileError', message: 'WebAssembly.compile does not compile here: await $.wasm.compile(source) answers the module', isCompileError: true },
    instantiate: { name: 'CompileError', message: 'WebAssembly.instantiate over anything but a module does not compile here: await $.wasm.compile(source) answers the module', isCompileError: true },
    construct: { name: 'CompileError', message: 'new WebAssembly.Module does not compile here: await $.wasm.compile(source) answers the module', isCompileError: true },
    validate: [true, false, true],
    validateType: { name: 'TypeError', message: 'WebAssembly.validate takes an ArrayBuffer or a view of one', isCompileError: false },
    sharedMemory: { name: 'TypeError', message: 'WebAssembly.Memory is never shared in a hooks module', isCompileError: false },
    call: { name: 'TypeError', message: "WebAssembly.Memory is called with 'new'", isCompileError: false },
    memory: 65536,
  })
})

test('a non-caller has no WebAssembly global', async () => {
  expect(await run([{ name: 'plain', files: { 'entry.mjs': hook(`return { result: typeof WebAssembly }`) } }])).toBe('undefined')
})

test('bytes are copied as the call is made, capped at 64 MiB, and a shared memory is refused', async () => {
  const result = await run([{ name: 'probe', files: { 'entry.mjs': hook(`
    const bytes = Uint8Array.from(${list(answer(7))});
    const pending = $.wasm.compile(new DataView(bytes.buffer));
    bytes.fill(0);
    const module = await pending;
    return { result: {
      answer: (await WebAssembly.instantiate(module)).exports.answer(),
      over: ${settle('$.wasm.compile(new Uint8Array(67108865))')},
      type: ${settle('$.wasm.compile([42][0])')},
      garbage: ${settle('$.wasm.compile(new Uint8Array(8))')},
      defines: ${settle(`$.wasm.compile(Uint8Array.from(${list(definesShared)}))`)},
      imports: ${settle(`$.wasm.compile(Uint8Array.from(${list(importsShared)}).buffer)`)},
    } }`) } }])
  expect(result).toMatchObject({
    answer: 7,
    over: { name: 'RangeError', message: '$.wasm.compile takes at most 67108864 bytes' },
    type: { name: 'TypeError', message: '$.wasm.compile takes a literal path, or bytes as an ArrayBuffer or a view of one' },
    garbage: { isCompileError: true },
    defines: { isCompileError: true, message: 'probe: $.wasm.compile: the module declares a shared memory, which no hooks module may hold' },
    imports: { isCompileError: true, message: 'probe: $.wasm.compile: the module declares a shared memory, which no hooks module may hold' },
  })
})

test('a hook above reads the file, replaces its bytes or refuses; the path is pinned', async () => {
  const guard = (body: string) => ({ name: 'guard', files: { 'entry.mjs': `export function register(on){on('wasm.compile', async ($, e, next) => { ${body} })}` } })
  const caller = { name: 'probe', files: { 'answer.wasm': answer(), 'entry.mjs': hook(`
    const module = await $.wasm.compile('./answer.wasm');
    return { result: (await WebAssembly.instantiate(module)).exports.answer() }`) } }
  const replacement = Buffer.from(answer(9)).toString('base64')
  expect(await run([guard(`
    if (e.path !== 'answer.wasm' || e.base64 !== ${JSON.stringify(Buffer.from(answer()).toString('base64'))}) return { deny: 'unexpected ' + JSON.stringify(e) };
    return next({ ...e, base64: ${JSON.stringify(replacement)} })`), caller])).toBe(9)
  expect(await run([guard(`return { value: { base64: ${JSON.stringify(replacement)} } }`), caller])).toBe(9)
  const refused = { ...caller, files: { ...caller.files, 'entry.mjs': hook(`return { result: ${settle("$.wasm.compile('./answer.wasm')")} }`) } }
  expect(await run([guard(`return { deny: 'not today' }`), refused])).toMatchObject({ message: 'probe: $.wasm.compile: not today' })
  // A hook that throws is set aside; this one answers the refusal of its next() as its deny.
  expect(await run([guard(`return next({ ...e, path: 'other.wasm' }).catch(error => ({ deny: error.message }))`), refused]))
    .toMatchObject({ message: 'probe: $.wasm.compile: guard: next() passed an argument with a changed path (the file asked for; next(e) passes it on)' })
  // An answer that is no binary is the hook's fault: it is reported and set aside.
  expect(await run([guard(`return { value: { base64: '%%' } }`), caller])).toBe(42)
  expect(reported).toMatchObject([{ plugin: 'guard', stage: 'wasm.compile', message: expect.stringContaining('a base64 that does not decode') }])
})

test('the host reads only a listed file, through no link to another kind of file', async () => {
  const listed = await run([{ name: 'probe', files: { 'entry.mjs': hook(`
    const named = ['other.wasm'];
    return { result: [${settle('$.wasm.compile(named[0])')}, ${settle("$.wasm.compile('./answer.wasm')")}] }`), 'other.wasm': answer() } }],
  async ([root]) => { await symlink(join(root!, 'data.bin'), join(root!, 'answer.wasm')); await writeFile(join(root!, 'data.bin'), answer()) })
  expect(listed).toMatchObject([
    { message: 'probe: $.wasm.compile refused: a path is a string literal in the call itself, and its hooks module names no such file that way (host rule; the scan lists answer.wasm)' },
    { message: expect.stringContaining('answer.wasm is a link to a file not named .wasm and was not read') },
  ])
})

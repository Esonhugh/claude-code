import officialDeclaration from '../../../assets/mods-2.1.290.d.ts.txt' with {type: 'text'}
import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readlink, realpath, rename, rm, rmdir, stat, symlink, unlink } from 'node:fs/promises'
import type { Tool } from '../../Tool.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type ModTypeDependency = Readonly<{name: string; pluginRoot: string; path: string}>

export type ModDeclarationFile = Readonly<{ path: string; text: string }>
export type ModDeclarationWriteResult = Readonly<{
  root: string
  entries: readonly string[]
  written: readonly string[]
  unchanged: readonly string[]
}>

const authorProject = {
  compilerOptions: {
    target: 'es2023',
    lib: ['es2023'],
    module: 'esnext',
    moduleResolution: 'bundler',
    strict: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    skipLibCheck: true,
    jsx: 'react',
    jsxFactory: 'h',
    jsxFragmentFactory: 'Fragment',
    typeRoots: ['.'],
    types: ['claude-code', 'claude-code-tools', 'claude-code-mcp'],
  },
  include: ['../../hooks', '../../types', '../../tests'],
}
const compilerOptions = `${JSON.stringify(authorProject, null, 2)}\n`

function declaration(version: string): string {
  return `// Written by Claude Code ${version}.\n${officialDeclaration}`
}

// Deliberately bounded: no ref resolution, conditionals, tuple or pattern-property inference.
// Unsupported constructs retain unknown rather than inventing an input contract.
function schemaType(schema: unknown, depth = 0): string {
  if (schema === false) return 'never'
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 20) return 'unknown'
  const s = schema as Record<string, unknown>
  if (['$ref', '$dynamicRef', 'not', 'if', 'then', 'else', 'patternProperties', 'prefixItems', 'dependencies', 'dependentSchemas'].some(key => key in s)) return 'unknown'
  const emit = (value: unknown) => schemaType(value, depth + 1)
  const literal = (value: unknown): string => value === null || ['string', 'number', 'boolean'].includes(typeof value) ? JSON.stringify(value) : 'unknown'
  if ('const' in s) return literal(s.const)
  if (Array.isArray(s.enum)) return s.enum.map(literal).join(' | ') || 'never'
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(s[key])) return `(${s[key].map(emit).join(key === 'allOf' ? ' & ' : ' | ') || 'unknown'})`
  }
  if (Array.isArray(s.type)) return `(${s.type.map(type => emit({ ...s, type })).join(' | ')})`
  switch (s.type) {
    case 'string': return 'string'
    case 'number': case 'integer': return 'number'
    case 'boolean': return 'boolean'
    case 'null': return 'null'
    case 'array': return Array.isArray(s.items) ? 'unknown' : `Array<${emit(s.items)}>`
    case 'object': {
      const properties = s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties) ? s.properties as Record<string, unknown> : {}
      const required = Array.isArray(s.required) ? s.required : []
      const fields = Object.entries(properties).map(([key, value]) => `${JSON.stringify(key)}${required.includes(key) ? '' : '?'}: ${emit(value)}`)
      // An index signature with known properties must not contradict those properties.
      if (s.additionalProperties !== false) fields.push(`[key: string]: ${Object.keys(properties).length ? 'unknown' : emit(s.additionalProperties)}`)
      return `{ ${fields.join('; ')} }`
    }
    default: return 'unknown'
  }
}

function toolDeclarations(tools: readonly Tool[], mcp: boolean): string {
  const fields = tools.filter(tool => Boolean(tool.isMcp) === mcp).map(tool => {
    let schema: unknown
    try { schema = tool.inputJSONSchema ?? zodToJsonSchema(tool.inputSchema) } catch { schema = undefined }
    return `    ${JSON.stringify(tool.name)}: ${schemaType(schema)}`
  }).sort()
  const results = mcp ? [] : tools.filter(tool => !tool.isMcp && tool.outputSchema).map(tool => {
    let schema: unknown
    try { schema = zodToJsonSchema(tool.outputSchema!) } catch { schema = undefined }
    return `    ${JSON.stringify(tool.name)}: ${schemaType(schema)}`
  }).sort()
  return `declare module 'claude-code' {\n  interface ${mcp ? 'McpToolInputs' : 'BuiltinToolInputs'} {\n${fields.join('\n')}\n  }\n${mcp ? '' : `  interface BuiltinToolResults {\n${results.join('\n')}\n  }\n`} }\n`
}

const ownershipPrefix = '// Claude Code owned declaration sha256='
function owned(text: string, configuration?: string): string {
  const project = configuration === undefined ? '' : ` tsconfig-sha256=${createHash('sha256').update(configuration).digest('hex')}`
  return `${text}\n${ownershipPrefix}${createHash('sha256').update(text + project).digest('hex')}${project}\n`
}
function ownership(text: string): {configurationHash?: string} | undefined {
  const start = text.lastIndexOf(`\n${ownershipPrefix}`)
  if (start < 0) return undefined
  const footer = text.slice(start + 1 + ownershipPrefix.length)
  const match = /^([a-f0-9]{64})(?: tsconfig-sha256=([a-f0-9]{64}))?\n$/.exec(footer)
  if (!match) return undefined
  const project = match[2] === undefined ? '' : ` tsconfig-sha256=${match[2]}`
  if (createHash('sha256').update(text.slice(0, start) + project).digest('hex') !== match[1]) return undefined
  return {configurationHash:match[2]}
}
function isOwned(text: string): boolean {return ownership(text) !== undefined}

export function generateModDeclarationFiles(version: string, tools?: readonly Tool[], entrypointIncludes: readonly string[] = [], dependencyNames: readonly string[] = []): readonly ModDeclarationFile[] {
  if (typeof version !== 'string' || !version || /[\r\n\0]/.test(version))
    throw new TypeError('version must be a non-empty single-line string')
  const configuration = entrypointIncludes.length === 0 && dependencyNames.length === 0 ? compilerOptions :
    `${JSON.stringify({...authorProject, compilerOptions:{...authorProject.compilerOptions, types:[...authorProject.compilerOptions.types, ...dependencyNames]}, include:[...authorProject.include, ...entrypointIncludes]}, null, 2)}\n`
  return Object.freeze([
    Object.freeze({ path: 'claude-code/index.d.ts', text: owned(declaration(version), entrypointIncludes.length ? configuration : undefined) }),
    Object.freeze({ path: 'claude-code-tools/index.d.ts', text: owned(toolDeclarations(tools ?? [], false)) }),
    Object.freeze({ path: 'claude-code-mcp/index.d.ts', text: owned(toolDeclarations(tools ?? [], true)) }),
    Object.freeze({ path: 'tsconfig.json', text: configuration }),
    Object.freeze({ path: '.gitignore', text: '*\n' }),
  ])
}

function inside(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === '' || !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)
}

async function ensureDirectory(root: string, target: string): Promise<void> {
  if (!inside(root, target)) throw new Error('declaration path escapes the plugin types root')
  const child = relative(root, target)
  let current = root
  for (const part of child ? child.split(sep) : []) {
    current = join(current, part)
    try {
      await mkdir(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const entry = await lstat(current)
    if (entry.isSymbolicLink()) throw new Error(`refusing declaration path through symlink: ${current}`)
    if (!entry.isDirectory()) throw new Error(`declaration path is not a directory: ${current}`)
  }
}

const contractReadCap = 262144
const unsafeTypeName = /[@:\s/\\\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029\p{Default_Ignorable_Code_Point}\u2800]/u
function safeTypeName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' &&
    ![...authorProject.compilerOptions.types, 'tsconfig.json', '.gitignore'].some(reserved => reserved.toLowerCase() === name.toLowerCase()) &&
    !unsafeTypeName.test(name)
}
async function previousTypeNames(path: string): Promise<string[]> {
  try {
    const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
    try {
      const entry = await handle.stat()
      if (!entry.isFile() || entry.size > contractReadCap) return []
      const names = JSON.parse(await handle.readFile('utf8')).compilerOptions?.types
      return Array.isArray(names) && names.every(name => typeof name === 'string') ? names : []
    } finally {await handle.close()}
  } catch {return []}
}
async function ensureGeneratedFolder(path: string): Promise<void> {
  try {await mkdir(path)} catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!(await lstat(path)).isDirectory()) {await unlink(path); await mkdir(path)}
  }
}
async function writeGenerated(path: string, text: string, replace = true): Promise<boolean> {
  const entry = await lstat(path).catch(error => {if (error.code !== 'ENOENT') throw error; return undefined})
  if (entry?.isFile()) {
    if (!replace || entry.size === Buffer.byteLength(text) && await readFile(path, {encoding:'utf8', flag:constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)}) === text) return false
  } else if (entry) await rm(path, {recursive:true, force:true})
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW), 0o644)
  try {
    try {await handle.writeFile(text, 'utf8')} finally {await handle.close()}
    await rename(temporary, path)
  } finally {await unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error})}
  return true
}
async function linkContract(path: string, source: string): Promise<boolean> {
  if (await readlink(path).catch(() => undefined) === source) return false
  const temporary = `${path}.${randomUUID()}.tmp`
  try {await symlink(source, temporary); await rename(temporary, path); return true}
  catch {
    await unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error})
    const handle = await open(source, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
    let text: string
    try {
      const entry = await handle.stat()
      if (!entry.isFile() || entry.size > contractReadCap) throw new Error('dependency declaration is over the size cap, or not a regular file, and was not read')
      text = (await handle.readFile('utf8')).replace(/^\uFEFF/, '')
    } finally {await handle.close()}
    return writeGenerated(path, text)
  }
}

const installations = new Map<string, Promise<ModDeclarationWriteResult>>()
export async function ensureModDeclarations(pluginRoot: string, version: string, tools?: readonly Tool[], entrypoints: readonly string[] = [], dependencies: readonly ModTypeDependency[] = []): Promise<ModDeclarationWriteResult> {
  if (typeof pluginRoot !== 'string' || !pluginRoot || pluginRoot.includes('\0'))
    throw new TypeError('pluginRoot must be a non-empty path without NUL')
  const key = await realpath(resolve(pluginRoot))
  const previous = installations.get(key)
  const pending = (async () => {
    await previous?.catch(() => {})
    return installDeclarations(pluginRoot, version, tools, entrypoints, dependencies)
  })()
  installations.set(key, pending)
  try { return await pending } finally { if (installations.get(key) === pending) installations.delete(key) }
}

async function installDeclarations(pluginRoot: string, version: string, tools: readonly Tool[] | undefined, entrypoints: readonly string[], dependencies: readonly ModTypeDependency[]): Promise<ModDeclarationWriteResult> {
  const root = await realpath(resolve(pluginRoot))
  const types = join(root, '.claude-plugin', 'types')
  const entrypointIncludes = [...new Set(entrypoints.map(entry => {
    const resolved = resolve(pluginRoot, entry)
    if (!inside(resolve(pluginRoot), resolved)) throw new Error(`declaration entry escapes plugin root: ${entry}`)
    return resolve(root, relative(resolve(pluginRoot), resolved))
  }).filter(entry => !inside(join(root, 'hooks'), entry)).map(entry => relative(types, entry).split(sep).join('/')))]
  await ensureDirectory(root, types)
  const written: string[] = []
  const unchanged: string[] = []
  const gitignoreChanged = await writeGenerated(join(types, '.gitignore'), '*\n')
  const contracts: {name:string; real:string}[] = []
  const seen = new Set<string>()
  for (const dependency of dependencies) {
    if (seen.has(dependency.name)) continue
    seen.add(dependency.name)
    if (!safeTypeName(dependency.name)) continue
    try {
      const plugin = await realpath(resolve(dependency.pluginRoot))
      const contract = await realpath(resolve(dependency.pluginRoot, dependency.path))
      if (inside(plugin, contract) && (await stat(contract)).isFile()) contracts.push({name:dependency.name, real:contract})
    } catch { /* An unavailable dependency contract does not prevent the author's base project. */ }
  }
  const entries = [...authorProject.compilerOptions.types, ...contracts.map(contract => contract.name)]
  for (const name of await previousTypeNames(join(types, 'tsconfig.json'))) {
    if (!safeTypeName(name) || entries.includes(name)) continue
    const folder = join(types, name), entry = await lstat(folder).catch(() => undefined)
    if (!entry) continue
    if (entry.isDirectory()) {
      await unlink(join(folder, 'index.d.ts')).catch(error => {if (error.code !== 'ENOENT') throw error})
      await rmdir(folder).catch(() => {}) // Keep any author-owned siblings.
    } else await unlink(folder)
    written.push(name)
  }
  const files = generateModDeclarationFiles(version, tools, entrypointIncludes, contracts.map(contract => contract.name))
  for (const file of files.slice(0, 3)) {
    const target = join(types, file.path)
    await ensureGeneratedFolder(dirname(target))
    const replace = file.path === 'claude-code/index.d.ts' ||
      (file.path === 'claude-code-tools/index.d.ts' ? tools !== undefined : tools?.some(tool => tool.isMcp) === true)
    const changed = await writeGenerated(target, file.text, replace)
    ;(changed ? written : unchanged).push(file.path)
  }
  for (const contract of contracts) {
    const folder = join(types, contract.name), path = `${contract.name}/index.d.ts`
    await ensureGeneratedFolder(folder)
    const changed = await linkContract(join(types, path), contract.real)
    ;(changed ? written : unchanged).push(path)
  }
  const configuration = files.find(file => file.path === 'tsconfig.json')!
  ;(await writeGenerated(join(types, configuration.path), configuration.text) ? written : unchanged).push(configuration.path)
  ;(gitignoreChanged ? written : unchanged).push('.gitignore')
  const legacyResults = join(types, 'claude-code', 'results.d.ts')
  try {
    const before = await lstat(legacyResults)
    if (before.isFile() && !before.isSymbolicLink()) {
      const text = await readFile(legacyResults, {encoding: 'utf8', flag: constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)})
      if (isOwned(text)) {
        const after = await lstat(legacyResults)
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
          throw new Error(`legacy declaration changed while refreshing: ${legacyResults}`)
        await unlink(legacyResults)
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let jsconfigExists = true
  try { await lstat(join(root, 'jsconfig.json')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    jsconfigExists = false
  }
  if (!jsconfigExists) {
    const config = await open(join(root, 'tsconfig.json'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
        (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW), 0o644,
    ).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return undefined
    })
    if (config) {
      try { await config.writeFile('{\n  "extends": "./.claude-plugin/types/tsconfig.json"\n}\n', 'utf8') }
      finally { await config.close() }
    }
  }
  return Object.freeze({ root: types, entries:Object.freeze(entries), written: Object.freeze(written), unchanged: Object.freeze(unchanged) })
}

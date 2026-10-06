import officialDeclaration from '../../../assets/mods-2.1.290.d.ts.txt' with {type: 'text'}
import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import type { Tool } from '../../Tool.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { dirname, join, relative, resolve, sep } from 'node:path'

export type ModDeclarationFile = Readonly<{ path: string; text: string }>
export type ModDeclarationWriteResult = Readonly<{
  root: string
  written: readonly string[]
  unchanged: readonly string[]
}>

const compilerOptions = `${JSON.stringify({
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
}, null, 2)}\n`

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

// Exact pre-footer 2.1.280 outputs retained in fixtures/legacy280-declarations.json.
// Bind each digest to its destination; a generated header alone proves nothing.
const legacyDeclarationHashes: Readonly<Record<string, string>> = {
  'claude-code/index.d.ts': '2abb2722d131f2c15736cea8d8403f8446b54c3b5cb11f4cc0137af846dec0b0',
  'tsconfig.json': '943f1d1ec27a8c6f6be329b460b815da840641bb31fceb15b5b1c86b26ccb33d',
}
const previousCompilerOptionsHash = '8d41a379ff4712e6610d991497a184cda31124344a9d05c930c5938377e64a83'
const additionalLegacyDeclarationHashes: Readonly<Record<string, readonly string[]>> = {
  'tsconfig.json': [previousCompilerOptionsHash],
}

const ownershipPrefix = '// Claude Code owned declaration sha256='
function owned(text: string): string {
  return `${text}\n${ownershipPrefix}${createHash('sha256').update(text).digest('hex')}\n`
}
function isOwned(text: string): boolean {
  const start = text.lastIndexOf(`\n${ownershipPrefix}`)
  return start >= 0 && owned(text.slice(0, start)) === text
}

export function generateModDeclarationFiles(version: string, tools?: readonly Tool[]): readonly ModDeclarationFile[] {
  if (typeof version !== 'string' || !version || /[\r\n\0]/.test(version))
    throw new TypeError('version must be a non-empty single-line string')
  return Object.freeze([
    Object.freeze({ path: 'claude-code/index.d.ts', text: owned(declaration(version)) }),
    Object.freeze({ path: 'claude-code-tools/index.d.ts', text: owned(toolDeclarations(tools ?? [], false)) }),
    Object.freeze({ path: 'claude-code-mcp/index.d.ts', text: owned(toolDeclarations(tools ?? [], true)) }),
    Object.freeze({ path: 'tsconfig.json', text: compilerOptions }),
    Object.freeze({ path: '.gitignore', text: '*\n' }),
  ])
}

function inside(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === '' || child !== '..' && !child.startsWith(`..${sep}`)
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

const installations = new Map<string, Promise<ModDeclarationWriteResult>>()
export async function ensureModDeclarations(pluginRoot: string, version: string, tools?: readonly Tool[]): Promise<ModDeclarationWriteResult> {
  const key = resolve(pluginRoot)
  const previous = installations.get(key)
  const pending = (async () => {
    await previous?.catch(() => {})
    return installDeclarations(pluginRoot, version, tools)
  })()
  installations.set(key, pending)
  try { return await pending } finally { if (installations.get(key) === pending) installations.delete(key) }
}

async function installDeclarations(pluginRoot: string, version: string, tools?: readonly Tool[]): Promise<ModDeclarationWriteResult> {
  if (typeof pluginRoot !== 'string' || !pluginRoot || pluginRoot.includes('\0'))
    throw new TypeError('pluginRoot must be a non-empty path without NUL')
  const root = await realpath(resolve(pluginRoot))
  const types = join(root, '.claude-plugin', 'types')
  await ensureDirectory(root, types)
  const written: string[] = []
  const unchanged: string[] = []
  for (const file of generateModDeclarationFiles(version, tools)) {
    const target = resolve(types, file.path)
    if (!inside(types, target)) throw new Error(`declaration path escapes types root: ${file.path}`)
    await ensureDirectory(types, dirname(target))
    let replacing = false
    try {
      const entry = await lstat(target)
      if (entry.isSymbolicLink()) throw new Error(`refusing to write declaration symlink: ${target}`)
      if (!entry.isFile()) throw new Error(`declaration target is not a file: ${target}`)
      const existing = await readFile(target, 'utf8')
      if (existing === file.text) {
        unchanged.push(file.path)
        continue
      }
      const digest = createHash('sha256').update(existing).digest('hex')
      if (!isOwned(existing) && digest !== legacyDeclarationHashes[file.path] && !additionalLegacyDeclarationHashes[file.path]?.includes(digest))
        throw new Error(`refusing to replace unowned declaration; schema not refreshed: ${target}`)
      replacing = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const destination = replacing ? `${target}.${randomUUID()}.tmp` : target
    const handle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
        (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
      0o644,
    )
    try {
      await handle.writeFile(file.text, 'utf8')
    } finally {
      await handle.close()
    }
    if (replacing) await rename(destination, target)
    written.push(file.path)
  }
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
  return Object.freeze({ root: types, written: Object.freeze(written), unchanged: Object.freeze(unchanged) })
}

import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { buildTool, getEmptyToolPermissionContext, type Tool, type ToolUseContext } from '../../Tool.js'
import { REPLTool } from './REPLTool.js'
import { releaseAllReplSessions } from './sessions.js'

afterAll(() => releaseAllReplSessions())

const allow: CanUseToolFn = async () => ({ behavior: 'allow' })

function fakeTool(name: string, inputSchema: z.ZodObject, call: (input: Record<string, unknown>) => unknown) {
  return buildTool({
    name,
    inputSchema,
    maxResultSizeChars: Infinity,
    isConcurrencySafe: () => true,
    description: async () => name,
    prompt: async () => name,
    renderToolUseMessage: () => null,
    call: async (input: Record<string, unknown>) => ({ data: call(input) }),
    mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: JSON.stringify(data),
    }),
  } as Parameters<typeof buildTool>[0]) as Tool
}

/** An in-memory disk with the real tools' read-before-write rule. */
function fakeDisk(files: Record<string, string>) {
  const disk = new Map(Object.entries(files))
  const seen = new Set<string>()
  const commands: string[] = []
  const path = (input: Record<string, unknown>) => String(input.file_path)
  const mustHaveRead = (p: string) => {
    if (disk.has(p) && !seen.has(p)) throw new Error('File has not been read yet. Read it first before writing to it.')
  }
  const tools = [
    fakeTool('Read', z.object({ file_path: z.string(), offset: z.number().optional(), limit: z.number().optional() }), input => {
      const p = path(input)
      const content = disk.get(p)
      if (content === undefined) throw new Error('File does not exist.')
      seen.add(p)
      return { type: 'text', file: { filePath: p, content } }
    }),
    fakeTool('Write', z.object({ file_path: z.string(), content: z.string() }), input => {
      const p = path(input)
      mustHaveRead(p)
      disk.set(p, String(input.content))
      seen.add(p)
      return { type: disk.has(p) ? 'update' : 'create', filePath: p }
    }),
    fakeTool(
      'Edit',
      z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }),
      input => {
        const p = path(input)
        mustHaveRead(p)
        const text = disk.get(p) ?? ''
        const old = String(input.old_string)
        if (!text.includes(old)) throw new Error('String to replace not found in file.')
        const matches = text.split(old).length - 1
        if (matches > 1 && !input.replace_all) throw new Error(`Found ${matches} matches of the string to replace, but replace_all is false.`)
        disk.set(p, input.replace_all ? text.split(old).join(String(input.new_string)) : text.replace(old, () => String(input.new_string)))
        return { filePath: p }
      },
    ),
    fakeTool('Bash', z.object({ command: z.string(), timeout: z.number().optional() }), input => {
      const command = String(input.command)
      commands.push(command)
      if (command.startsWith('false')) throw new Error('Exit code 1\nboom')
      return { stdout: command.startsWith('echo ') ? command.slice(5) : `ran ${command}`, stderr: '', interrupted: false }
    }),
  ]
  return { disk, seen, commands, tools }
}

function contextFor(tools: Tool[]) {
  return {
    options: { tools: [REPLTool, ...tools], mcpClients: [], isNonInteractiveSession: true },
    abortController: new AbortController(),
    messages: [],
    agentId: `helpers-${Math.random()}`,
    toolUseId: 'toolu_current',
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map() }),
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
  } as unknown as ToolUseContext
}

async function run(code: string, context: ToolUseContext) {
  const { data } = await REPLTool.call({ code }, context, allow, undefined as never, undefined)
  return data
}

describe('file, write and edit', () => {
  test('file() reads text, json, lines, slices and existence', async () => {
    const { tools } = fakeDisk({ 'a.json': '{"n": 1}', 'b.txt': 'one\ntwo' })
    const data = await run(
      'const a = file("a.json"); [a.name, (await a.json()).n, await file("b.txt").lines(), await a.exists(), await file("nope").exists()]',
      contextFor(tools),
    )
    expect(data.error).toBeUndefined()
    expect(data.result).toBe("[ 'a.json', 1, [ 'one', 'two' ], true, false ]")
  })

  test('write() creates a file and returns the UTF-8 byte count', async () => {
    const { disk, tools } = fakeDisk({})
    const data = await run('await write("new.txt", "h\u00e9")', contextFor(tools))
    expect(data.result).toBe('3')
    expect(disk.get('new.txt')).toBe('h\u00e9')
  })

  test('write() over an unread file reads it first and retries', async () => {
    const { disk, seen, tools } = fakeDisk({ 'old.txt': 'before' })
    const data = await run('await write("old.txt", "after")', contextFor(tools))
    expect(data.error).toBeUndefined()
    expect(seen.has('old.txt')).toBe(true)
    expect(disk.get('old.txt')).toBe('after')
  })

  test('edit() replaces once, all, in a batch, and refuses ambiguous anchors', async () => {
    const { disk, tools } = fakeDisk({ 'c.ts': 'a a b' })
    const context = contextFor(tools)
    expect((await run('(await edit("c.ts", "b", "B")).replacements', context)).result).toBe('1')
    expect((await run('(await edit("c.ts", "a", "x", {all: true})).replacements', context)).result).toBe('2')
    expect(disk.get('c.ts')).toBe('x x B')
    // The single form leaves the match count to the Edit tool; {soft} hands its error back.
    expect((await run('(await edit("c.ts", "x", "y", {soft: true})).error', context)).result).toContain('Found 2 matches')
    expect(disk.get('c.ts')).toBe('x x B')
    expect((await run('await edit("c.ts", [["x x", "1"], ["1 B", "done"]])', context)).result).toContain('ok: true')
    expect(disk.get('c.ts')).toBe('done')
    const missing = await run('await edit("c.ts", [["zzz", "1"]])', context)
    expect(missing.error).toContain('edit 1 of 1: text not found in c.ts')
    expect(disk.get('c.ts')).toBe('done')
  })
})

describe('$ and preview', () => {
  test('$ quotes values, reads text and lines, and throws on a failing exit', async () => {
    const { commands, tools } = fakeDisk({})
    const context = contextFor(tools)
    const data = await run(
      'const name = "it\'s"; const t = await $`echo ${name} ${["a b", "c"]} ${{raw: "*"}}`.text(); const bad = await $`false`.nothrow(); let threw; try { await $`false` } catch (e) { threw = [e.name, e.exitCode] } [t, bad.exitCode, bad.stdout, threw]',
      context,
    )
    expect(data.error).toBeUndefined()
    expect(commands[0]).toBe("echo 'it'\\''s' 'a b' 'c' *")
    expect(data.result).toContain("[ 'ShellError', 1 ]")
    expect(data.result).toContain("1, 'boom'")
    // nothrow() is a view of the same run: one command per $.
    expect(commands.filter(c => c === 'false')).toHaveLength(2)
  })

  test('cwd and env wrap the command; preview cuts with a marker', async () => {
    const { commands, tools } = fakeDisk({})
    const data = await run(
      'await $`ls`.cwd("/tmp").env({A: "1"}); [preview("x".repeat(10), 4), preview(await $`echo hi`), preview(null)]',
      contextFor(tools),
    )
    expect(commands[0]).toBe("(cd '/tmp' || exit 1; export A='1'; ls)")
    expect(data.result).toBe("[ 'xxxx\u2026[+6 chars]', 'hi', '' ]")
  })
})

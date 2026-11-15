import helperDeclarations from '../../../assets/code-mode-2.1.325.bash.d.ts.txt' with { type: 'text' }
import type { Tool, ToolPermissionContext, Tools } from '../../Tool.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { TOOL_SEARCH_TOOL_NAME } from '../ToolSearchTool/constants.js'
import { codeModeHidesTools } from './codeModeGate.js'
import { POLL_TOOL_NAME, REPL_TOOL_NAME } from './constants.js'
import { REPL_OUTPUT_PART_CHARS } from './executor/host.js'
import { replCallableToolsFrom } from './toolWrappers.js'

/** Doc lines in the declarations are cut to this many characters (official `zt`). */
const DOC_CHARS = 120
/** MCP servers named before "and N more"; the official cap is not known, this is a guess. */
const MCP_SERVERS_LISTED = 10
const SKILL_TOOL_PREFIX = 'skill__'

const EXAMPLE = `One script can look in several places at once and then act on what it found, for example:
\`\`\`js
const [defs, uses] = await Promise.all([
  $\`rg -l "function retryPolicy" src\`.text(),
  $\`rg -lF "retryPolicy(" src test\`.text(),
]);
const target = defs.trim().split('\\n')[0];                 // the file that defines it
if (!target) throw new Error('nothing defines retryPolicy: not editing');
await edit(target, 'maxAttempts: 3', 'maxAttempts: 5');
({edited: target, callers: uses.trim().split('\\n').filter(f => f !== target), test: $\`npm test -- retryPolicy\`.nothrow()})
\`\`\`
`

function firstDocLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > DOC_CHARS ? `${line.slice(0, DOC_CHARS - 1)}\u2026` : line
}

function docComment(schema: Record<string, unknown>, indent: string): string {
  return typeof schema.description === 'string' && schema.description.trim()
    ? `${indent}/** ${firstDocLine(schema.description).replaceAll('*/', '*\\/')} */\n`
    : ''
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * A JSON schema written as a TypeScript type, with property descriptions as
 * doc comments. Constructs it can't express ($ref, conditionals) become unknown.
 */
export function schemaToTypeScript(schema: unknown, indent = '', depth = 0): string {
  if (schema === false) return 'never'
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 12) return 'unknown'
  const s = schema as Record<string, unknown>
  if (['$ref', 'not', 'if', 'patternProperties', 'prefixItems'].some(key => key in s)) return 'unknown'
  const inner = (value: unknown) => schemaToTypeScript(value, indent, depth + 1)
  const literal = (value: unknown) =>
    value === null || ['string', 'number', 'boolean'].includes(typeof value) ? JSON.stringify(value) : 'unknown'
  if ('const' in s) return literal(s.const)
  if (Array.isArray(s.enum)) return s.enum.map(literal).join(' | ') || 'never'
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const parts = s[key]
    if (Array.isArray(parts)) return parts.map(inner).join(key === 'allOf' ? ' & ' : ' | ') || 'unknown'
  }
  if (Array.isArray(s.type)) return s.type.map(type => inner({ ...s, type })).join(' | ')
  switch (s.type) {
    case 'string':
      return 'string'
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array': {
      const item = inner(s.items)
      return /^[\w$]+$/.test(item) ? `${item}[]` : `Array<${item}>`
    }
    case 'object':
    case undefined: {
      const properties =
        s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties)
          ? (s.properties as Record<string, unknown>)
          : undefined
      if (!properties) return s.type === 'object' ? 'Record<string, unknown>' : 'unknown'
      const required = Array.isArray(s.required) ? s.required : []
      const fieldIndent = `${indent}  `
      const fields = Object.entries(properties).map(([key, value]) => {
        const name = IDENTIFIER.test(key) ? key : JSON.stringify(key)
        const doc = value && typeof value === 'object' ? docComment(value as Record<string, unknown>, fieldIndent) : ''
        const type = schemaToTypeScript(value, fieldIndent, depth + 1)
        return `${doc}${fieldIndent}${name}${required.includes(key) ? '' : '?'}: ${type};`
      })
      if (fields.length === 0) return 'Record<string, unknown>'
      return `{\n${fields.join('\n')}\n${indent}}`
    }
    default:
      return 'unknown'
  }
}

export function toolInputSchema(tool: Tool): Record<string, unknown> {
  try {
    return (tool.inputJSONSchema ?? zodToJsonSchema(tool.inputSchema)) as Record<string, unknown>
  } catch {
    return { type: 'object' }
  }
}

/**
 * The tools `interface Tools` declares: built-ins a script can call that the
 * API tool list doesn't carry. Empty when Code Mode isn't hiding tools, as in
 * official `pr()`; MCP and skill tools are found with searchTools instead.
 */
export function replDeclaredTools(tools: Tools, permissionContext: ToolPermissionContext): Tools {
  if (!codeModeHidesTools(tools)) return []
  return replCallableToolsFrom(tools, permissionContext).filter(
    tool =>
      tool.isMcp !== true &&
      !tool.name.startsWith(SKILL_TOOL_PREFIX) &&
      tool.name !== TOOL_SEARCH_TOOL_NAME &&
      tool.name !== REPL_TOOL_NAME &&
      tool.name !== POLL_TOOL_NAME &&
      tool.name !== 'list',
  )
}

function toolsInterface(tools: Tools): string {
  if (tools.length === 0) return ''
  const lines = tools.map(tool => {
    const name = IDENTIFIER.test(tool.name) ? tool.name : JSON.stringify(tool.name)
    return `  ${name}(input: ${schemaToTypeScript(toolInputSchema(tool), '  ')}): Promise<unknown>`
  })
  return `interface Tools {\n${lines.join('\n')}\n}`
}

function toolsGlobal(declared: string): string[] {
  const doc =
    '/** Every tool of this session by name, with its usual input (each is a bare global too); a built-in resolves {error} on failure; an MCP tool throws (e.message carries the tool error, e.detail the parsed body when it was JSON).' +
    (declared === ''
      ? ''
      : " In a subagent, or a session run as an agent, Tools can list a file or shell tool that agent isn't given; it is missing from tools.list() and calling it throws, so check tools.list() first.") +
    ' */'
  return declared === ''
    ? [doc, 'declare var tools: {[name: string]: (input: Record<string, unknown>) => Promise<unknown>} & {list(): string[]}']
    : [
        doc,
        'declare var tools: Tools & {[name: string]: (input: Record<string, unknown>) => Promise<unknown>} & {list(): string[]}',
        ...declared.split('\n'),
      ]
}

function declarations(declared: Tools): string {
  const tools = toolsInterface(declared)
  return (
    '```ts\n' +
    [
      tools === ''
        ? "// The globals of a REPL script, as TypeScript declarations. The session's tools are not listed here: searchTools finds them."
        : "// The globals of a REPL script, as TypeScript declarations. interface Tools covers the built-in tools a script can call that aren't in your tool list; long doc lines are cut short, and describeTool(name) returns a tool's description and full input schema. searchTools finds the others, such as MCP tools.",
      helperDeclarations.trimEnd(),
      ...toolsGlobal(tools),
    ].join('\n') +
    '\n```'
  )
}

function mcpLine(tools: Tools, codeMode: boolean): string {
  const servers = [...new Set(tools.flatMap(tool => (tool.isMcp === true && tool.mcpInfo ? [tool.mcpInfo.serverName] : [])))]
  if (!codeMode || servers.length === 0) return ''
  const listed = servers.slice(0, MCP_SERVERS_LISTED)
  const more = servers.length - listed.length
  return `MCP tools: connected servers are ${listed.join(', ')}${more > 0 ? ` and ${more} more` : ''}. Find a tool with \`searchTools\`, then call it with the input its match shows.\n`
}

/** The REPL tool's prompt, as official 2.1.325 `ts()` without the async lane and the skill listing. */
export function getReplPrompt(tools: Tools, permissionContext: ToolPermissionContext): string {
  const codeMode = codeModeHidesTools(tools)
  const opening = codeMode
    ? 'Your one tool is `REPL`; there are no other tools. Everything you do \u2014 shell commands, file reads and edits, code search, web fetches, MCP calls \u2014 happens as JavaScript inside a `REPL` call, through the globals below.'
    : 'Everything you do to investigate \u2014 shell commands, file reads, code search \u2014 happens as JavaScript inside a `REPL` call, through the globals below; the other tools in your list are also callable from a script, by name.'
  const partCap = ` Each part of what a script returns (each key of a returned object, what it logged) is shown cut to about ${REPL_OUTPUT_PART_CHARS.toLocaleString('en-US')} characters, head and tail kept, with a marker where the middle went.`
  const escaping =
    " In what a script returns, logs or throws, `&`, `<` and `>` are shown to you as `&amp;`, `&lt;` and `&gt;`. That's only how output is shown: your files and values aren't changed, so write the plain characters in your code."
  return `
${opening}

The REPL is one persistent JavaScript context: variables and functions you define in one call are there in the next, so keep results in variables (\`const out = await $\`\u2026\`.text()\`) instead of re-reading a file or re-running a command whose output you already hold. Those variables last between calls, but not across a restart, a resume, a fork or a wake: the first result after one of those says so. Top-level \`await\` works. There is no \`import\`, \`require\` or \`process\`: the context is sealed, and the globals below are how it reaches the machine. The REPL language is always JavaScript, whatever the codebase is written in \u2014 run the codebase's own tools (pytest, cargo, go test, \u2026) with \`$\`.

What a \`REPL\` call costs: each call is a full model round-trip \u2014 the whole conversation is re-read before your script runs, and you wait for the reply \u2014 while the work inside a script (shell commands, file reads, searches, tool calls) is comparatively free, and runs concurrently when you fan it out with \`Promise.all\`. So the expensive thing is coming back to decide, not doing more in one go: gather what a decision could plausibly need in the script you are already writing, and come back for another call when the next step depends on what this one shows you.

A script's output is its last expression's value plus anything it \`self.log(...)\`s along the way. What it returns is added to your context and stays there; the value itself stays in the REPL whether you return it or not. So return what you want to read now, and keep the rest in variables to slice or search later.${partCap}${escaping} Promise values inside a returned object are awaited for you (\`({status: $\`git status\`, branches: $\`git branch\`})\` needs no awaits); a promise used inline \u2014 concatenated, interpolated, passed to another call \u2014 needs \`await\`. \`console.*\` goes to a bounded in-memory ring rather than into your context; \`console.tail(n)\` reads it back.

To keep a long output out of your context, return \`preview(out)\` or \`preview(out, 2000)\` instead of the output itself: it gives the first characters, and when \`out\` is an awaited \`$\` result (not its \`.text()\` string) whose output the shell tool saved to a file, it starts with the output's size and the file's path.

A call's result is a \`<repl-output>\` element: \`<log>\` lines, then the \`<result>\` (or \`<error>\`).

${EXAMPLE}
## Declarations
${declarations(replDeclaredTools(tools, permissionContext))}
${mcpLine(tools, codeMode)}`
}

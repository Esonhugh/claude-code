import helperDeclarations from '../../../assets/code-mode-2.1.325.bash.d.ts.txt' with { type: 'text' }
import type { Tool, ToolPermissionContext, Tools } from '../../Tool.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { TOOL_SEARCH_TOOL_NAME } from '../ToolSearchTool/constants.js'
import { codeModeHidesTools, isReplEventDeliveryEnabled } from './codeModeGate.js'
import { POLL_TOOL_NAME, REPL_TOOL_NAME } from './constants.js'
import { REPL_OUTPUT_PART_CHARS } from './executor/host.js'
import { replCallableToolsFrom } from './toolWrappers.js'

/** Doc lines in the declarations are cut to this many characters (official `zt`). */
const DOC_CHARS = 120
/** MCP servers named before "and N more"; the official cap is not known, this is a guess. */
const MCP_SERVERS_LISTED = 10
const SKILL_TOOL_PREFIX = 'skill__'
/** Official replSettleWindowMs (TWt); REPLTool.ts holds the same value, which can't be imported here without a cycle. */
const SETTLE_WINDOW_SECONDS = 30
/** Official Aun (REPL_MAX_TIMEOUT_MS). */
const MAX_SCRIPT_MS = 600_000

/** Official async-lane text (2.1.325 chunk-g61t94xb.js:1573-1575), XML event variant. */
const ASYNC_OUTPUT = `
How output arrives: a script that finishes within about ${SETTLE_WINDOW_SECONDS} s comes back as the \`${REPL_TOOL_NAME}\` call's own result, a \`<repl-output eval="N">\` element holding \`<log>\` lines and the \`<result>\` (or \`<error>\`). One still running by then returns \`(dispatched #N)\` instead, runs on, and no longer holds up the scripts after it: its output arrives as an \`<event kind="repl-eval" eval="N">\` element with the same children, in a \`${POLL_TOOL_NAME}\` result or before your next turn, with an \`<event kind="repl-status">\` line meanwhile saying what is still pending. A receipt means the script is running, so issuing it again would run it twice. Scripts start in call order.

Waiting: \`${POLL_TOOL_NAME}\` returns as soon as something arrives; while a script or a background task (a context, say) is still running, a wait with nothing to deliver ends just before the prompt cache would expire (about 5 minutes, or about an hour on a 1-hour cache) in a status line saying what is still pending, so you can poll again. Sent in the same turn as a \`${REPL_TOOL_NAME}\` call it waits for that call's script: a long one (a test suite, a build) then costs no extra round trip, and one that has already come back ends the wait at once. When nothing else needs doing while a long script or a context runs, ending your turn works too: its result or notification starts your next turn when it lands, and waiting that way costs nothing. A shell command with no timeout of its own moves to the background after 10 minutes, so give a long build a longer timeout (up to 2 hours) to await it.
`

const SYNC_OUTPUT = "\nA call's result is a `<repl-output>` element: `<log>` lines, then the `<result>` (or `<error>`).\n"

/** Official Y: the lane follows the mode of each call, so the model hears how a permission-asking mode differs. */
const MODE_CHANGE = `
The user can change the permission mode at any time. In a mode that asks for permission, every \`${REPL_TOOL_NAME}\` call instead waits for its script and returns its output. The script is stopped ${MAX_SCRIPT_MS} ms after it starts, and that time includes time spent waiting at permission prompts.
`

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

const SHELL_TOOL_NAMES = new Set(['Bash', 'PowerShell'])

/** Official `Vl`: with the async lane described, a shell tool's schema loses run_in_background. */
function declaredSchema(tool: Tool, dropBackground: boolean): Record<string, unknown> {
  const schema = toolInputSchema(tool)
  const properties = schema.properties
  if (!dropBackground || !SHELL_TOOL_NAMES.has(tool.name) || !properties || typeof properties !== 'object') return schema
  const { run_in_background: _dropped, ...rest } = properties as Record<string, unknown>
  return { ...schema, properties: rest }
}

function toolsInterface(tools: Tools, dropBackground: boolean): string {
  if (tools.length === 0) return ''
  const lines = tools.map(tool => {
    const name = IDENTIFIER.test(tool.name) ? tool.name : JSON.stringify(tool.name)
    return `  ${name}(input: ${schemaToTypeScript(declaredSchema(tool, dropBackground), '  ')}): Promise<unknown>`
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

/**
 * Official `qo({asyncLane})` picks the async build of the helper declarations
 * when the async lane is described (`j7()`). Of its differences only the `$`
 * timeout sentence applies here: the async build's `running()` global and its
 * `self.running` doc have no counterpart in this worker.
 */
const SYNC_SHELL_TIMEOUT =
  'Timeouts cap at 600000 ms: past that the command keeps running in the background, and running names the task and the file its output streams to, so that file can be read'
const ASYNC_SHELL_TIMEOUT =
  'A command with no timeout of its own is awaited for up to 600000 ms; give it a longer one (at most 7200000 ms) to await a long build. Past its timeout the command moves to the background (one that starts with sleep is stopped instead): the await resolves without throwing, with exitCode null and running naming the task and the file its output streams to, and the script goes on. So check running before using its output or exit code, and read that file'
/** Official `Ol` and `Pl`: Code Mode's sync build says how the script cap and a command's own timeout interact. */
const SYNC_TIMEOUT_SENTENCE = `${SYNC_SHELL_TIMEOUT} instead of running the command again.`
const CODE_MODE_SYNC_TIMEOUT_SENTENCE =
  'A script is stopped 600000 ms after it starts, counting the time spent waiting on permission prompts, and a command still running then is stopped too and its output is lost. So give a long command a timeout that ends well before that. At its own timeout a command moves to the background and keeps running (one that starts with sleep is stopped instead, and so is every command if background tasks are disabled): the await resolves without throwing, with exitCode null, and running names the task and the file its output streams to, so read that file instead of running the command again.'

/** Official `Al`: Code Mode has no unsandboxed retry, so ShellOutput loses the field and its doc line. */
const UNSANDBOXED_RETRY =
  /(?: {4}\/\*\* the sandbox blocked the command, so this is its retry outside the sandbox;[^\n]*\n)? {4}unsandboxedRetry\?: \{\n {8}violation: string;\n {4}\};\n/g

function helpers(asyncLane: boolean, codeMode: boolean): string {
  const text = helperDeclarations.trimEnd()
  const laned = asyncLane ? text.replace(SYNC_SHELL_TIMEOUT, ASYNC_SHELL_TIMEOUT) : text
  if (!codeMode) return laned
  // Official xl(): a replacer function, so `$` in the sentence stays literal.
  return laned.replace(SYNC_TIMEOUT_SENTENCE, () => CODE_MODE_SYNC_TIMEOUT_SENTENCE).replace(UNSANDBOXED_RETRY, '')
}

function declarations(declared: Tools, asyncLane: boolean, codeMode: boolean, dropBackground: boolean): string {
  const tools = toolsInterface(declared, dropBackground)
  return (
    '```ts\n' +
    [
      tools === ''
        ? "// The globals of a REPL script, as TypeScript declarations. The session's tools are not listed here: searchTools finds them."
        : "// The globals of a REPL script, as TypeScript declarations. interface Tools covers the built-in tools a script can call that aren't in your tool list; long doc lines are cut short, and describeTool(name) returns a tool's description and full input schema. searchTools finds the others, such as MCP tools.",
      helpers(asyncLane, codeMode),
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

/**
 * The REPL tool's prompt, as official 2.1.325 `ts()` without the skill
 * listing. The async-lane text depends on the mode the session was launched
 * in (where Poll exists), not on the current mode, as official `j7()`, so the
 * prompt stays the same across mode changes.
 */
export function getReplPrompt(tools: Tools, permissionContext: ToolPermissionContext): string {
  const codeMode = codeModeHidesTools(tools)
  const asyncLane = isReplEventDeliveryEnabled()
  const dropBackground = asyncLane && tools.some(tool => tool.isMcp !== true && tool.name === POLL_TOOL_NAME)
  const opening = codeMode
    ? `${asyncLane ? `Your two tools are \`${REPL_TOOL_NAME}\` and \`${POLL_TOOL_NAME}\`` : 'Your one tool is `REPL`'}; there are no other tools. Everything you do \u2014 shell commands, file reads and edits, code search, web fetches, MCP calls \u2014 happens as JavaScript inside a \`REPL\` call, through the globals below.`
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
${asyncLane ? `${ASYNC_OUTPUT}${MODE_CHANGE}` : SYNC_OUTPUT}
${EXAMPLE}
## Declarations
${declarations(replDeclaredTools(tools, permissionContext), asyncLane, codeMode, dropBackground)}
${mcpLine(tools, codeMode)}`
}

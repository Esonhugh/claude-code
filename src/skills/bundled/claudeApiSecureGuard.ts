// PreToolUse guard for `/claude-api managed-agents-secure` (official 2.1.311).
// The skill has the model run `ant` commands whose IDs come from the account,
// so every shell command is checked before it runs: a command carrying one of
// the guide's --transform values must be that `ant` command as written, and
// IDs with internal or local-server prefixes are refused.
import {
  getRegisteredHooks,
  registerHookCallbacks,
} from '../../bootstrap/state.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { MONITOR_TOOL_NAME } from '../../tools/MonitorTool/prompt.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import type { HookCallback } from '../../types/hooks.js'
import type { HookInput, HookJSONOutput } from '../../entrypoints/agentSdkTypes.js'
import {
  checkSemantics,
  parseForSecurityFromAst,
  type SimpleCommand,
} from '../../utils/bash/ast.js'
import { type Node, PARSE_ABORTED, parseCommandRawForRemoval } from '../../utils/bash/parser.js'

const ID_FLAGS = new Map([
  ['--agent-id', /^agent_[A-Za-z0-9]+$/],
  ['--environment-id', /^env_[A-Za-z0-9]+$/],
  ['--vault-id', /^vlt_[A-Za-z0-9]+$/],
])
const VERSION = /^[1-9][0-9]*$/
const ANT_WORD = /\bant\b/i
const INTERNAL_ID = /(?:^|[^A-Za-z0-9_])(?:agent|env|vlt)_(?:staging|vrtx|bdrk)_/
const LOCAL_ID = /(?:^|[^A-Za-z0-9_])(?:agent|env|vlt)_local_/g
const LOCAL_ID_FORM =
  /^(?:--[a-z][a-z-]*=)?(?:agent|env|vlt)_local_01[1-9A-HJ-NP-Za-km-z]{22}$/
const QUOTES = /['"\\`\u2018-\u201f]/g
const ANT_PATH = /^(?:~?\/(?:[\w.-]+\/)*)?ant(?:\.exe)?$/
const ANT_BARE = /^ant(?:\.exe)?$/
const NESTED_PARSE_BUDGET = 16
const FORBIDDEN_NODES = new Set([
  '&',
  'subshell',
  'compound_statement',
  'if_statement',
  'case_statement',
])
const LOOP_NODES = new Set([
  'for_statement',
  'c_style_for_statement',
  'while_statement',
])
const TOKEN = String.raw`'([^'"\r\n\u2018-\u201f]*)'|([\w:./=~-]+)`
const CD_PREFIX = /^(?:cd '[^'"\r\n\u2018-\u201f]*' && )+/
const SET_LOCATION_PREFIX =
  /^(?:Set-Location -LiteralPath '[^'"\r\n\u2018-\u201f]*'(?: -ErrorAction Stop)?; )+/

const COMMAND_CHANGED =
  "Claude Code did not run this command: it holds a --transform from the /claude-api managed-agents-secure instructions but is not that `ant` command as written. Run each of those commands alone and exactly as written, with each ID typed inside its single quotes (agent_, env_ or vlt_, then only letters and digits). Add --version only to `ant beta:agents retrieve`, as a whole number with no leading zero. If an ID or version read from the account has another form, do not run the command: ask the developer about it, and mark each report row that needs it CAN'T TELL."
const INTERNAL_ID_REFUSED =
  "Claude Code did not run this command: it holds an ID starting agent_, env_ or vlt_ then staging_, vrtx_ or bdrk_, which `ant` commands may not use. Do not run the command another way: tell the developer which ID was refused and ask where it came from. If this is part of /claude-api managed-agents-secure, mark each report row that needs it CAN'T TELL."
const LOCAL_ID_FORM_REFUSED =
  "Claude Code did not run this command: it holds an ID starting agent_local_, env_local_ or vlt_local_, and the ID or the command around it is not in the one form Claude Code accepts. Such IDs come from a self-hosted or local Managed Agents server. Each such ID in the command must have the form agent_, env_ or vlt_, then local_01, then 22 letters and digits other than 0, O, I and l, and must be typed in full as its own argument to ant or ant.exe, named in lowercase with no path. Only cd into a folder, or another ant command, may come before ant; do not run ant through or feed it from another program such as timeout, echo or xargs. The command must be Bash made of plain commands joined by &&, || or ;, with at most one | after ant, into a program such as jq. It must not use: & to run a command in the background; VAR=value, export or any other variable setting; a redirect such as > file or 2>&1; if, for, while, case or function; a ( ) or { } group; $ variables; $( ), <( ), >( ) or backtick substitutions; or here-documents or <<< strings. To reach a self-hosted server, pass its address with ant's --base-url flag, not a variable. If ant is not on PATH, ask the developer to add its folder to PATH in their shell settings and restart Claude Code. If this is part of /claude-api managed-agents-secure, do not run the command again: mark each report row that needs the ID CAN'T TELL. Otherwise, if the ID came from such a server and already has that form, you may run the command again following these rules; if not, do not change the ID: ask the developer where it came from."
const LOCAL_SERVER_UNSUPPORTED =
  "Claude Code did not run this command: /claude-api managed-agents-secure does not support self-hosted or local Managed Agents servers, whose IDs start agent_local_, env_local_ or vlt_local_. Do not run the command another way: tell the developer which ID was refused and that /claude-api managed-agents-secure checks only agents on Anthropic's Managed Agents API, ask where the ID came from, and mark each report row that needs it CAN'T TELL."

type ShapedCommand = SimpleCommand & { argvSourceLiteral: boolean }

type BashShape =
  | {
      kind: 'simple'
      commands: ShapedCommand[]
      bareAssignmentNames: string[]
      hasLoop: boolean
      hasForbiddenNode: boolean
    }
  | { kind: 'other' }

function someNode(node: Node, test: (n: Node) => boolean): boolean {
  if (test(node)) return true
  for (const child of node.children) {
    if (child && someNode(child, test)) return true
  }
  return false
}

function collectBareAssignments(node: Node, names: string[]): void {
  if (node.type === 'command') return
  if (node.type === 'variable_assignment' || node.type === 'declaration_command') {
    names.push(node.text)
    return
  }
  for (const child of node.children) {
    if (child) collectBareAssignments(child, names)
  }
}

// True when every argument is spelled out in the source: no $ or backtick
// expansion, no unquoted glob, no unquoted leading ~.
function isSourceLiteral(text: string): boolean {
  let quote: "'" | '"' | null = null
  let wordStart = true
  for (const ch of text) {
    if (quote === "'") {
      if (ch === "'") quote = null
    } else if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '$' || ch === '`') return false
    } else if (ch === "'" || ch === '"') {
      quote = ch
    } else if (ch === '$' || ch === '`' || ch === '*' || ch === '?' || ch === '[') {
      return false
    } else if (ch === '~' && wordStart) {
      return false
    }
    wordStart = quote === null && /\s/.test(ch)
  }
  return true
}

// Like official, the guard always parses; the feature-gated parseCommandRaw
// would leave external builds without a tree and refuse every guide command.
async function parseBash(command: string): Promise<BashShape> {
  const root = await parseCommandRawForRemoval(command)
  if (root === null) return { kind: 'other' }
  const parsed = parseForSecurityFromAst(command, root)
  if (parsed.kind !== 'simple' || root === PARSE_ABORTED) return { kind: 'other' }
  const bareAssignmentNames: string[] = []
  collectBareAssignments(root, bareAssignmentNames)
  return {
    kind: 'simple',
    commands: parsed.commands.map(c => ({
      ...c,
      argvSourceLiteral: isSourceLiteral(c.text),
    })),
    bareAssignmentNames,
    hasLoop: someNode(root, n => LOOP_NODES.has(n.type)),
    hasForbiddenNode: someNode(root, n => FORBIDDEN_NODES.has(n.type)),
  }
}

function tokenize(text: string): string[] | undefined {
  const trimmed = text.replace(/^[ \t\n]+|[ \t\n]+$/g, '')
  if (!new RegExp(`^(?:${TOKEN})(?:[ \\t]+(?:${TOKEN}))*$`).test(trimmed)) return undefined
  return [...trimmed.matchAll(new RegExp(TOKEN, 'g'))].map(m => m[1] ?? m[2] ?? '')
}

type GuideCommand = { words: string[]; transform: string }
let guideCommands: GuideCommand[] | undefined

async function loadGuideCommands(): Promise<GuideCommand[]> {
  if (guideCommands === undefined) {
    const { SKILL_FILES } = await import('./claudeApiContent.js')
    guideCommands = (SKILL_FILES['shared/managed-agents-secure.md'] ?? '')
      .split('\n')
      .filter(line => line.startsWith('ant beta:'))
      .flatMap(line => {
        const words = tokenize(line)
        const i = words?.indexOf('--transform') ?? -1
        const transform = i === -1 ? undefined : words?.[i + 1]
        return words !== undefined && transform ? [{ words, transform }] : []
      })
  }
  return guideCommands
}

// A loop whose later passes may differ, or a nested shell (`bash -c "...do..."`)
// that hides one, means the guard cannot tell what runs.
async function mayHideCommands(shape: BashShape, budget: { left: number }): Promise<boolean> {
  // The fork's parser does not compare loop passes, so any loop counts.
  if (shape.kind !== 'simple' || shape.hasLoop) return true
  for (const word of shape.commands.flatMap(({ argv }) => argv)) {
    if (
      /\bdo\b/.test(word) &&
      /\s/.test(word) &&
      (budget.left-- <= 0 || (await mayHideCommands(await parseBash(word), budget)))
    ) {
      return true
    }
  }
  return false
}

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}

export async function checkManagedAgentsSecureCommand(
  toolName: string,
  command: string,
): Promise<string | null> {
  const shell = toolName === POWERSHELL_TOOL_NAME ? 'powershell' : 'bash'
  const unquoted = command.replace(QUOTES, '')
  const shape: BashShape = shell === 'bash' ? await parseBash(command) : { kind: 'other' }
  const simple = shape.kind === 'simple' ? shape : undefined
  const mentionsAnt =
    simple === undefined ||
    ANT_WORD.test(unquoted) ||
    simple.commands.some(({ argv }) => argv.some(a => /(?:^|\/)ant(?:\.exe)?$/i.test(a)))
  const joinedArgv = simple ? simple.commands.flatMap(({ argv }) => argv).join(' ') : ''
  const variants = [command, command.replace(/\\\n/g, '')].map(v => v.replace(QUOTES, ''))
  const countLocal = (s: string) => (s.match(LOCAL_ID) ?? []).length
  const hasLocalId = variants.some(v => countLocal(v) > 0) || countLocal(joinedArgv) > 0
  const lastLocal = simple
    ? simple.commands.findLastIndex(({ argv }) => argv.some(a => countLocal(a) > 0))
    : -1
  const localArgs =
    hasLocalId &&
    simple &&
    !/\$\(|`|<<|[<>]\(/.test(command) &&
    checkSemantics(simple.commands).ok &&
    simple.bareAssignmentNames.length === 0 &&
    !simple.hasLoop &&
    !simple.hasForbiddenNode &&
    simple.commands.every(
      ({ argv, argvSourceLiteral, envVars, redirects }, i) =>
        argvSourceLiteral &&
        envVars.length === 0 &&
        (i > lastLocal ||
          (redirects.length === 0 &&
            (ANT_BARE.test(argv[0] ?? '') ||
              (argv.length === 2 && argv[0] === 'cd' && countLocal(argv[1] ?? '') === 0)))),
    )
      ? simple.commands.flatMap(({ argv }) => argv.filter(a => countLocal(a) > 0))
      : undefined
  const localIdsWellFormed =
    localArgs !== undefined &&
    localArgs.every(a => LOCAL_ID_FORM.test(a)) &&
    variants.every(v => countLocal(v) === localArgs.length)
  const hasInternalId = variants.some(v => INTERNAL_ID.test(v)) || INTERNAL_ID.test(joinedArgv)

  if (
    (hasInternalId || (hasLocalId && !localIdsWellFormed)) &&
    (mentionsAnt || (await mayHideCommands(shape, { left: NESTED_PARSE_BUDGET })))
  ) {
    if (hasInternalId) return INTERNAL_ID_REFUSED
    const guide = await loadGuideCommands().catch(() => [])
    return guide.some(({ transform }) => unquoted.includes(transform))
      ? LOCAL_SERVER_UNSUPPORTED
      : LOCAL_ID_FORM_REFUSED
  }

  const guide = await loadGuideCommands()
  let expected: string[] | undefined
  let actual: string[] | undefined
  if (shell === 'powershell') {
    expected = guide.find(({ transform }) => unquoted.includes(transform))?.words
    const rest = command.replace(SET_LOCATION_PREFIX, '')
    actual = /^[ \t\n]*['"]/.test(rest) ? undefined : tokenize(rest)
  } else if (simple === undefined) {
    expected = guide.find(({ transform }) => unquoted.includes(transform))?.words
  } else {
    const carrying = simple.commands.filter(({ argv }) =>
      guide.some(({ transform }) => argv.includes(transform)),
    )
    expected = (
      guide.find(({ transform }) => carrying.some(({ argv }) => argv.includes(transform))) ??
      guide.find(({ transform }) => unquoted.includes(transform))
    )?.words
    const last = simple.commands.at(-1)
    const before = simple.commands.slice(0, -1)
    const written = tokenize(command.replace(CD_PREFIX, ''))
    actual =
      carrying.length === 1 &&
      simple.bareAssignmentNames.length === 0 &&
      !simple.hasLoop &&
      last !== undefined &&
      last === carrying[0] &&
      written !== undefined &&
      written.length === last.argv.length &&
      written.every((w, i) => w === last.argv[i]) &&
      last.envVars.length === 0 &&
      last.redirects.length === 0 &&
      last.argvSourceLiteral &&
      before.every(
        ({ argv, envVars, redirects }) =>
          argv.length === 2 && argv[0] === 'cd' && envVars.length === 0 && redirects.length === 0,
      )
        ? last.argv
        : undefined
  }
  if (expected === undefined) return null

  const words = actual ?? []
  const versionAt =
    expected[1] === 'beta:agents' && expected[2] === 'retrieve'
      ? words.findIndex((w, i) => i > 2 && (w === '--version' || w.startsWith('--version=')))
      : -1
  const inline = words[versionAt]?.startsWith('--version=') === true
  const version = inline ? words[versionAt]?.slice(10) : words[versionAt + 1]
  const compared =
    versionAt === -1
      ? words
      : version !== undefined && VERSION.test(version) && !(words[versionAt - 1] ?? '').startsWith('-')
        ? [...words.slice(0, versionAt), ...words.slice(versionAt + (inline ? 1 : 2))]
        : []
  if (
    compared.length === expected.length &&
    expected.every((word, i) => {
      const idForm = ID_FLAGS.get(expected[i - 1] ?? '')
      const got = compared[i] ?? ''
      return idForm !== undefined ? idForm.test(got) : i === 0 ? ANT_PATH.test(got) : got === word
    })
  ) {
    return null
  }
  return hasLocalId && localIdsWellFormed ? LOCAL_SERVER_UNSUPPORTED : COMMAND_CHANGED
}

async function guardHook(input: HookInput): Promise<HookJSONOutput> {
  if (input.hook_event_name !== 'PreToolUse') return {}
  const toolInput = input.tool_input
  const command =
    typeof toolInput === 'object' && toolInput !== null && 'command' in toolInput
      ? (toolInput as { command: unknown }).command
      : undefined
  if (typeof command !== 'string') return {}
  const reason = await checkManagedAgentsSecureCommand(input.tool_name, command)
  return reason === null ? {} : deny(reason)
}

const GUARD_HOOK: HookCallback = {
  type: 'callback',
  callback: guardHook,
  timeout: 10,
  internal: true,
}

export function registerManagedAgentsSecureGuard(): void {
  const registered = getRegisteredHooks()?.PreToolUse ?? []
  if (registered.some(m => m.hooks.some(h => h === GUARD_HOOK))) return
  registerHookCallbacks({
    PreToolUse: [
      {
        matcher: `${BASH_TOOL_NAME}|${POWERSHELL_TOOL_NAME}|${MONITOR_TOOL_NAME}`,
        hooks: [GUARD_HOOK],
      },
    ],
  })
}

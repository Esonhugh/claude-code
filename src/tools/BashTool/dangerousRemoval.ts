import { existsSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, resolve } from 'path'
import { getParserModule } from '../../utils/bash/bashParser.js'
import type { Node, PARSE_ABORTED } from '../../utils/bash/parser.js'
import { logForDebugging } from '../../utils/debug.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { isDangerousRemovalPath } from '../../utils/permissions/pathValidation.js'

type Argument = { value: string; unknown: boolean }
type Variables = Readonly<Record<string, string | undefined>>
type Known = (name: string) => string[]
// `dir` is the working directory after literal cd commands, when known.
type Scope = { changed: boolean; dir?: string }

// The shell maintains these itself, so the process snapshot does not describe them.
const SHELL_MAINTAINED = new Set(['PWD', 'OLDPWD', '_'])
// Plain $NAME or ${NAME}. A following '[' or ':' is a zsh subscript or modifier.
const VARIABLE = /\$(?:([A-Za-z_]\w*)(?![\w:[])|\{([A-Za-z_]\w*)\}(?![:[]))/y

// Decode one parser-delimited word, never evaluate shell syntax. Plain variables
// are substituted from the supplied environment snapshot only.
function argument(text: string, vars: Variables): Argument {
  let value = ''
  let quote = ''
  let opened = 0
  let unknown = false
  const braces: boolean[] = []
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (char === '$' && quote !== "'") {
      VARIABLE.lastIndex = i
      const match = VARIABLE.exec(text)
      const name = match?.[1] ?? match?.[2]
      const resolved =
        name && !SHELL_MAINTAINED.has(name) && Object.hasOwn(vars, name)
          ? vars[name]
          : undefined
      // Unquoted results may be split or globbed by the shell.
      if (resolved !== undefined && (quote || !/[\s*?[\]]/.test(resolved))) {
        value += resolved
        i += match![0].length - 1
        continue
      }
    }
    if (quote === "'") {
      if (char === "'") quote = ''
      else value += char
    } else if (
      char === '\\' &&
      (quote !== '"' || /[$`"\\\n]/.test(text[i + 1] ?? ''))
    ) {
      const next = text[++i]
      if (next === undefined) unknown = true
      else if (next !== '\n') value += next
    } else if (char === quote) {
      quote = ''
    } else if (!quote && (char === "'" || char === '"')) {
      quote = char
      opened = value.length
    } else {
      if (!quote) {
        if (char === '{') braces.push(false)
        else if (char === '}') unknown = (braces.pop() ?? false) || unknown
        else if (
          braces.length &&
          (char === ',' || (char === '.' && text[i + 1] === '.'))
        )
          braces[braces.length - 1] = true
      }
      // zsh also expands forms such as $~NAME, $=NAME and $^NAME.
      if (
        (char === '$' &&
          /\S/.test(text[i + 1] ?? ' ') &&
          !(quote && text[i + 1] === '"')) ||
        char === '`' ||
        (!quote &&
          (/[*?\[\]]/.test(char) ||
            ((char === '<' || char === '>') && text[i + 1] === '(')))
      )
        unknown = true
      if (i === 0 && char === '~' && !quote) {
        if (text.length === 1 || text[1] === '/') value += homedir()
        else {
          unknown = true
          value += char
        }
      } else value += char
    }
  }
  // The parser ends an open single quote on the word's last character.
  if (quote === "'")
    return { value: value.slice(0, Math.max(opened, value.length - 1)), unknown }
  return { value, unknown: unknown || quote !== '' }
}

function protectedPath(value: string, cwd: string): boolean {
  // Expansion globs were handled above. A literal trailing '*' must not trigger
  // the legacy helper's wildcard rule; the protected directory rules still apply.
  const literal = value.endsWith('*')
    ? `${value.slice(0, -1)}literal-star`
    : value
  const lexical = isAbsolute(literal) ? literal : `${cwd}/${literal}`
  return (
    isDangerousRemovalPath(lexical) ||
    isDangerousRemovalPath(resolve(cwd, literal))
  )
}

// Unresolved parts (variables, substitutions) drop out, as when they expand
// empty: `"$DIR"/` becomes `/`. Known values of each variable are tried too.
const EXPANSION =
  /\$\{[^}]*\}|\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`|\$[~=^]*[A-Za-z_]\w*|\$[0-9@*#?!$-]/g
const NAMED = /^\$(?:[~=^]*([A-Za-z_]\w*)|\{[~=^]*([A-Za-z_]\w*)\})$/

function expansionValues(value: string, known: Known): string[] {
  const name = (match: string) => {
    const named = NAMED.exec(match)
    return named?.[1] ?? named?.[2]
  }
  const values = [value.replace(EXPANSION, '')]
  for (const variable of new Set([...value.matchAll(EXPANSION)].map(match => name(match[0]))))
    for (const candidate of variable ? known(variable) : [])
      values.push(value.replace(EXPANSION, match => (name(match) === variable ? candidate : '')))
  return values
}

// Like official, an unresolved target only asks when it can reach a protected
// path, or when a trailing `*` can cover the working directory.
function unresolvedTarget(
  target: Argument,
  cwd: string,
  changed: boolean,
  known: Known,
): PermissionResult | undefined {
  for (const [i, value] of expansionValues(target.value, known).entries()) {
    const path = resolve(cwd, value)
    // `$DIR/name` with DIR empty only reaches an existing top-level entry.
    const missingRootChild =
      i === 0 && dirname(path) === '/' && path !== '/' && !/[*?[]/.test(path) && !existsSync(path)
    if (protectedPath(value, cwd) && !missingRootChild)
      return mandatory(`Removal target can reach a protected path: ${target.value}`)
    const wipe = /^(.*?)\/?\*$/.exec(value)
    if (!wipe) continue
    const dir = resolve(cwd, wipe[1] || '.')
    if (
      (changed && !isAbsolute(value)) ||
      protectedPath(wipe[1] || '.', cwd) ||
      cwd === dir ||
      cwd.startsWith(`${dir}/`)
    )
      return mandatory(`Removal glob can cover a protected or working directory: ${target.value}`)
  }
}

function mandatory(reason: string): PermissionResult {
  return {
    behavior: 'ask',
    message: `Removal requires explicit user approval: ${reason}`,
    decisionReason: {
      type: 'safetyCheck',
      reason,
      classifierApprovable: false,
      bypassImmune: true,
    },
    suggestions: [],
  }
}

const REMOVALS = new Set(['rm', 'rmdir', 'unlink'])
const WRAPPERS: Record<string, { value: string[]; flag: RegExp }> = {
  xargs: {
    value: [
      '-a',
      '--arg-file',
      '-d',
      '--delimiter',
      '-E',
      '-I',
      '-J',
      '-L',
      '-n',
      '--max-args',
      '-P',
      '--max-procs',
      '-s',
      '--max-chars',
    ],
    flag: /^(-[0rptx]+|--null|--no-run-if-empty|--verbose|--interactive|--exit|--replace(?:=.*)?|--eof(?:=.*)?|--max-lines(?:=.*)?)$/,
  },
  nice: { value: ['-n', '--adjustment'], flag: /^-\d+$/ },
  timeout: {
    value: ['-s', '--signal', '-k', '--kill-after'],
    flag: /^(--foreground|--preserve-status|-v|--verbose)$/,
  },
  time: {
    value: ['-f', '--format', '-o', '--output'],
    flag: /^(-p|-a|-v|--portability|--append|--verbose)$/,
  },
  nohup: { value: [], flag: /^$/ },
  stdbuf: {
    value: ['-i', '-o', '-e', '--input', '--output', '--error'],
    flag: /^$/,
  },
  env: {
    value: ['-u', '--unset'],
    flag: /^(-i|--ignore-environment|-0|--null)$/,
  },
  command: { value: [], flag: /^-p$/ },
  exec: { value: ['-a'], flag: /^-[cl]+$/ },
  setsid: { value: [], flag: /^(-[cfw]+|--ctty|--fork|--wait)$/ },
  ionice: {
    value: ['-c', '--class', '-n', '--classdata'],
    flag: /^(-t|--ignore)$/,
  },
  busybox: { value: [], flag: /^$/ },
  doas: { value: ['-u', '-C'], flag: /^-[ns]+$/ },
  pkexec: {
    value: ['--user'],
    flag: /^(--disable-internal-agent|--keep-cwd)$/,
  },
  sudo: {
    value: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt'],
    flag: /^-[nEHSkAb]+$/,
  },
}

// This only uncovers removal candidates, never grants wrapper permissions.
function unwrap(argv: Argument[]): { argv: Argument[] } {
  while (argv[0] && !argv[0].unknown) {
    const name = basename(argv[0].value)
    const options = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined
    if (!options) break
    let i = 1
    for (; i < argv.length; i++) {
      const arg = argv[i]!
      if (arg.value === '--') {
        i++
        break
      }
      if (name === 'command' && /^-[pvV]*[vV][pvV]*$/.test(arg.value))
        return { argv: [] }
      if (name === 'env' && /^[A-Za-z_][A-Za-z_0-9]*=/.test(arg.value)) continue
      if (!arg.value.startsWith('-')) break
      if (name === 'env' && /^(-S|--split-string(?:=|$))/.test(arg.value)) {
        const text =
          arg.value.startsWith('-S') && arg.value.length > 2
            ? arg.value.slice(2)
            : arg.value.includes('=')
              ? arg.value.slice(arg.value.indexOf('=') + 1)
              : (argv[++i]?.value ?? '')
        const candidate = text.match(
          /^\s*((?:\/[^\s]+\/)?(?:rm|rmdir|unlink))(?:\s|$)/,
        )
        return {
          argv: candidate
            ? [
                { value: candidate[1]!, unknown: false },
                { value: '', unknown: true },
              ]
            : [],
        }
      }
      if (
        (name === 'env' && /^(-C|--chdir)(=|$)/.test(arg.value)) ||
        (name === 'sudo' && /^(-D|--chdir)(=|$)/.test(arg.value))
      ) {
        if (!arg.value.includes('=')) i++
        continue
      }
      if (options.value.includes(arg.value)) {
        i++
        continue
      }
      if (
        options.value.some(
          flag =>
            arg.value.startsWith(`${flag}=`) ||
            (flag.length === 2 &&
              arg.value.startsWith(flag) &&
              arg.value.length > 2),
        )
      )
        continue
      if (!options.flag.test(arg.value) || arg.unknown) {
        // An unknown option may consume a value. Only use the immediately
        // following removal name as evidence; do not search arbitrary arguments.
        if (
          argv[i + 1] &&
          !REMOVALS.has(basename(argv[i + 1]!.value)) &&
          argv[i + 2] &&
          REMOVALS.has(basename(argv[i + 2]!.value))
        )
          i++
      }
    }
    if (name === 'timeout') i++ // duration, not a command
    argv = argv.slice(i)
  }
  return { argv }
}

function* operands(args: Argument[]): Generator<Argument> {
  let options = true
  for (const target of args) {
    if (options && target.value === '--') {
      options = false
      continue
    }
    if (options && target.value.startsWith('-') && !target.unknown) continue
    yield target
  }
}

const FIND_VALUE_PREDICATES = new Set([
  '-name',
  '-iname',
  '-path',
  '-ipath',
  '-wholename',
  '-iwholename',
  '-lname',
  '-ilname',
  '-regex',
  '-iregex',
  '-newer',
  '-anewer',
  '-cnewer',
  '-samefile',
  '-type',
  '-xtype',
  '-user',
  '-group',
  '-uid',
  '-gid',
  '-perm',
  '-size',
  '-links',
  '-inum',
  '-atime',
  '-ctime',
  '-mtime',
  '-amin',
  '-cmin',
  '-mmin',
  '-used',
  '-maxdepth',
  '-mindepth',
  '-regextype',
  '-printf',
  '-fprintf',
  '-fprint',
  '-fprint0',
  '-fls',
])

function checkFind(
  argv: Argument[],
  cwd: string,
  changed: boolean,
  known: Known,
): PermissionResult | undefined {
  const roots: Argument[] = []
  let i = 1
  for (; i < argv.length; i++) {
    const arg = argv[i]!
    if (['-H', '-L', '-P', '-E', '-X', '-s', '-x', '--'].includes(arg.value))
      continue
    if (arg.value === '-f') {
      roots.push(argv[++i] ?? { value: '', unknown: true })
      continue
    }
    if (arg.value.startsWith('-') || ['!', '('].includes(arg.value)) break
    roots.push(arg)
  }
  if (!roots.length) roots.push({ value: '.', unknown: false })
  for (; i < argv.length; i++) {
    const value = argv[i]!.value
    if (value === '-files0-from') {
      roots.push({ value: '', unknown: true })
      i++
      continue
    }
    if (
      FIND_VALUE_PREDICATES.has(value) ||
      /^-newer[acmBt][acmtB]$/.test(value)
    ) {
      i += value === '-fprintf' ? 2 : 1
      continue
    }
    let traverses = value === '-delete'
    if (['-exec', '-execdir', '-ok', '-okdir'].includes(value)) {
      const start = ++i
      while (i < argv.length && ![';', '+'].includes(argv[i]!.value)) i++
      const executable = argv[start]
      if (
        !executable ||
        executable.unknown ||
        !REMOVALS.has(basename(executable.value))
      )
        continue
      for (const target of operands(argv.slice(start + 1, i))) {
        if (target.value === '{}') {
          traverses = true
          continue
        }
        if (target.unknown) {
          const result = unresolvedTarget(target, cwd, changed, known)
          if (result) return result
          continue
        }
        if (
          target.value.includes('{}') ||
          ((changed || value.endsWith('dir')) && !isAbsolute(target.value))
        )
          continue
        if (protectedPath(target.value, cwd))
          return mandatory(
            `Protected find exec removal target: ${resolve(cwd, target.value)}`,
          )
      }
    }
    if (!traverses) continue
    for (const target of roots) {
      if (target.unknown) {
        const result = unresolvedTarget(target, cwd, changed, known)
        if (result) return result
        continue
      }
      if (changed && !isAbsolute(target.value)) continue
      const path = resolve(cwd, target.value)
      // Root children and home are protected objects, not protected whole trees.
      // Traversal is also dangerous when it can reach a protected home descendant.
      if (protectedPath(target.value, cwd) || homedir().startsWith(`${path}/`))
        return mandatory(`Protected find removal root: ${path}`)
    }
  }
}

const ARGUMENT_NODES = new Set([
  'command_name',
  'word',
  'number',
  'raw_string',
  'ansi_c_string',
  'string',
  'concatenation',
  'simple_expansion',
  'expansion',
  'arithmetic_expansion',
  'brace_expression',
  'command_substitution',
  'process_substitution',
])

function commandWords(children: Node[]): Node[] {
  return children.flatMap(child => {
    if (ARGUMENT_NODES.has(child.type)) return [child]
    // The parser stores arguments following a redirect beside its target.
    if (child.type === 'file_redirect')
      return child.children
        .filter(part => ARGUMENT_NODES.has(part.type))
        .slice(1)
    return []
  })
}

function* commands(
  root: Node,
): Generator<{ words: Node[]; scope: Scope }> {
  const pending = [
    { node: root, scope: { changed: false } as Scope, trailing: [] as Node[] },
  ]
  while (pending.length) {
    const { node, scope, trailing } = pending.pop()!
    if (node.type === 'function_definition' || node.type === 'raw_string')
      continue
    if (node.type === 'command')
      yield { words: [...commandWords(node.children), ...trailing], scope }
    const redirected =
      node.type === 'redirected_statement'
        ? node.children
            .filter(child => child.type === 'file_redirect')
            .flatMap(child => commandWords([child]))
        : []
    const recipient = [
      'redirected_statement',
      'pipeline',
      'negated_command',
    ].includes(node.type)
      ? node.children.findLast(child =>
          [
            'command',
            'pipeline',
            'redirected_statement',
            'negated_command',
          ].includes(child.type),
        )
      : undefined
    const isolated = [
      'subshell',
      'command_substitution',
      'process_substitution',
    ].includes(node.type)
    const childScope = isolated ? { ...scope } : scope
    for (let i = node.children.length - 1; i >= 0; i--) {
      pending.push({
        node: node.children[i]!,
        trailing:
          node.children[i] === recipient ? [...redirected, ...trailing] : [],
        scope:
          node.type === 'pipeline' ? { ...scope } : childScope,
      })
    }
  }
}

const ASSIGNMENT_NODES = new Set([
  'variable_assignment',
  'declaration_command',
  'unset_command',
  'for_statement',
  'c_style_for_statement',
])
// Commands that assign variables directly, by name, or by evaluating text.
const VARIABLE_SETTERS = new Set([
  'read',
  'mapfile',
  'readarray',
  'getopts',
  'printf',
  'print',
  'vared',
  'zparseopts',
  'eval',
  'source',
  '.',
  'trap',
  'set',
  'let',
  'export',
  'declare',
  'typeset',
  'local',
  'readonly',
  'unset',
  'integer',
  'float',
])

// The environment snapshot only describes commands that cannot assign
// variables themselves, including inside function bodies.
function assignsVariables(root: Node): boolean {
  const pending = [root]
  while (pending.length) {
    const node = pending.pop()!
    if (
      ASSIGNMENT_NODES.has(node.type) ||
      (node.type === 'expansion' && node.text.includes('='))
    )
      return true
    if (node.type === 'command') {
      const [name = '', next = ''] = commandWords(node.children).map(word =>
        basename(argument(word.text, {}).value),
      )
      if (
        VARIABLE_SETTERS.has(name) ||
        (['builtin', 'command', 'noglob'].includes(name) &&
          VARIABLE_SETTERS.has(next))
      )
        return true
    }
    pending.push(...node.children)
  }
  return false
}

// Literal values each variable is assigned in the command; values that
// still need the shell to evaluate them are left out.
function assignedValues(root: Node, env: Variables): Map<string, string[]> {
  const assigned = new Map<string, string[]>()
  const pending = [root]
  while (pending.length) {
    const node = pending.pop()!
    pending.push(...node.children)
    if (node.type !== 'variable_assignment') continue
    const [name, , value] = node.children
    if (name?.type !== 'variable_name') continue
    const resolved = value ? argument(value.text, env) : { value: '', unknown: false }
    if (resolved.unknown) continue
    assigned.set(name.text, [...(assigned.get(name.text) ?? []), resolved.value])
  }
  return assigned
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh'])
// Nesting depth for `sh -c '...'` scripts analyzed as their own command.
const MAX_SCRIPT_DEPTH = 3

// Returns the script operand of `sh -c SCRIPT`, or undefined when the shell
// runs a file or stdin instead.
function shellScript(argv: Argument[]): Argument | undefined {
  let script = false
  for (let i = 1; i < argv.length; i++) {
    const { value } = argv[i]!
    if (value === '--' || value === '-') return script ? argv[i + 1] : undefined
    if (/^[-+]o$|^[-+]O$/.test(value)) {
      i++
      continue
    }
    if (/^[-+][A-Za-z]+$/.test(value)) {
      if (value[0] === '-' && value.includes('c')) script = true
      continue
    }
    if (value.startsWith('--')) continue
    return script ? argv[i] : undefined
  }
  return undefined
}

function checkScript(
  script: string,
  cwd: string,
  changed: boolean,
  env: Variables,
  depth: number,
): PermissionResult | undefined {
  if (depth >= MAX_SCRIPT_DEPTH)
    return /\b(?:rm|rmdir|unlink)\b/.test(script)
      ? mandatory('Shell -c script nested too deeply to analyze')
      : undefined
  const root = getParserModule()?.parse(script)
  if (!root) {
    return /\b(?:rm|rmdir|unlink)\b/.test(script)
      ? mandatory('Shell -c script could not be analyzed')
      : undefined
  }
  const result = checkRoot(root, cwd, env, depth + 1, changed)
  return result.behavior === 'passthrough' ? undefined : result
}

/**
 * The removal commands (rm, rmdir, unlink) that literal `sh -c` scripts in
 * the command run, as plain command text, for deny-rule matching.
 */
export function inlineShellRemovals(root: Node, depth = 0): string[] {
  const found: string[] = []
  if (depth >= MAX_SCRIPT_DEPTH) return found
  for (const { words } of commands(root)) {
    const { argv } = unwrap(words.map(child => argument(child.text, {})))
    if (!argv[0] || argv[0].unknown || !SHELLS.has(basename(argv[0].value)))
      continue
    const script = shellScript(argv)
    const inner =
      script && !script.unknown ? getParserModule()?.parse(script.value) : null
    if (!inner) continue
    for (const command of commands(inner)) {
      const removal = unwrap(command.words.map(child => argument(child.text, {})))
      if (removal.argv[0] && REMOVALS.has(basename(removal.argv[0].value)))
        found.push(removal.argv.map(arg => arg.value).join(' '))
    }
    found.push(...inlineShellRemovals(inner, depth + 1))
  }
  return found
}

export function checkDangerousRemoval(
  command: string,
  cwd: string,
  root: Node | null | typeof PARSE_ABORTED,
  env: Variables,
): PermissionResult {
  if (!root || typeof root === 'symbol') {
    const message = `Dangerous removal not analyzed: raw Bash parse unavailable (${command.length} characters)`
    logForDebugging(message)
    return { behavior: 'passthrough', message }
  }
  return checkRoot(root, cwd, env, 0, false)
}

function checkRoot(
  root: Node,
  cwd: string,
  env: Variables,
  depth: number,
  changed: boolean,
): PermissionResult {
  const assigns = assignsVariables(root)
  const vars = assigns ? {} : env
  const assigned = assigns ? assignedValues(root, env) : new Map<string, string[]>()
  const known: Known = name => [
    ...(assigned.get(name) ?? []),
    ...(SHELL_MAINTAINED.has(name) || env[name] === undefined ? [] : [env[name]]),
  ]
  for (const { words, scope } of commands(root)) {
    scope.changed ||= changed
    const here = scope.dir ?? cwd
    const lost = scope.changed && scope.dir === undefined
    const { argv } = unwrap(
      words.map(child => argument(child.text, vars)),
    )
    if (!argv[0] || argv[0].unknown) continue
    const name = basename(argv[0].value)
    if (['cd', 'pushd', 'popd'].includes(name)) {
      const [to, extra] = [...operands(argv.slice(1))]
      scope.dir =
        !lost && !extra && !to?.unknown && to?.value !== '-' &&
        (name === 'cd' || (name === 'pushd' && to))
          ? resolve(here, to?.value ?? homedir())
          : undefined
      scope.changed = true
    }
    const script = SHELLS.has(name) ? shellScript(argv) : undefined
    const scripts = !script
      ? []
      : script.unknown
        ? expansionValues(script.value, known)
        : [script.value]
    for (const text of scripts) {
      const result = checkScript(text, here, lost, vars, depth)
      if (result) return result
    }
    if (name === 'find') {
      const result = checkFind(argv, here, lost, known)
      if (result) return result
    }
    if (!REMOVALS.has(name)) continue
    for (const target of operands(argv.slice(1))) {
      // Like official: an empty operand is not a path that can be ruled out.
      if (target.value === '' && !target.unknown && name !== 'unlink')
        return mandatory('Removal target is empty')
      if (target.unknown) {
        const result = unresolvedTarget(target, here, lost, known)
        if (result) return result
        continue
      }
      if (lost && !isAbsolute(target.value)) continue
      if (protectedPath(target.value, here))
        return mandatory(
          `Protected removal target: ${resolve(here, target.value)} (${target.value})`,
        )
    }
  }
  return { behavior: 'passthrough', message: 'No dangerous removal detected' }
}

import { expect, test } from 'bun:test'
import { checkSemantics, parseForSecurityFromAst } from './ast.js'
import { parseCommandRawForRemoval } from './parser.js'

async function parse(command: string) {
  const root = await parseCommandRawForRemoval(command)
  if (root === null) throw new Error(`no parse: ${command}`)
  return parseForSecurityFromAst(command, root)
}

async function argvOf(command: string) {
  const result = await parse(command)
  return result.kind === 'simple' ? result.commands.map(c => c.argv) : result.kind
}

test('a value reassigned on a later loop pass is not resolved to its first-pass value', async () => {
  for (const command of [
    'x=echo; for i in 1 2; do $x f; x=touch; done',
    'x=echo; for i in 1 2; do "$x" f; x=touch; done',
    'x=echo; while true; do "$x" f; x=touch; done',
    'x=echo; for i in 1 2; do "$x" f; unset x; done',
    'x=/dev/null; for i in 1 2; do echo hi > "$x"; x=out; done',
  ]) {
    expect({ command, result: await argvOf(command) }).toEqual({ command, result: 'too-complex' })
  }
})

test('a value set in a branch that may not run is unknown afterwards', async () => {
  for (const command of [
    'x=echo; for i in 1; do x=touch; done; "$x" f',
    'x=echo; if true; then x=touch; fi; "$x" f',
    'x=echo; if false; then :; else x=touch; fi; "$x" f',
    'x=echo; false || x=touch; "$x" f',
    'x=echo; false && x=touch || true; "$x" f',
    'x=/dev/null; if true; then x=out; fi; echo hi > "$x"',
  ]) {
    expect({ command, result: await argvOf(command) }).toEqual({ command, result: 'too-complex' })
  }
  // Sequential assignments still resolve.
  expect(await argvOf('x=touch && "$x" f')).toEqual([['touch', 'f']])
})

test('builtins that store into a variable make its value unknown', async () => {
  for (const command of [
    'x=echo; read x <<< touch; "$x" f',
    'x=echo; read -r -a x; "$x" f',
    'x=echo; printf -v x touch; "$x" f',
    'x=echo; printf -vx touch; "$x" f',
    'x=echo; getopts t: x; "$x" f',
  ]) {
    expect({ command, result: await argvOf(command) }).toEqual({ command, result: 'too-complex' })
  }
})

test('commands that read a variable set earlier in the command are marked', async () => {
  for (const command of ['x=hi; echo "$x"', 'x=hi && echo $x', 'for i in a b; do echo "item $i"; done']) {
    const result = await parse(command)
    expect({ command, uses: result.kind === 'simple' && result.usesAssignedValue }).toEqual({ command, uses: true })
  }
  for (const command of ['echo hi', 'x=hi; echo done']) {
    const result = await parse(command)
    expect({ command, uses: result.kind === 'simple' && result.usesAssignedValue }).toEqual({ command, uses: false })
  }
})

test('too-complex reasons use the wording shown in the permission prompt', async () => {
  for (const [command, reason] of [
    ['echo $HOME', "A variable in this command can't be checked before it runs"],
    ['echo ${HOME}', "A variable in braces in this command can't be checked before it runs"],
    ['ls $(pwd)', "A nested command in this command can't be checked before it runs"],
    ['{ ls; }', "A group in braces or double parentheses in this command can't be checked before it runs"],
    ['case a in a) ls;; esac', "A case statement in this command can't be checked before it runs"],
    ['f(){ ls; }; f', "A function definition in this command can't be checked before it runs"],
    ['cat <(ls)', "A command used as a file in this command can't be checked before it runs"],
    ['a=(1 2); ls', "A list of values in this command can't be checked before it runs"],
  ] as const) {
    const result = await parse(command)
    expect({ command, reason: result.kind === 'too-complex' ? result.reason : result.kind }).toEqual({ command, reason })
  }
})

test('command and builtin are checked as the command they run', async () => {
  for (const [command, ok] of [
    ['builtin echo hi', true],
    ['command -v eval', true],
    ['command ls', true],
    ['builtin eval "ls"', false],
    ['command eval "ls"', false],
    ['command -p eval "ls"', false],
    ['command -- eval "ls"', false],
    ['command -x eval "ls"', false],
  ] as const) {
    const result = await parse(command)
    if (result.kind !== 'simple') throw new Error(`${command}: ${result.kind}`)
    expect({ command, ok: checkSemantics(result.commands).ok }).toEqual({ command, ok })
  }
})

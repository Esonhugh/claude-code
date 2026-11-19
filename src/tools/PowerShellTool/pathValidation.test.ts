import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolPermissionContext } from '../../Tool.js'
import type { ParsedPowerShellCommand } from '../../utils/powershell/parser.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { getCwdState, getOriginalCwd, setCwdState, setOriginalCwd } = await import('../../bootstrap/state.js')
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { checkPathConstraints } = await import('./pathValidation.js')

// Not realpath'd on purpose: on macOS tmpdir() sits under /var -> /private/var,
// so `Read(./...)` rules are written against a path that is itself a link.
const project = mkdtempSync(join(tmpdir(), 'ps-path-validation-project-'))
const outside = mkdtempSync(join(tmpdir(), 'ps-path-validation-outside-'))
writeFileSync(join(outside, 'secret'), 's')
writeFileSync(join(project, 'x.ts'), 'a')
// <project>/.env-link -> <outside>/secret
symlinkSync(join(outside, 'secret'), join(project, '.env-link'))

const savedCwd = getCwdState()
const savedOriginalCwd = getOriginalCwd()
setOriginalCwd(project)
setCwdState(project)
afterAll(() => {
  setOriginalCwd(savedOriginalCwd)
  setCwdState(savedCwd)
  rmSync(project, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

function context(
  mode: ToolPermissionContext['mode'],
  deny: string[],
): ToolPermissionContext {
  const initial = getDefaultAppState().toolPermissionContext
  return {
    ...initial,
    mode,
    alwaysDenyRules: { session: deny },
  } as ToolPermissionContext
}

function parsed(name: string, path: string): ParsedPowerShellCommand {
  const text = `${name} ${path}`
  return {
    valid: true,
    errors: [],
    statements: [
      {
        statementType: 'PipelineAst',
        commands: [
          {
            name,
            nameType: 'cmdlet',
            elementType: 'CommandAst',
            args: [path],
            text,
            elementTypes: ['StringConstant', 'StringConstant'],
          },
        ],
        redirections: [],
        text,
      },
    ],
    variables: [],
    hasStopParsing: false,
    originalCommand: text,
  } as ParsedPowerShellCommand
}

test('Read deny rules match a symlink by its own name when it points outside the project', () => {
  for (const deny of ['Read(./.env-link)', 'Read(**/.env-link)']) {
    for (const mode of ['default', 'bypassPermissions'] as const) {
      for (const name of ['Get-Content', 'gc', 'cat']) {
        const result = checkPathConstraints(
          { command: `${name} .env-link` },
          parsed(name, '.env-link'),
          context(mode, [deny]),
        )
        expect({ deny, mode, name, behavior: result.behavior }).toEqual({
          deny,
          mode,
          name,
          behavior: 'deny',
        })
      }
      // A backtick makes the path unvalidatable; the stripped guess is still
      // checked against deny rules.
      const guessed = checkPathConstraints(
        { command: 'Get-Content .env`-link' },
        parsed('Get-Content', '.env`-link'),
        context(mode, [deny]),
      )
      expect({ deny, mode, behavior: guessed.behavior }).toEqual({
        deny,
        mode,
        behavior: 'deny',
      })
    }
    const allowed = checkPathConstraints(
      { command: 'Get-Content x.ts' },
      parsed('Get-Content', 'x.ts'),
      context('default', [deny]),
    )
    expect(allowed.behavior).toBe('passthrough')
  }
})

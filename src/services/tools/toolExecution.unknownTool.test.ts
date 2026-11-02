import { expect, test } from 'bun:test'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import { unknownToolSuffix } from './toolExecution.js'

test('a built-in tool missing from the session says why like 2.1.311', () => {
  const context = getEmptyToolPermissionContext()
  expect(unknownToolSuffix('Bash', context)).toBe(
    '. Bash is not among the tools available here. Continue with the tools you have.',
  )
  const denied = {
    ...context,
    alwaysDenyRules: { ...context.alwaysDenyRules, userSettings: ['Bash'] },
  }
  expect(unknownToolSuffix('Bash', denied)).toBe(
    '. Bash is disabled for this session, in subagents as well as here.',
  )
})

test('a tool name the CLI does not know adds nothing', () => {
  expect(unknownToolSuffix('NoSuchThing', getEmptyToolPermissionContext())).toBe('')
})

test('Glob and Grep replaced by embedded search point at Bash like 2.1.311', () => {
  const context = getEmptyToolPermissionContext()
  expect(unknownToolSuffix('Glob', context, ['Bash'], true)).toBe(
    '. Glob is not available in this session — find files with `find` via the Bash tool instead.',
  )
  expect(unknownToolSuffix('Grep', context, ['Bash'], true)).toBe(
    '. Grep is not available in this session — search file contents with `grep` via the Bash tool instead.',
  )
  expect(unknownToolSuffix('Grep', context, [], true)).toBe('. Grep is disabled for this session.')
})

test('a built-in tool switched off for this build state says it is disabled', () => {
  expect(unknownToolSuffix('TaskCreate', getEmptyToolPermissionContext(), [], false)).toBe(
    '. TaskCreate is disabled for this session, in subagents as well as here.',
  )
})

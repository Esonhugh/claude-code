import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { getIsInteractive, setIsInteractive } from '../../bootstrap/state.js'
import { CollapsedReadSearchContent } from '../../components/messages/CollapsedReadSearchContent.js'
import { AppStoreContext, getDefaultAppState } from '../../state/AppState.js'
import { createStore } from '../../state/store.js'
import { collapseReadSearchGroups } from '../../utils/collapseReadSearch.js'
import { buildMessageLookups, createAssistantMessage, createUserMessage, normalizeMessages } from '../../utils/messages.js'
import { renderToString } from '../../utils/staticRender.js'
import { resetCodeModeGateForTesting } from './codeModeGate.js'
import { replTimeoutMessage } from './executor/host.js'
import { REPLTool } from './REPLTool.js'
import { ScriptSourceContext } from './ScriptSourceRow.js'
import { replErrorLine } from './UI.js'

const saved = {
  CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE,
  CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT,
}
const savedInteractive = getIsInteractive()
beforeAll(() => {
  process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  setIsInteractive(true)
  resetCodeModeGateForTesting()
})
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  setIsInteractive(savedInteractive)
  resetCodeModeGateForTesting()
})

const tools = [REPLTool] as never
const code = "const z = 1;\nthrow new TypeError('boom-21')"
const error = 'TypeError: boom-21\nThe script threw partway through: statements before the failing one ran. No tool call had completed.'

/** A failed script as REPLTool.call leaves it: its call, the virtual errored call, its result. */
function failedScript() {
  return [
    createAssistantMessage({ content: [{ type: 'tool_use', id: 'repl1', name: 'REPL', input: { code, description: 'failing script' } }] as never }),
    createAssistantMessage({ content: [{ type: 'tool_use', id: 'repl-error-1', name: 'REPL', input: {} }] as never, isVirtual: true }),
    createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: 'repl-error-1', content: 'TypeError: boom-21', is_error: true }] as never,
      toolUseResult: { error: 'TypeError: boom-21' },
      isVirtual: true,
    }),
    createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: 'repl1', content: `<repl-output>\n<error>${error}</error>\n</repl-output>` }] as never,
      toolUseResult: { code, stdout: '', stderr: '', error },
    }),
  ]
}

async function drawGroup(transcript: { all: boolean } | null) {
  const all = failedScript()
  const normalized = normalizeMessages(all)
  const group = collapseReadSearchGroups(normalized as never, tools).find(m => m.type === 'collapsed_read_search')
  expect(group).toBeDefined()
  const drawn = await renderToString(
    <AppStoreContext value={createStore(getDefaultAppState())}>
      <ScriptSourceContext value={transcript}>
        <CollapsedReadSearchContent
          message={group as never}
          inProgressToolUseIDs={new Set()}
          shouldAnimate={false}
          verbose={transcript !== null}
          tools={tools}
          lookups={buildMessageLookups(normalized, all)}
        />
      </ScriptSourceContext>
    </AppStoreContext>,
    110,
  )
  return drawn.replaceAll('\u00A0', ' ').split('\n').map(line => line.trimEnd()).filter(line => line !== '')
}

describe("a script's own failure shows under its call (official 2.1.329)", () => {
  test('a throw shows the first line of its error', () => {
    const error = 'TypeError: boom-21\nThe script threw partway through: statements before the failing one ran. No tool call had completed.'
    expect(replErrorLine(error)).toBe('TypeError: boom-21')
  })

  test('a timeout says how long the script had', () => {
    expect(replErrorLine(replTimeoutMessage(1500))).toBe('Timed out after 1.5s, not counting time spent in tool calls')
    expect(replErrorLine(replTimeoutMessage(120000))).toBe('Timed out after 2m, not counting time spent in tool calls')
  })

  test('a syntax error shows its headline only', () => {
    expect(replErrorLine('Syntax error, so nothing ran\nUnexpected token')).toBe('Syntax error, so nothing ran')
  })

  test('the prompt view shows the line alone, and the transcript shows it under one Code row', async () => {
    expect(await drawGroup(null)).toEqual(['  \u23bf  TypeError: boom-21'])
    const rows = await drawGroup({ all: false })
    expect(rows.filter(row => row.includes('Code('))).toHaveLength(1)
    expect(rows.slice(-2)).toEqual([expect.stringContaining('Code(failing script) \u00b7 2 lines'), '  \u23bf  TypeError: boom-21'])
  })

  test('the line of a failed script, and the reason of a refused dispatch, draw under the call', async () => {
    const draw = async (content: string) =>
      (await renderToString(<>{REPLTool.renderToolUseErrorMessage?.(content, { verbose: false } as never)}</>, 200)).trim()
    const reason = 'async REPL dispatch rejected: 8 evals already waiting or running \u2014 wait for their settles (Poll) before dispatching more'
    expect(await draw('TypeError: boom-21')).toBe('\u23bf \u00a0TypeError: boom-21')
    expect(await draw(`error: ${reason}`)).toBe(`\u23bf \u00a0${reason}`)
    // An error worded for the model keeps the standard row.
    expect(REPLTool.renderToolUseErrorMessage?.('<tool_use_error>InputValidationError: x</tool_use_error>', { verbose: false } as never)).toBeNull()
  })
})

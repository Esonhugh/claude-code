import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'

const configDir = mkdtempSync(join(tmpdir(), 'collapsed-no-result-test-'))
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = configDir
afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

const { AppStoreContext, getDefaultAppState } = await import('../../state/AppState.js')
const { createStore } = await import('../../state/store.js')
const { BashTool } = await import('../../tools/BashTool/BashTool.js')
const { collapseReadSearchGroups } = await import('../../utils/collapseReadSearch.js')
const {
  buildMessageLookups,
  createAssistantMessage,
  createUserMessage,
  normalizeMessages,
  TOOL_CALL_INTERRUPTED_MESSAGE,
} = await import('../../utils/messages.js')
const { renderToString } = await import('../../utils/staticRender.js')
const { CollapsedReadSearchContent } = await import('./CollapsedReadSearchContent.js')

const tools = [BashTool] as never

// Shell calls in one group; `interrupted` ones carry the stand-in result resume records.
async function draw(calls: { id: string; interrupted: boolean }[]) {
  const messages = calls.flatMap(({ id, interrupted }) => [
    createAssistantMessage({
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `make ${id}` } }] as never,
    }),
    createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: interrupted ? TOOL_CALL_INTERRUPTED_MESSAGE : 'done',
          is_error: interrupted,
        },
      ] as never,
      toolUseResult: interrupted ? TOOL_CALL_INTERRUPTED_MESSAGE : { stdout: 'done', stderr: '' },
      ...(interrupted && { toolDenialKind: 'interrupted' as const }),
    }),
  ])
  const normalized = normalizeMessages(messages)
  const [group] = collapseReadSearchGroups(normalized as never, tools)
  expect(group?.type).toBe('collapsed_read_search')
  const store = createStore(getDefaultAppState())
  return renderToString(
    <AppStoreContext value={store}>
      <CollapsedReadSearchContent
        message={group as never}
        inProgressToolUseIDs={new Set()}
        shouldAnimate={false}
        verbose={false}
        tools={tools}
        lookups={buildMessageLookups(normalized, messages)}
      />
    </AppStoreContext>,
  )
}

test('shell calls cut off by the session ending are not counted as run (official 2.1.329)', async () => {
  const drawn = await draw([
    { id: 'b1', interrupted: false },
    { id: 'b2', interrupted: true },
    { id: 'b3', interrupted: true },
  ])
  expect(drawn).toContain('Ran 1 shell command, no result recorded for 2 other calls')
  expect(drawn).not.toContain('Interrupted')
})

test('a group of only cut-off calls leads with the fold', async () => {
  const drawn = await draw([
    { id: 'b1', interrupted: true },
    { id: 'b2', interrupted: true },
  ])
  expect(drawn).toContain('No result recorded for 2 calls')
  expect(drawn).not.toContain('shell command')
})

test('one cut-off call is singular', async () => {
  const drawn = await draw([
    { id: 'b1', interrupted: false },
    { id: 'b2', interrupted: false },
    { id: 'b3', interrupted: true },
  ])
  expect(drawn).toContain('Ran 2 shell commands, no result recorded for 1 other call')
})

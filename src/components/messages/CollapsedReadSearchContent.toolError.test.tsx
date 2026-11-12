import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'

const configDir = mkdtempSync(join(tmpdir(), 'collapsed-tool-error-test-'))
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = configDir
afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

const { AppStoreContext, getDefaultAppState } = await import('../../state/AppState.js')
const { createStore } = await import('../../state/store.js')
const { FileReadTool } = await import('../../tools/FileReadTool/FileReadTool.js')
const { collapseReadSearchGroups } = await import('../../utils/collapseReadSearch.js')
const { buildMessageLookups, createAssistantMessage, createUserMessage, normalizeMessages } =
  await import('../../utils/messages.js')
const { renderToString } = await import('../../utils/staticRender.js')
const { CollapsedReadSearchContent } = await import('./CollapsedReadSearchContent.js')

const tools = [FileReadTool] as never
const reason = 'PreToolUse:Read hook error: [guard.sh]: reads are blocked'

async function draw(verbose: boolean) {
  const messages = [
    createAssistantMessage({
      content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/etc/hostname' } }] as never,
    }),
    createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: 'r1', content: reason, is_error: true }] as never,
      toolUseResult: `Error: ${reason}`,
    }),
  ]
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
        verbose={verbose}
        tools={tools}
        lookups={buildMessageLookups(normalized, messages)}
      />
    </AppStoreContext>,
  )
}

test('a collapsed read blocked by a hook shows why (official 2.1.318)', async () => {
  const drawn = await draw(false)
  expect(drawn).toContain('Read 1 file')
  expect(drawn).toContain(reason)
})

test('the expanded read blocked by a hook shows the error', async () => {
  expect(await draw(true)).toContain(`Error: ${reason}`)
})

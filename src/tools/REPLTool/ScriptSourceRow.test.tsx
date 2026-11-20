import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'

const configDir = mkdtempSync(join(tmpdir(), 'script-source-row-test-'))
const saved = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE,
  CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT,
}
process.env.CLAUDE_CONFIG_DIR = configDir

const { getIsInteractive, setIsInteractive } = await import('../../bootstrap/state.js')
const { AppStoreContext, getDefaultAppState } = await import('../../state/AppState.js')
const { createStore } = await import('../../state/store.js')
const { GrepTool } = await import('../GrepTool/GrepTool.js')
const { REPLTool } = await import('./REPLTool.js')
const { resetCodeModeGateForTesting } = await import('./codeModeGate.js')
const { escapeScriptText, scriptCode, scriptSourceText, ScriptSourceContext } = await import('./ScriptSourceRow.js')
const { AssistantToolUseMessage } = await import('../../components/messages/AssistantToolUseMessage.js')
const { CollapsedReadSearchContent } = await import('../../components/messages/CollapsedReadSearchContent.js')
const { collapseReadSearchGroups } = await import('../../utils/collapseReadSearch.js')
const { buildMessageLookups, createAssistantMessage, createUserMessage, normalizeMessages } =
  await import('../../utils/messages.js')
const { renderToString } = await import('../../utils/staticRender.js')

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
  rmSync(configDir, { recursive: true, force: true })
})

const code = [
  "const hits = await Grep({pattern: 'TODO', path: 'src', output_mode: 'count'})",
  "const files = await Glob({pattern: 'src/**/*.ts'})",
  'hits.content + `\\n(${files.numFiles} files scanned)`',
].join('\n')
const tools = [REPLTool, GrepTool] as never

function messages() {
  return [
    createAssistantMessage({
      content: [{ type: 'tool_use', id: 'repl1', name: 'REPL', input: { code, description: 'Count TODOs under src' } }] as never,
    }),
    createAssistantMessage({
      content: [{ type: 'tool_use', id: 'grep1', name: 'Grep', input: { pattern: 'TODO', path: 'src', output_mode: 'count' } }] as never,
      isVirtual: true,
    }),
    createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: 'grep1', content: 'src/app.ts:2' }] as never,
      toolUseResult: { mode: 'count', numFiles: 1, filenames: [], content: 'src/app.ts:2', numMatches: 2 },
      isVirtual: true,
    }),
    createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: 'repl1', content: 'src/app.ts:2\n(3 files scanned)' }] as never,
      toolUseResult: { code, stdout: '', stderr: '', result: 'src/app.ts:2\n(3 files scanned)' },
    }),
  ]
}

function drawGroup(transcript: { all: boolean } | null) {
  const all = messages()
  const normalized = normalizeMessages(all)
  const group = collapseReadSearchGroups(normalized as never, tools).find(m => m.type === 'collapsed_read_search')
  expect(group).toBeDefined()
  return renderToString(
    <AppStoreContext value={createStore(getDefaultAppState())}>
      <ScriptSourceContext value={transcript}>
        <CollapsedReadSearchContent
          message={group as never}
          inProgressToolUseIDs={new Set()}
          shouldAnimate={false}
          verbose
          tools={tools}
          lookups={buildMessageLookups(normalized, all)}
        />
      </ScriptSourceContext>
    </AppStoreContext>,
    110,
  )
}

describe('the script source in the transcript (official 2.1.325 chunk-eh1rf8gd.js ScriptSourceRow)', () => {
  test('collapsed: the summary and line count, and not the script result', async () => {
    const drawn = await drawGroup({ all: false })
    expect(drawn).toContain('Code(Count TODOs under src) · 3 lines (ctrl+e to show)')
    expect(drawn).not.toContain('files scanned)')
    expect(drawn).toContain('Search(pattern: "TODO", path: "src")')
  })

  test('ctrl+e: the script under ⎿, without line numbers', async () => {
    // MessageResponse pads ⎿ with a no-break space.
    const lines = (await drawGroup({ all: true })).replaceAll('\u00A0', ' ').split('\n').map(line => line.trimEnd())
    const header = lines.findIndex(line => line.includes('Code(Count TODOs under src)'))
    expect(lines[header]).toEndWith('Code(Count TODOs under src)')
    expect(lines.slice(header + 1, header + 4)).toEqual([
      "  ⎿  const hits = await Grep({pattern: 'TODO', path: 'src', output_mode: 'count'})",
      "     const files = await Glob({pattern: 'src/**/*.ts'})",
      '     hits.content + `\\n(${files.numFiles} files scanned)`',
    ])
  })

  test('outside the transcript there is no row', async () => {
    expect(await drawGroup(null)).not.toContain('Code')
  })

  test('a lone REPL call in the transcript shows the same row', async () => {
    const all = messages()
    const normalized = normalizeMessages(all)
    const draw = (isTranscriptMode: boolean) =>
      renderToString(
        <AppStoreContext value={createStore(getDefaultAppState())}>
          <ScriptSourceContext value={isTranscriptMode ? { all: false } : null}>
            <AssistantToolUseMessage
              param={all[0]!.message.content[0] as never}
              addMargin={false}
              tools={tools}
              commands={[]}
              verbose
              inProgressToolUseIDs={new Set()}
              progressMessagesForMessage={[]}
              shouldAnimate={false}
              shouldShowDot
              lookups={buildMessageLookups(normalized, all)}
              isTranscriptMode={isTranscriptMode}
            />
          </ScriptSourceContext>
        </AppStoreContext>,
        110,
      )
    expect((await draw(true)).trim()).toEndWith('Code(Count TODOs under src) · 3 lines (ctrl+e to show)')
    expect((await draw(false)).trim()).toBe('')
  })
})

test('search indexes visible REPL source in standalone and collapsed rows', async () => {
  const { renderableSearchText } = await import('../../utils/transcriptSearch.js')
  const normalized = normalizeMessages(messages())
  const grouped = collapseReadSearchGroups(normalized as never, tools)
  const rows = [normalized.find(m => m.type === 'assistant')!, grouped.find(m => m.type === 'collapsed_read_search')!]
  for (const row of rows) {
    expect(renderableSearchText(row)).not.toContain('const hits')
    expect(renderableSearchText(row, true)).toContain('const hits')
    expect(renderableSearchText(row)).not.toContain('const hits')
  }
})

describe('script text escaping (official U)', () => {
  test('line separators break the line and are shown; trailing blank lines go', () => {
    expect(scriptSourceText('a\r\nb\rc\u2028d\n\n  ')).toBe('a\nb\nc\\u{2028}\nd')
  })

  test('control, invisible and unusual space characters are escaped', () => {
    expect(escapeScriptText('a\u00A0b\u200Bc\u001Bd\u0007\tx')).toBe('a\\u{A0}b\\u{200B}c\u241Bd\u2407\tx')
    expect(escapeScriptText('\u{E0041}\uE000')).toBe('\\u{E0041}\\u{E000}')
  })

  test('emoji sequences are kept', () => {
    expect(escapeScriptText('👩‍💻 ❤️ 🇯🇵')).toBe('👩‍💻 ❤️ 🇯🇵')
  })

  test('a run of joiners keeps one variation selector and joiner', () => {
    expect(escapeScriptText('👩\u200D\u200D\u200D💻')).toBe('👩\u200D\\u{200D}\\u{200D}💻')
  })

  test('only a non-blank string script counts', () => {
    expect(scriptCode({ code: '1' })).toBe('1')
    expect(scriptCode({ code: '  \n' })).toBeUndefined()
    expect(scriptCode({ code: 1 })).toBeUndefined()
    expect(scriptCode(null)).toBeUndefined()
  })
})

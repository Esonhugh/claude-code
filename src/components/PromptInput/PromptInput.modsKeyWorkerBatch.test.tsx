import { afterEach, beforeEach, expect, test } from 'bun:test'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import React, { useRef, useState } from 'react'
import { Readable, Writable } from 'node:stream'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ThemeProvider, render } from '../../ink.js'
import { AppStoreContext, getDefaultAppState } from '../../state/AppState.js'
import { createStore } from '../../state/store.js'
import instances from '../../ink/instances.js'
import type { DOMElement, DOMNode } from '../../ink/dom.js'
import { createModPromptEditQueue, runModPromptEdit, type PromptEditResult } from '../../services/mods/promptEdit.js'
import { createModsRuntime } from '../../services/mods/runtime.js'
import { fillPromptBox } from '../../services/mods/promptAdapter.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import type { PastedContent } from '../../utils/config.js'
import type { TextInputEdit, PromptInputMode, PromptInputHandle, VimMode } from '../../types/textInputTypes.js'
import PromptInput from './PromptInput.js'

const testEnvKeys = [
  'HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
]
let testConfigRoot: string | undefined
let savedTestEnvironment: (string | undefined)[] = []
beforeEach(async () => {
  savedTestEnvironment = testEnvKeys.map(key => process.env[key])
  testConfigRoot = await realpath(await mkdtemp(join(tmpdir(), 'mods-test-config-')))
  process.env.HOME = testConfigRoot
  process.env.CLAUDE_CONFIG_DIR = join(testConfigRoot, 'config')
  process.env.XDG_CONFIG_HOME = join(testConfigRoot, 'xdg-config')
  process.env.XDG_CACHE_HOME = join(testConfigRoot, 'xdg-cache')
  process.env.XDG_STATE_HOME = join(testConfigRoot, 'xdg-state')
  process.env.ANTHROPIC_API_KEY = 'sk-test-placeholder'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  resetSettingsCache()
})

afterEach(async () => {
  try {
    if (testConfigRoot !== undefined) await rm(testConfigRoot, { recursive: true, force: true })
  } finally {
    testConfigRoot = undefined
    resetSettingsCache()
    testEnvKeys.forEach((key, i) => {
      if (savedTestEnvironment[i] === undefined) delete process.env[key]
      else process.env[key] = savedTestEnvironment[i]
    })
  }
})

class Input extends Readable {
  isTTY = true
  _read() {}
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Output extends Writable {
  columns = 80
  rows = 24
  isTTY = true
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void) { done() }
}
async function settle() { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)) }
async function waitFor(done: () => boolean, evidence?: () => unknown) {
  const deadline = Date.now() + 1000
  while (!done() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
  const ready = done()
  if (!ready && evidence) console.error('Mods key batch failure:', JSON.stringify(evidence()))
  expect(ready).toBe(true)
}

// Official 2.1.292 hr, chunk-5zgdeqqz.js; SHA256 bdb01e259aeda18e7e81cca5a5ce96d14eb8c6353de6f90a7e1015bda2a3d3c7.
// The shipped helper merges semantic edits while omitting the key for a batch.
const officialMerge = Function("return function hr(e){let[n]=e,r=n?.before??{text:\"\",cursor:0},s=e.at(-1)?.after??r,g=e.length===1&&n?.key!==void 0;return{before:r,after:s,...g&&{key:n.key}}}")() as (edits: TextInputEdit[]) => TextInputEdit

async function mount(vim: boolean, relay: (edit: TextInputEdit) => void) {
  const previousMode = getGlobalConfig().editorMode
  saveGlobalConfig(config => ({...config, editorMode: vim ? 'vim' : 'normal'}))
  const stdin = new Input(), stdout = new Output(), edits: TextInputEdit[] = []
  const state = getDefaultAppState()
  let editor: React.RefObject<PromptInputHandle | null>
  let currentMode: PromptInputMode = 'prompt', currentVim: VimMode = 'INSERT'
  function Probe() {
    const [input, setInput] = useState('old'), [mode, setMode] = useState<PromptInputMode>('prompt')
    const [vimMode, setVimMode] = useState<VimMode>('INSERT')
    const [pastedContents, setPastedContents] = useState<Record<number, PastedContent>>({})
    const [helpOpen, setHelpOpen] = useState(false)
    editor = useRef(null)
    return <PromptInput debug={false} ideSelection={undefined}
      toolPermissionContext={state.toolPermissionContext} setToolPermissionContext={() => {}}
      apiKeyStatus="valid" commands={[]} agents={[]} enableLocalIOCompletions={false}
      isLoading={false} isAssistantResponding={false} verbose={false} messages={[]}
      onAutoUpdaterResult={() => {}} autoUpdaterResult={null} input={input}
      onInputChange={setInput} onPromptEdit={edit => {edits.push(structuredClone(edit)); relay(edit)}}
      mode={mode} onModeChange={next => {currentMode = next; setMode(next)}} stashedPrompt={undefined} setStashedPrompt={() => {}}
      submitCount={0} onShowMessageSelector={() => {}} mcpClients={[]}
      pastedContents={pastedContents} setPastedContents={setPastedContents} vimMode={vimMode}
      setVimMode={next => {currentVim = next; setVimMode(next)}}
      showBashesDialog={false} setShowBashesDialog={() => {}} onExit={() => {}}
      getToolUseContext={() => {throw new Error('This fixture never executes a query')}}
      onSubmit={async () => {throw new Error('This fixture never submits')}}
      isSearchingHistory={false} setIsSearchingHistory={() => {}} helpOpen={helpOpen} setHelpOpen={setHelpOpen}
      insertTextRef={editor} />
  }
  const instance = await render(<AppStoreContext value={createStore(state)}><ThemeProvider initialState="dark"><Probe /></ThemeProvider></AppStoreContext>, {
    stdin: stdin as never, stdout: stdout as never, patchConsole: false, exitOnCtrlC: false,
  })
  await settle()
  function painted(color: string) {
    const root = (instances.get(stdout as never) as unknown as {rootNode: DOMElement}).rootNode
    const found: string[] = []
    const text = (node: DOMNode): string => node.nodeName === '#text' ? node.nodeValue : node.childNodes.map(text).join('')
    const walk = (node: DOMNode) => {
      if (node.nodeName === '#text') return
      if (node.textStyles?.color === color) found.push(text(node))
      node.childNodes.forEach(walk)
    }
    walk(root)
    return found.join('')
  }
  return {stdin, edits, painted, get editor() {return editor!.current!}, get mode() {return currentMode}, get vim() {return currentVim},
    dispose() {instance.unmount(); instance.cleanup(); saveGlobalConfig(config => ({...config, editorMode: previousMode}))}}
}

const burst = '\x1b[97u\x1b[98u'
test.each([false, true])('actual Worker fill and same-read semantic keys merge one author edit and paint its rewrite: vim=%s', async vim => {
  await exercise(vim, false)
})
test.each([false, true])('actual Worker fill, in-flight edit and same-read semantic keys retain pending merge and final paint: vim=%s', async vim => {
  await exercise(vim, true)
})

async function exercise(vim: boolean, alreadyInFlight: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mods-key-worker-batch-'))), entry = join(root, 'register.ts')
  await writeFile(entry, `let releaseEdit;export function register(on){on('tool.call',async($,e)=>{if(e.release){releaseEdit();return {result:'released'}}if(e.inspect)return {result:{events:await $.store.get('events'),answers:await $.store.get('answers')}};const fill=await $.prompt.fill(e.fill);return {result:{fill,box:await $.prompt.read()}}});on('prompt.edit',async($,e,next)=>{const events=await $.store.get('events')??[];await $.store.set('events',[...events,e]);if(e.inputText==='x')await new Promise(resolve=>{releaseEdit=resolve;$.ui.status('edit-held')});const r=await next(${alreadyInFlight ? 'e' : '{...e,inputText:e.inputText.toUpperCase()}'});const answers=await $.store.get('answers')??[];await $.store.set('answers',[...answers,r]);return {...r,decorations:[{start:0,end:r.text.length,color:'green',bold:true}]}})}`)
  const raises: TextInputEdit[] = [], replies: PromptEditResult[] = [], diagnostics: unknown[] = [], reports: string[] = []
  let editHeld = false
  const h = await mount(vim, edit => queue.record(edit))
  const composer = {read: () => ({text: h.editor.text, cursor: h.editor.cursorOffset}),
    set: (text: string, cursor: number) => h.editor.setInputWithCursor(text, cursor),
    paint: (runs: Parameters<PromptInputHandle['paintDecorations']>[0], text: string) => h.editor.paintDecorations(runs, text)}
  const runtime = createModsRuntime({
    // This verifies Worker/UI ordering; the default 50ms budget is covered by promptEditBudget.test.ts.
    promptEditBudgetMs: 1000, onDiagnostic: event => diagnostics.push(event), services: {
      uiStatus: (_plugin, text) => { if (text === 'edit-held') editHeld = true }, prompt: () => ({read: composer.read, fill: input => fillPromptBox(composer, input)})}})
  const queue = createModPromptEditQueue({read: composer.read, commit: box => composer.set(box.text, box.cursor), paint: composer.paint,
    carry: edit => h.editor.carryDecorations(edit), report: reason => reports.push(reason), raise: async (edit, signal) => {
      raises.push(structuredClone(edit))
      const snapshot = runtime.capture()
      try {const answer = await runModPromptEdit(snapshot, edit, signal); replies.push(structuredClone(answer)); return answer}
      finally {snapshot.release()}
    }})
  try {
    await runtime.bind({cwd: root, surface: 'terminal', isInteractive: true, sessionId: 'key-worker-batch'})
    await runtime.reconcile([{name: 'key-worker-batch', storageId: `key-worker-batch@${vim}-${alreadyInFlight}`, pluginRoot: root, entrypoints: [entry]}])
    const filled = await runtime.dispatch('tool.call', {tool: 'Bash', tool_use_id: 'fill', fill: {text: 'ABC', mode: 'replace', decorations: [{start: 0, end: 3, color: 'red'}]}}, async () => ({result: 'core'}))
    expect(filled).toEqual({result: {fill: {isFilled: true, text: 'ABC', cursor: 3}, box: {text: 'ABC', cursor: 3}}})
    await settle()
    expect(h.painted('#e5484d')).toBe('ABC')
    expect(h.edits).toEqual([])
    if (alreadyInFlight) {
      h.stdin.push('\x1b[120u')
      await waitFor(() => raises.length === 1 && editHeld)
      expect(replies).toEqual([])
    }
    h.stdin.push(burst)
    if (alreadyInFlight) {
      await waitFor(() => h.edits.length === 3)
      expect(replies).toEqual([])
      expect(await runtime.dispatch('tool.call', {tool: 'Bash', tool_use_id: 'release', release: true}, async () => ({result: 'core'})))
        .toEqual({result: 'released'})
    }
    const expected = alreadyInFlight ? 'ABCxab' : 'ABCAB'
    await waitFor(() => h.painted('#46a758') === expected, () => ({
      vim, alreadyInFlight, expected, raises, replies, diagnostics, reports, edits: h.edits,
      box: composer.read(), green: h.painted('#46a758'), red: h.painted('#e5484d'), mode: h.mode, vimMode: h.vim,
    }))
    await settle()
    const typed = alreadyInFlight ? 'ABCx' : 'ABC'
    const cursor = typed.length
    const batchEdits: TextInputEdit[] = [{before: {text: typed, cursor}, after: {text: typed + 'a', cursor: cursor + 1}, key: {key: 'a'}},
      {before: {text: typed + 'a', cursor: cursor + 1}, after: {text: typed + 'ab', cursor: cursor + 2}, key: {key: 'b'}}]
    expect(h.edits.slice(alreadyInFlight ? 1 : 0)).toEqual(batchEdits)
    expect(raises).toEqual(alreadyInFlight ? [h.edits[0]!, officialMerge(batchEdits)] : [officialMerge(batchEdits)])
    const receipt = await runtime.dispatch('tool.call', {tool: 'Bash', tool_use_id: 'inspect', inspect: true}, async () => ({result: 'core'}))
    const inputs = alreadyInFlight ? [{text: 'ABC', cursor: 3, start: 3, end: 3, inputText: 'x', key: {key: 'x'}, origin: {kind: 'composer'}},
      {text: 'ABCx', cursor: 4, start: 4, end: 4, inputText: 'ab', origin: {kind: 'composer'}}] :
      [{text: 'ABC', cursor: 3, start: 3, end: 3, inputText: 'ab', origin: {kind: 'composer'}}]
    const answers = alreadyInFlight ? [{text: 'ABCx', cursor: 4}, {text: 'ABCxab', cursor: 6}] : [{text: 'ABCAB', cursor: 5}]
    expect({receipt, replies, diagnostics, reports}).toEqual({receipt: {result: {events: inputs, answers}}, replies: answers.map(box => ({...box, decorations: [{start: 0, end: box.text.length, color: 'green', bold: true}]})), diagnostics: [], reports: []})
    expect(replies).toEqual(answers.map(box => ({...box, decorations: [{start: 0, end: box.text.length, color: 'green', bold: true}]})))
    expect({text: h.editor.text, cursor: h.editor.cursorOffset, mode: h.mode, vim: h.vim}).toEqual({text: expected, cursor: expected.length, mode: 'prompt', vim: 'INSERT'})
    expect(h.painted('#46a758')).toBe(expected)
    expect(h.painted('#e5484d')).toBe('')
    expect({diagnostics, reports}).toEqual({diagnostics: [], reports: []})
  } finally {queue.dispose(); h.dispose(); await runtime.dispose(); await rm(root, {recursive: true, force: true})}
}

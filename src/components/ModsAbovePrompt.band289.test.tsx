import { expect, test } from 'bun:test'
import React, { useEffect, useRef } from 'react'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { Box, Text, ThemeProvider, createRoot, useStdin } from '../ink.js'
import instances from '../ink/instances.js'
import type { DOMElement } from '../ink/dom.js'
import type { Frame } from '../ink/frame.js'
import { charInCellAt } from '../ink/screen.js'
import { ClockContext, createClock } from '../ink/components/ClockContext.js'
import { createModsRuntime, type ModDiagnostic } from '../services/mods/runtime.js'
import { KeybindingProvider } from '../keybindings/KeybindingContext.js'
import { DEFAULT_BINDINGS } from '../keybindings/defaultBindings.js'
import { parseBindings } from '../keybindings/parser.js'
import type { ParsedKeystroke } from '../keybindings/types.js'
import { KEYBINDING_ACTIONS } from '../keybindings/schema.js'
import { ModsAbovePrompt } from './ModsAbovePrompt.js'
import { FullscreenLayout } from './FullscreenLayout.js'

class Output extends Writable {
  columns = 120
  rows = 40
  isTTY = true
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void) { done() }
}
class Input extends Readable {
  isTTY = true
  _read() {}
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
type Ink = { rootNode: DOMElement; frontFrame?: Frame; setAltScreenActive(active: boolean, mouseTracking?: boolean): void }
const settleForClick = new WeakMap<Ink, () => void>()
function EnableInput() {
  const { setRawMode } = useStdin()
  useEffect(() => { setRawMode(true); return () => setRawMode(false) }, [setRawMode])
  return null
}
function Bindings({ custom, children }: { custom?: boolean; children: React.ReactNode }) {
  const pending = useRef<ParsedKeystroke[] | null>(null)
  const registry = useRef(new Map())
  const active = useRef(new Set(['Chat']))
  return <KeybindingProvider bindings={parseBindings([...DEFAULT_BINDINGS, ...(custom ? [{ context: 'Chat', bindings: { 'ctrl+g': 'abovePrompt:toggle' } }] : [])])}
    pendingChordRef={pending} pendingChord={null} setPendingChord={value => { pending.current = value }}
    activeContexts={active.current} registerActiveContext={value => { active.current.add(value) }}
    unregisterActiveContext={value => { active.current.delete(value) }} handlerRegistryRef={registry}>
    {children}
  </KeybindingProvider>
}
function lines(ink: Ink): string[] {
  const screen = ink.frontFrame?.screen
  return screen ? Array.from({ length: screen.height }, (_, y) => Array.from({ length: screen.width }, (_, x) => charInCellAt(screen, x, y) ?? ' ').join('').trimEnd()) : []
}
async function until(predicate: () => boolean, phase: string, ink: Ink) {
  const end = Date.now() + 1500
  while (!predicate() && Date.now() < end) await new Promise(resolve => setImmediate(resolve))
  if (!predicate()) console.error('band289 barrier', phase, JSON.stringify(lines(ink)))
  expect(predicate()).toBe(true)
}
function click(ink: Ink, stdin: Input, text: string) {
  // Official 2.1.292 drops clicks during the first 300ms after a Button mounts.
  // Advance the injected clock so the test exercises an intentional click.
  settleForClick.get(ink)!()
  const frame = lines(ink)
  const row = frame.findIndex(line => line.includes(text))
  expect(row).toBeGreaterThanOrEqual(0)
  const column = frame[row]!.indexOf(text)
  stdin.push(`\x1b[<0;${column + 1};${row + 1}M\x1b[<0;${column + 1};${row + 1}m`)
}
async function fixture(run: (host: {
 runtime: ReturnType<typeof createModsRuntime>; stdout: Output; stdin: Input; ink: Ink
 app: Awaited<ReturnType<typeof createRoot>>; render(working?: boolean, custom?: boolean, shown?: boolean): void
 firstClientPaint: string[]; inputs: Record<string, unknown>[]; focus: boolean[]; errors: unknown[]; diagnostics: ModDiagnostic[]
}) => Promise<void>, layout?: { dock?: boolean; tall?: boolean }, initiallyCollapsed = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mods-band289-')))
  const entry = join(root, 'register.ts')
  await writeFile(entry, `export function register(on) {
    on('ui.render',{component:'AbovePrompt'},($,e)=>{const {Box,Text,Client}=$.ui.resolve(e);const c=e.props.bodyColumns;
      return Box({flexDirection:'column',children:[Text({children:'BAND:'+c}),Text({children:'L'+'x'.repeat(Math.max(0,c-2))+'R'}),
        Client({key:'counter',module:'./counter.ts',width:24,height:1,props:{working:e.props.isWorking}}),
        ...(e.props.view.agentId==='tall'?Array.from({length:20},(_,i)=>Text({children:'MORE:'+i})):[])]})});
  }`)
  await writeFile(join(root, 'counter.ts'), `export default function Counter(props,s) {
    if(s.state===undefined)s.setState(0);
    return s.elements.Button({key:'increment',label:(props.working?'working':'idle')+':'+s.state+'@'+s.columns+'x'+s.rows,onPress:()=>s.setState(s.state+1)});
  }`)
  const diagnostics: ModDiagnostic[] = [], inputs: Record<string, unknown>[] = [], focus: boolean[] = [], errors: unknown[] = []
  const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event) })
  runtime.registerHostHook({ plugin: 'band-observer', tier: 'prepend', registration: { id: 1, event: 'ui.render', hasCatch: false },
    invoke(input, next) { if (input.component === 'AbovePrompt') inputs.push(input); return next(input) },
  })
  const stdout = new Output(), stdin = new Input()
  const app = await createRoot({ stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
  const ink = instances.get(stdout as never) as unknown as Ink
  const realClock = createClock(16)
  let clickOffset = 0
  const clock = { ...realClock, now: () => realClock.now() + clickOffset }
  settleForClick.set(ink, () => { clickOffset += 300 })
  try {
    await runtime.bind({ cwd: root, sessionId: 'band289', surface: 'terminal', isInteractive: true })
    await runtime.reconcile([{ name: 'band-author', storageId: 'band-author@inline', pluginRoot: root, entrypoints: [entry] }])
    ink.setAltScreenActive(true, true)
    const draw = (working = false, custom = false, shown = true) => {
      const band = shown && <ModsAbovePrompt ui={runtime.ui} hasSurvey={false} isWorking={working} view={layout?.tall ? { agentId: 'tall' } : {}} canFocus
        onFocusChange={value => focus.push(value)} onError={error => errors.push(error)} />
      app.render(<ClockContext.Provider value={clock}><ThemeProvider><Bindings custom={custom}><EnableInput /><Box width="100%" height={layout ? stdout.rows : undefined} flexDirection="column">
        {layout ? <FullscreenLayout scrollable={<Text>TRANSCRIPT</Text>} abovePrompt={band}
          dockPane={layout.dock ? <Text>DOCK</Text> : undefined} dockWidth={30}
          bottom={<Box height={5} flexDirection="column" flexShrink={0}><Text>COMPOSER</Text></Box>} /> : band}
      </Box></Bindings></ThemeProvider></ClockContext.Provider>)
    }
    draw()
    await until(() => lines(ink).some(line => line.includes(initiallyCollapsed ? '▸ plugin panel hidden' : 'idle:0')), 'initial actual Worker Client paint', ink)
    const firstClientPaint = lines(ink)
    await run({ runtime, stdout, stdin, ink, app, render: draw, firstClientPaint, inputs, focus, errors, diagnostics })
    expect(errors).toEqual([])
    expect(diagnostics.filter(event => ['ui.render', 'ui.close', 'client'].includes(event.stage))).toEqual([])
  } finally { settleForClick.delete(ink); app.unmount(); await new Promise(resolve => setImmediate(resolve)); await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
}

test('actual Worker AbovePrompt reserves five columns and paints the full ruler without Pane chrome', async () => fixture(async ({ ink, inputs }) => {
  expect(inputs.at(-1)?.props).toMatchObject({ bodyColumns: 115 })
  const screen = lines(ink)
  expect(screen.some(line => /[╭╮╰╯✕]/u.test(line))).toBe(false)
  expect(screen[0]?.slice(116, 119)).toBe('[-]')
  expect(screen[1]?.slice(0, 115)).toBe('L'+'x'.repeat(113)+'R')
}))

test('actual Worker terminal Client reports its own laid-out region rather than the global viewport', async () => fixture(async ({ firstClientPaint }) => {
  expect(firstClientPaint.some(line => line.includes('idle:0@120x40'))).toBe(false)
  expect(firstClientPaint.some(line => /idle:0@(0x0|24x1)/.test(line))).toBe(true)
}))

test('actual stdin collapse and expand retain the terminal Client state while fresh drawings stay hidden', async () => fixture(async ({ ink, stdin, render, focus, inputs }) => {
  click(ink, stdin, 'idle:0')
  await until(() => lines(ink).some(line => line.includes('idle:1')), 'actual Worker Client press', ink)
  expect(focus.at(-1)).toBe(true)
  click(ink, stdin, '[-]')
  const hint = '▸ plugin panel hidden · ctrl+x ctrl+a or click to show'
  await until(() => lines(ink).some(line => line.includes(hint)), 'collapse hint', ink)
  expect(lines(ink).some(line => /idle:1|working:1|✕|\[-\]/.test(line))).toBe(false)
  expect(focus.at(-1)).toBe(false)
  render(true)
  await until(() => (inputs.at(-1)?.props as Record<string, unknown>)?.isWorking === true, 'hidden fresh drawing request', ink)
  expect(lines(ink).some(line => line.includes(hint))).toBe(true)
  click(ink, stdin, hint)
  await until(() => lines(ink).some(line => line.includes('working:1')), 'expand preserved actual Client state', ink)
  expect(lines(ink)[0]?.slice(116, 119)).toBe('[-]')
}))

for (const custom of [false, true]) test(`actual stdin ${custom ? 'rebound shortcut' : 'default chord'} toggles AbovePrompt and is a public action`, async () => fixture(async ({ ink, stdin, render }) => {
  expect(KEYBINDING_ACTIONS).toContain('abovePrompt:toggle')
  render(false, custom)
  await new Promise(resolve => setImmediate(resolve))
  stdin.push(custom ? '\x07' : '\x18\x01')
  await until(() => lines(ink).some(line => line.startsWith('▸ plugin panel hidden')), 'keyboard collapse', ink)
  expect(lines(ink).some(line => line.includes('idle:0'))).toBe(false)
  stdin.push(custom ? '\x07' : '\x18\x01')
  await until(() => lines(ink).some(line => line.includes('idle:0')), 'keyboard expand', ink)
}))

for (const dock of [false, true]) test(`real fullscreen host ${dock ? 'with dock' : 'without dock'} gives AbovePrompt the official width and remaining bottom budget`, async () => {
  const previous = process.env.CLAUDE_CODE_NO_FLICKER
  process.env.CLAUDE_CODE_NO_FLICKER = '1'
  try {
    await fixture(async ({ ink, inputs }) => {
      const bodyColumns = dock ? 85 : 115
      await until(() => (inputs.at(-1)?.props as Record<string, unknown>)?.maxRows === 15, 'measured fullscreen band budget', ink)
      expect(inputs.at(-1)?.props).toMatchObject({ bodyColumns, maxRows: 15, scroll: { bodyRows: 14 } })
      const screen = lines(ink)
      const row = screen.findIndex(line => line.includes('BAND:'+bodyColumns))
      expect(row).toBeGreaterThanOrEqual(0)
      expect(screen[row]?.slice(bodyColumns + 1, bodyColumns + 4)).toBe('[-]')
      expect(screen[row + 1]?.slice(0, bodyColumns)).toBe('L'+'x'.repeat(bodyColumns-2)+'R')
      expect(screen.some(line => /[╭╮╰╯✕]/u.test(line))).toBe(false)
      expect(screen.some(line => line.includes('COMPOSER'))).toBe(true)
    }, { dock })
  } finally { if (previous === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER; else process.env.CLAUDE_CODE_NO_FLICKER = previous }
})

test('real fullscreen host clips a tall band with the official more cue and updates its budget on resize', async () => {
  const previous = process.env.CLAUDE_CODE_NO_FLICKER
  process.env.CLAUDE_CODE_NO_FLICKER = '1'
  try {
    await fixture(async ({ ink, inputs, stdout, render }) => {
      await until(() => lines(ink).some(line => line.includes('↓ 9 more')) &&
        (inputs.at(-1)?.props as Record<string, unknown>)?.maxRows === 15, 'settled fourteen content rows plus cue', ink)
      expect(inputs.at(-1)?.props).toMatchObject({ maxRows: 15, scroll: { bodyRows: 14 } })
      expect(lines(ink).some(line => line.includes('MORE:19'))).toBe(false)
      stdout.rows = 20
      stdout.emit('resize')
      render()
      await until(() => lines(ink).some(line => line.includes('↓ 19 more')) &&
        (inputs.at(-1)?.props as Record<string, unknown>)?.maxRows === 5, 'settled resized four content rows plus cue', ink)
      expect(inputs.at(-1)?.props).toMatchObject({ maxRows: 5, scroll: { bodyRows: 4 } })
      expect(lines(ink).some(line => line.includes('COMPOSER'))).toBe(true)
    }, { tall: true })
  } finally { if (previous === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER; else process.env.CLAUDE_CODE_NO_FLICKER = previous }
})


test('actual stdin shared collapse survives AbovePrompt unmount and remount while the old Client is disposed', async () => fixture(async ({ ink, stdin, render, focus, inputs }) => {
  click(ink, stdin, 'idle:0')
  await until(() => lines(ink).some(line => line.includes('idle:1')), 'Client state before complete site unmount', ink)
  click(ink, stdin, '[-]')
  await until(() => lines(ink).some(line => line.startsWith('▸ plugin panel hidden')), 'collapse before remount', ink)
  render(false, false, false)
  await until(() => !lines(ink).some(line => /plugin panel hidden|BAND:|idle:/.test(line)), 'actual empty host after unmount', ink)
  expect(focus.at(-1)).toBe(false)
  const previousInputs = inputs.length
  render()
  await until(() => inputs.length > previousInputs, 'remounted actual Worker render request', ink)
  await until(() => lines(ink).some(line => line.startsWith('▸ plugin panel hidden')), 'shared collapsed state after remount', ink)
  expect(lines(ink).some(line => /idle:|BAND:|\[-\]/.test(line))).toBe(false)
  click(ink, stdin, '▸ plugin panel hidden')
  await until(() => lines(ink).some(line => line.includes('idle:0@24x1')), 'remounted Client has new state after expansion', ink)
  expect(lines(ink).some(line => line.includes('idle:1'))).toBe(false)
}))

test('actual stdin shared collapse survives runtime replacement in the same process', async () => {
  await fixture(async ({ ink, stdin }) => {
    click(ink, stdin, '[-]')
    await until(() => lines(ink).some(line => line.startsWith('▸ plugin panel hidden')), 'collapse before runtime disposal', ink)
  })
  await fixture(async ({ ink, stdin, inputs, focus }) => {
    expect(inputs.some(input => input.component === 'AbovePrompt')).toBe(true)
    expect(lines(ink).some(line => /idle:|BAND:|\[-\]/.test(line))).toBe(false)
    expect(focus.at(-1)).toBe(false)
    click(ink, stdin, '▸ plugin panel hidden')
    await until(() => lines(ink).some(line => line.includes('idle:0@24x1')), 'replacement runtime expands with a new Client', ink)
  }, undefined, true)
})

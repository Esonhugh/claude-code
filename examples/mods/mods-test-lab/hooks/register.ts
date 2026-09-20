import type { On } from 'claude-code'

const paneId = 'mods-test-lab'
const contextMarker = '[mods-test-lab: one-shot context]'
const usage = '/mods-test [open|status|reset|close|context]'
const emptyCounts = () => ({ command: 0, tool: 0, prompt: 0, turn: 0 })
type Event = 'activation' | 'open' | 'status' | 'reset' | 'close' | 'context' |
  'tool' | 'prompt' | 'prompt.context' | 'turn' | 'button' | 'input' | 'submit' | 'select'

let counts = emptyCounts()
let persistent = { activations: 0, ...emptyCounts() }
let controls = { button: 0, input: 0, submit: 0, select: 0 }
let events: Event[] = []
let input = ''
let selection = 'ascii'
let pendingContext = false
let lastTurn: { reason: string; aborted: boolean } | undefined

function record(event: Event) {
  events.push(event)
  if (events.length > 20) events.shift()
}

function summary() {
  return [
    `Mods test lab | activation=${persistent.activations}`,
    `Activation counters (since load/reset): ${JSON.stringify(counts)}`,
    `Persistent counters (since reset; activations retained): ${JSON.stringify(persistent)}`,
    `Controls: ${JSON.stringify(controls)}`,
    `Input length=${input.length}/256 | selection=${selection} | context=${pendingContext ? 'pending' : 'idle'}`,
    `Last turn: ${lastTurn ? JSON.stringify(lastTurn) : 'none'}`,
    `Events (${events.length}/20): ${events.join(', ')}`,
  ].join('\n')
}

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('counters')
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const key of Object.keys(persistent) as (keyof typeof persistent)[]) {
        const value = (saved as Record<string, unknown>)[key]
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) persistent[key] = value
      }
    }
    persistent.activations++
    await $.store.set('counters', persistent)
    await $.command.register({
      name: 'mods-test',
      description: 'Open the local Mods test lab (no model request)',
      argumentHint: '[open|status|reset|close|context]',
      immediate: true,
    })
    record('activation')
    return next(e)
  })

  on('command.run', { command: 'mods-test' }, async ($, e) => {
    const action = e.args.trim() || 'open'
    if (!['open', 'status', 'reset', 'close', 'context'].includes(action)) return { text: usage }
    if (action === 'reset') {
      counts = emptyCounts()
      persistent = { activations: persistent.activations, ...emptyCounts() }
      controls = { button: 0, input: 0, submit: 0, select: 0 }
      events = []
      input = ''
      selection = 'ascii'
      pendingContext = false
      lastTurn = undefined
    } else {
      counts.command++
      persistent.command++
      record(action as Event)
    }
    if (action === 'context') pendingContext = true
    await $.store.set('counters', persistent)
    if (action === 'open') await $.ui.open({ id: paneId, title: 'Mods test lab', focus: true, closeOnEscape: true })
    if (action === 'close') await $.ui.close({ id: paneId })
    await $.ui.invalidate('ui.render')
    if (action === 'status' || action === 'reset') return { text: summary() }
    if (action === 'context') return { text: 'Mods test lab: fixed context armed for the next prompt only.' }
    return {}
  })

  on('tool.call', async ($, e, next) => {
    counts.tool++
    persistent.tool++
    record('tool')
    await $.store.set('counters', persistent)
    await $.ui.invalidate('ui.render')
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const attach = pendingContext
    pendingContext = false
    counts.prompt++
    persistent.prompt++
    record(attach ? 'prompt.context' : 'prompt')
    await $.store.set('counters', persistent)
    await $.ui.invalidate('ui.render')
    return next(attach ? { ...e, context: [...(e.context ?? []), contextMarker] } : e)
  })

  on('turn.complete', async ($, e, next) => {
    counts.turn++
    persistent.turn++
    lastTurn = {
      reason: ['answer', 'aborted', 'refusal', 'error'].includes(e.reason) ? e.reason : 'unknown',
      aborted: e.isAborted === true,
    }
    record('turn')
    await $.store.set('counters', persistent)
    await $.ui.invalidate('ui.render')
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: paneId }, ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const { Box, Text, Button, Input, Select } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: [
      Text({ children: summary() }),
      Text({ dimColor: true, children: 'Tab/Shift+Tab: focus | Enter: activate/submit | arrows/wheel: scroll | Esc: close' }),
      Button({ key: 'count', autoFocus: true, label: `Count: ${controls.button}`, onPress: async () => {
        controls.button++
        record('button')
        await $.ui.invalidate('ui.render')
      } }),
      Input({ key: 'input', label: 'Local input', placeholder: 'Not logged or persisted (max 256)', value: input,
        onInput: async value => {
          input = value.slice(0, 256)
          controls.input++
          record('input')
          await $.ui.invalidate('ui.render')
        },
        onSubmit: async value => {
          input = value.slice(0, 256)
          controls.submit++
          record('submit')
          await $.ui.invalidate('ui.render')
        },
      }),
      Select({ key: 'selection', label: 'Diff labels', value: selection,
        options: [{ value: 'ascii', label: 'ASCII' }, { value: 'cjk', label: '中文 / CJK' }],
        onSelect: async value => {
          if (value !== 'ascii' && value !== 'cjk') return
          selection = value
          controls.select++
          record('select')
          await $.ui.invalidate('ui.render')
        },
      }),
      Button({ key: 'close', label: 'Close panel', onPress: async () => {
        record('close')
        await $.ui.close({ id: paneId })
      } }),
      Text({ bold: true, children: selection === 'cjk' ? '固定示例差异 / CJK diff' : 'Fixed ASCII / CJK diff' }),
      Text({ children: '--- before.txt\n+++ after.txt\n@@ -1,2 +1,2 @@' }),
      Text({ color: 'red', children: '- hello world\n- 旧行：你好世界' }),
      Text({ color: 'green', children: '+ hello mods\n+ 新行：宽度测试' }),
      ...Array.from({ length: 60 }, (_, index) => Text({ children: `Row ${String(index + 1).padStart(2, '0')} | fixed scroll fixture | 中文宽度测试` })),
    ] })
  })
}

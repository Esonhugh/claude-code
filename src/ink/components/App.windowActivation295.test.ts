import { expect, spyOn, test } from 'bun:test'
import { Readable, Writable } from 'node:stream'
import App from './App.js'
import type { ClickDisposition, ClickModifiers } from '../events/click-event.js'
import { createSelectionState } from '../selection.js'
import { resetTerminalFocusState } from '../terminal-focus-state.js'

function fixture(result: ClickDisposition = 'handled') {
  const clicks: { activation: boolean | undefined; mods: ClickModifiers | undefined }[] = []
  const keys: string[] = [], multi: number[] = [], links: string[] = []
  const stdin = new Readable({read(){}})
  const stdout = new Writable({write(_chunk,_encoding,done){done()}})
  const app = new App({children:null, stdin:stdin as never, stdout:stdout as never,
    stderr:stdout as never, exitOnCtrlC:false, onExit(){}, terminalColumns:80, terminalRows:24,
    selection:createSelectionState(), onSelectionChange(){},
    onClickAt(_col,_row,activation,mods){clicks.push({activation,mods});return result},
    onHoverAt(){},getHyperlinkAt(){return 'https://example.invalid'},onOpenHyperlink(url){links.push(url)},
    onMultiClick(_col,_row,count){multi.push(count)},onSelectionDrag(){},
    dispatchKeyboardEvent(key){keys.push(key.sequence)},
  })
  return {app,clicks,keys,multi,links,close(){
    if(app.incompleteEscapeTimer)clearTimeout(app.incompleteEscapeTimer)
    if(app.pendingHyperlinkTimer)clearTimeout(app.pendingHyperlinkTimer)
    stdin.destroy();stdout.destroy();resetTerminalFocusState()
  }}
}
const click = (button=0) => `\x1b[<${button};3;5M\x1b[<${button};3;5m`

test.each([399,400])('real parser classifies focus activation strictly below 400ms (%i)', elapsed => {
  let now=1000
  const time=spyOn(Date,'now').mockImplementation(()=>now), h=fixture()
  try {
    h.app.processInput('\x1b[I')
    now+=elapsed
    h.app.processInput(click(4|8|16))
    expect(h.clicks).toEqual([{activation:elapsed<400,mods:{shift:true,alt:true,ctrl:true}}])
    expect(h.app.windowActivationClickArmed).toBe(false)
    expect(h.keys).toEqual([])
    expect(h.multi).toEqual([])
  } finally {h.close();time.mockRestore()}
})

test.each(['a','\x1b[200~pasted\x1b[201~'])('real key or paste consumes activation before a following mouse press (%s)', text => {
  const time=spyOn(Date,'now').mockReturnValue(1000), h=fixture()
  try {
    h.app.processInput('\x1b[I'+text+click())
    expect(h.clicks).toHaveLength(1)
    expect(h.clicks[0]!.activation).toBe(false)
    expect(h.keys).toHaveLength(1)
    expect(h.app.lastActivationInputTime).toBe(1000)
  } finally {h.close();time.mockRestore()}
})

test('focus echoes inside 400ms do not rearm a consumed latch; blur does rearm it', () => {
  let now=1000
  const time=spyOn(Date,'now').mockImplementation(()=>now), h=fixture()
  try {
    h.app.processInput('\x1b[Ia')
    now=1399
    h.app.processInput('\x1b[I'+click())
    expect(h.clicks[0]!.activation).toBe(false)
    now=1400
    h.app.processInput('\x1b[O\x1b[I'+click())
    expect(h.clicks[1]!.activation).toBe(true)
    expect(h.links).toEqual([])
  } finally {h.close();time.mockRestore()}
})

test.each(['stray','repeat'] as const)('real release %s resets the click chain before the next press', disposition => {
  const time=spyOn(Date,'now').mockReturnValue(1000), h=fixture(disposition)
  try {
    h.app.processInput('a'+click()+click())
    expect(h.clicks).toHaveLength(2)
    expect(h.multi).toEqual([])
    expect(h.app.clickCount).toBe(0)
    expect(h.app.lastClickTime).toBe(0)
    expect(h.links).toEqual([])
  } finally {h.close();time.mockRestore()}
})

test('wheel and passive motion preserve activation; a response does not become a key', () => {
  const time=spyOn(Date,'now').mockReturnValue(1000), h=fixture()
  try {
    h.app.processInput('\x1b[I\x1b[<64;3;5M\x1b[<35;3;5M\x1b[?25;1$y'+click())
    expect(h.clicks[0]!.activation).toBe(true)
    expect(h.keys).toHaveLength(1)
    expect(h.multi).toEqual([])
  } finally {h.close();time.mockRestore()}
})

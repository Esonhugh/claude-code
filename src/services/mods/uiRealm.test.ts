import { describe, expect, test } from 'bun:test'
import * as vm from 'node:vm'
import { isProxy } from 'node:util/types'
import { createModUiRealm } from './uiRealm.js'

function realm() {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  })
  context.ui = vm.runInContext(`(${createModUiRealm.toString()})`, context)('owner', isProxy)
  return { context, run: (source: string) => vm.runInContext(source, context) }
}

describe('VM-local Mods UI constructors', () => {
  test('resolve and JSX return frozen synchronous plain-data nodes in the VM realm', () => {
    const { run } = realm()
    const result = run(`(() => {
      const { Box, Text } = ui.resolve({surface: 'terminal', component: 'Pane'});
      const tree = ui.h(Box, {gap: 1}, ui.h(Text, {bold: true}, 'hello'), [null, false, 2]);
      return {tree, frozen: Object.isFrozen(tree) && Object.isFrozen(tree.children),
        sameRealm: Object.getPrototypeOf(Box) === Function.prototype, then: typeof tree.then};
    })()`)
    expect(result.tree).toEqual({
      type: 'Box', props: { gap: 1 },
      children: [{ type: 'Text', props: { bold: true }, children: ['hello'] }, '2'],
    })
    expect(result.frozen).toBe(true)
    expect(result.sameRealm).toBe(true)
    expect(result.then).toBe('undefined')
  })

  test('Fragment and functional tags normalize children without intrinsic tags', () => {
    const { run } = realm()
    expect(run(`ui.h(ui.Fragment, null, 'a', [0, true, undefined, ['b']])`)).toEqual({
      type: 'Box', props: { flexDirection: 'column' }, children: ['a', '0', 'b'],
    })
    expect(() => run(`ui.h('Text', null, 'bad')`)).toThrow('constructor')
    expect(run(`ui.h(() => null, null)`)).toBeNull()
  })

  test('callbacks remain private and receive their documented author arguments', async () => {
    const { run } = realm()
    const result = run(`(() => {
      const {Button, Input, Select} = ui.resolve({surface: 'terminal', component: 'Pane'});
      const calls = [];
      const button = Button({label:'Run', children:['Run'], onPress:(...args) => calls.push(['press', args.length])});
      const input = Input({key:'reply', onInput:(value, event) => calls.push(['input', value, event.kind]), onSubmit:(value, event) => calls.push(['submit', value, event.kind])});
      const select = Select({key:'source', options:[{label:'Current', value:'current'}], onSelect:(value, event) => calls.push(['select', value, event.value])});
      const callbacks = [];
      const tree = ui.materialize(ui.h(ui.Fragment, null, button, input, select), callback => callbacks.push(callback));
      return {button, tree, callbacks, calls};
    })()`)
    expect(result.button.press).toEqual({ plugin: 'owner', handle: 0 })
    expect(result.tree.children[0].press).toEqual({ plugin: 'owner', handle: 1 })
    expect(result.tree.children[1].press).toEqual({ plugin: 'owner', handle: 2 })
    expect(result.tree.children[2].press).toEqual({ plugin: 'owner', handle: 3 })
    expect(result.tree.children.map((node: { group?: unknown }) => node.group)).toEqual([
      { plugin: 'owner' },
      { plugin: 'owner' },
      { plugin: 'owner' },
    ])
    expect(JSON.stringify(result.tree)).not.toContain('onPress')
    await result.callbacks[0]({ element: 'Run' })
    await result.callbacks[1]({ kind: 'change', value: 'draft' })
    await result.callbacks[1]({ kind: 'submit', value: 'sent' })
    await result.callbacks[2]({ value: 'current' })
    expect(result.calls).toEqual([
      ['press', 0],
      ['input', 'draft', 'change'],
      ['submit', 'sent', 'submit'],
      ['select', 'current', 'current'],
    ])
  })

  test('drawing materialization does not change an existing callback owner or allocate duplicates', () => {
    const { run } = realm()
    expect(run(`(() => {
      const {Button} = ui.resolve({surface:'terminal', component:'Pane'});
      const button = Button({label:'one', onPress:() => {}});
      let count=0;
      const tree=ui.materialize(ui.h(ui.Fragment,null,button,button), () => ++count);
      const forwarded=ui.materialize(tree, () => ++count);
      return {count, same:forwarded===tree, handles:tree.children.map(n=>n.press.handle)};
    })()`)).toEqual({ count: 1, same: true, handles: [1, 1] })
  })

  test('style and code props stay data, callbacks and children do not leak into leaf props', () => {
    const { run } = realm()
    expect(run(`(() => {
      const {Text, Code, Button} = ui.resolve({surface:'terminal', component:'Pane'});
      return [Text({hover:{color:'green',scope:'group'},children:'label'}),
        Code({source:'+a',format:'diff',children:[]}),
        Button({label:'next',hover:{bold:true},onPress:()=>{}})];
    })()`)).toEqual([
      {type:'Text',props:{},children:['label'],hover:{color:'green',scope:'group'},group:{plugin:'owner'}},
      {type:'Code',props:{source:'+a',format:'diff'}},
      {type:'Button',props:{key:'next',label:'next'},hover:{bold:true},group:{plugin:'owner'},press:{plugin:'owner',handle:0}},
    ])
  })

  test('rejects callback accessors and non-callable handlers without evaluating getters', () => {
    const { run } = realm()
    expect(run(`(() => {
      let read=0; const {Button}=ui.resolve({surface:'terminal',component:'Pane'});
      try {Button({label:'bad',get onPress(){read++;return()=>{}}})} catch {}
      return read;
    })()`)).toBe(0)
    expect(() => run(`ui.resolve({surface:'terminal',component:'Pane'}).Button({label:'bad',onPress:'oops'})`)).toThrow('callback')
    expect(() => run(`ui.resolve({surface:'terminal',component:'Pane'}).Input({key:'bad',onInput:()=>{}})`)).toThrow('onSubmit')
  })
})

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

  test('Links omit empty normalized children so label and URL fallbacks remain available', () => {
    const { run } = realm()
    expect(run(`(() => {
      const {Link, Text} = ui.resolve({surface:'terminal', component:'Pane'});
      const props = {href:'https://example.com/', label:'Docs'};
      return [Link(props), ...[null, false, [], [null, false, []], ['', null]].map(children => ui.h(Link, props, children))]
        .map(node => ui.materialize(node, () => {throw new Error('unexpected callback')}));
    })()`)).toEqual(Array.from({ length: 6 }, () => ({ type: 'Link', props: { href: 'https://example.com/', label: 'Docs' } })))
    expect(run(`(() => {
      const {Link, Text} = ui.resolve({surface:'terminal', component:'Pane'});
      return ui.h(Link, {href:'https://example.com/'}, 0, ' ', ui.h(Text, {bold:true}, 'docs'));
    })()`)).toEqual({ type: 'Link', props: { href: 'https://example.com/' }, children: [
      '0', ' ', { type: 'Text', props: { bold: true }, children: ['docs'] },
    ] })
  })

  test('callbacks remain private and receive their documented author arguments', async () => {
    const { run } = realm()
    const result = run(`(() => {
      const {Button, Input, Select, Markdown} = ui.resolve({surface: 'terminal', component: 'Pane'});
      const calls = [];
      const button = Button({label:'Run', children:['Run'], onPress:(...args) => calls.push(['press', args.length])});
      const input = Input({key:'reply', onInput:(value, event) => calls.push(['input', value, event.kind]), onSubmit:(value, event) => calls.push(['submit', value, event.kind])});
      const select = Select({key:'source', options:[{label:'Current', value:'current'}], onSelect:(value, event) => calls.push(['select', value, event.value])});
      const markdown = Markdown({key:'docs', text:'[Docs](https://example.com/)', onLinkPress:(link, event) => calls.push(['link', link.href, event.link.href])});
      const callbacks = [];
      const tree = ui.materialize(ui.h(ui.Fragment, null, button, input, select, markdown), callback => callbacks.push(callback));
      return {button, tree, callbacks, calls};
    })()`)
    expect(result.button.press).toEqual({ plugin: 'owner', handle: 0 })
    expect(result.tree.children[0].press).toEqual({ plugin: 'owner', handle: 1 })
    expect(result.tree.children[1].press).toEqual({ plugin: 'owner', handle: 2 })
    expect(result.tree.children[2].press).toEqual({ plugin: 'owner', handle: 3 })
    expect(result.tree.children[3].press).toEqual({ plugin: 'owner', handle: 4 })
    expect(result.tree.children.map((node: { group?: unknown }) => node.group)).toEqual([
      { plugin: 'owner' },
      { plugin: 'owner' },
      { plugin: 'owner' },
      { plugin: 'owner' },
    ])
    expect(JSON.stringify(result.tree)).not.toContain('onPress')
    expect(JSON.stringify(result.tree)).not.toContain('onLinkPress')
    await result.callbacks[0]({ element: 'Run' })
    await result.callbacks[1]({ kind: 'change', value: 'draft' })
    await result.callbacks[1]({ kind: 'submit', value: 'sent' })
    await result.callbacks[2]({ value: 'current' })
    await result.callbacks[3]({ link: { href: 'https://example.com/' } })
    expect(result.calls).toEqual([
      ['press', 0],
      ['input', 'draft', 'change'],
      ['submit', 'sent', 'submit'],
      ['select', 'current', 'current'],
      ['link', 'https://example.com/', 'https://example.com/'],
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

  test('Svg is remote-only, exact-prop leaf data with bounded safe markup and dimensions', () => {
    const { run } = realm()
    expect(run(`(() => {
      const surfaces=['terminal','desktop','mobile','vscode'];
      return surfaces.map(surface => {
        const elements=ui.resolve({surface,component:'Pane'});
        return [surface, Object.keys(elements).includes('Svg'), elements.Svg?.({
          source:'<svg xmlns="http://www.w3.org/2000/svg"><title>safe</title></svg>',
          alt:'safe image',width:12.5,height:8,isInteractive:true,
        })];
      });
    })()`)).toEqual([
      ['terminal', false, undefined],
      ...['desktop', 'mobile', 'vscode'].map(surface => [surface, true, {
        type:'Svg', props:{
          source:'<svg xmlns="http://www.w3.org/2000/svg"><title>safe</title></svg>',
          alt:'safe image', width:12.5, height:8, isInteractive:true,
        },
      }]),
    ])
    for (const source of [
      `'not svg'`,
      `'<svg></svg>tail'`,
      `'<svg><script>alert(1)</script></svg>'`,
      `'<svg><path onclick="alert(1)"/></svg>'`,
      `'<svg><a href="javascript:alert(1)"></a></svg>'`,
      `'<svg><foreignObject><iframe src="https://example.com"></iframe></foreignObject></svg>'`,
      `'<svg><style>@import url(https://example.com/x.css)</style></svg>'`,
      `'<'+'svg>'+'x'.repeat(131072)+'</svg>'`,
    ]) expect(() => run(`ui.resolve({surface:'desktop'}).Svg({source:${source},alt:'x'})`)).toThrow()
    for (const props of [
      `{source:'<svg></svg>',alt:'x',children:[]}`,
      `{source:'<svg></svg>',alt:'x',unknown:true}`,
      `{source:'<svg></svg>',alt:1}`,
      `{source:'<svg></svg>',alt:'x',width:0}`,
      `{source:'<svg></svg>',alt:'x',height:Infinity}`,
      `{source:'<svg></svg>',alt:'x',isInteractive:1}`,
    ]) expect(() => run(`ui.resolve({surface:'desktop'}).Svg(${props})`)).toThrow()
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

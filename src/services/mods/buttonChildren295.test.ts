import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'
import { createModUiRealm } from './uiRealm.js'
import { isProxy } from 'node:util/types'
import { validateModRenderTree } from '../../components/ModsPane.js'

test('real author Worker preserves Button Text children and one callback through ui.render', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-button-children-295-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event),
    services: { uiPresentation: () => ({ columns: 160, rows: 40, isFullscreen: true,
      composerEmpty: true, hasDialog: false, keyboardOwned: false }) } })
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, [
      'export function register(on) {',
      "on('session.start', async ($, e, next) => { await $.ui.open({id:'children'}); return next(e) });",
      "on('ui.render', {component:'Pane'}, ($, e) => {",
      'const { Button, Text } = $.ui.resolve(e);',
      "return Button({ key: 'save', label: 'accessible name', children: [",
      "'Save ', Text({ dimColor: true, children: '2m' })",
      '], onPress: () => {} }); }); }',
    ].join('\n'))
    await runtime.bind({ cwd: root, surface: 'terminal', isInteractive: true, sessionId: 'button-children' })
    await runtime.reconcile([{ name: 'children', storageId: 'children@test',
      pluginRoot: root, entrypoints: [entry] }])
    expect(diagnostics).toEqual([])
    expect(runtime.ui.getSnapshot()[0]!.tree).toMatchObject({ type: 'Button',
      props: { key: 'save', label: 'accessible name' },
      children: ['Save ', { type: 'Text', props: { dimColor: true }, children: ['2m'] }],
      press: { plugin: expect.any(String), handle: expect.any(Number) },
    })
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('Button children preserve stable addresses, legacy one-string labels and nested text', () => {
  const ui = createModUiRealm('owner', isProxy)
  const { Button, Text, Box, Link } = ui.resolve({surface:'terminal'})
  const press = () => {}
  expect(Button!({children:'Save', onPress:press})).toMatchObject({props:{key:'Save',label:'Save'}})
  expect(Button!({children:'Save', onPress:press}).children).toBeUndefined()
  // The fixed 2.1.295 constructor refuses an empty address for label-only Buttons too.
  expect(() => Button!({label:'', onPress:press})).toThrow('key')
  expect(() => Button!({label:'Save', key:'', onPress:press})).toThrow('key')
  expect(Button!({label:'', key:'base', onPress:press})).toMatchObject({props:{key:'base',label:''}})
  const held = Button!({key:'row', children:['Save ',Text!({dimColor:true,children:['2',Text!({children:'m'})]})],onPress:press})
  expect(held.props).toMatchObject({key:'row',label:'Save 2m'})
  expect(held.children).toHaveLength(2)
  expect(Object.isFrozen(held.children)).toBe(true)
  expect(() => Button!({children:[Text!({children:'changing text'})],onPress:press})).toThrow('key')
  for (const child of [Box!({children:'bad'}), Link!({href:'https://example.com/',children:'bad'}), {type:'engine',ref:0}]) {
    expect(() => Button!({key:'bad',label:'bad',children:[Text!({children:child})],onPress:press})).toThrow('strings or Text')
  }
})

test('terminal admission accepts only strings and Text throughout held Button children', () => {
  const base = {type:'Button',props:{key:'save',label:'accessible'},press:{plugin:'owner',handle:1}}
  expect(validateModRenderTree({...base,children:['Save ',{type:'Text',children:['2m']}]}).tree).toMatchObject({children:['Save ',{type:'Text',children:['2m']}]})
  for (const child of [{type:'Box'}, {type:'Link',props:{href:'https://example.com/'}}, {type:'Button',props:{key:'nested',label:'x'},press:{plugin:'owner',handle:2}}, {type:'engine',ref:1}]) {
    expect(() => validateModRenderTree({...base,children:[{type:'Text',children:[child]}]},'terminal',new Set([1]))).toThrow()
  }
})

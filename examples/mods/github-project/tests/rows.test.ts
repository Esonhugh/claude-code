import { expect, test } from 'claude-code/testing'
import GithubRows from '../hooks/rows.mjs'

test('shows three cells per relation row as plain text and ordinary links; no actions', () => {
  const element = (type: string) => (props: object) => ({ type, props })
  const issue = 'https://github.com/example/project/issues/1'
  const pull = 'https://github.com/example/project/pull/17'
  const tree = GithubRows([
    { title: 'Issues', empty: 'No results', rows: [], tableRows: [
      { issue, pulls: [pull], title: '<fixture>' },
      { pulls: [], title: 'Another issue' },
    ] },
    { title: 'Pull requests', empty: 'No results', rows: [] },
  ], { elements: { Box: element('Box'), Text: element('Text'), Link: element('Link') } }) as any
  const children = (el: any) => el.props.children
  const [first, second] = children(tree)
  const [issueCell, prCell, title] = children(first)
  expect(children(issueCell)).toEqual([{ type: 'Link', props: { href: issue } }])
  expect(children(prCell)).toEqual([{ type: 'Link', props: { href: pull } }])
  expect(children(title)).toBe('<fixture>')
  expect(children(children(second)[0])).toEqual([])
})

test('still supports the old host’s sections-only props', () => {
  const element = (type: string) => (props: object) => ({ type, props })
  const url = 'https://github.com/example/project/pull/17'
  const tree = GithubRows([{ title: 'Pull requests', empty: 'No results', rows: [
    { number: 17, title: '<fixture>', label: 'Draft', url },
  ] }], { elements: { Box: element('Box'), Text: element('Text'), Link: element('Link') } }) as any
  expect(tree.props.children[0].props.children[1]).toEqual({ type: 'Link', props: { href: url, label: '#17 <fixture> · Draft' } })
})

test('the desktop pane declares the documented Client without reading data itself', async $ => {
  const ui = await $.ui.mount({ plugin: 'github-project', surface: 'desktop', component: 'Pane', requestId: 'github-project', props: {} } as never)
  try {
    expect((await ui.find({ type: 'Client', key: 'github-rows' })).props.props).toBe(null)
    expect((await ui.find({ type: 'Text', in: 'github-rows' })).text).toBe('GitHub')
  } finally {
    await ui.unmount()
  }
})

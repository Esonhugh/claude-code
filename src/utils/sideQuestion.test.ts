import { expect, mock, test } from 'bun:test'

let forkMessages: unknown[] = []
const realForkedAgent = await import('./forkedAgent.js')
mock.module('./forkedAgent.js', () => ({
  ...realForkedAgent,
  runForkedAgent: async () => ({ messages: forkMessages, totalUsage: {} }),
}))
const { runSideQuestion } = await import('./sideQuestion.js')

const assistant = (content: unknown[]) => ({ type: 'assistant', message: { content } })
const ask = () => runSideQuestion({ question: 'q', cacheSafeParams: {} as never })

test('side question results say whether the text came from the model', async () => {
  forkMessages = [assistant([{ type: 'text', text: 'model answer' }])]
  expect(await ask()).toMatchObject({ response: 'model answer', synthetic: false })

  forkMessages = [assistant([{ type: 'tool_use', id: 't', name: 'Read', input: {} }])]
  expect(await ask()).toMatchObject({ synthetic: true })

  forkMessages = []
  expect(await ask()).toMatchObject({ response: null, synthetic: false })
})

import { expect, test } from 'bun:test'
import { ERROR_MESSAGE_NOT_ENOUGH_MESSAGES } from '../../services/compact/compact.js'
import { createUserMessage } from '../../utils/messages.js'
import { call } from './compact.js'

const context = (messages: unknown[]) => ({ messages, abortController: new AbortController() }) as never

test('/compact with nothing the model answered refuses like 2.1.311', async () => {
  const onlyCommand = [createUserMessage({ content: '<command-name>/clear</command-name>' })]
  await expect(call('', context(onlyCommand))).rejects.toThrow(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
})

test('/compact on an empty conversation reports nothing', async () => {
  expect(await call('', context([]))).toEqual({ type: 'text', value: '' })
})

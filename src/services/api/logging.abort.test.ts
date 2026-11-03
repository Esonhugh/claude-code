import { expect, test } from 'bun:test'
import { APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import { getInMemoryErrors } from '../../utils/log.js'
import { logAPIError } from './logging.js'

const failed = (error: unknown) =>
  logAPIError({ error, model: 'gpt-6.1-sol', messageCount: 1, durationMs: 1, durationMsIncludingRetries: 1, attempt: 1 })

test('a request the user aborted is not recorded as an error (it reached `-p` result errors and the web chat)', () => {
  const before = getInMemoryErrors().length
  failed(new APIUserAbortError())
  expect(getInMemoryErrors().slice(before)).toEqual([])
  failed(new APIError(500, undefined, 'boom', new Headers()))
  expect(getInMemoryErrors().slice(before).map(e => e.error)).toEqual([expect.stringContaining('boom')])
})

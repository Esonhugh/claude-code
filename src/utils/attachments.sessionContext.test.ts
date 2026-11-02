import { describe, expect, mock, test } from 'bun:test'
import type { ToolUseContext } from '../Tool.js'
import type { Message } from '../types/message.js'

const GIT_STATUS = 'Current branch: main\n\nStatus:\n?? new.txt'
const realContext = await import('../context.js')
mock.module('../context.js', () => ({
  ...realContext,
  getSessionGitStatus: async () => GIT_STATUS,
}))

const { getSessionContextAttachments } = await import('./attachments.js')
const { normalizeAttachmentForAPI } = await import('./messages.js')

const ctx = (agentType?: string) => ({ agentType }) as unknown as ToolUseContext

describe('git status rides a persisted session_context attachment (2.1.311)', () => {
  test('announced once per conversation, not again once it is in history', async () => {
    const first = await getSessionContextAttachments(ctx(), [])
    expect(first).toEqual([{ type: 'session_context', context: { gitStatus: GIT_STATUS } }])
    const history = [{ type: 'attachment', attachment: first[0] }] as Message[]
    expect(await getSessionContextAttachments(ctx(), history)).toEqual([])
  })

  test('Explore and Plan subagents do not get it', async () => {
    expect(await getSessionContextAttachments(ctx('Explore'), [])).toEqual([])
    expect(await getSessionContextAttachments(ctx('Plan'), [])).toEqual([])
  })

  test('renders as the official context reminder', () => {
    const [message] = normalizeAttachmentForAPI({ type: 'session_context', context: { gitStatus: GIT_STATUS } })
    expect(message?.message.content).toBe(
      `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# gitStatus\n${GIT_STATUS}\n\nClaude Code attached this context automatically; it isn't part of the user's message. It describes the user's own account and workspace, so they don't need it reported back.\n</system-reminder>`,
    )
  })
})

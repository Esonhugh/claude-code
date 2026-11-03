import { describe, expect, test } from 'bun:test'
import type { Message } from '../types/message.js'
import {
  createAssistantMessage,
  createCompactBoundaryMessage,
  createUserMessage,
  getMessagesForCompactDisplay,
} from './messages.js'

const boundary = () => createCompactBoundaryMessage('manual', 1000)

describe('getMessagesForCompactDisplay', () => {
  test('a kept tail already on screen above the boundary is shown once', () => {
    const prompt = createUserMessage({ content: 'P1' })
    const reply = createAssistantMessage({ content: 'P1 reply' })
    const summary = createUserMessage({ content: 'summary', isCompactSummary: true })
    const next = createUserMessage({ content: 'P2' })
    const shown = getMessagesForCompactDisplay([prompt, reply, boundary(), summary, { ...reply }, next] as Message[])
    expect(shown.map(m => m.uuid)).toEqual([prompt.uuid, reply.uuid, summary.uuid, next.uuid])
  })

  test('a live boundary under its own history is hidden, a leading one is kept', () => {
    const first = boundary()
    const prompt = createUserMessage({ content: 'P1' })
    const second = boundary()
    const shown = getMessagesForCompactDisplay([first, prompt, second] as Message[])
    expect(shown.map(m => m.uuid)).toEqual([first.uuid, prompt.uuid])
  })

  test('without a boundary the list is unchanged', () => {
    const list = [createUserMessage({ content: 'P1' })] as Message[]
    expect(getMessagesForCompactDisplay(list)).toBe(list)
  })
})

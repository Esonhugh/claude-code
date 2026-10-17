import { expect, test } from 'bun:test'
import { isValidElement, type ReactNode } from 'react'
import { renderToolResultMessage } from './UI.js'

function text(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(text).join('')
  if (isValidElement<{ children?: ReactNode }>(node))
    return text(node.props.children)
  return ''
}
for (const background of [true, false]) {
  test(`fork skill UI reports the worker state: background=${background}`, () => {
    const output = {
      success: true,
      commandName: 'probe',
      status: 'forked' as const,
      agentId: 'aprobe',
      result: 'launch result',
      background,
    }
    expect(text(renderToolResultMessage(output))).toBe(
      background ? 'Running in the background' : 'Done',
    )
  })
}

import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'

import type { Message, SystemCompactBoundaryMessage } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages.js'
import { annotateBoundaryWithPreservedSegment } from './compact.js'

const boundary = {
  type: 'system',
  subtype: 'compact_boundary',
  uuid: randomUUID(),
  compactMetadata: { trigger: 'manual', preTokens: 0 },
} as unknown as SystemCompactBoundaryMessage

test('preserved segment ends point at messages that reach the transcript (2.1.311)', () => {
  // An empty SessionStart hook_success is never written to disk, so pointing
  // headUuid at it made resume drop the whole kept prefix after "Summarize from here".
  const emptyHook = {
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: new Date(0).toISOString(),
    attachment: { type: 'hook_success', content: '', hookName: 'SessionStart', toolUseID: 't', hookEvent: 'SessionStart' },
  } as Message
  const first = createUserMessage({ content: 'first prompt' })
  const last = createUserMessage({ content: 'last prompt' })
  const progress = { type: 'progress', uuid: randomUUID() } as unknown as Message

  const annotated = annotateBoundaryWithPreservedSegment(boundary, boundary.uuid, [emptyHook, first, last, progress])
  expect(annotated.compactMetadata.preservedSegment).toEqual({
    headUuid: first.uuid,
    anchorUuid: boundary.uuid,
    tailUuid: last.uuid,
  })
})

test('nothing loggable to keep leaves the boundary unannotated', () => {
  const progress = { type: 'progress', uuid: randomUUID() } as unknown as Message
  expect(annotateBoundaryWithPreservedSegment(boundary, boundary.uuid, [progress])).toBe(boundary)
})

test('compact_metadata carries post_tokens, duration_ms and preserved_messages like SDK 0.3.311', async () => {
  const { toSDKCompactMetadata, fromSDKCompactMetadata } = await import('../../utils/messages/mappers.js')
  const first = createUserMessage({ content: 'first prompt' })
  const last = createUserMessage({ content: 'last prompt' })
  const annotated = annotateBoundaryWithPreservedSegment(
    { ...boundary, compactMetadata: { trigger: 'manual', preTokens: 900, postTokens: 120, durationMs: 2500 } } as SystemCompactBoundaryMessage,
    boundary.uuid,
    [first, last],
  )
  const sdk = toSDKCompactMetadata(annotated.compactMetadata)
  expect(sdk).toEqual({
    trigger: 'manual',
    pre_tokens: 900,
    post_tokens: 120,
    duration_ms: 2500,
    preserved_segment: { head_uuid: first.uuid, anchor_uuid: boundary.uuid, tail_uuid: last.uuid },
    preserved_messages: { anchor_uuid: boundary.uuid, uuids: [first.uuid, last.uuid] },
  })
  expect(toSDKCompactMetadata({ trigger: 'auto', preTokens: 5 })).toEqual({ trigger: 'auto', pre_tokens: 5 })
  expect(fromSDKCompactMetadata(sdk)).toMatchObject({ postTokens: 120, durationMs: 2500, preservedMessages: { anchorUuid: boundary.uuid, uuids: [first.uuid, last.uuid] } })
})

import { useEffect, useRef } from 'react'
import type { QuerySource } from '../constants/querySource.js'
import {
  getIdleCompactionDelayMs,
  getIdleCompactionSkipReason,
} from '../services/compact/idleCompaction.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'
import { tokenCountWithEstimation } from '../utils/tokens.js'

/**
 * Arms the idle-compaction timer each time a main-thread turn ends, and
 * compacts once it fires if the conversation is still idle and large enough.
 */
export function useIdleCompaction(
  messages: readonly Message[],
  isLoading: boolean,
  querySource: QuerySource,
  compact: () => Promise<void>,
): void {
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const compactRef = useRef(compact)
  compactRef.current = compact

  useEffect(() => {
    if (isLoading) return
    if (!messagesRef.current.some(message => message.type === 'assistant')) return
    const delay = getIdleCompactionDelayMs(querySource)
    if (delay === null) return
    const fireAt = Date.now() + delay
    const timer = setTimeout(() => {
      const contextTokens = tokenCountWithEstimation(messagesRef.current)
      const skip = getIdleCompactionSkipReason({
        contextTokens,
        lateMs: Math.max(0, Date.now() - fireAt),
      })
      logForDebugging(
        `[IdleCompaction] fired: ${skip ?? 'compacting'} (contextTokens=${contextTokens})`,
      )
      if (skip === null) void compactRef.current()
    }, delay)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, [isLoading, querySource])
}

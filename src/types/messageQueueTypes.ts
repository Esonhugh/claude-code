export type QueueOperation = 'enqueue' | 'dequeue' | string

export interface QueueOperationMessage {
  type: 'queue-operation'
  operation: QueueOperation
  timestamp: string
  sessionId: string
  content?: string
  /** Why a command left the queue (official 2.1.325 `remove` records, e.g. `absorbed_mid_turn`). */
  reason?: string
  /** The queued command a `remove` record is for. */
  commandUuid?: string
}

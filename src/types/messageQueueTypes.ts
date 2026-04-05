export type QueueOperation = 'enqueue' | 'dequeue' | string

export interface QueueOperationMessage {
  type: 'queue-operation'
  operation: QueueOperation
  timestamp: string
  sessionId: string
  content?: string
}

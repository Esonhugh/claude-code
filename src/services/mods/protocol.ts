import type { ModDeclaration, ModRegistration } from './types.js'

export type ModWireValue =
  | { type: 'undefined' }
  | { type: 'value'; value: null | boolean | number | string }
  | { type: 'array'; values: ModWireValue[] }
  | { type: 'object'; entries: [string, ModWireValue][] }
  | { type: 'function'; id: number }
  | { type: 'host-function'; id: number }
  | { type: 'clock'; now: number; wait: number; cancel: number; run: number }

export type ModWorkerRequest =
  | { type: 'ping' }
  | { id: number; type: 'load'; environment: number; declaration: ModDeclaration }
  | {
      id: number
      type: 'invoke'
      environment: number
      handle: number
      args: ModWireValue[]
      next?: {
        call: number
        to: number
        event: string
        origin: ModWireValue
        trace: ModWireValue
        error?: ModWireValue
        called?: boolean
      }
    }
  | { id: number; type: 'unload'; environment: number }
  | { type: 'abort'; environment: number; invocation: number }
  | {
      type: 'host-result'
      environment: number
      call: number
      invocation?: number
      trace?: ModWireValue
      value?: ModWireValue
      error?: string
    }

export type ModWorkerReply =
  | { type: 'pong' }
  | { type: 'async-error'; environment: number; error: string }
  | {
      type: 'result'
      id: number
      value?: ModWireValue
      registrations?: (ModRegistration & { catchId?: number })[]
      error?: string
    }
  | {
      type: 'host-call'
      environment: number
      invocation: number
      call: number
      handle: number
      args: ModWireValue[]
    }

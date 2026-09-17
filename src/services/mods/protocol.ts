import type { ModDeclaration, ModRegistration } from './types.js'

export type ModWireValue =
  | { type: 'undefined' }
  | { type: 'value'; value: null | boolean | number | string }
  | { type: 'array'; values: ModWireValue[] }
  | { type: 'regexp'; source: string; flags: string }
  | { type: 'object'; entries: [string, ModWireValue][] }
  | { type: 'function'; id: number }
  | { type: 'host-function'; id: number; storeMethod?: 'get' | 'set' | 'delete' }
  | { type: 'clock'; now: number; wait: number; cancel: number; run: number }
  | { type: 'ui'; methods: [string, ModWireValue][] }

export type ModWorkerRequest =
  | { type: 'ping' }
  | { id: number; type: 'load'; environment: number; declaration: ModDeclaration }
  | {
      id: number
      type: 'invoke'
      environment: number
      handle: number
      args: ModWireValue[]
      drawing?: number
      callbackDrawing?: number
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
  | { id: number; type: 'release-drawing'; environment: number; drawing: number }
  | { id: number; type: 'ui-access'; environment: number; allowed: boolean }
  | { type: 'abort'; environment: number; invocation: number }
  | {
      type: 'host-result'
      environment: number
      call: number
      invocation?: number
      trace?: ModWireValue
      value?: ModWireValue
      error?: string
      errorRef?: number
    }

export type ModWorkerReply =
  | { type: 'pong' }
  | { type: 'async-error'; environment: number; error: string }
  | {
      type: 'result'
      id: number
      value?: ModWireValue
      registrations?: (Omit<ModRegistration, 'matcher'> & { matcher?: ModWireValue; catchId?: number })[]
      error?: string
      errorRef?: number
    }
  | {
      type: 'host-call'
      environment: number
      invocation: number
      call: number
      handle: number
      args: ModWireValue[]
    }

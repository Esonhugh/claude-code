// Folds the stream-json messages of one `claude -p` session into the view
// model the chat renders. Unknown message types are ignored, so newer engine
// messages never break the page.

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      input: string
      result?: string
      isError?: boolean
    }

export type Item =
  | { kind: 'user'; id: string; text: string }
  | {
      kind: 'assistant'
      id: string
      model?: string
      streamed: boolean
      blocks: Block[]
    }
  | { kind: 'error'; id: string; text: string }

export type Approval = {
  requestId: string
  toolName: string
  input: Record<string, unknown>
}

export type ChatState = {
  items: Item[]
  busy: boolean
  model?: string
  cwd?: string
  approvals: Approval[]
  /** Message id of the assistant message currently streaming. */
  streamingId?: string
}

export const initialState: ChatState = { items: [], busy: false, approvals: [] }

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part =>
      isObj(part) && part.type === 'text' ? (str(part.text) ?? '') : '',
    )
    .filter(Boolean)
    .join('\n')
}

function blockFromContent(part: Json): Block | undefined {
  switch (part.type) {
    case 'text':
      return { kind: 'text', text: str(part.text) ?? '' }
    case 'thinking':
      return { kind: 'thinking', text: str(part.thinking) ?? '' }
    case 'tool_use':
      return {
        kind: 'tool',
        id: str(part.id) ?? '',
        name: str(part.name) ?? '',
        input: part.input === undefined ? '' : JSON.stringify(part.input),
      }
    default:
      return undefined
  }
}

function updateLastAssistant(
  state: ChatState,
  id: string,
  fn: (item: Extract<Item, { kind: 'assistant' }>) => Item,
): ChatState {
  const index = state.items.findIndex(
    item => item.kind === 'assistant' && item.id === id,
  )
  if (index === -1) return state
  const items = state.items.slice()
  items[index] = fn(items[index] as Extract<Item, { kind: 'assistant' }>)
  return { ...state, items }
}

function mapTool(
  state: ChatState,
  toolId: string,
  fn: (block: Extract<Block, { kind: 'tool' }>) => Block,
): ChatState {
  let changed = false
  const items = state.items.map(item => {
    if (item.kind !== 'assistant') return item
    if (!item.blocks.some(b => b.kind === 'tool' && b.id === toolId)) {
      return item
    }
    changed = true
    return {
      ...item,
      blocks: item.blocks.map(b =>
        b.kind === 'tool' && b.id === toolId ? fn(b) : b,
      ),
    }
  })
  return changed ? { ...state, items } : state
}

function reduceStreamEvent(state: ChatState, event: Json): ChatState {
  const { streamingId } = state
  switch (event.type) {
    case 'message_start': {
      const message = isObj(event.message) ? event.message : {}
      const id = str(message.id) ?? `stream-${state.items.length}`
      if (state.items.some(i => i.kind === 'assistant' && i.id === id)) {
        return { ...state, streamingId: id }
      }
      return {
        ...state,
        streamingId: id,
        items: [
          ...state.items,
          {
            kind: 'assistant',
            id,
            model: str(message.model),
            streamed: true,
            blocks: [],
          },
        ],
      }
    }
    case 'content_block_start': {
      const index = typeof event.index === 'number' ? event.index : -1
      const block = isObj(event.content_block)
        ? blockFromContent(event.content_block)
        : undefined
      if (!streamingId || index < 0 || !block) return state
      if (block.kind === 'tool') block.input = ''
      return updateLastAssistant(state, streamingId, item => {
        const blocks = item.blocks.slice()
        blocks[index] = block
        return { ...item, blocks }
      })
    }
    case 'content_block_delta': {
      const index = typeof event.index === 'number' ? event.index : -1
      const delta = isObj(event.delta) ? event.delta : {}
      if (!streamingId || index < 0) return state
      return updateLastAssistant(state, streamingId, item => {
        const block = item.blocks[index]
        if (!block) return item
        let next: Block = block
        if (delta.type === 'text_delta' && block.kind === 'text') {
          next = { ...block, text: block.text + (str(delta.text) ?? '') }
        } else if (
          delta.type === 'thinking_delta' &&
          block.kind === 'thinking'
        ) {
          next = { ...block, text: block.text + (str(delta.thinking) ?? '') }
        } else if (
          delta.type === 'input_json_delta' &&
          block.kind === 'tool'
        ) {
          next = {
            ...block,
            input: block.input + (str(delta.partial_json) ?? ''),
          }
        }
        if (next === block) return item
        const blocks = item.blocks.slice()
        blocks[index] = next
        return { ...item, blocks }
      })
    }
    default:
      return state
  }
}

export function addUserMessage(state: ChatState, text: string): ChatState {
  return {
    ...state,
    busy: true,
    items: [
      ...state.items,
      { kind: 'user', id: `user-${state.items.length}`, text },
    ],
  }
}

export function removeApproval(
  state: ChatState,
  requestId: string,
): ChatState {
  return {
    ...state,
    approvals: state.approvals.filter(a => a.requestId !== requestId),
  }
}

export function addError(state: ChatState, text: string): ChatState {
  return {
    ...state,
    busy: false,
    items: [
      ...state.items,
      { kind: 'error', id: `error-${state.items.length}`, text },
    ],
  }
}

export function reduce(state: ChatState, raw: unknown): ChatState {
  if (!isObj(raw)) return state
  // Subagent traffic (parent_tool_use_id set) belongs to the Agents panel.
  if (raw.parent_tool_use_id) return state

  switch (raw.type) {
    case 'system':
      if (raw.subtype !== 'init') return state
      return {
        ...state,
        model: str(raw.model) ?? state.model,
        cwd: str(raw.cwd) ?? state.cwd,
      }

    case 'stream_event':
      return isObj(raw.event) ? reduceStreamEvent(state, raw.event) : state

    case 'assistant': {
      const message = isObj(raw.message) ? raw.message : {}
      const id = str(message.id) ?? `assistant-${state.items.length}`
      const content = Array.isArray(message.content) ? message.content : []
      const blocks = content
        .filter(isObj)
        .map(blockFromContent)
        .filter((b): b is Block => b !== undefined)
      const existing = state.items.find(
        (i): i is Extract<Item, { kind: 'assistant' }> =>
          i.kind === 'assistant' && i.id === id,
      )
      if (existing?.streamed) {
        // The streamed copy already has the text; take the final tool input.
        let next = state
        for (const block of blocks) {
          if (block.kind === 'tool') {
            next = mapTool(next, block.id, b => ({ ...b, input: block.input }))
          }
        }
        return next
      }
      if (existing) {
        return updateLastAssistant(state, id, item => ({
          ...item,
          blocks: [...item.blocks, ...blocks],
        }))
      }
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: 'assistant',
            id,
            model: str(message.model),
            streamed: false,
            blocks,
          },
        ],
      }
    }

    case 'user': {
      const message = isObj(raw.message) ? raw.message : {}
      const content = Array.isArray(message.content) ? message.content : []
      let next = state
      for (const part of content) {
        if (!isObj(part) || part.type !== 'tool_result') continue
        const toolId = str(part.tool_use_id)
        if (!toolId) continue
        next = mapTool(next, toolId, b => ({
          ...b,
          result: toolResultText(part.content),
          isError: part.is_error === true,
        }))
      }
      return next
    }

    case 'result': {
      const failed = raw.is_error === true || raw.subtype !== 'success'
      const next = {
        ...state,
        busy: false,
        approvals: [],
        streamingId: undefined,
      }
      if (!failed) return next
      const errors = Array.isArray(raw.errors)
        ? raw.errors.filter(e => typeof e === 'string').join('\n')
        : ''
      return addError(next, str(raw.result) || errors || String(raw.subtype))
    }

    case 'control_request': {
      const request = isObj(raw.request) ? raw.request : {}
      const requestId = str(raw.request_id)
      if (request.subtype !== 'can_use_tool' || !requestId) return state
      return {
        ...state,
        approvals: [
          ...state.approvals,
          {
            requestId,
            toolName: str(request.tool_name) ?? '',
            input: isObj(request.input) ? request.input : {},
          },
        ],
      }
    }

    default:
      return state
  }
}

/** Control requests the page cannot answer yet get an error, so the session never waits on them. */
export function unsupportedControlResponse(raw: unknown): Json | undefined {
  if (!isObj(raw) || raw.type !== 'control_request') return undefined
  const request = isObj(raw.request) ? raw.request : {}
  const requestId = str(raw.request_id)
  if (!requestId || request.subtype === 'can_use_tool') return undefined
  return {
    type: 'control_response',
    response: {
      subtype: 'error',
      request_id: requestId,
      error: `Unsupported control request: ${String(request.subtype)}`,
    },
  }
}

export function permissionResponse(
  approval: Approval,
  allow: boolean,
): Json {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: approval.requestId,
      response: allow
        ? { behavior: 'allow', updatedInput: approval.input }
        : { behavior: 'deny', message: 'The user denied this tool use.' },
    },
  }
}

export function userMessage(text: string): Json {
  return {
    type: 'user',
    session_id: '',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  }
}

export function interruptRequest(id: string): Json {
  return {
    type: 'control_request',
    request_id: id,
    request: { subtype: 'interrupt' },
  }
}

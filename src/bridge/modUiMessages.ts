import type {
  ModRenderInput,
  ModRenderSurface,
  ModUiCallback,
  ModUiInteraction,
} from '../services/mods/ui.js'

export type ModUiInboundEvent =
  | { type: 'mod_ui'; subtype: 'attach' | 'update'; client_id: string; surface: Exclude<ModRenderSurface, 'terminal'>; input: ModRenderInput }
  | { type: 'mod_ui'; subtype: 'interact'; client_id: string; drawing: number; callback: ModUiCallback; kind: ModUiInteraction; element: string; value?: string }
  | { type: 'mod_ui'; subtype: 'detach'; client_id: string }

export type ModUiOutboundEvent =
  | { type: 'mod_ui'; subtype: 'render'; client_id: string; drawing: number; tree: unknown }
  | { type: 'mod_ui'; subtype: 'unmount'; client_id: string }

const surfaces = new Set(['desktop', 'mobile', 'vscode'])
const components = new Set([
  'AskUserQuestion', 'UserMessage', 'AssistantMessage', 'ToolUse', 'ToolResult',
  'ToolGroup', 'ToolProgress', 'CommandOutput', 'Spinner', 'TurnDuration',
  'InfoNotice', 'SessionMode', 'PromptHint', 'AbovePrompt', 'Pane',
])
const interactions = new Set(['press', 'input.change', 'input.submit', 'select'])

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validInput(value: unknown, surface: string): value is ModRenderInput {
  if (!record(value) || value.surface !== surface || !components.has(String(value.component)) ||
      typeof value.requestId !== 'string' || value.requestId === '' || !record(value.props)) return false
  if (value.viewport !== undefined) {
    if (!record(value.viewport) || !Number.isInteger(value.viewport.columns) || (value.viewport.columns as number) < 1 ||
        !Number.isInteger(value.viewport.rows) || (value.viewport.rows as number) < 1 ||
        value.viewport.isFullscreen !== undefined && typeof value.viewport.isFullscreen !== 'boolean') return false
  }
  return true
}

export function isModUiInboundEvent(value: unknown): value is ModUiInboundEvent {
  if (!record(value) || value.type !== 'mod_ui' || typeof value.client_id !== 'string' || value.client_id === '') return false
  if (value.subtype === 'detach') return true
  if (value.subtype === 'attach' || value.subtype === 'update') {
    return typeof value.surface === 'string' && surfaces.has(value.surface) && validInput(value.input, value.surface)
  }
  if (value.subtype !== 'interact' || !Number.isInteger(value.drawing) || (value.drawing as number) < 1 ||
      !record(value.callback) || typeof value.callback.plugin !== 'string' ||
      !Number.isInteger(value.callback.handle) || (value.callback.handle as number) < 1 ||
      typeof value.kind !== 'string' || !interactions.has(value.kind) ||
      typeof value.element !== 'string' || value.element === '') return false
  return value.kind === 'press' ? value.value === undefined : typeof value.value === 'string'
}

/** Replaces runtime-only engine references and rejects values that cannot cross JSON transport. */
export function materializeModUiTree(tree: unknown, resolveEngine: (ref: number) => unknown): unknown {
  const active = new Set<object>()
  function visit(value: unknown): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('Mod UI tree numbers must be finite')
      return value
    }
    if (Array.isArray(value)) {
      if (active.has(value)) throw new TypeError('Mod UI tree must not be cyclic')
      active.add(value)
      const output = value.map(visit)
      active.delete(value)
      return output
    }
    if (!record(value)) throw new TypeError('Mod UI tree must be JSON-safe')
    if (value.type === 'engine') {
      if (!Number.isInteger(value.ref) || (value.ref as number) < 0)
        throw new TypeError('Mod UI engine ref must be a non-negative integer')
      return visit(resolveEngine(value.ref as number))
    }
    if (active.has(value)) throw new TypeError('Mod UI tree must not be cyclic')
    active.add(value)
    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue
      output[key] = visit(child)
    }
    active.delete(value)
    return output
  }
  return visit(tree)
}

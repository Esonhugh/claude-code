import { HOOK_EVENTS, type HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { AppState } from 'src/state/AppState.js'
import type { Message } from 'src/types/message.js'
import { logForDebugging } from '../debug.js'
import type { AggregatedHookResult } from '../hooks.js'
import type { HookCommand } from '../settings/types.js'
import { isHookEqual } from './hooksSettings.js'

type OnHookSuccess = (
  hook: HookCommand | FunctionHook,
  result: AggregatedHookResult,
) => void

/** Function hook callback - returns true if check passes, false to block */
export type FunctionHookCallback = (
  messages: Message[],
  signal?: AbortSignal,
) => boolean | Promise<boolean>

/**
 * Function hook type with callback embedded.
 * Session-scoped only, cannot be persisted to settings.json.
 */
export type FunctionHook = {
  type: 'function'
  id?: string // Optional unique ID for removal
  timeout?: number
  callback: FunctionHookCallback
  errorMessage: string
  statusMessage?: string
}

type SessionHookMatcher = {
  matcher: string
  skillRoot?: string
  hooks: Array<{
    hook: HookCommand | FunctionHook
    onHookSuccess?: OnHookSuccess
  }>
}

export type SessionStore = {
  hooks: {
    [event in HookEvent]?: SessionHookMatcher[]
  }
}

/**
 * Map (not Record) so .set/.delete don't change the container's identity.
 * Mutator functions mutate the Map and return prev unchanged, letting
 * store.ts's Object.is(next, prev) check short-circuit and skip listener
 * notification. Session hooks are ephemeral per-agent runtime callbacks,
 * never reactively read (only getAppState() snapshots in the query loop).
 * Same pattern as agentControllers on LocalWorkflowTaskState.
 *
 * This matters under high-concurrency workflows: parallel() with N
 * schema-mode agents fires N addFunctionHook calls in one synchronous
 * tick. With a Record + spread, each call cost O(N) to copy the growing
 * map (O(N²) total) plus fired all ~30 store listeners. With Map: .set()
 * is O(1), return prev means zero listener fires.
 */
export type SessionHooksState = Map<string, SessionStore>

/**
 * Add a command or prompt hook to the session.
 * Session hooks are temporary, in-memory only, and cleared when session ends.
 */
export function addSessionHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  hook: HookCommand,
  onHookSuccess?: OnHookSuccess,
  skillRoot?: string,
): void {
  addHookToSession(
    setAppState,
    sessionId,
    event,
    matcher,
    hook,
    onHookSuccess,
    skillRoot,
  )
}

/**
 * Add a function hook to the session.
 * Function hooks execute TypeScript callbacks in-memory for validation.
 * @returns The hook ID (for removal)
 */
export function addFunctionHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  callback: FunctionHookCallback,
  errorMessage: string,
  options?: {
    timeout?: number
    id?: string
  },
): string {
  const id = options?.id || `function-hook-${Date.now()}-${Math.random()}`
  const hook: FunctionHook = {
    type: 'function',
    id,
    timeout: options?.timeout || 5000,
    callback,
    errorMessage,
  }
  addHookToSession(setAppState, sessionId, event, matcher, hook)
  return id
}

/**
 * Remove a function hook by ID from the session.
 */
export function removeFunctionHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  hookId: string,
): void {
  setAppState((prev) => {
    const store = prev.sessionHooks.get(sessionId)
    if (!store) {
      return prev
    }

    const eventMatchers = store.hooks[event] || []

    // Remove the hook with matching ID from all matchers
    const updatedMatchers = eventMatchers
      .map((matcher) => {
        const updatedHooks = matcher.hooks.filter((h) => {
          if (h.hook.type !== 'function') return true
          return h.hook.id !== hookId
        })

        return updatedHooks.length > 0
          ? { ...matcher, hooks: updatedHooks }
          : null
      })
      .filter((m): m is SessionHookMatcher => m !== null)

    const newHooks =
      updatedMatchers.length > 0
        ? { ...store.hooks, [event]: updatedMatchers }
        : Object.fromEntries(
            Object.entries(store.hooks).filter(([e]) => e !== event),
          )

    prev.sessionHooks.set(sessionId, { hooks: newHooks })
    return prev
  })

  logForDebugging(
    `Removed function hook ${hookId} for event ${event} in session ${sessionId}`,
  )
}

/**
 * Internal helper to add a hook to session state
 */
function addHookToSession(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  hook: HookCommand | FunctionHook,
  onHookSuccess?: OnHookSuccess,
  skillRoot?: string,
): void {
  setAppState((prev) => {
    const store = prev.sessionHooks.get(sessionId) ?? { hooks: {} }
    const eventMatchers = store.hooks[event] || []

    // Find existing matcher or create new one
    const existingMatcherIndex = eventMatchers.findIndex(
      (m) => m.matcher === matcher && m.skillRoot === skillRoot,
    )

    let updatedMatchers: SessionHookMatcher[]
    if (existingMatcherIndex >= 0) {
      // Add to existing matcher
      updatedMatchers = [...eventMatchers]
      const existingMatcher = updatedMatchers[existingMatcherIndex]!
      updatedMatchers[existingMatcherIndex] = {
        matcher: existingMatcher.matcher,
        skillRoot: existingMatcher.skillRoot,
        hooks: [...existingMatcher.hooks, { hook, onHookSuccess }],
      }
    } else {
      // Create new matcher
      updatedMatchers = [
        ...eventMatchers,
        {
          matcher,
          skillRoot,
          hooks: [{ hook, onHookSuccess }],
        },
      ]
    }

    const newHooks = { ...store.hooks, [event]: updatedMatchers }

    prev.sessionHooks.set(sessionId, { hooks: newHooks })
    return prev
  })

  logForDebugging(
    `Added session hook for event ${event} in session ${sessionId}`,
  )
}

export function removeSessionHooksBySource(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  skillRoot: string,
): void {
  setAppState((prev) => {
    const store = prev.sessionHooks.get(sessionId)
    if (!store) return prev

    const updatedMatchers = (store.hooks[event] ?? []).filter(
      (matcher) => matcher.skillRoot !== skillRoot,
    )
    const newHooks = { ...store.hooks }
    if (updatedMatchers.length > 0) newHooks[event] = updatedMatchers
    else delete newHooks[event]

    prev.sessionHooks.set(sessionId, { ...store, hooks: newHooks })
    return prev
  })

  logForDebugging(
    `Removed session hooks for event ${event} and source ${skillRoot} in session ${sessionId}`,
  )
}

/**
 * Remove a specific hook from the session
 * @param setAppState The function to update the app state
 * @param sessionId The session ID
 * @param event The hook event
 * @param hook The hook command to remove
 */
export function removeSessionHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  hook: HookCommand,
  skillRoot?: string,
  matcherFilter?: string,
): void {
  setAppState((prev) => {
    const store = prev.sessionHooks.get(sessionId)
    if (!store) {
      return prev
    }

    const eventMatchers = store.hooks[event] || []

    const updatedMatchers = eventMatchers
      .map((matcher) => {
        if (
          (skillRoot !== undefined && matcher.skillRoot !== skillRoot) ||
          (matcherFilter !== undefined && matcher.matcher !== matcherFilter)
        ) {
          return matcher
        }
        const updatedHooks = matcher.hooks.filter(
          (h) => h.hook !== hook && !isHookEqual(h.hook, hook),
        )

        return updatedHooks.length > 0
          ? { ...matcher, hooks: updatedHooks }
          : null
      })
      .filter((m): m is SessionHookMatcher => m !== null)

    const newHooks =
      updatedMatchers.length > 0
        ? { ...store.hooks, [event]: updatedMatchers }
        : { ...store.hooks }

    if (updatedMatchers.length === 0) {
      delete newHooks[event]
    }

    prev.sessionHooks.set(sessionId, { ...store, hooks: newHooks })
    return prev
  })

  logForDebugging(
    `Removed session hook for event ${event} in session ${sessionId}`,
  )
}

// Extended hook matcher that includes optional skillRoot for skill-scoped hooks
export type SessionDerivedHookMatcher = {
  matcher: string
  hooks: HookCommand[]
  skillRoot?: string
}

export type SessionExecutionHookMatcher = SessionDerivedHookMatcher & {
  sessionHook: true
  onHookSuccesses: Array<OnHookSuccess | undefined>
}

/**
 * Convert session hook matchers to regular hook matchers
 * @param sessionMatchers The session hook matchers to convert
 * @returns Regular hook matchers (with optional skillRoot preserved)
 */
function convertToHookMatchers(
  sessionMatchers: SessionHookMatcher[],
): SessionDerivedHookMatcher[] {
  return sessionMatchers.map((sm) => ({
    matcher: sm.matcher,
    skillRoot: sm.skillRoot,
    hooks: sm.hooks
      .map(({ hook }) => hook)
      .filter((hook): hook is HookCommand => hook.type !== 'function'),
  }))
}

function convertToExecutionHookMatchers(
  sessionMatchers: SessionHookMatcher[],
): SessionExecutionHookMatcher[] {
  return sessionMatchers.map((sm) => {
    const commandHooks = sm.hooks.filter(({ hook }) => hook.type !== 'function')
    return {
      matcher: sm.matcher,
      skillRoot: sm.skillRoot,
      sessionHook: true,
      hooks: commandHooks.map(({ hook }) => hook) as HookCommand[],
      onHookSuccesses: commandHooks.map(({ onHookSuccess }) => onHookSuccess),
    }
  })
}

/**
 * Get all session hooks for a specific event (excluding function hooks)
 * @param appState The app state
 * @param sessionId The session ID
 * @param event Optional event to filter by
 * @returns Hook matchers for the event, or all hooks if no event specified
 */
export function getSessionHooks(
  appState: AppState,
  sessionId: string,
  event?: HookEvent,
): Map<HookEvent, SessionDerivedHookMatcher[]> {
  return getSessionHooksWithConverter(
    appState,
    sessionId,
    convertToHookMatchers,
    event,
  )
}

export function getSessionExecutionHooks(
  appState: AppState,
  sessionId: string,
  event?: HookEvent,
): Map<HookEvent, SessionExecutionHookMatcher[]> {
  return getSessionHooksWithConverter(
    appState,
    sessionId,
    convertToExecutionHookMatchers,
    event,
  )
}

function getSessionHooksWithConverter<T>(
  appState: AppState,
  sessionId: string,
  convert: (matchers: SessionHookMatcher[]) => T[],
  event?: HookEvent,
): Map<HookEvent, T[]> {
  const store = appState.sessionHooks.get(sessionId)
  if (!store) {
    return new Map()
  }

  const result = new Map<HookEvent, T[]>()

  if (event) {
    const sessionMatchers = store.hooks[event]
    if (sessionMatchers) {
      result.set(event, convert(sessionMatchers))
    }
    return result
  }

  for (const evt of HOOK_EVENTS) {
    const sessionMatchers = store.hooks[evt]
    if (sessionMatchers) {
      result.set(evt, convert(sessionMatchers))
    }
  }

  return result
}

type FunctionHookMatcher = {
  matcher: string
  hooks: FunctionHook[]
}

/**
 * Get all session function hooks for a specific event
 * Function hooks are kept separate because they can't be persisted to HookMatcher format.
 * @param appState The app state
 * @param sessionId The session ID
 * @param event Optional event to filter by
 * @returns Function hook matchers for the event
 */
export function getSessionFunctionHooks(
  appState: AppState,
  sessionId: string,
  event?: HookEvent,
): Map<HookEvent, FunctionHookMatcher[]> {
  const store = appState.sessionHooks.get(sessionId)
  if (!store) {
    return new Map()
  }

  const result = new Map<HookEvent, FunctionHookMatcher[]>()

  const extractFunctionHooks = (
    sessionMatchers: SessionHookMatcher[],
  ): FunctionHookMatcher[] => {
    return sessionMatchers
      .map((sm) => ({
        matcher: sm.matcher,
        hooks: sm.hooks
          .map((h) => h.hook)
          .filter((h): h is FunctionHook => h.type === 'function'),
      }))
      .filter((m) => m.hooks.length > 0)
  }

  if (event) {
    const sessionMatchers = store.hooks[event]
    if (sessionMatchers) {
      const functionMatchers = extractFunctionHooks(sessionMatchers)
      if (functionMatchers.length > 0) {
        result.set(event, functionMatchers)
      }
    }
    return result
  }

  for (const evt of HOOK_EVENTS) {
    const sessionMatchers = store.hooks[evt]
    if (sessionMatchers) {
      const functionMatchers = extractFunctionHooks(sessionMatchers)
      if (functionMatchers.length > 0) {
        result.set(evt, functionMatchers)
      }
    }
  }

  return result
}

/**
 * Get the full hook entry (including callbacks) for a specific session hook
 */
export function getSessionHookBySource(
  appState: AppState,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  skillRoot: string,
):
  | {
      hook: HookCommand
      onHookSuccess?: OnHookSuccess
      skillRoot: string
    }
  | undefined {
  const eventMatchers = appState.sessionHooks.get(sessionId)?.hooks[event]
  const matcherEntry = eventMatchers?.find(
    (entry) => entry.matcher === matcher && entry.skillRoot === skillRoot,
  )
  const hookEntry = matcherEntry?.hooks.find(
    (entry): entry is { hook: HookCommand; onHookSuccess?: OnHookSuccess } =>
      entry.hook.type !== 'function',
  )
  return hookEntry ? { ...hookEntry, skillRoot } : undefined
}


/**
 * Clear all session hooks for a specific session
 * @param setAppState The function to update the app state
 * @param sessionId The session ID
 */
export function clearSessionHooks(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
): void {
  setAppState((prev) => {
    prev.sessionHooks.delete(sessionId)
    return prev
  })

  logForDebugging(`Cleared all session hooks for session ${sessionId}`)
}

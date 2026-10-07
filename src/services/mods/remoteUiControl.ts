import { logForDebugging } from '../../utils/debug.js'
import type { SDKControlRequest } from '../../entrypoints/sdk/controlTypes.js'
import {
  SDKControlUIRequestSchema,
  SDKControlUIClientFaultRequestSchema,
} from '../../entrypoints/sdk/controlSchemas.js'
import type { SDKUIInvalidateMessage, SDKUIPanesMessage, SDKUIScrollMessage, SDKControlUIPanesResponse } from '../../entrypoints/sdk/modsControlTypes.js'
import type { ModsRuntime } from './runtime.js'
import { createModRemoteRenderer } from './remoteUiRender.js'

export const modUIAttachError =
  'ui_attach: surface must be "desktop", "mobile" or "vscode", client_id 1-64 of letters, digits, . _ - (the colon is the engine\'s), viewport (when given) positive integer columns and rows with isFullscreen (when given) a boolean, and answers (when given) a list of "ui_copy", "ui_prompt_read", "ui_prompt_fill", "ui_prompt_suggest", "ui_read_selection"'
export const modUIDetachError =
  "ui_detach: client_id must be 1-64 of letters, digits, . _ - (the colon is the engine's)"
export const modUIRenderError =
  'ui_render: surface must be "desktop", "mobile" or "vscode", component a render site name, instance_id a string, props an object, client_id (when given) 1-64 safe characters, viewport (when given) positive integer columns and rows with isFullscreen (when given) a boolean, and on_screen (when given) null or integers first <= last < of'
const errors: Record<string, string> = {
  ui_scroll: 'ui_scroll: component must be "Pane" or "AbovePrompt", instance_id a string of at most 256 characters, offset, body_rows and content_rows non-negative integers, by an integer, pointer (when given) integer column and row, keyed (when given) at most 512 of {plugin, key, top, bottom}, surface (when given) "desktop", "mobile" or "vscode"',
  ui_panes: 'ui_panes: client_id (when given) 1-64 safe characters',
  ui_pane_show: 'ui_pane_show: id must be 1-64 of letters, digits, _ or -',
  ui_pane_focus: 'ui_pane_focus: id must be null or 1-64 of letters, digits, _ or -, surface (when given) "desktop", "mobile" or "vscode"',
  ui_close: 'ui_close: id must be 1-64 of letters, digits, _ or -',
  ui_attach: modUIAttachError,
  ui_detach: modUIDetachError,
  ui_render: modUIRenderError,
  ui_press:
    'ui_press: plugin must be a string, handle an integer, key (when given) a string, surface (when given) "desktop", "mobile" or "vscode" and href (when given) a string of at most 2048 characters',
  ui_input:
    'ui_input: plugin must be a string, handle an integer, kind "change" or "submit", value a string of at most 16384 characters, key (when given) a string, component (when given) a render site name, instance_id (when given) a string and surface (when given) "desktop", "mobile" or "vscode"',
  ui_select:
    'ui_select: plugin must be a string, handle an integer, value a string of at most 16384 characters, key (when given) a string, component (when given) a render site name, instance_id (when given) a string and surface (when given) "desktop", "mobile" or "vscode"',
  ui_client_module: 'ui_client_module: plugin must be a string',
  ui_client_press:
    'ui_client_press: plugin, instance_id, client, module and element must be strings, component a render site name, and event {type: "press"} | {type: "input", kind, value} | {type: "select", value}',
  ui_client_fault: 'ui_client_fault: malformed',
  ui_message:
    'ui_message: plugin, instance_id, client and module must be strings, component a render site name, and data present (plain JSON)',
}

/** These controls describe an SDK connection, independently of individual drawings. */
export function createModRemoteUIControl(options: {
  ready?(): Promise<void>
  invalidate?(
    message: Omit<SDKUIInvalidateMessage, 'uuid' | 'session_id'>,
  ): void
  panes?(message: Omit<SDKUIPanesMessage, 'uuid' | 'session_id'>): void
  scroll?(message: Omit<SDKUIScrollMessage, 'uuid' | 'session_id'>): void
  runtime(): ModsRuntime | undefined
  success(message: SDKControlRequest, response: Record<string, unknown>): void
  error(message: SDKControlRequest, reason: string): void
}) {
  const subscriptions = new Map<ModsRuntime, () => void>()
  const panePublications = new Map<ModsRuntime, number>()
  const publishPanes = (runtime: ModsRuntime, state = paneState(runtime)) => {
    panePublications.set(runtime, (panePublications.get(runtime) ?? 0) + 1)
    options.panes?.({type: 'system', subtype: 'ui_panes', ...state})
  }
  const paneState = (runtime: ModsRuntime): SDKControlUIPanesResponse => {
    const state = runtime.ui.paneState()
    return {
      panes: state.panes.map(({closeOnEscape, holdToasts, ...pane}) => ({...pane,
        ...(closeOnEscape ? {close_on_escape: true as const} : {}),
        ...(holdToasts ? {hold_toasts: true as const} : {}),
      })),
      shown_id: state.shownId, focused_id: state.focusedId, focus_requested_id: state.focusRequestedId,
    }
  }
  const observePanes = (runtime: ModsRuntime) => {
    if (subscriptions.has(runtime)) return
    let previous = JSON.stringify(paneState(runtime))
    const stopPanes = runtime.ui.subscribe(() => {
      const state = paneState(runtime)
      const next = JSON.stringify(state)
      if (next === previous) return
      previous = next
      logForDebugging(`[ModsUIPanes] changed count=${state.panes.length} shown=${state.shown_id} focused=${state.focused_id} requested=${state.focus_requested_id}`)
      publishPanes(runtime, state)
    })
    const stopScroll = runtime.remoteScroll.subscribe(message => options.scroll?.(message))
    subscriptions.set(runtime, () => { stopPanes(); stopScroll() })
  }
  const pending = new Set<Promise<void>>()
  const jobs = new Map<string, { cancelled: boolean }>()
  const renderers = new Map<
    ModsRuntime,
    ReturnType<typeof createModRemoteRenderer>
  >()
  const rendererFor = (runtime: ModsRuntime) => {
    let renderer = renderers.get(runtime)
    if (!renderer) {
      renderer = createModRemoteRenderer(runtime, {
        invalidate: (instances) =>
          options.invalidate?.({
            type: 'system',
            subtype: 'ui_invalidate',
            event: 'ui.render',
            ...(instances === undefined ? {} : { instances }),
          }),
      })
      renderers.set(runtime, renderer)
    }
    return renderer
  }
  return {
    connect(): void {
      const runtime = options.runtime()
      if (!runtime || subscriptions.has(runtime)) return
      observePanes(runtime)
      const state = paneState(runtime)
      if (state.panes.length) publishPanes(runtime, state)
    },
    async settle(): Promise<void> {
      await Promise.allSettled([...pending])
    },
    cancel(requestId: string): void {
      const job = jobs.get(requestId)
      if (job) job.cancelled = true
    },
    async dispose(): Promise<void> {
      for (const job of jobs.values()) job.cancelled = true
      await Promise.all(
        [...renderers.values()].map((renderer) => renderer.dispose()),
      )
      renderers.clear()
      for (const unsubscribe of subscriptions.values()) unsubscribe()
      subscriptions.clear()
      panePublications.clear()
    },
    handleRequest(message: SDKControlRequest): boolean {
      const subtype = message.request.subtype
      if (!Object.hasOwn(errors, subtype)) return false
      if (subtype === 'ui_client_fault') {
        const fault = SDKControlUIClientFaultRequestSchema().safeParse(
          message.request,
        )
        if (!fault.success) {
          const first = fault.error.issues[0]
          options.error(
            message,
            first
              ? `ui_client_fault: ${first.path.join('.') || 'request'}: ${first.message}`
              : errors[subtype]!,
          )
          return true
        }
      }
      const parsed = SDKControlUIRequestSchema().safeParse(message.request)
      if (!parsed.success) {
        options.error(message, errors[subtype]!)
        return true
      }
      const cancellable = !['ui_scroll', 'ui_client_fault', 'ui_panes', 'ui_pane_show', 'ui_pane_focus', 'ui_close'].includes(subtype)
      const previous = jobs.get(message.request_id)
      if (previous && cancellable) previous.cancelled = true
      const job = { cancelled: false }
      // Official fault observations do not register a cancellable control job.
      if (cancellable) jobs.set(message.request_id, job)
      const success = (value: Record<string, unknown>) => {
        if (!job.cancelled) options.success(message, value)
      }
      const failure = (error: unknown) => {
        if (!job.cancelled)
          options.error(
            message,
            error instanceof Error ? error.message : String(error),
          )
      }
      const apply = () => {
        const runtime = options.runtime()
        if (!runtime) {
          failure(`${subtype}: Mods session is unavailable`)
          return
        }
        try {
          observePanes(runtime)
          const request = parsed.data
          if (request.subtype === 'ui_scroll') {
            return runtime.remoteScroll.report(request).then(result => success({...result}), failure)
          } else if (request.subtype === 'ui_panes') {
            success({...paneState(runtime)})
          } else if (request.subtype === 'ui_pane_show') {
            success({shown_id: runtime.ui.showPane(request.id)})
          } else if (request.subtype === 'ui_pane_focus') {
            success({focused_id: runtime.ui.focusPane(request.id)})
          } else if (request.subtype === 'ui_close') {
            return runtime.ui.closePane(request.id).then(closed => success({closed}), failure)
          } else if (request.subtype === 'ui_attach') {
            const before = panePublications.get(runtime) ?? 0
            const result = runtime.remoteClients.attach({
              surface: request.surface,
              clientId: request.client_id,
              ...(request.viewport === undefined
                ? {}
                : { viewport: request.viewport }),
              ...(request.answers === undefined
                ? {}
                : { answers: request.answers }),
            })
            success({ surfaces: result.surfaces })
            // A layout client must receive the current roster even when placement did not change it.
            if (runtime.remoteClients.placesPanes(request.client_id) && (panePublications.get(runtime) ?? 0) === before)
              publishPanes(runtime)
          } else if (request.subtype === 'ui_detach') {
            const result = runtime.remoteClients.detach(request.client_id)
            success({ detached: result.detached, surfaces: result.surfaces })
          } else if (request.subtype === 'ui_client_module') {
            const bundle = runtime.clientModule(request.plugin)
            if (bundle) success({ ...bundle })
            else
              failure(
                `ui_client_module: plugin ${request.plugin} is not loaded or its hooks module names no surface module`,
              )
          } else if (request.subtype === 'ui_client_fault') {
            return rendererFor(runtime)
              .clientFault(request)
              .then(success, failure)
          } else if (request.subtype === 'ui_client_press') {
            return rendererFor(runtime)
              .clientPress({ ...request, event: request.event! })
              .then(success, failure)
          } else if (request.subtype === 'ui_message') {
            return rendererFor(runtime)
              .clientMessage(request)
              .then(success, failure)
          } else if (request.subtype === 'ui_render') {
            return rendererFor(runtime)
              .render(request)
              .then((result) => {
                if (
                  runtime.remoteClients.has(
                    request.client_id ?? `${request.surface}:default`,
                  )
                )
                  success({ ...result })
              }, failure)
          } else if (
            request.subtype === 'ui_press' ||
            request.subtype === 'ui_input' ||
            request.subtype === 'ui_select'
          ) {
            return rendererFor(runtime).interact(request).then(success, failure)
          }
        } catch (error) {
          failure(error)
        }
      }
      const work = options.ready
        ? Promise.resolve()
            .then(() => options.ready!())
            .then(apply, failure)
        : Promise.resolve(apply())
      pending.add(work)
      const finish = () => {
        pending.delete(work)
        if (jobs.get(message.request_id) === job)
          jobs.delete(message.request_id)
      }
      void work.then(finish, finish)
      return true
    },
  }
}

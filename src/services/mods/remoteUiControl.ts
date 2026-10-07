import type { SDKControlRequest } from '../../entrypoints/sdk/controlTypes.js'
import { SDKControlUIAttachRequestSchema, SDKControlUIDetachRequestSchema } from '../../entrypoints/sdk/controlSchemas.js'
import type { ModsRuntime } from './runtime.js'

export const modUIAttachError = 'ui_attach: surface must be "desktop", "mobile" or "vscode", client_id 1-64 of letters, digits, . _ - (the colon is the engine\'s), viewport (when given) positive integer columns and rows with isFullscreen (when given) a boolean, and answers (when given) a list of "ui_copy", "ui_prompt_read", "ui_prompt_fill", "ui_prompt_suggest", "ui_read_selection"'
export const modUIDetachError = 'ui_detach: client_id must be 1-64 of letters, digits, . _ - (the colon is the engine\'s)'

/** These controls describe an SDK connection, independently of individual drawings. */
export function createModRemoteUIControl(options: {
  ready?(): Promise<void>
  runtime(): ModsRuntime | undefined
  success(message: SDKControlRequest, response: Record<string, unknown>): void
  error(message: SDKControlRequest, reason: string): void
}) {
  const pending = new Set<Promise<void>>()
  return {
    async settle(): Promise<void> { await Promise.allSettled([...pending]) },
    handleRequest(message: SDKControlRequest): boolean {
      const subtype = message.request.subtype
      if (subtype !== 'ui_attach' && subtype !== 'ui_detach') return false
      const parsed = subtype === 'ui_attach'
        ? SDKControlUIAttachRequestSchema().safeParse(message.request)
        : SDKControlUIDetachRequestSchema().safeParse(message.request)
      if (!parsed.success) {
        options.error(message, subtype === 'ui_attach' ? modUIAttachError : modUIDetachError)
        return true
      }
      const apply = () => {
        const runtime = options.runtime()
        if (!runtime) {
          options.error(message, `${subtype}: Mods session is unavailable`)
          return
        }
        try {
          const request = parsed.data
          if (request.subtype === 'ui_attach') {
            const result = runtime.remoteClients.attach({
              surface:request.surface, clientId:request.client_id,
              ...(request.viewport === undefined ? {} : {viewport:request.viewport}),
              ...(request.answers === undefined ? {} : {answers:request.answers}),
            })
            options.success(message, {surfaces:result.surfaces})
          } else {
            const result = runtime.remoteClients.detach(request.client_id)
            options.success(message, {detached:result.detached, surfaces:result.surfaces})
          }
        } catch (error) {
          options.error(message, error instanceof Error ? error.message : String(error))
        }
      }
      const work = options.ready
        ? Promise.resolve().then(() => options.ready!()).then(apply, error => {
          options.error(message, error instanceof Error ? error.message : String(error))
        })
        : Promise.resolve(apply())
      pending.add(work)
      void work.then(() => pending.delete(work), () => pending.delete(work))
      return true
    },
  }
}

import type {
  SDKUIAnswer,
  SDKUIRemoteSurface,
} from '../../entrypoints/sdk/modsControlTypes.js'
import {
  emptyPromptBox,
  type ModPromptHost,
  type PromptBox,
  type PromptFillResult,
} from './promptAdapter.js'
import { normalizePromptDecorations } from './promptEdit.js'
import type { ModUiSelection } from './uiSelection.js'

export const MOD_REMOTE_ASK_TIMEOUT_MS = 5000
const REMOTE_TEXT_LIMIT = 1_000_000

export type ModRemoteAnsweringClient = { clientId: string; surface: SDKUIRemoteSurface }
/** The client's answer, or undefined when it timed out, refused or answered unparsably. */
export type ModRemoteUiAsk = (
  request: { subtype: Exclude<SDKUIAnswer, 'ui_prompt_paint'>; surface: SDKUIRemoteSurface; client_id: string } & Record<string, unknown>,
) => Promise<Record<string, unknown> | undefined>

/**
 * Engine -> client asks for a headless session (official 2.1.316): each goes only to a client
 * whose ui_attach named it under `answers`. Over the spawning host's pipes only the first such
 * client is asked; ui_read_selection asks all of them at once and takes the first selection.
 */
export function createModRemoteUiHost({
  clients,
  ask,
}: {
  clients(answer: SDKUIAnswer, surface?: SDKUIRemoteSurface): readonly ModRemoteAnsweringClient[]
  ask: ModRemoteUiAsk
}) {
  const askFirst = (answer: Exclude<SDKUIAnswer, 'ui_prompt_paint'>, fields: Record<string, unknown> = {}, surface?: SDKUIRemoteSurface) => {
    const client = clients(answer, surface)[0]
    return client
      ? ask({ subtype: answer, surface: client.surface, client_id: client.clientId, ...fields })
      : Promise.resolve(undefined)
  }
  const prompt: ModPromptHost = {
    remote: true,
    async read(): Promise<PromptBox> {
      const answer = await askFirst('ui_prompt_read')
      if (typeof answer?.text !== 'string' || typeof answer.cursor !== 'number') return emptyPromptBox()
      return { text: answer.text, cursor: Math.min(answer.cursor, answer.text.length) }
    },
    async fill(input): Promise<PromptFillResult> {
      if (!clients('ui_prompt_fill').length) return { isFilled: false, refusal: 'no_composer' }
      if (input.text.length > REMOTE_TEXT_LIMIT) return { isFilled: false }
      const decorations = normalizePromptDecorations(input.decorations, input.text)
      const answer = await askFirst('ui_prompt_fill', {
        text: input.text,
        mode: input.mode,
        ...(decorations.length ? { decorations } : {}),
      })
      return { isFilled: answer?.filled === true }
    },
    async suggest(text) {
      if (text.length > REMOTE_TEXT_LIMIT) return false
      return (await askFirst('ui_prompt_suggest', { text }))?.shown === true
    },
  }
  return {
    prompt,
    /** undefined when no client on that surface answers ui_copy. */
    async copy(text: string, surface: SDKUIRemoteSurface, plugin: string): Promise<boolean | undefined> {
      if (!clients('ui_copy', surface).length) return undefined
      if (text.length > REMOTE_TEXT_LIMIT) return false
      return (await askFirst('ui_copy', { plugin, text }, surface))?.copied === true
    },
    async selection(): Promise<ModUiSelection | undefined> {
      const asks = clients('ui_read_selection').map(async client => {
        const answer = await ask({ subtype: 'ui_read_selection', surface: client.surface, client_id: client.clientId })
        if (typeof answer?.text !== 'string' || answer.text === '') throw new Error('nothing selected')
        return typeof answer.instance_id === 'string' && answer.instance_id !== ''
          ? { text: answer.text, requestId: answer.instance_id }
          : { text: answer.text }
      })
      return Promise.any(asks).catch(() => undefined)
    },
  }
}

import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'
import type { SDKControlSSHFileSuggestionsResponse } from '../entrypoints/sdk/controlTypes.js'
import type {
  SSHFileSuggestionQuery,
  SSHSessionManager,
} from '../ssh/SSHSessionManager.js'

export type RemoteFileSuggestionProvider = (
  request: SSHFileSuggestionQuery,
  signal: AbortSignal,
) => Promise<SDKControlSSHFileSuggestionsResponse>

export function createRemoteFileSuggestionProvider(
  manager: Pick<SSHSessionManager, 'getFileSuggestions'>,
): RemoteFileSuggestionProvider {
  return (request, signal) => manager.getFileSuggestions(request, signal)
}

export type RemoteFileSuggestionResult = {
  items: SuggestionItem[]
  incomplete: boolean
}

export function toRemoteFileSuggestionResult(
  response: SDKControlSSHFileSuggestionsResponse,
): RemoteFileSuggestionResult {
  return {
    incomplete: response.incomplete,
    items: response.items.map(item => {
      const displayText =
        item.kind === 'directory' && !item.path.endsWith('/')
          ? `${item.path}/`
          : item.path
      return {
        id: `file-${displayText}`,
        displayText,
        metadata: {
          type: item.kind,
          ...(item.score === undefined ? {} : { score: item.score }),
        },
      }
    }),
  }
}

export function toRemoteFileSuggestionItems(
  response: SDKControlSSHFileSuggestionsResponse,
): SuggestionItem[] {
  return toRemoteFileSuggestionResult(response).items
}

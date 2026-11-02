import { getClientType } from '../bootstrap/state.js'
import {
  getRemoteSessionUrl,
  isRemoteSessionLocal,
} from '../constants/product.js'
import { TERMINAL_OUTPUT_TAGS } from '../constants/xml.js'
import type { AppState } from '../state/AppState.js'
import { isUndercover } from './undercover.js'
import { isAnt } from 'src/utils/userType.js'


export {
  projectAttributionText,
  type AttributionTextKind,
} from '../services/mods/attributionText.js'

export type AttributionTexts = {
  commit: string
  pr: string
}

/**
 * Commit and PR attribution. Settings cannot add any (no Co-Authored-By); only
 * a remote session links back to itself.
 */
export function getAttributionTexts(): AttributionTexts {
  if (getClientType() !== 'remote' || (isAnt() && isUndercover())) {
    return { commit: '', pr: '' }
  }
  const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
  const ingressUrl = process.env.SESSION_INGRESS_URL
  // Skip for local dev - URLs won't persist
  if (!remoteSessionId || isRemoteSessionLocal(remoteSessionId, ingressUrl)) {
    return { commit: '', pr: '' }
  }
  const sessionUrl = getRemoteSessionUrl(remoteSessionId, ingressUrl)
  return { commit: sessionUrl, pr: sessionUrl }
}

/**
 * Check if a message content string is terminal output rather than a user prompt.
 * Terminal output includes bash input/output tags and caveat messages about local commands.
 */
function isTerminalOutput(content: string): boolean {
  for (const tag of TERMINAL_OUTPUT_TAGS) {
    if (content.includes(`<${tag}>`)) {
      return true
    }
  }
  return false
}

/**
 * Count user messages with visible text content in a list of non-sidechain messages.
 * Excludes tool_result blocks, terminal output, and empty messages.
 *
 * Callers should pass messages already filtered to exclude sidechain messages.
 */
export function countUserPromptsInMessages(
  messages: ReadonlyArray<{ type: string; message?: { content?: unknown } }>,
): number {
  let count = 0

  for (const message of messages) {
    if (message.type !== 'user') {
      continue
    }

    const content = message.message?.content
    if (!content) {
      continue
    }

    let hasUserText = false

    if (typeof content === 'string') {
      if (isTerminalOutput(content)) {
        continue
      }
      hasUserText = content.trim().length > 0
    } else if (Array.isArray(content)) {
      hasUserText = content.some(block => {
        if (!block || typeof block !== 'object' || !('type' in block)) {
          return false
        }
        return (
          (block.type === 'text' &&
            typeof block.text === 'string' &&
            !isTerminalOutput(block.text)) ||
          block.type === 'image' ||
          block.type === 'document'
        )
      })
    }

    if (hasUserText) {
      count++
    }
  }

  return count
}

export async function getEnhancedPRAttribution(
  _getAppState: () => AppState,
): Promise<string> {
  return getAttributionTexts().pr
}

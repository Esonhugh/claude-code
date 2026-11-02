/**
 * Clear command - minimal metadata only.
 * Implementation is lazy-loaded from clear.ts to reduce startup time.
 * Utility functions:
 * - clearSessionCaches: import from './clear/caches.js'
 * - clearConversation: import from './clear/conversation.js'
 */
import type { Command } from '../../commands.js'

const clear = {
  type: 'local',
  name: 'clear',
  description:
    'Start a new session with empty context; previous session stays on disk (resumable with /resume)',
  argumentHint: '[name]',
  aliases: ['reset', 'new'],
  supportsNonInteractive: true,
  load: () => import('./clear.js'),
} satisfies Command

export default clear

// Past tense verbs for turn completion messages
// These verbs work naturally with "for [duration]" (e.g., "Worked for 5s")
export const TURN_COMPLETION_VERBS = [
  'Baked',
  'Brewed',
  'Churned',
  'Cogitated',
  'Cooked',
  'Crunched',
  'Sautéed',
  'Worked',
]

/** Same UTF-16 hash as the native 2.1.292 completion row; stable across remounts. */
export function getTurnCompletionVerb(uuid: string): string {
  let hash = 0
  for (let i = 0; i < uuid.length; i++) hash = ((hash << 5) - hash + uuid.charCodeAt(i)) | 0
  return TURN_COMPLETION_VERBS[(hash >>> 0) % TURN_COMPLETION_VERBS.length] ?? 'Worked'
}

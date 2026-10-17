import type { ToolUseContext } from '../../Tool.js'

export type AttributionTextKind = 'commit' | 'pr' | 'exemption' | 'remedy'

type AttributionTextResult = { text: string }

// Attribution text is embedded in the /commit and /commit-push-pr prompts,
// which expand ```! blocks and !`...` spans through the shell with git and gh
// commands pre-approved. Engine text never carries these markers, so a Mod
// must not be able to introduce them.
const SHELL_MARKERS = /```!|(?:^|\s)!`/m

function validateText(text: string): void {
  if (SHELL_MARKERS.test(text)) {
    throw new Error('attribution.text must not contain shell command markers')
  }
}

function validateResult(value: unknown): asserts value is AttributionTextResult {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as { text?: unknown }).text !== 'string'
  ) {
    throw new TypeError('attribution.text must return { text }')
  }
  validateText((value as AttributionTextResult).text)
}

export async function projectAttributionText(
  context: Pick<ToolUseContext, 'mods' | 'modsSnapshot' | 'abortController'>,
  kind: AttributionTextKind,
  text: string,
): Promise<string> {
  const signal = context.abortController.signal
  signal.throwIfAborted()
  if (!(context.modsSnapshot ?? context.mods)?.hasHooks('attribution.text')) {
    return text
  }

  const snapshot = context.modsSnapshot ?? context.mods!.capture()
  const input = { kind, text }
  try {
    const result = await snapshot.dispatch(
      'attribution.text',
      input,
      async value => ({ text: value.text }),
      {
        signal,
        validateInput: value => {
          if (value.kind !== kind) {
            throw new Error('attribution.text cannot rewrite kind')
          }
          if (typeof value.text !== 'string') {
            throw new TypeError('attribution.text requires text')
          }
          validateText(value.text)
        },
        validateResult,
      },
    )
    signal.throwIfAborted()
    validateResult(result)
    return result.text
  } finally {
    if (!context.modsSnapshot) snapshot.release()
  }
}

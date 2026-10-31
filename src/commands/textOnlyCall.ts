import type {
  LocalCommandResult,
  LocalJSXCommandOnDone,
} from '../types/command.js'

/**
 * Runs the text path of an interactive command for a headless session: the
 * command reports through onDone and renders nothing.
 */
export async function textOnlyCall(
  run: (onDone: LocalJSXCommandOnDone) => Promise<unknown>,
): Promise<LocalCommandResult> {
  let text = ''
  await run(result => {
    text = result ?? ''
  })
  return { type: 'text', value: text }
}

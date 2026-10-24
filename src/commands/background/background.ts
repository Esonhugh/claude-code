import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import { formatBackgroundedHint, spawnBackgroundSession } from '../../cli/bg.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { errorMessage } from '../../utils/errors.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { isHumanTurn } from '../../utils/messagePredicates.js'
import { flushSessionStorage } from '../../utils/sessionStorage.js'
import type { Message } from '../../types/message.js'

/** The first prompt names the background session, like a fresh `--bg` one. */
function firstPrompt(messages: Message[]): string | undefined {
  for (const message of messages) {
    if (!isHumanTurn(message)) continue
    const content = message.message.content
    const text =
      typeof content === 'string'
        ? content
        : content.find(block => block.type === 'text')?.text
    if (text && !text.startsWith('<')) return text.split('\n')[0]!.slice(0, 60)
  }
  return undefined
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const prompt = args.trim() || undefined
  const appState = context.getAppState()
  // The worker resumes this conversation with the same mode and model.
  const flags = ['--permission-mode', appState.toolPermissionContext.mode]
  if (appState.mainLoopModelForSession) flags.push('--model', appState.mainLoopModelForSession)
  try {
    await flushSessionStorage()
    const job = await spawnBackgroundSession({
      cwd: getOriginalCwd(),
      flags,
      prompt,
      sessionId: getSessionId(),
      name: firstPrompt(context.messages),
      origin: `transient — started on-demand by /background (pid ${process.pid}) in ${getOriginalCwd()}`,
    })
    const hint = formatBackgroundedHint(job.id)
    onDone(hint, { display: 'system' })
    // Let the hint render before the REPL exits; fullscreen leaves the
    // alternate screen, so it is printed again after that.
    await new Promise(resolve => setTimeout(resolve, 100))
    await gracefulShutdown(0, 'other', {
      ...(isFullscreenEnvEnabled() && { finalMessage: hint }),
      skipResumeHint: true,
    })
  } catch (error) {
    onDone(`Could not send this session to the background: ${errorMessage(error)}`, { display: 'system' })
  }
  return null
}

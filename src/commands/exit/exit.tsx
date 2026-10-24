import { feature } from 'bun:bundle'
import sample from 'lodash-es/sample.js'
import * as React from 'react'
import { ExitFlow } from '../../components/ExitFlow.js'
import { detachAttachedClients } from '../../daemon/protocol.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { isBgSession } from '../../utils/concurrentSessions.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { getCurrentWorktreeSession } from '../../utils/worktree.js'

const GOODBYE_MESSAGES = ['Goodbye!', 'See ya!', 'Bye!', 'Catch you later!']

function getRandomGoodbyeMessage(): string {
  return sample(GOODBYE_MESSAGES) ?? 'Goodbye!'
}

export async function call(
  onDone: LocalJSXCommandOnDone,
): Promise<React.ReactNode> {
  // Inside a background session: detach instead of kill. The REPL keeps
  // running; `claude attach` can reconnect. Covers /exit, /quit, ctrl+c,
  // ctrl+d — all funnel through here via REPL's handleExit.
  if (feature('BG_SESSIONS') && isBgSession()) {
    onDone()
    detachAttachedClients()
    return null
  }

  const showWorktree = getCurrentWorktreeSession() !== null

  if (showWorktree) {
    return (
      <ExitFlow
        showWorktree={showWorktree}
        onDone={onDone}
        onCancel={() => onDone()}
      />
    )
  }

  onDone(getRandomGoodbyeMessage())
  await gracefulShutdown(0, 'prompt_input_exit')
  return null
}

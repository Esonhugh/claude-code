import sample from 'lodash-es/sample.js'
import React from 'react'
import type { BackgroundWorkItem } from '../tasks/backgroundWorkOnExit.js'
import { gracefulShutdown } from '../utils/gracefulShutdown.js'
import { BackgroundWorkExitDialog } from './BackgroundWorkExitDialog.js'
import { WorktreeExitDialog } from './WorktreeExitDialog.js'

const GOODBYE_MESSAGES = ['Goodbye!', 'See ya!', 'Bye!', 'Catch you later!']

function getRandomGoodbyeMessage(): string {
  return sample(GOODBYE_MESSAGES) ?? 'Goodbye!'
}

type Props = {
  onDone: (message?: string) => void
  onCancel?: () => void
  showWorktree: boolean
  backgroundWork?: BackgroundWorkItem[]
}

export function ExitFlow({
  showWorktree,
  backgroundWork,
  onDone,
  onCancel,
}: Props): React.ReactNode {
  async function onExit(resultMessage?: string) {
    onDone(resultMessage ?? getRandomGoodbyeMessage())
    await gracefulShutdown(0, 'prompt_input_exit')
  }

  if (showWorktree) {
    return <WorktreeExitDialog onDone={onExit} onCancel={onCancel} />
  }

  if (backgroundWork && backgroundWork.length > 0) {
    return (
      <BackgroundWorkExitDialog
        items={backgroundWork}
        onExit={() => void onExit()}
        onCancel={() => onCancel?.()}
      />
    )
  }

  return null
}

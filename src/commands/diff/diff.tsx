import * as React from 'react'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getIsGit } from '../../utils/git.js'
import { MIN_DIFF_SIDEBAR_COLUMNS } from './index.js'

export const call: LocalJSXCommandCall = async (onDone, context) => {
  const current = context.getAppState()
  if (current.diffSidebarVisible) {
    context.diff?.setOpenPreference(false)
    context.setAppState(previous => ({
      ...previous,
      diffSidebarVisible: false,
    }))
    onDone('Diff sidebar hidden', { display: 'system' })
    return null
  }

  if (context.diff) {
    await context.diff.refresh()
    const data = context.diff.getSnapshot().data
    if (data.outcome !== 'data') {
      onDone(data.outcome === 'no-repository'
        ? 'Diff is unavailable outside a git repository.'
        : `Diff is unavailable: ${data.error ?? 'Git did not return a diff'}`, { display: 'system' })
      return null
    }
  } else if (!(await getIsGit())) {
    onDone('Diff is unavailable outside a git repository.', {
      display: 'system',
    })
    return null
  }

  const presentation = context.modCommand?.presentation
  const hasVisibleModDock = context.mods?.ui
    .getSnapshot()
    .some(pane => pane.visible && pane.placement === 'dock')
  if (
    presentation?.isFullscreen === true &&
    presentation.columns >= MIN_DIFF_SIDEBAR_COLUMNS &&
    !hasVisibleModDock
  ) {
    context.diff?.setOpenPreference(true)
    context.setAppState(previous => ({
      ...previous,
      diffSidebarVisible: true,
    }))
    onDone('Diff sidebar shown', { display: 'system' })
    return null
  }

  const { DiffDialog } = await import('../../components/diff/DiffDialog.js')
  if (hasVisibleModDock) {
    context.addNotification?.({
      key: 'diff-sidebar-mod-dock',
      text: 'A Mods dock is visible; opened the diff dialog instead.',
      priority: 'medium',
    })
  }
  return <DiffDialog messages={context.messages} controller={context.diff} onDone={onDone} />
}

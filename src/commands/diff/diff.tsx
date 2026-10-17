import * as React from 'react'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getIsGit } from '../../utils/git.js'
import { MIN_DIFF_SIDEBAR_COLUMNS } from './index.js'

export const call: LocalJSXCommandCall = async (onDone, context) => {
  if (context.mods?.isDiffOwned?.()) {
    onDone(undefined, {display:'skip'})
    return null
  }
  const current = context.getAppState()
  const presentation = context.modCommand?.presentation
  const hasVisibleModDock = context.mods?.ui
    .getSnapshot()
    .some(pane => pane.visible && pane.placement === 'dock')
  const sidebarCanRender =
    (presentation?.columns ?? 0) >= MIN_DIFF_SIDEBAR_COLUMNS &&
    !hasVisibleModDock
  if (current.diffSidebarVisible && sidebarCanRender) {
    context.diff?.setOpenPreference(false)
    context.setAppState(previous => ({
      ...previous,
      diffSidebarVisible: false,
    }))
    onDone('Diff panel hidden', { display: 'system' })
    return null
  }
  if (current.diffSidebarVisible) {
    context.diff?.setOpenPreference(false)
    context.setAppState(previous => ({
      ...previous,
      diffSidebarVisible: false,
    }))
  }

  if (!context.diff) {
    const isGit = await getIsGit()
    if (context.mods?.isDiffOwned?.()) {
      onDone(undefined, {display:'skip'})
      return null
    }
    if (!isGit) {
      onDone('Diff is unavailable outside a git repository.', {
        display: 'system',
      })
      return null
    }
  }

  if (sidebarCanRender) {
    context.diff?.setOpenPreference(true)
    context.setAppState(previous => ({
      ...previous,
      diffSidebarVisible: true,
    }))
    onDone('Diff panel shown', { display: 'system' })
    if (context.diff) {
      void context.diff.refresh().then(() => {
        if (context.mods?.isDiffOwned?.()) return
        const data = context.diff?.getSnapshot().data
        const text = data?.outcome === 'no-repository'
          ? 'Diff is unavailable outside a git repository.'
          : data?.outcome === 'unavailable'
            ? `Diff is unavailable: ${data.error ?? 'Git did not return a diff'}`
            : undefined
        if (text) {
          context.addNotification?.({
            key: 'diff-refresh',
            text,
            priority: 'medium',
          })
        }
      })
    }
    return null
  }

  if (context.diff) {
    await context.diff.refresh()
    if (context.mods?.isDiffOwned?.()) {
      onDone(undefined, {display:'skip'})
      return null
    }
    const data = context.diff.getSnapshot().data
    if (data.outcome !== 'data') {
      onDone(data.outcome === 'no-repository'
        ? 'Diff is unavailable outside a git repository.'
        : `Diff is unavailable: ${data.error ?? 'Git did not return a diff'}`, { display: 'system' })
      return null
    }
  }

  const { DiffDialog } = await import('../../components/diff/DiffDialog.js')
  if (context.mods?.isDiffOwned?.()) {
    onDone(undefined, {display:'skip'})
    return null
  }
  if (hasVisibleModDock) {
    context.addNotification?.({
      key: 'diff-sidebar-mod-dock',
      text: 'A Mods dock is visible; opened the diff dialog instead.',
      priority: 'medium',
    })
  }
  return <DiffDialog messages={context.messages} controller={context.diff} onDone={onDone} />
}

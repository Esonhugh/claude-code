import { useEffect, useRef } from 'react'
import { getVisibleAgentTasks } from '../components/CoordinatorAgentStatusRows.js'
import { useAppState, useAppStateStore, useSetAppState } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'
import { getCwd } from '../utils/cwd.js'
import { logForDebugging } from '../utils/debug.js'
import {
  executeSubagentStatusLineCommand,
  type SubagentStatusLineDecorations,
} from '../utils/hooks.js'
import { getContextWindowForModel } from '../utils/context.js'
import { isLocalAgentTask } from '../tasks/LocalAgentTask/LocalAgentTask.js'

const FIRST_TICK_MS = 300
const TICK_MS = 5000
const MAX_TOKEN_SAMPLES = 16

function panelAgentTasks(state: AppState) {
  return getVisibleAgentTasks(state.tasks, state.viewingAgentTaskId).filter(
    isLocalAgentTask,
  )
}

function sameDecorations(
  a: SubagentStatusLineDecorations,
  b: SubagentStatusLineDecorations,
): boolean {
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every(key => a[key]?.content === b[key]?.content)
  )
}

/**
 * Official 2.1.303: while agent panel rows are visible, run
 * `subagentStatusLine` every 5s and store its per-row text in
 * AppState.taskDecorations.
 */
export function useSubagentStatusLine(columns: number): void {
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  const enabled = useAppState(
    s => s.settings?.subagentStatusLine?.command !== undefined,
  )
  const rowCount = useAppState(s => (enabled ? panelAgentTasks(s).length : 0))
  const running = useRef(false)
  const tokenSamples = useRef(new Map<string, number[]>())

  useEffect(() => {
    const clear = () =>
      setAppState(prev =>
        Object.keys(prev.taskDecorations).length === 0
          ? prev
          : { ...prev, taskDecorations: {} },
      )
    if (!enabled || rowCount === 0) {
      clear()
      return
    }
    let cancelled = false
    const tick = () => {
      if (running.current) return
      const state = store.getState()
      const tasks = panelAgentTasks(state)
      const samples = tokenSamples.current
      for (const task of tasks) {
        const list = samples.get(task.id) ?? []
        list.push(task.progress?.tokenCount ?? 0)
        samples.set(task.id, list.slice(-MAX_TOKEN_SAMPLES))
      }
      for (const id of samples.keys()) {
        if (!tasks.some(task => task.id === id)) samples.delete(id)
      }
      if (tasks.length === 0) {
        clear()
        return
      }
      const names = new Map<string, string>()
      for (const [name, id] of state.agentNameRegistry) names.set(id, name)
      const cwd = getCwd()
      running.current = true
      void executeSubagentStatusLineCommand({
        columns,
        tasks: tasks.map(task => ({
          id: task.id,
          name: names.get(task.agentId),
          type: task.type,
          agentType: task.agentType,
          status: task.status,
          description: task.description,
          label: task.progress?.summary || task.description,
          startTime: task.startTime,
          model: task.model,
          contextWindowSize: task.model
            ? getContextWindowForModel(task.model)
            : undefined,
          tokenCount: task.progress?.tokenCount ?? 0,
          tokenSamples: samples.get(task.id) ?? [],
          cwd,
        })),
      })
        .then(decorations => {
          if (cancelled) return
          const ids = new Set(tasks.map(task => task.id))
          const next: SubagentStatusLineDecorations = {}
          for (const [id, decoration] of Object.entries(decorations)) {
            if (ids.has(id)) next[id] = decoration
          }
          setAppState(prev =>
            sameDecorations(prev.taskDecorations, next)
              ? prev
              : { ...prev, taskDecorations: next },
          )
        })
        .catch(error => {
          logForDebugging(`subagentStatusLine tick failed: ${error}`, {
            level: 'error',
          })
        })
        .finally(() => {
          running.current = false
        })
    }
    const first = setTimeout(tick, FIRST_TICK_MS)
    const interval = setInterval(tick, TICK_MS)
    return () => {
      cancelled = true
      clearTimeout(first)
      clearInterval(interval)
    }
  }, [enabled, rowCount, columns, store, setAppState])
}

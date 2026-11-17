import { describe, expect, test } from 'bun:test'
import { getDefaultAppState, type AppState } from '../../state/AppStateStore.js'
import { getBackgroundWorkOnExit } from '../backgroundWorkOnExit.js'
import { getPillLabel } from '../pillLabel.js'
import { isBackgroundTask } from '../types.js'
import { endScriptTask, registerScriptTask, ScriptTask, type ScriptTaskState, UNNAMED_SCRIPT } from './ScriptTask.js'

function store() {
  let state: AppState = getDefaultAppState()
  return {
    get: () => state,
    set: (f: (prev: AppState) => AppState) => void (state = f(state)),
  }
}

const register = (s: ReturnType<typeof store>, description: string | undefined, controller = new AbortController()) => {
  const id = registerScriptTask(s.set, { description, toolUseId: 'toolu_1', abortController: controller })
  return { id, task: () => s.get().tasks[id] as ScriptTaskState }
}

describe('script background task (official 2.1.325 chunk-x5qyz3j2.js)', () => {
  test('a dispatched script is one running background task, labelled with its description', () => {
    const s = store()
    const { task } = register(s, 'Run the slow build\nsecond line')
    expect(task()).toMatchObject({ type: 'local_script', status: 'running', description: 'Run the slow build', outputFile: '' })
    const running = Object.values(s.get().tasks).filter(isBackgroundTask)
    expect(running).toHaveLength(1)
    expect(getPillLabel(running)).toBe('1 background task')
    expect(getBackgroundWorkOnExit(s.get().tasks)).toEqual([{ label: 'code', detail: 'Run the slow build' }])
  })

  test('without a description it is "started by Claude"; a long one is cut to 200 characters', () => {
    const s = store()
    expect(register(s, undefined).task().description).toBe(UNNAMED_SCRIPT)
    expect(register(s, '  ').task().description).toBe(UNNAMED_SCRIPT)
    expect(register(s, 'x'.repeat(250)).task().description).toBe(`${'x'.repeat(200)}\u2026`)
  })

  test('the first end wins and the task is notified at once', () => {
    const s = store()
    const { id, task } = register(s, 'build')
    expect(endScriptTask(id, s.set, 'killed')).toBe(true)
    expect(endScriptTask(id, s.set, 'completed')).toBe(false)
    expect(task()).toMatchObject({ status: 'killed', notified: true, abortController: undefined })
    expect(isBackgroundTask(task())).toBe(false)
  })

  test('kill stops the script as the user would', async () => {
    const s = store()
    const controller = new AbortController()
    const { id, task } = register(s, 'build', controller)
    await ScriptTask.kill(id, s.set)
    expect(controller.signal.reason).toBe('user-cancel')
    // The script's abort listener ends the task, not kill itself.
    expect(task().status).toBe('running')
  })
})

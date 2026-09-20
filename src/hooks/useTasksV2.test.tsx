import { expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scenarioKey = 'USE_TASKS_V2_TEST_SCENARIO'

if (!process.env[scenarioKey]) {
  test.each([
    'switch-session',
    'switch-hidden',
    'switch-completed',
    'stale-read',
    'stop',
    'clear',
  ])(
    'useTasksV2 lifecycle: %s (isolated)',
    async scenario => {
      const home = mkdtempSync(join(tmpdir(), 'use-tasks-v2-'))
      try {
        const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
          cwd: home,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            CLAUDE_CONFIG_DIR: join(home, 'config'),
            CLAUDE_CODE_ENABLE_TASKS: '1',
            CLAUDE_CODE_SIMPLE: '1',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            DISABLE_AUTOUPDATER: '1',
            [scenarioKey]: scenario,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
        expect(code).toBe(0)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    },
    20_000,
  )
} else {
  const React = await import('react')
  const { Writable } = await import('node:stream')
  const fsPromises = await import('node:fs/promises')
  const { default: render } = await import('../ink/root.js')
  const { AppStoreContext, getDefaultAppState } =
    await import('../state/AppState.js')
  const { createStore } = await import('../state/store.js')
  const {
    getSessionId,
    setCwdState,
    setOriginalCwd,
    switchSession,
  } = await import('../bootstrap/state.js')
  const { asSessionId } = await import('../types/ids.js')
  const { createTask, getTasksDir, updateTask } =
    await import('../utils/tasks.js')
  const { useTasksV2 } = await import('./useTasksV2.js')
  type Task = import('../utils/tasks.js').Task

  setOriginalCwd(process.cwd())
  setCwdState(process.cwd())

  const task = (subject: string) => ({
    subject,
    description: subject,
    activeForm: subject,
    status: 'pending' as const,
    blocks: [],
    blockedBy: [],
  })

  const waitFor = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + 2_000
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error('condition timed out')
      await Bun.sleep(10)
    }
  }

  const renderHook = async () => {
    let observed: Task[] | undefined
    function Capture() {
      observed = useTasksV2()
      return null
    }

    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    })
    const store = createStore(getDefaultAppState())
    const instance = await render(
      React.createElement(
        AppStoreContext.Provider,
        { value: store },
        React.createElement(Capture),
      ),
      {
        stdout: stdout as NodeJS.WriteStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )
    return { instance, getObserved: () => observed }
  }

  if (process.env[scenarioKey] === 'switch-session') {
    test('switchSession replaces the rendered task list', async () => {
      const oldSessionId = getSessionId()
      const oldTaskId = await createTask(oldSessionId, task('old task'))
      const newSessionId = asSessionId(randomUUID())
      await createTask(newSessionId, task('new task'))
      const { instance, getObserved } = await renderHook()

      try {
        await waitFor(() => getObserved()?.[0]?.subject === 'old task')
        await updateTask(oldSessionId, oldTaskId, { subject: 'old updated' })
        await waitFor(() => getObserved()?.[0]?.subject === 'old updated')

        switchSession(newSessionId)

        await waitFor(() => getObserved()?.[0]?.subject === 'new task')
        expect(getObserved()?.map(item => item.subject)).toEqual(['new task'])
      } finally {
        instance.unmount()
        instance.cleanup()
      }
    })
  }

  if (process.env[scenarioKey] === 'switch-hidden') {
    test('switchSession clears an empty list hidden state', async () => {
      const { instance, getObserved } = await renderHook()
      const newSessionId = asSessionId(randomUUID())
      await createTask(newSessionId, task('new task'))

      try {
        await waitFor(() => getObserved() === undefined)
        switchSession(newSessionId)
        await waitFor(() => getObserved()?.[0]?.subject === 'new task')
        expect(getObserved()?.map(item => item.subject)).toEqual(['new task'])
      } finally {
        instance.unmount()
        instance.cleanup()
      }
    })
  }

  if (process.env[scenarioKey] === 'switch-completed') {
    test('switching from an empty list shows completed tasks in the resumed list', async () => {
      const oldSessionId = getSessionId()
      const id = await createTask(oldSessionId, task('old task'))
      const newSessionId = asSessionId(randomUUID())
      await createTask(newSessionId, { ...task('completed task'), status: 'completed' })
      const { resetTaskList } = await import('../utils/tasks.js')
      const { instance, getObserved } = await renderHook()
      try {
        await waitFor(() => getObserved()?.[0]?.id === id)
        await resetTaskList(oldSessionId)
        await waitFor(() => getObserved() === undefined)
        switchSession(newSessionId)
        await waitFor(() => getObserved()?.[0]?.subject === 'completed task')
        expect(getObserved()?.[0]?.status).toBe('completed')
      } finally {
        instance.unmount()
        instance.cleanup()
      }
    })
  }

  if (process.env[scenarioKey] === 'stale-read') {
    test('an older task-list read cannot replace the switched list', async () => {
      const oldSessionId = getSessionId()
      await createTask(oldSessionId, task('old task'))
      const newSessionId = asSessionId(randomUUID())
      await createTask(newSessionId, task('new task'))
      const oldTasksDir = getTasksDir(oldSessionId)
      const originalReaddir = fsPromises.readdir
      let releaseOldRead = () => {}
      let oldReadStarted = false
      const oldReadGate = new Promise<void>(resolve => {
        releaseOldRead = resolve
      })
      const readdirSpy = spyOn(fsPromises, 'readdir').mockImplementation(
        (async (...args: Parameters<typeof fsPromises.readdir>) => {
          if (String(args[0]) === oldTasksDir) {
            oldReadStarted = true
            await oldReadGate
          }
          return originalReaddir(...args)
        }) as typeof fsPromises.readdir,
      )
      const { instance, getObserved } = await renderHook()

      try {
        await waitFor(() => oldReadStarted)
        switchSession(newSessionId)
        await waitFor(() => getObserved()?.[0]?.subject === 'new task')
        const newSnapshot = getObserved()

        releaseOldRead()
        await Bun.sleep(100)
        expect(getObserved()).toBe(newSnapshot)
        expect(getObserved()?.map(item => item.subject)).toEqual(['new task'])
      } finally {
        releaseOldRead()
        readdirSpy.mockRestore()
        instance.unmount()
        instance.cleanup()
      }
    })
  }

  if (process.env[scenarioKey] === 'stop') {
    test('a pending read cannot restart work after the hook unmounts', async () => {
      const sessionId = getSessionId()
      await createTask(sessionId, task('pending task'))
      const tasksDir = getTasksDir(sessionId)
      const originalReaddir = fsPromises.readdir
      let releaseRead = () => {}
      let readStarted = false
      let reads = 0
      const readGate = new Promise<void>(resolve => {
        releaseRead = resolve
      })
      const readdirSpy = spyOn(fsPromises, 'readdir').mockImplementation(
        (async (...args: Parameters<typeof fsPromises.readdir>) => {
          if (String(args[0]) === tasksDir) {
            reads++
            readStarted = true
            await readGate
          }
          return originalReaddir(...args)
        }) as typeof fsPromises.readdir,
      )
      const { instance } = await renderHook()

      try {
        await waitFor(() => readStarted)
        instance.unmount()
        instance.cleanup()
        releaseRead()
        await Bun.sleep(5_200)
        expect(reads).toBe(1)
      } finally {
        releaseRead()
        readdirSpy.mockRestore()
      }
    }, 10_000)
  }

  if (process.env[scenarioKey] === 'clear') {
    test('the clear command replaces the rendered task list', async () => {
      const oldSessionId = getSessionId()
      await createTask(oldSessionId, task('old task'))
      const { instance, getObserved } = await renderHook()

      try {
        await waitFor(() => getObserved()?.[0]?.subject === 'old task')
        const clearCommand = await import('../commands/clear/clear.js')
        const { createFileStateCacheWithSizeLimit } =
          await import('../utils/fileStateCache.js')
        await clearCommand.call('', {
          setMessages: () => {},
          readFileState: createFileStateCacheWithSizeLimit(10),
        } as unknown as Parameters<typeof clearCommand.call>[1])

        expect(getSessionId()).not.toBe(oldSessionId)
        await waitFor(() => getObserved() === undefined)
        expect(getObserved()).toBeUndefined()
      } finally {
        instance.unmount()
        instance.cleanup()
      }
    })
  }
}

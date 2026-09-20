import { describe, expect, jest, test } from 'bun:test'
import { DiffController } from './controller.js'

test('pane actions normalize selection when switching source and reset session-only state', () => {
  const diff = new DiffController({ cwd: '/synthetic' })
  diff.selectFile('sample.ts')
  diff.toggleNoise()
  diff.togglePreSession()
  diff.chooseSource(2)
  expect(diff.getSnapshot()).toMatchObject({
    source: 2,
    selectedPath: null,
    showNoise: true,
    showPreSession: true,
  })
  diff.toggleAsk(
    'sample.ts',
    [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ['-old', '+new'],
      },
    ],
    'Session',
  )
  diff.reset('/other')
  expect(diff.getSnapshot()).toMatchObject({
    source: null,
    selectedPath: null,
    showNoise: false,
    showPreSession: false,
    armedPath: null,
  })
  diff.dispose()
})

test('tool completions are main-loop observations, not replayed history or progress', () => {
  const diff = new DiffController({ cwd: '/synthetic' })
  const assistant = {
    type: 'assistant',
    uuid: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'edit-1',
          name: 'Edit',
          input: { file_path: 'sample.ts' },
        },
        {
          type: 'tool_use',
          id: 'edit-2',
          name: 'Edit',
          input: { file_path: 'denied.ts' },
        },
      ],
    },
  } as unknown as import('../../types/message.js').Message
  diff.observeMessage(assistant)
  expect(
    diff.observeMessage({
      type: 'progress',
    } as import('../../types/message.js').Message),
  ).toBeUndefined()
  const result = {
    type: 'user',
    uuid: 'result',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'edit-1', content: 'ok' },
      ],
    },
  } as unknown as import('../../types/message.js').Message
  expect(diff.observeMessage(result)).toEqual({ edited: true })
  expect(diff.observeMessage(result)).toBeUndefined()
  expect(
    diff.observeMessage({
      ...result,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'edit-2',
            content: 'denied',
            is_error: true,
          },
        ],
      },
    } as unknown as import('../../types/message.js').Message),
  ).toBeUndefined()
  diff.reset('/synthetic')
  expect(diff.observeMessage(result)).toBeUndefined()
  diff.dispose()
})

test('duplicate assistant/result pairs cannot trigger another edit observation', () => {
  const diff = new DiffController({ cwd: '/synthetic' })
  const assistant = {
    type: 'assistant',
    uuid: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'edit-once',
          name: 'Write',
          input: { file_path: 'sample.ts' },
        },
      ],
    },
  } as unknown as import('../../types/message.js').Message
  const result = {
    type: 'user',
    uuid: 'result',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'edit-once', content: 'ok' },
      ],
    },
  } as unknown as import('../../types/message.js').Message
  diff.observeMessage(assistant)
  expect(diff.observeMessage(result)).toEqual({ edited: true })
  diff.observeMessage(assistant)
  expect(diff.observeMessage(result)).toBeUndefined()
  diff.dispose()
})

test('diff loads lazily and retains last good files when Git becomes unavailable', async () => {
  let probes = 0
  let available = true
  const backend: import('../../utils/gitDiff.js').GitDiffBackend = {
    root: '/synthetic',
    headKey: async () => 'head',
    fetch: async mode =>
      available
        ? {
            kind: 'data',
            data: {
              root: '/synthetic',
              mode,
              stats: { filesCount: 1, linesAdded: 1, linesRemoved: 1 },
              files: [
                {
                  path: 'sample.ts',
                  added: 1,
                  removed: 1,
                  isBinary: false,
                  renamedFrom: null,
                  isUntracked: false,
                  isPreSession: false,
                },
              ],
              source: { kind: 'working-tree', base: 'HEAD' },
              baseRef: 'HEAD',
              isUnborn: false,
              stalePaths: [],
              isUntrackedWithheld: false,
              detailsOmitted: false,
            },
          }
        : { kind: 'unavailable', reason: 'temporary Git failure' },
    fetchBody: async () => ({
      status: 'ready',
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ['-old', '+new'],
        },
      ],
    }),
  }
  const diff = new DiffController({
    cwd: '/synthetic',
    createBackend: async () => {
      probes++
      return backend
    },
  })
  expect(probes).toBe(0)
  await diff.refresh()
  expect(probes).toBe(1)
  expect(diff.getSnapshot().data.isUnborn).toBe(false)
  expect(diff.getSnapshot().data.hunks.get('sample.ts')?.[0]?.lines).toEqual([
    '-old',
    '+new',
  ])
  available = false
  await diff.refresh()
  expect(diff.getSnapshot().data.outcome).toBe('unavailable')
  expect(diff.getSnapshot().data.files.map(file => file.path)).toEqual([
    'sample.ts',
  ])
  expect(probes).toBe(1)
  diff.dispose()
})

test('reset discards an old repository response even if it ignores cancellation', async () => {
  let resolveOld!: (
    value: import('../../utils/gitDiff.js').DiffFetchOutcome,
  ) => void
  const backend: import('../../utils/gitDiff.js').GitDiffBackend = {
    root: '/old',
    headKey: async () => 'old',
    fetchBody: async () => ({ status: 'no-body', hunks: [] }),
    fetch: () =>
      new Promise(resolve => {
        resolveOld = resolve
      }),
  }
  const diff = new DiffController({
    cwd: '/old',
    createBackend: async ({ cwd }) => (cwd === '/old' ? backend : null),
  })
  const old = diff.refresh()
  await Promise.resolve()
  diff.reset('/new')
  await diff.refresh()
  resolveOld({ kind: 'unavailable', reason: 'old repository failed' })
  await old
  expect(diff.getSnapshot().data.outcome).toBe('no-repository')
  expect(diff.getSnapshot().data.error).toBeUndefined()
  diff.dispose()
})

test('file bodies load with at most six requests in flight', async () => {
  let active = 0
  let peak = 0
  const backend: import('../../utils/gitDiff.js').GitDiffBackend = {
    root: '/synthetic',
    headKey: async () => 'head',
    fetch: async mode => ({
      kind: 'data',
      data: {
        root: '/synthetic',
        mode,
        stats: { filesCount: 16, linesAdded: 16, linesRemoved: 0 },
        files: Array.from({ length: 16 }, (_, i) => ({
          path: `${i}.ts`,
          added: 1,
          removed: 0,
          isBinary: false,
          renamedFrom: null,
          isUntracked: false,
          isPreSession: false,
        })),
        source: { kind: 'working-tree', base: 'HEAD' },
        baseRef: 'HEAD',
        isUnborn: false,
        stalePaths: [],
        isUntrackedWithheld: false,
        detailsOmitted: false,
      },
    }),
    fetchBody: async () => {
      active++
      peak = Math.max(peak, active)
      await Promise.resolve()
      active--
      return { status: 'no-body', hunks: [] }
    },
  }
  const diff = new DiffController({
    cwd: '/synthetic',
    createBackend: async () => backend,
  })
  await diff.refresh()
  expect(peak).toBeLessThanOrEqual(6)
  expect(diff.getSnapshot().data.files).toHaveLength(16)
  diff.dispose()
})

test('refresh requests coalesce without overlapping Git fetches', async () => {
  let active = 0
  let peak = 0
  const backend: import('../../utils/gitDiff.js').GitDiffBackend = {
    root: '/synthetic',
    headKey: async () => 'head',
    fetchBody: async () => ({ status: 'no-body', hunks: [] }),
    fetch: async () => {
      active++
      peak = Math.max(peak, active)
      await Promise.resolve()
      active--
      return { kind: 'unavailable', reason: 'fixture' }
    },
  }
  const diff = new DiffController({
    cwd: '/synthetic',
    createBackend: async () => backend,
  })
  await Promise.all([diff.refresh(), diff.refresh(), diff.refresh()])
  expect(peak).toBe(1)
  diff.dispose()
})

test('visible views share one polling lifecycle and release it on close', async () => {
  let probes = 0
  const diff = new DiffController({
    cwd: '/synthetic',
    createBackend: async () => {
      probes++
      return null
    },
  })
  const first = diff.watch()
  const second = diff.watch()
  await diff.refresh()
  expect(probes).toBe(1)
  expect(diff.getSnapshot().data.outcome).toBe('no-repository')
  first()
  second()
  diff.dispose()
})

test('closing and reopening during a refresh keeps exactly one polling loop', async () => {
  jest.useFakeTimers()
  let settle!: (
    value: import('../../utils/gitDiff.js').DiffFetchOutcome,
  ) => void
  let calls = 0
  const diff = new DiffController({
    cwd: '/synthetic',
    createBackend: async () => ({
      root: '/synthetic',
      headKey: async () => 'head',
      fetchBody: async () => ({ status: 'no-body', hunks: [] }),
      fetch: () => {
        calls++
        return calls === 1
          ? new Promise(resolve => {
              settle = resolve
            })
          : Promise.resolve({ kind: 'unavailable', reason: 'fixture' })
      },
    }),
  })
  try {
    const first = diff.watch()
    await Promise.resolve()
    first()
    const second = diff.watch()
    settle({ kind: 'unavailable', reason: 'fixture' })
    for (let i = 0; i < 12; i++) await Promise.resolve()
    const before = calls
    jest.advanceTimersByTime(2000)
    for (let i = 0; i < 12; i++) await Promise.resolve()
    expect(calls - before).toBe(1)
    second()
    jest.advanceTimersByTime(4000)
    expect(calls - before).toBe(1)
  } finally {
    diff.dispose()
    jest.useRealTimers()
  }
})

test('reset restarts a visible poll without waiting for an obsolete fetch', async () => {
  jest.useFakeTimers()
  let settle!: (
    value: import('../../utils/gitDiff.js').DiffFetchOutcome,
  ) => void
  let newCalls = 0
  const diff = new DiffController({
    cwd: '/old',
    createBackend: async ({ cwd }) => ({
      root: cwd,
      headKey: async () => 'head',
      fetchBody: async () => ({ status: 'no-body', hunks: [] }),
      fetch: () =>
        cwd === '/old'
          ? new Promise(resolve => {
              settle = resolve
            })
          : (newCalls++,
            Promise.resolve({ kind: 'unavailable', reason: 'fixture' })),
    }),
  })
  try {
    const stop = diff.watch()
    await Promise.resolve()
    diff.reset('/new')
    for (let i = 0; i < 12; i++) await Promise.resolve()
    expect(newCalls).toBe(1)
    settle({ kind: 'unavailable', reason: 'old' })
    for (let i = 0; i < 12; i++) await Promise.resolve()
    jest.advanceTimersByTime(2000)
    for (let i = 0; i < 12; i++) await Promise.resolve()
    expect(newCalls).toBe(2)
    stop()
  } finally {
    diff.dispose()
    jest.useRealTimers()
  }
})

test('base changes are saved and previous file selection is cleared', async () => {
  const modes: string[] = []
  const saved: string[] = []
  const backend: import('../../utils/gitDiff.js').GitDiffBackend = {
    root: '/synthetic',
    headKey: async () => 'head',
    fetchBody: async () => ({ status: 'no-body', hunks: [] }),
    fetch: async mode => {
      modes.push(mode)
      return { kind: 'unavailable', reason: 'fixture' }
    },
  }
  const diff = new DiffController({
    cwd: '/synthetic',
    createBackend: async () => backend,
    loadPreferences: () => ({ mode: 'uncommitted' }),
    savePreferences: (_root, value) => {
      if (value.mode) saved.push(value.mode)
    },
  })
  await diff.refresh()
  expect(diff.getSnapshot().mode).toBe('uncommitted')
  diff.selectFile('sample.ts')
  await diff.cycleBase()
  expect(diff.getSnapshot().selectedPath).toBeNull()
  expect(modes).toEqual(['uncommitted', 'branch'])
  expect(saved).toEqual(['branch'])
  diff.dispose()
})

test('automatic opening requires checkpointed main-loop edits and the correct width', async () => {
  let probes = 0
  const diff = new DiffController({
    cwd: '/synthetic',
    createBackend: async () => {
      probes++
      return {
        root: '/synthetic',
        headKey: async () => 'head',
        fetchBody: async () => ({ status: 'no-body', hunks: [] }),
        fetch: async mode => ({
          kind: 'data',
          data: {
            root: '/synthetic',
            mode,
            stats: { filesCount: 0, linesAdded: 0, linesRemoved: 0 },
            files: [],
            source: { kind: 'working-tree', base: 'HEAD' },
            baseRef: 'HEAD',
            isUnborn: false,
            stalePaths: [],
            isUntrackedWithheld: false,
            detailsOmitted: false,
          },
        }),
      }
    },
  })
  const surface = {
    columns: 144,
    isFullscreen: true,
    hasDock: false,
    checkpointing: true,
  }
  expect(await diff.autoOpen({ ...surface, columns: 143 })).toBe(false)
  expect(await diff.autoOpen({ ...surface, checkpointing: false })).toBe(
    false,
  )
  expect(await diff.autoOpen({ ...surface, hasDock: true })).toBe(false)
  expect(probes).toBe(0)
  expect(await diff.autoOpen(surface)).toBe(true)
  expect(await diff.autoOpen(surface)).toBe(false)
  expect(probes).toBe(1)
  diff.dispose()
})

test('a transient repository failure retries without poisoning the negative cache', async () => {
  let probes = 0
  const diff = new DiffController({
    cwd: '/synthetic',
    createBackend: async () => {
      probes++
      if (probes === 1) throw new Error('temporary probe failure')
      return null
    },
  })
  await diff.refresh()
  expect(diff.getSnapshot().data.outcome).toBe('unavailable')
  await diff.refresh()
  expect(diff.getSnapshot().data.outcome).toBe('no-repository')
  await diff.refresh()
  expect(probes).toBe(2)
  diff.dispose()
})

test('automatic opening rechecks pinned repository preferences from a subdirectory', async () => {
  const diff = new DiffController({
    cwd: '/synthetic/subdir',
    loadPreferences: root => (root === '/synthetic' ? { open: false } : {}),
    createBackend: async () => ({
      root: '/synthetic',
      headKey: async () => 'head',
      fetchBody: async () => ({ status: 'no-body', hunks: [] }),
      fetch: async mode => ({
        kind: 'data',
        data: {
          root: '/synthetic',
          mode,
          stats: { filesCount: 0, linesAdded: 0, linesRemoved: 0 },
          files: [],
          source: { kind: 'working-tree', base: 'HEAD' },
          baseRef: 'HEAD',
          isUnborn: false,
          stalePaths: [],
          isUntrackedWithheld: false,
          detailsOmitted: false,
        },
      }),
    }),
  })
  expect(
    await diff.autoOpen({
      columns: 144,
      isFullscreen: true,
      hasDock: false,
      checkpointing: true,
    }),
  ).toBe(false)
  diff.dispose()
})

test('closing while auto-open is preparing prevents a late reopen', async () => {
  let settle!: (
    value: import('../../utils/gitDiff.js').DiffFetchOutcome,
  ) => void
  const diff = new DiffController({
    cwd: '/synthetic',
    createBackend: async () => ({
      root: '/synthetic',
      headKey: async () => 'head',
      fetchBody: async () => ({ status: 'no-body', hunks: [] }),
      fetch: () =>
        new Promise(resolve => {
          settle = resolve
        }),
    }),
  })
  const opening = diff.autoOpen({
    columns: 144,
    isFullscreen: true,
    hasDock: false,
    checkpointing: true,
  })
  await Promise.resolve()
  diff.setOpenPreference(false)
  settle({
    kind: 'data',
    data: {
      root: '/synthetic',
      mode: 'session',
      stats: { filesCount: 0, linesAdded: 0, linesRemoved: 0 },
      files: [],
      source: { kind: 'working-tree', base: 'HEAD' },
      baseRef: 'HEAD',
      isUnborn: false,
      stalePaths: [],
      isUntrackedWithheld: false,
      detailsOmitted: false,
    },
  })
  expect(await opening).toBe(false)
  diff.dispose()
})

test('pre-session bodies stay lazy and showing them loads at most twenty files', async () => {
  const loaded: string[] = []
  const backend: import('../../utils/gitDiff.js').GitDiffBackend = {
    root: '/synthetic',
    headKey: async () => 'head',
    fetch: async mode => ({
      kind: 'data',
      data: {
        root: '/synthetic',
        mode,
        stats: { filesCount: 25, linesAdded: 25, linesRemoved: 0 },
        files: Array.from({ length: 25 }, (_, i) => ({
          path: `${i}.ts`,
          added: 1,
          removed: 0,
          isBinary: false,
          renamedFrom: null,
          isUntracked: false,
          isPreSession: true,
        })),
        source: { kind: 'working-tree', base: 'HEAD' },
        baseRef: 'HEAD',
        isUnborn: false,
        stalePaths: [],
        isUntrackedWithheld: false,
        detailsOmitted: false,
      },
    }),
    fetchBody: async (_data, file) => {
      loaded.push(file.path)
      return { status: 'ready', hunks: [] }
    },
  }
  const diff = new DiffController({
    cwd: '/synthetic',
    createBackend: async () => backend,
  })
  await diff.refresh()
  expect(loaded).toEqual([])
  await diff.togglePreSession()
  expect(loaded).toHaveLength(20)
  expect(diff.getSnapshot().data.files).toHaveLength(25)
  await diff.togglePreSession()
  await diff.togglePreSession()
  expect(loaded).toHaveLength(20)
  diff.dispose()
})

test('switching base does not publish an in-flight result from the old base', async () => {
  let settle!: (
    value: import('../../utils/gitDiff.js').DiffFetchOutcome,
  ) => void
  const diff = new DiffController({
    cwd: '/synthetic',
    createBackend: async () => ({
      root: '/synthetic',
      headKey: async () => 'head',
      fetchBody: async () => ({ status: 'no-body', hunks: [] }),
      fetch: mode =>
        mode === 'session'
          ? new Promise(resolve => {
              settle = resolve
            })
          : Promise.resolve({
              kind: 'unavailable',
              reason: 'new base unavailable',
            }),
    }),
  })
  const seen: string[] = []
  diff.subscribe(() => {
    seen.push(...diff.getSnapshot().data.files.map(file => file.path))
  })
  const refreshing = diff.refresh()
  await Promise.resolve()
  const switching = diff.cycleBase()
  settle({
    kind: 'data',
    data: {
      root: '/synthetic',
      mode: 'session',
      stats: { filesCount: 1, linesAdded: 1, linesRemoved: 0 },
      files: [
        {
          path: 'old-base.ts',
          added: 1,
          removed: 0,
          isBinary: false,
          renamedFrom: null,
          isUntracked: false,
          isPreSession: false,
        },
      ],
      source: { kind: 'working-tree', base: 'HEAD' },
      baseRef: 'HEAD',
      isUnborn: false,
      stalePaths: [],
      isUntrackedWithheld: false,
      detailsOmitted: false,
    },
  })
  await Promise.all([refreshing, switching])
  expect(seen).not.toContain('old-base.ts')
  expect(diff.getSnapshot().mode).toBe('uncommitted')
  diff.dispose()
})

test('stats are visible before a slow body finishes and partial bodies redraw within 100ms', async () => {
  jest.useFakeTimers()
  let start!: () => void
  const started = new Promise<void>(resolve => {
    start = resolve
  })
  let settle!: (value: import('../../utils/gitDiff.js').DiffBody) => void
  const diff = new DiffController({
    cwd: '/synthetic',
    createBackend: async () => ({
      root: '/synthetic',
      headKey: async () => 'head',
      fetch: async mode => ({
        kind: 'data',
        data: {
          root: '/synthetic',
          mode,
          stats: { filesCount: 2, linesAdded: 2, linesRemoved: 0 },
          files: ['fast.ts', 'slow.ts'].map(path => ({
            path,
            added: 1,
            removed: 0,
            isBinary: false,
            renamedFrom: null,
            isUntracked: false,
            isPreSession: false,
          })),
          source: { kind: 'working-tree', base: 'HEAD' },
          baseRef: 'HEAD',
          isUnborn: false,
          stalePaths: [],
          isUntrackedWithheld: false,
          detailsOmitted: false,
        },
      }),
      fetchBody: async (_data, file) =>
        file.path === 'fast.ts'
          ? { status: 'no-body', hunks: [] }
          : new Promise(resolve => {
              settle = resolve
              start()
            }),
    }),
  })
  try {
    const refreshing = diff.refresh()
    await started
    for (let i = 0; i < 4; i++) await Promise.resolve()
    expect(diff.getSnapshot().data.stats?.filesCount).toBe(2)
    jest.advanceTimersByTime(100)
    expect(diff.getSnapshot().data.files[0]?.bodyState).toBe('no-body')
    expect(diff.getSnapshot().data.files[1]?.bodyState).toBe('loading')
    settle({ status: 'ready', hunks: [] })
    await refreshing
    expect(diff.getSnapshot().data.files[1]?.bodyState).toBe('ready')
  } finally {
    diff.dispose()
    jest.useRealTimers()
  }
})

test('refresh clears a removed current-file selection but leaves turn selection alone', async () => {
  let present = true
  const diff = new DiffController({
    cwd: '/synthetic',
    createBackend: async () => ({
      root: '/synthetic',
      headKey: async () => 'head',
      fetchBody: async () => ({ status: 'no-body', hunks: [] }),
      fetch: async mode => ({
        kind: 'data',
        data: {
          root: '/synthetic',
          mode,
          stats: {
            filesCount: present ? 1 : 0,
            linesAdded: 0,
            linesRemoved: 0,
          },
          files: present
            ? [
                {
                  path: 'removed.ts',
                  added: 0,
                  removed: 0,
                  isBinary: false,
                  renamedFrom: null,
                  isUntracked: false,
                  isPreSession: false,
                },
              ]
            : [],
          source: { kind: 'working-tree', base: 'HEAD' },
          baseRef: 'HEAD',
          isUnborn: false,
          stalePaths: [],
          isUntrackedWithheld: false,
          detailsOmitted: false,
        },
      }),
    }),
  })
  await diff.refresh()
  diff.selectFile('removed.ts')
  present = false
  await diff.refresh()
  expect(diff.getSnapshot().selectedPath).toBeNull()
  diff.chooseSource(1)
  diff.selectFile('turn-only.ts')
  await diff.refresh()
  expect(diff.getSnapshot().selectedPath).toBe('turn-only.ts')
  diff.dispose()
})

test('refresh retains the last good body until its replacement is ready', async () => {
  let delay = false
  let start!: () => void
  const started = new Promise<void>(resolve => {
    start = resolve
  })
  let settle!: (value: import('../../utils/gitDiff.js').DiffBody) => void
  const diff = new DiffController({
    cwd: '/synthetic',
    createBackend: async () => ({
      root: '/synthetic',
      headKey: async () => 'head',
      fetch: async mode => ({
        kind: 'data',
        data: {
          root: '/synthetic',
          mode,
          stats: { filesCount: 1, linesAdded: 1, linesRemoved: 0 },
          files: [
            {
              path: 'sample.ts',
              added: 1,
              removed: 0,
              isBinary: false,
              renamedFrom: null,
              isUntracked: false,
              isPreSession: false,
            },
          ],
          source: { kind: 'working-tree', base: 'HEAD' },
          baseRef: 'HEAD',
          isUnborn: false,
          stalePaths: [],
          isUntrackedWithheld: false,
          detailsOmitted: false,
        },
      }),
      fetchBody: async () =>
        delay
          ? new Promise(resolve => {
              settle = resolve
              start()
            })
          : {
              status: 'ready',
              hunks: [
                {
                  oldStart: 0,
                  oldLines: 0,
                  newStart: 1,
                  newLines: 1,
                  lines: ['+last good'],
                },
              ],
            },
    }),
  })
  await diff.refresh()
  delay = true
  const refreshing = diff.refresh()
  await started
  expect(diff.getSnapshot().data.hunks.get('sample.ts')?.[0]?.lines).toEqual([
    '+last good',
  ])
  settle({
    status: 'ready',
    hunks: [
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        lines: ['+replacement'],
      },
    ],
  })
  await refreshing
  expect(diff.getSnapshot().data.hunks.get('sample.ts')?.[0]?.lines).toEqual([
    '+replacement',
  ])
  diff.dispose()
})

test('a failed body refresh preserves its last good hunks and remains retryable', async () => {
  let fail = false
  let calls = 0
  const diff = new DiffController({
    cwd: '/synthetic',
    createBackend: async () => ({
      root: '/synthetic',
      headKey: async () => 'head',
      fetch: async mode => ({
        kind: 'data',
        data: {
          root: '/synthetic',
          mode,
          stats: { filesCount: 1, linesAdded: 1, linesRemoved: 0 },
          files: [
            {
              path: 'sample.ts',
              added: 1,
              removed: 0,
              isBinary: false,
              renamedFrom: null,
              isUntracked: false,
              isPreSession: false,
            },
          ],
          source: { kind: 'working-tree', base: 'HEAD' },
          baseRef: 'HEAD',
          isUnborn: false,
          stalePaths: [],
          isUntrackedWithheld: false,
          detailsOmitted: false,
        },
      }),
      fetchBody: async () => {
        calls++
        return fail
          ? { status: 'unavailable', hunks: [], reason: 'temporary failure' }
          : {
              status: 'ready',
              hunks: [
                {
                  oldStart: 0,
                  oldLines: 0,
                  newStart: 1,
                  newLines: 1,
                  lines: ['+last good'],
                },
              ],
            }
      },
    }),
  })
  await diff.refresh()
  fail = true
  await diff.refresh()
  expect(diff.getSnapshot().data.files[0]?.bodyState).toBe('unavailable')
  expect(diff.getSnapshot().data.hunks.get('sample.ts')?.[0]?.lines).toEqual([
    '+last good',
  ])
  fail = false
  await diff.refresh()
  expect(diff.getSnapshot().data.files[0]?.bodyState).toBe('ready')
  expect(calls).toBe(3)
  diff.dispose()
})

test('disposing cancels deferred body loads without starting new work', async () => {
  let settle!: (value: import('../../utils/gitDiff.js').DiffBody) => void
  let start!: () => void
  const started = new Promise<void>(resolve => {
    start = resolve
  })
  let calls = 0
  const diff = new DiffController({
    cwd: '/synthetic',
    createBackend: async () => ({
      root: '/synthetic',
      headKey: async () => 'head',
      fetch: async mode => ({
        kind: 'data',
        data: {
          root: '/synthetic',
          mode,
          stats: { filesCount: 2, linesAdded: 2, linesRemoved: 0 },
          files: [false, true].map((isPreSession, i) => ({
            path: `${i}.ts`,
            added: 1,
            removed: 0,
            isBinary: false,
            renamedFrom: null,
            isUntracked: false,
            isPreSession,
          })),
          source: { kind: 'working-tree', base: 'HEAD' },
          baseRef: 'HEAD',
          isUnborn: false,
          stalePaths: [],
          isUntrackedWithheld: false,
          detailsOmitted: false,
        },
      }),
      fetchBody: () => {
        calls++
        return calls === 1
          ? new Promise(resolve => {
              settle = resolve
              start()
            })
          : Promise.resolve({ status: 'no-body', hunks: [] })
      },
    }),
  })
  const refreshing = diff.refresh()
  await started
  const showing = diff.togglePreSession()
  diff.dispose()
  settle({ status: 'no-body', hunks: [] })
  await Promise.all([refreshing, showing])
  expect(calls).toBe(1)
})

test('test and generated files are classified as noise and their bodies stay lazy', async () => {
  const paths = [
    'src/main.ts',
    'tests/example.ts',
    'src/example.test.ts',
    'dist/app.js',
    'package-lock.json',
    'schema.pb.go',
    'types.d.ts',
    'src/testing.ts',
  ]
  const loaded: string[] = []
  const diff = new DiffController({
    cwd: '/synthetic',
    createBackend: async () => ({
      root: '/synthetic',
      headKey: async () => 'head',
      fetch: async mode => ({
        kind: 'data',
        data: {
          root: '/synthetic',
          mode,
          stats: {
            filesCount: paths.length,
            linesAdded: paths.length,
            linesRemoved: 0,
          },
          files: paths.map(path => ({
            path,
            added: 1,
            removed: 0,
            isBinary: false,
            renamedFrom: null,
            isUntracked: false,
            isPreSession: false,
          })),
          source: { kind: 'working-tree', base: 'HEAD' },
          baseRef: 'HEAD',
          isUnborn: false,
          stalePaths: [],
          isUntrackedWithheld: false,
          detailsOmitted: false,
        },
      }),
      fetchBody: async (_data, file) => {
        loaded.push(file.path)
        return { status: 'no-body', hunks: [] }
      },
    }),
  })
  await diff.refresh()
  expect(loaded).toEqual(['src/main.ts', 'src/testing.ts'])
  expect(
    diff
      .getSnapshot()
      .data.files.filter(file => file.isNoise)
      .map(file => file.path),
  ).toEqual(paths.slice(1, -1))
  await diff.toggleNoise()
  expect(loaded).toHaveLength(paths.length)
  await diff.toggleNoise()
  await diff.toggleNoise()
  expect(loaded).toHaveLength(paths.length)
  diff.dispose()
})

test('diagnostics record categorical transitions without file or patch contents', async () => {
  const records: string[] = []
  const diff = new DiffController({
    cwd: '/private/repository',
    record: (event: string) => records.push(event),
    createBackend: async () => ({
      root: '/private/repository',
      headKey: async () => 'head',
      fetch: async mode => ({
        kind: 'data',
        data: {
          root: '/private/repository',
          mode,
          stats: { filesCount: 0, linesAdded: 0, linesRemoved: 0 },
          files: [],
          source: { kind: 'working-tree', base: 'HEAD' },
          baseRef: 'HEAD',
          isUnborn: false,
          stalePaths: [],
          isUntrackedWithheld: false,
          detailsOmitted: false,
        },
      }),
      fetchBody: async () => ({ status: 'no-body', hunks: [] }),
    }),
  })
  await diff.refresh()
  await diff.refresh()
  expect(records.filter(event => event.includes('fetch data'))).toHaveLength(
    1,
  )
  diff.setOpenPreference(true)
  await diff.cycleBase()
  diff.toggleAsk(
    'secret.ts',
    [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        lines: ['+private body'],
      },
    ],
    'Session',
  )
  diff.beginAsk([])!.finish(true)
  expect(records.some(event => event.includes('open user'))).toBe(true)
  expect(records.some(event => event.includes('base uncommitted'))).toBe(true)
  expect(records.some(event => event.includes('ask accepted'))).toBe(true)
  expect(records.join('\n')).not.toMatch(/private|secret/)
  diff.dispose()
})

describe('diff prompt attachment', () => {
  test('arming bounds the snapshot to 400 body lines including hunk headers', () => {
    const diff = new DiffController({ cwd: '/synthetic' })
    diff.toggleAsk(
      'large.ts',
      [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 700,
          lines: Array.from({ length: 700 }, (_, i) => `+line-${i}`),
        },
      ],
      'Turn 2',
    )
    const pending = diff.beginAsk([])!
    expect(pending.text).toContain('Turn 2')
    expect(pending.text).toContain('+line-398')
    expect(pending.text).not.toContain('+line-399')
    expect(pending.text.split('\n').slice(1)).toHaveLength(400)
    pending.finish(true)
    diff.dispose()
  })
  test('an accepted prompt consumes the armed snapshot exactly once', () => {
    const diff = new DiffController({ cwd: '/synthetic' })
    const hunks = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ['-before', '+after'],
      },
    ]
    diff.toggleAsk('sample.ts', hunks, 'Uncommitted changes')
    hunks[0]!.lines[1] = '+changed later'

    const pending = diff.beginAsk([])
    expect(pending?.text).toContain('+after')
    expect(pending?.text).not.toContain('changed later')
    expect(diff.beginAsk([])).toBeUndefined()
    pending!.finish(true)
    expect(diff.getSnapshot().armedPath).toBeNull()
    expect(diff.beginAsk([])).toBeUndefined()
    diff.dispose()
  })

  test('a rejected submission retains the snapshot and a settled lease cannot consume it later', () => {
    const diff = new DiffController({ cwd: '/synthetic' })
    diff.toggleAsk(
      'sample.ts',
      [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ['-old', '+new'],
        },
      ],
      'Session',
    )
    const first = diff.beginAsk([])!
    first.finish(false)
    expect(diff.getSnapshot().armedPath).toBe('sample.ts')
    const retry = diff.beginAsk([])!
    first.finish(true)
    expect(diff.getSnapshot().armedPath).toBe('sample.ts')
    expect(diff.beginAsk([])).toBeUndefined()
    retry.finish(true)
    expect(diff.getSnapshot().armedPath).toBeNull()
    diff.dispose()
  })

  test('prompt context leaves room only for complete diff lines and a truncation notice', () => {
    const diff = new DiffController({ cwd: '/synthetic' })
    const lines = Array.from(
      { length: 40 },
      (_, i) => `+${i}:${'x'.repeat(80)}`,
    )
    diff.toggleAsk(
      'sample.ts',
      [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 40, lines }],
      'Session',
    )
    const pending = diff.beginAsk(['x'.repeat(31_700)])!
    expect(pending.text.length).toBeLessThanOrEqual(300)
    expect(pending.text).toContain('truncated')
    for (const line of pending.text
      .split('\n')
      .filter(line => line.startsWith('+'))) {
      expect(lines).toContain(line)
    }
    pending.finish(true)
    diff.dispose()
  })

  test('an attachment with no room is dropped with a visible notification', () => {
    const notices: string[] = []
    const diff = new DiffController({
      cwd: '/synthetic',
      notify: text => notices.push(text),
    })
    diff.toggleAsk(
      'sample.ts',
      [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ['-old', '+new'],
        },
      ],
      'Session',
    )
    expect(diff.beginAsk(['x'.repeat(32_000)])).toBeUndefined()
    expect(diff.getSnapshot().armedPath).toBeNull()
    expect(notices).toEqual([
      "sample.ts's diff did not fit in the prompt and was dropped",
    ])
    diff.dispose()
  })

  test('finishing an older prompt cannot consume a newly armed file', () => {
    const diff = new DiffController({ cwd: '/synthetic' })
    const hunks = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ['-old', '+new'],
      },
    ]
    diff.toggleAsk('first.ts', hunks, 'Session')
    const first = diff.beginAsk([])!
    diff.toggleAsk('next.ts', hunks, 'Session')
    first.finish(true)
    expect(diff.getSnapshot().armedPath).toBe('next.ts')
    expect(diff.beginAsk([])?.text).toContain('next.ts')
    diff.dispose()
  })

  test('arming the same path toggles off even if its content changed', () => {
    const diff = new DiffController({ cwd: '/synthetic' })
    const hunks = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ['-old', '+new'],
      },
    ]
    diff.toggleAsk('sample.ts', hunks, 'Session')
    diff.toggleAsk('sample.ts', hunks, 'Branch')
    expect(diff.beginAsk([])).toBeUndefined()
    expect(diff.getSnapshot().armedPath).toBeNull()
    diff.dispose()
  })
})

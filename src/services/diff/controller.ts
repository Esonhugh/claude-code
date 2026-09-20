import type { StructuredPatchHunk } from 'diff'
import { isDiffNoise } from './classify.js'
import { logForDebugging } from '../../utils/debug.js'
import type { Message } from '../../types/message.js'
import type { DiffData } from '../../hooks/useDiffData.js'
import {
  createGitDiffBackend,
  type DiffBaseMode,
  type DiffBody,
  type DiffSnapshot,
  type GitDiffBackend,
} from '../../utils/gitDiff.js'

export type DiffPreferences = { mode?: DiffBaseMode; open?: boolean }

type Options = {
  cwd: string
  notify?: (message: string) => void
  record?: (event: string) => void
  sessionStartMs?: number
  createBackend?: typeof createGitDiffBackend
  loadPreferences?: (root: string) => DiffPreferences
  savePreferences?: (root: string, preferences: DiffPreferences) => void
}

export type DiffViewState = {
  mode: DiffBaseMode
  data: DiffData
  armedPath: string | null
  selectedPath: string | null
  source: number | null
  showNoise: boolean
  showPreSession: boolean
}

function initialState(): DiffViewState {
  return {
    mode: 'session',
    data: { stats: null, files: [], hunks: new Map(), loading: false },
    armedPath: null,
    selectedPath: null,
    source: null,
    showNoise: false,
    showPreSession: false,
  }
}

type ArmedAsk = { path: string; text: string }

export class DiffController {
  private state: DiffViewState = initialState()
  private listeners = new Set<() => void>()
  private armed: ArmedAsk | null = null
  private carrying: ArmedAsk | null = null
  private toolCalls = new Map<string, string>()
  private completedTools = new Set<string>()
  private backend: Promise<GitDiffBackend | null> | undefined
  private root: string | undefined
  private current:
    | {
        backend: GitDiffBackend
        snapshot: DiffSnapshot
        bodies: Map<string, DiffBody>
        loaded: Set<string>
      }
    | undefined
  private bodiesInFlight: Promise<void> | undefined
  private autoOpened = false
  private opening = false
  private sessionStartMs: number
  private epoch = 0
  private baseRevision = 0
  private abortController = new AbortController()
  private refreshInFlight: Promise<void> | undefined
  private refreshQueued = false
  private watchers = 0
  private watchRevision = 0
  private poll: ReturnType<typeof setTimeout> | undefined
  private debounce: ReturnType<typeof setTimeout> | undefined
  private redraw: ReturnType<typeof setTimeout> | undefined
  private lastFetchRecord: string | undefined

  private record(event: string): void {
    try {
      ;(this.options.record ?? logForDebugging)(`[diff] ${event}`)
    } catch {
      // Diagnostic sinks must not interrupt diff or prompt admission.
    }
  }

  constructor(private readonly options: Options) {
    this.sessionStartMs = options.sessionStartMs ?? Date.now()
  }

  get cwd(): string {
    return this.options.cwd
  }

  getSnapshot = (): DiffViewState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private update(patch: Partial<DiffViewState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  watch(): () => void {
    if (++this.watchers === 1) {
      this.watchRevision++
      void this.tick()
    }
    return () => {
      if (--this.watchers === 0) {
        this.watchRevision++
        clearTimeout(this.poll)
        clearTimeout(this.debounce)
      }
    }
  }

  private async tick(): Promise<void> {
    const epoch = this.epoch
    const watchRevision = this.watchRevision
    await this.refresh()
    if (
      this.watchers > 0 &&
      epoch === this.epoch &&
      watchRevision === this.watchRevision
    ) {
      this.poll = setTimeout(() => void this.tick(), 2000)
    }
  }

  scheduleRefresh(): void {
    if (!this.watchers) return
    clearTimeout(this.debounce)
    this.debounce = setTimeout(() => void this.refresh(), 150)
  }

  refresh(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshQueued = true
      return this.refreshInFlight
    }
    const epoch = this.epoch
    const run = async () => {
      do {
        this.refreshQueued = false
        await this.fetch()
      } while (epoch === this.epoch && this.refreshQueued)
    }
    const request = run().finally(() => {
      if (this.refreshInFlight === request) this.refreshInFlight = undefined
    })
    this.refreshInFlight = request
    return request
  }

  private async fetch(): Promise<void> {
    const epoch = this.epoch
    const signal = this.abortController.signal
    this.update({
      data: { ...this.state.data, loading: this.state.data.stats === null },
    })
    try {
      this.backend ??= (this.options.createBackend ?? createGitDiffBackend)({
        cwd: this.options.cwd,
        sessionStartMs: this.sessionStartMs,
        signal,
      })
      const backend = await this.backend
      if (epoch !== this.epoch) return
      if (!backend) {
        if (this.lastFetchRecord !== 'no-repository')
          this.record('fetch no-repository')
        this.lastFetchRecord = 'no-repository'
        this.update({
          data: {
            stats: null,
            files: [],
            hunks: new Map(),
            loading: false,
            outcome: 'no-repository',
          },
        })
        return
      }
      if (this.root !== backend.root) {
        this.root = backend.root
        const mode = this.options.loadPreferences?.(backend.root).mode
        if (mode === 'session' || mode === 'uncommitted' || mode === 'branch')
          this.update({ mode })
      }
      const baseRevision = this.baseRevision
      const result = await backend.fetch(this.state.mode, signal)
      if (epoch !== this.epoch || baseRevision !== this.baseRevision) return
      const fetchRecord =
        `${result.kind} mode=${this.state.mode}` +
        (result.kind === 'data'
          ? ` source=${result.data.source.kind} files=${result.data.stats.filesCount} untrackedWithheld=${result.data.isUntrackedWithheld}`
          : '')
      if (fetchRecord !== this.lastFetchRecord)
        this.record(`fetch ${fetchRecord}`)
      this.lastFetchRecord = fetchRecord
      if (result.kind !== 'data') {
        this.update({
          data: {
            ...this.state.data,
            loading: false,
            outcome: 'unavailable',
            error: result.reason,
          },
        })
        return
      }
      const previous = this.current
      const bodies =
        previous?.snapshot.mode === result.data.mode &&
        previous.snapshot.baseRef === result.data.baseRef
          ? new Map(
              [...previous.bodies].filter(([path]) =>
                result.data.files.some(file => file.path === path),
              ),
            )
          : new Map<string, DiffBody>()
      this.current = {
        backend,
        snapshot: result.data,
        bodies,
        loaded: new Set(),
      }
      this.publishBodies()
      await this.loadBodies()
    } catch (error) {
      if (epoch !== this.epoch) return
      if (this.lastFetchRecord !== 'exception') this.record('fetch exception')
      this.lastFetchRecord = 'exception'
      this.backend = undefined
      this.update({
        data: {
          ...this.state.data,
          loading: false,
          outcome: 'unavailable',
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  private publishBodies(): void {
    clearTimeout(this.redraw)
    this.redraw = undefined
    if (!this.current) return
    const { snapshot, bodies } = this.current
    const selectedPath =
      this.state.source === null &&
      this.state.selectedPath !== null &&
      !snapshot.files.some(file => file.path === this.state.selectedPath)
        ? null
        : this.state.selectedPath
    this.update({
      selectedPath,
      data: {
        stats: snapshot.stats,
        isUnborn: snapshot.isUnborn,
        isUntrackedWithheld: snapshot.isUntrackedWithheld,
        files: snapshot.files.map(file => {
          const body = bodies.get(file.path)
          return {
            path: file.path,
            linesAdded: file.added,
            linesRemoved: file.removed,
            isBinary: file.isBinary,
            isUntracked: file.isUntracked,
            isPreSession: file.isPreSession,
            isNoise: isDiffNoise(file.path),
            isLargeFile: body?.status === 'large',
            isTruncated: body?.status === 'truncated',
            bodyState: body?.status ?? 'loading',
          }
        }),
        hunks: new Map(
          snapshot.files.map(file => [
            file.path,
            bodies.get(file.path)?.hunks ?? [],
          ]),
        ),
        loading: false,
        outcome: 'data',
        baseLabel:
          snapshot.source.kind === 'branch'
            ? `vs ${snapshot.source.baseBranch}`
            : 'git diff HEAD',
      },
    })
  }

  private loadBodies(): Promise<void> {
    if (this.bodiesInFlight)
      return this.bodiesInFlight.then(() => this.loadBodies())
    const current = this.current
    if (!current) return Promise.resolve()
    const epoch = this.epoch
    const signal = this.abortController.signal
    let preSession = 0
    const files = current.snapshot.files
      .filter(file => this.state.showNoise || !isDiffNoise(file.path))
      .filter(
        file =>
          !file.isPreSession ||
          (this.state.showPreSession && preSession++ < 20),
      )
      .filter(file => !current.loaded.has(file.path))
    if (!files.length) return Promise.resolve()
    let next = 0
    const request = Promise.all(
      Array.from({ length: Math.min(6, files.length) }, async () => {
        while (
          next < files.length &&
          epoch === this.epoch &&
          this.current === current
        ) {
          const file = files[next++]!
          const body = await current.backend
            .fetchBody(current.snapshot, file, signal)
            .catch(
              (error: unknown): DiffBody => ({
                status: 'unavailable',
                hunks: [],
                reason:
                  error instanceof Error ? error.message : String(error),
              }),
            )
          if (epoch !== this.epoch || this.current !== current) return
          if (body.status !== current.bodies.get(file.path)?.status)
            this.record(`body ${body.status}`)
          current.bodies.set(
            file.path,
            body.status === 'unavailable'
              ? { ...body, hunks: current.bodies.get(file.path)?.hunks ?? [] }
              : body,
          )
          current.loaded.add(file.path)
          this.redraw ??= setTimeout(() => {
            this.redraw = undefined
            if (epoch === this.epoch && this.current === current)
              this.publishBodies()
          }, 100)
        }
      }),
    )
      .then(() => {
        if (epoch === this.epoch && this.current === current)
          this.publishBodies()
      })
      .finally(() => {
        if (this.bodiesInFlight === request) this.bodiesInFlight = undefined
      })
    this.bodiesInFlight = request
    return request
  }

  setOpenPreference(open: boolean): void {
    this.record(open ? 'open user' : 'close user')
    this.autoOpened = true
    this.options.savePreferences?.(this.root ?? this.options.cwd, { open })
  }

  async autoOpen(surface: {
    columns: number
    isFullscreen: boolean
    hasDock: boolean
    checkpointing: boolean
  }): Promise<boolean> {
    const preference = this.options.loadPreferences?.(
      this.root ?? this.options.cwd,
    ).open
    if (
      this.autoOpened ||
      this.opening ||
      preference === false ||
      !surface.isFullscreen ||
      !surface.checkpointing ||
      surface.hasDock ||
      surface.columns < (preference === true ? 110 : 144)
    )
      return false
    this.opening = true
    const epoch = this.epoch
    try {
      await this.refresh()
      if (
        epoch !== this.epoch ||
        this.autoOpened ||
        this.state.data.outcome !== 'data'
      )
        return false
      const pinnedPreference = this.options.loadPreferences?.(
        this.root ?? this.options.cwd,
      ).open
      if (
        pinnedPreference === false ||
        surface.columns < (pinnedPreference === true ? 110 : 144)
      )
        return false
      this.autoOpened = true
      this.record('open automatic')
      return true
    } finally {
      if (epoch === this.epoch) this.opening = false
    }
  }

  observeMessage(message: Message): { edited: boolean } | undefined {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (
          block.type === 'tool_use' &&
          block.id &&
          block.name &&
          !this.completedTools.has(block.id) &&
          ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'].includes(
            block.name,
          )
        ) {
          this.toolCalls.set(block.id, block.name)
        }
      }
    }
    if (message.type !== 'user' || !Array.isArray(message.message.content))
      return
    let landed = false
    let edited = false
    for (const block of message.message.content) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue
      const tool = this.toolCalls.get(block.tool_use_id)
      this.toolCalls.delete(block.tool_use_id)
      if (tool) this.completedTools.add(block.tool_use_id)
      if (!tool || block.is_error === true) continue
      landed = true
      edited ||= tool !== 'Bash'
    }
    return landed ? { edited } : undefined
  }

  selectFile(path: string | null): void {
    this.update({ selectedPath: path })
  }

  async cycleBase(): Promise<void> {
    const modes: DiffBaseMode[] = ['session', 'uncommitted', 'branch']
    const mode = modes[(modes.indexOf(this.state.mode) + 1) % modes.length]!
    this.record(`base ${mode}`)
    this.baseRevision++
    this.current = undefined
    this.update({
      mode,
      source: null,
      selectedPath: null,
      data: initialState().data,
    })
    if (this.root) this.options.savePreferences?.(this.root, { mode })
    await this.refresh()
  }

  chooseSource(source: number | null): void {
    this.update({ source, selectedPath: null })
  }

  async toggleNoise(): Promise<void> {
    this.update({ showNoise: !this.state.showNoise })
    if (this.state.showNoise) await this.loadBodies()
  }

  async togglePreSession(): Promise<void> {
    this.update({ showPreSession: !this.state.showPreSession })
    if (this.state.showPreSession) await this.loadBodies()
  }

  reset(cwd: string): void {
    this.record('reset')
    this.lastFetchRecord = undefined
    clearTimeout(this.poll)
    clearTimeout(this.debounce)
    clearTimeout(this.redraw)
    this.redraw = undefined
    this.watchRevision++
    this.options.cwd = cwd
    this.abortController.abort()
    this.abortController = new AbortController()
    this.epoch++
    this.refreshInFlight = undefined
    this.refreshQueued = false
    this.backend = undefined
    this.current = undefined
    this.bodiesInFlight = undefined
    this.root = undefined
    this.autoOpened = false
    this.opening = false
    this.sessionStartMs = Date.now()
    this.toolCalls.clear()
    this.completedTools.clear()
    this.armed = null
    this.carrying = null
    this.update(initialState())
    if (this.watchers > 0) void this.tick()
  }

  toggleAsk(
    path: string,
    hunks: readonly StructuredPatchHunk[],
    basis: string,
  ): void {
    if (this.armed?.path === path) {
      this.armed = null
      this.update({ armedPath: null })
      return
    }
    const lines: string[] = []
    for (const hunk of hunks) {
      if (lines.length === 400) break
      lines.push(
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      )
      lines.push(...hunk.lines.slice(0, 400 - lines.length))
    }
    this.armed = {
      path,
      text: [`Diff for ${path} (${basis})`, ...lines].join('\n'),
    }
    this.update({ armedPath: path })
  }

  beginAsk(
    context: readonly string[],
  ): { text: string; finish: (accepted: boolean) => void } | undefined {
    const asked = this.armed
    if (!asked || this.carrying === asked) return undefined
    const room =
      32_000 - context.reduce((total, entry) => total + entry.length, 0)
    let text = asked.text
    if (text.length > room) {
      const note = '[Diff truncated to fit prompt context]'
      const kept: string[] = []
      let used = note.length
      for (const line of text.split('\n')) {
        if (used + line.length + 1 > room) break
        kept.push(line)
        used += line.length + 1
      }
      if (kept.length < 2) {
        this.record('ask dropped-budget')
        this.armed = null
        this.update({ armedPath: null })
        this.options.notify?.(
          `${asked.path}'s diff did not fit in the prompt and was dropped`,
        )
        return undefined
      }
      text = `${kept.join('\n')}\n${note}`
    }
    this.carrying = asked
    let finished = false
    return {
      text,
      finish: accepted => {
        if (finished) return
        finished = true
        this.record(accepted ? 'ask accepted' : 'ask released')
        if (accepted && this.armed === asked) {
          this.armed = null
          this.update({ armedPath: null })
        }
        if (this.carrying === asked) this.carrying = null
      },
    }
  }

  dispose(): void {
    clearTimeout(this.poll)
    clearTimeout(this.debounce)
    clearTimeout(this.redraw)
    this.redraw = undefined
    this.watchers = 0
    this.epoch++
    this.abortController.abort()
    this.toolCalls.clear()
    this.completedTools.clear()
    this.armed = null
    this.carrying = null
    this.current = undefined
    this.bodiesInFlight = undefined
    this.listeners.clear()
  }
}

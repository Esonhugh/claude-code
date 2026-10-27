import { type ChildProcess, spawn } from 'child_process'
import { homedir } from 'os'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { getSettingsForSource } from './settings/settings.js'
import type { SettingsJson } from './settings/types.js'
import { createSignal } from './signal.js'
import { which } from './which.js'

// Official 2.1.303 `spellcheck`: misspelled words in the prompt input are
// underlined, using an installed aspell, hunspell or ispell in pipe (-a) mode.
export const SPELL_CHECKERS = ['aspell', 'hunspell', 'ispell'] as const
export type SpellCheckerName = (typeof SPELL_CHECKERS)[number]

export type SpellcheckSettings = NonNullable<SettingsJson['spellcheck']>

const DICTIONARY_NAME = /^[A-Za-z][A-Za-z0-9_.,-]{0,63}$/

export function isPlainDictionaryName(name: string): boolean {
  return DICTIONARY_NAME.test(name)
}

export function spellCheckerArgs(
  checker: SpellCheckerName,
  language: string | undefined,
): string[] {
  const lang =
    language !== undefined && isPlainDictionaryName(language)
      ? language
      : undefined
  switch (checker) {
    case 'aspell':
      return [
        '-a',
        '--encoding=utf-8',
        '--sug-mode=ultra',
        ...(lang ? [`--lang=${lang}`] : []),
      ]
    case 'hunspell':
      return ['-a', '-i', 'utf-8', ...(lang ? ['-d', lang] : [])]
    case 'ispell':
      return ['-a', ...(lang ? ['-d', lang] : [])]
  }
}

/** The ispell-protocol banner names the real backend. */
export function parseSpellCheckerBanner(line: string): SpellCheckerName | null {
  if (!line.startsWith('@(#) International Ispell')) return null
  if (/but really Aspell/i.test(line)) return 'aspell'
  if (/but really Hunspell/i.test(line)) return 'hunspell'
  return 'ispell'
}

export type SpellCheckerLine =
  | { type: 'end' }
  | { type: 'correct' }
  | { type: 'misspelled'; word: string }
  | { type: 'unrecognized' }

export function parseSpellCheckerLine(line: string): SpellCheckerLine {
  if (line === '') return { type: 'end' }
  switch (line[0]) {
    case '*':
    case '+':
    case '-':
      return { type: 'correct' }
    case '&':
    case '?': {
      const match = /^[&?] (\S+) \d+ \d+:/.exec(line)
      return match ? { type: 'misspelled', word: match[1]! } : { type: 'unrecognized' }
    }
    case '#': {
      const match = /^# (\S+) \d+/.exec(line)
      return match ? { type: 'misspelled', word: match[1]! } : { type: 'unrecognized' }
    }
    default:
      return { type: 'unrecognized' }
  }
}

const WORD = /\p{L}[\p{L}\p{M}]*(?:['’][\p{L}\p{M}]+)*/gu
const CODE_SPAN = /(``+)[\s\S]*?(?:\1|$)|`[^`\n]*(?:`|\n|$)/g
const EDGE_PUNCTUATION = String.raw`[\s.,;:!?"'‘’“”«»()[\]{}<>—–…*_~-]`
const EDGE_PUNCTUATION_RE = new RegExp(
  `^${EDGE_PUNCTUATION}+|${EDGE_PUNCTUATION}+$`,
  'gu',
)
const LEADING_QUOTES = /^["'‘’“”«»([{*_~]+/u
const CODE_LIKE = /[0-9_/\\@#=<>{}[\]()|~^$%*+:;`]|\.\p{L}/u
const FLAG_OR_TAG = /^(?:-|\.\p{L}|<\/?\p{L}[^<>]*>)/u
const NO_SPACES_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u

export type SpellcheckWord = { word: string; start: number; end: number }

/**
 * Words worth checking: outside code spans, 2-64 letters, not mixed case
 * after the first letter, and not inside a whitespace-delimited token that
 * looks like code, a path, a flag or a tag.
 */
export function findSpellcheckWords(text: string): SpellcheckWord[] {
  const code = [...text.matchAll(CODE_SPAN)].map(match => ({
    start: match.index,
    end: match.index + match[0].length,
  }))
  const words: SpellcheckWord[] = []
  let tokenEnd = -1
  let tokenIsProse = false
  let codeIndex = 0
  for (const match of text.matchAll(WORD)) {
    const word = match[0]
    const start = match.index
    const end = start + word.length
    while (codeIndex < code.length && code[codeIndex]!.end <= start) codeIndex++
    if (codeIndex < code.length && code[codeIndex]!.start < end) continue
    if (word.length < 2 || word.length > 64) continue
    if (word.slice(1) !== word.slice(1).toLowerCase()) continue
    if (NO_SPACES_SCRIPT.test(word)) continue
    if (start >= tokenEnd) {
      let tokenStart = start
      while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1]!)) tokenStart--
      tokenEnd = end
      while (tokenEnd < text.length && !/\s/.test(text[tokenEnd]!)) tokenEnd++
      const token = text.slice(tokenStart, tokenEnd)
      tokenIsProse =
        !FLAG_OR_TAG.test(token.replace(LEADING_QUOTES, '')) &&
        !CODE_LIKE.test(token.replace(EDGE_PUNCTUATION_RE, ''))
    }
    if (tokenIsProse) words.push({ word, start, end })
  }
  return words
}

/** user < flag < policy: the highest of those that sets `spellcheck` wins as a whole. */
export function getSpellcheckSettings(): SpellcheckSettings | undefined {
  return (
    getSettingsForSource('policySettings')?.spellcheck ??
    getSettingsForSource('flagSettings')?.spellcheck ??
    getSettingsForSource('userSettings')?.spellcheck
  )
}

const BANNER_TIMEOUT_MS = 3000
const RESPONSE_TIMEOUT_MS = 15_000
const RESTART_DELAY_MS = 1000
const MAX_RESTARTS = 1
const MAX_WORD_LENGTH = 128
const MAX_REQUEST_BYTES = 4096
const MAX_LINE_BUFFER = 65_536
const MAX_CACHE = 10_000
const BATCH_SIZE: Record<SpellCheckerName, number> = {
  aspell: 256,
  hunspell: 16,
  ispell: 256,
}
const UNCHECKABLE = /[\s\p{Cc}]/u

type CheckerCommand = { command: string; args: string[] }

type State =
  | { status: 'idle' | 'resolving' | 'unavailable' }
  | { status: 'starting'; process: ChildProcess }
  | { status: 'ready'; process: ChildProcess; backend: SpellCheckerName }

async function resolveChecker(
  checker: SpellCheckerName | 'auto',
  language: string | undefined,
): Promise<CheckerCommand | null> {
  const candidates = checker === 'auto' ? SPELL_CHECKERS : [checker]
  for (const name of candidates) {
    const command = await which(name)
    if (command) return { command, args: spellCheckerArgs(name, language) }
  }
  logForDebugging(
    `[spellcheck] no checker found on PATH (looked for ${candidates.join(', ')}); spell checking stays off`,
  )
  return null
}

/** One long-lived checker process in ispell pipe mode, with a verdict cache. */
export class SpellChecker {
  readonly changed = createSignal()
  #verdicts = new Map<string, boolean>()
  #pending = new Set<string>()
  #inFlight: Set<string> | null = null
  #misspelled = new Set<string>()
  #state: State = { status: 'idle' }
  #buffer = ''
  #timer: ReturnType<typeof setTimeout> | undefined
  #restarts = 0
  #disposed = false
  #unregisterCleanup: (() => void) | undefined

  constructor(private readonly resolve: () => Promise<CheckerCommand | null>) {}

  isMisspelled(word: string): boolean | undefined {
    return this.#verdicts.get(word)
  }

  request(words: Iterable<string>): void {
    if (this.#disposed || this.#state.status === 'unavailable') return
    for (const word of words) {
      if (
        word.length > 0 &&
        word.length <= MAX_WORD_LENGTH &&
        !UNCHECKABLE.test(word) &&
        !this.#verdicts.has(word) &&
        !this.#inFlight?.has(word)
      ) {
        this.#pending.add(word)
      }
    }
    void this.#pump()
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#stop()
    this.#pending.clear()
    this.changed.clear()
  }

  async #pump(): Promise<void> {
    if (this.#disposed || this.#inFlight || this.#pending.size === 0) return
    if (this.#state.status === 'idle') return this.#start()
    if (this.#state.status !== 'ready') return
    const batch: string[] = []
    let bytes = 2
    for (const word of this.#pending) {
      const size = Buffer.byteLength(word) + 1
      if (batch.length >= BATCH_SIZE[this.#state.backend] || bytes + size > MAX_REQUEST_BYTES) break
      batch.push(word)
      bytes += size
    }
    for (const word of batch) this.#pending.delete(word)
    this.#inFlight = new Set(batch)
    this.#misspelled.clear()
    this.#arm(RESPONSE_TIMEOUT_MS, 'response timeout')
    // `^` makes the checker treat the line as text, not a command.
    this.#state.process.stdin?.write(`^${batch.join(' ')}\n`)
  }

  async #start(): Promise<void> {
    this.#state = { status: 'resolving' }
    let command: CheckerCommand | null
    try {
      command = await this.resolve()
    } catch (error) {
      logForDebugging(`[spellcheck] could not look for a checker: ${error}`, { level: 'warn' })
      command = null
    }
    if (this.#disposed || this.#state.status !== 'resolving') return
    if (!command) {
      this.#state = { status: 'unavailable' }
      this.#pending.clear()
      return
    }
    logForDebugging(`[spellcheck] starting ${command.command} ${command.args.join(' ')}`)
    let child: ChildProcess
    try {
      child = spawn(command.command, command.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: homedir(),
        windowsHide: true,
      })
    } catch (error) {
      this.#state = { status: 'idle' }
      this.#fail(`spawn failed: ${error}`)
      return
    }
    this.#state = { status: 'starting', process: child }
    this.#unregisterCleanup = registerCleanup(async () => this.dispose())
    child.unref()
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      ;(stream as { unref?: () => void } | null)?.unref?.()
    }
    let lastStderr = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (this.#owns(child)) this.#read(chunk)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      lastStderr = chunk.trim().slice(0, 200) || lastStderr
    })
    child.on('error', error => {
      if (this.#owns(child)) this.#fail(`process error: ${error.message}`)
    })
    child.stdin?.on('error', error => {
      if (this.#owns(child)) this.#fail(`stdin error: ${error.message}`)
    })
    child.on('exit', (code, signal) => {
      if (this.#owns(child)) {
        this.#fail(
          `checker exited (code ${code}, signal ${signal}); last stderr: ${lastStderr || 'none'}`,
        )
      }
    })
    this.#arm(BANNER_TIMEOUT_MS, 'banner timeout')
  }

  #owns(child: ChildProcess): boolean {
    return (
      (this.#state.status === 'starting' || this.#state.status === 'ready') &&
      this.#state.process === child
    )
  }

  #read(chunk: string): void {
    this.#buffer += chunk
    let newline = this.#buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, '')
      this.#buffer = this.#buffer.slice(newline + 1)
      this.#line(line)
      if (this.#state.status !== 'starting' && this.#state.status !== 'ready') return
      newline = this.#buffer.indexOf('\n')
    }
    if (this.#buffer.length > MAX_LINE_BUFFER) this.#fail('output line too long')
  }

  #line(line: string): void {
    const state = this.#state
    if (state.status === 'starting') {
      const backend = parseSpellCheckerBanner(line)
      if (!backend) {
        this.#fail(`unexpected banner: ${line.slice(0, 80)}`)
        return
      }
      clearTimeout(this.#timer)
      this.#state = { status: 'ready', process: state.process, backend }
      // Terse mode: correct words print nothing but the end-of-line blank.
      state.process.stdin?.write('!\n')
      logForDebugging(`[spellcheck] ${backend} ready`)
      void this.#pump()
      return
    }
    if (!this.#inFlight) {
      this.#fail(`unexpected output: ${line.slice(0, 80)}`)
      return
    }
    const parsed = parseSpellCheckerLine(line)
    switch (parsed.type) {
      case 'correct':
        return
      case 'misspelled':
        this.#misspelled.add(parsed.word)
        return
      case 'unrecognized':
        this.#fail(`unrecognized output: ${line.slice(0, 80)}`)
        return
      case 'end':
        clearTimeout(this.#timer)
        this.#record(this.#inFlight, this.#misspelled)
        this.#inFlight = null
        this.#misspelled.clear()
        void this.#pump()
    }
  }

  #record(words: Set<string>, misspelled: Set<string>): void {
    if (this.#verdicts.size + words.size > MAX_CACHE) {
      let drop = Math.ceil(this.#verdicts.size / 2)
      for (const key of this.#verdicts.keys()) {
        if (drop-- <= 0) break
        this.#verdicts.delete(key)
      }
    }
    for (const word of words) this.#verdicts.set(word, misspelled.has(word))
    this.changed.emit()
  }

  #arm(ms: number, reason: string): void {
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => this.#fail(reason), ms)
    this.#timer.unref?.()
  }

  #stop(): void {
    clearTimeout(this.#timer)
    this.#unregisterCleanup?.()
    this.#unregisterCleanup = undefined
    const state = this.#state
    this.#state = { status: 'idle' }
    this.#buffer = ''
    if (this.#inFlight) {
      for (const word of this.#inFlight) this.#pending.add(word)
      this.#inFlight = null
      this.#misspelled.clear()
    }
    if (state.status === 'starting' || state.status === 'ready') {
      state.process.stdin?.end()
      if (state.process.exitCode === null && state.process.signalCode === null) {
        state.process.kill()
      }
    }
  }

  #fail(reason: string): void {
    if (this.#disposed || this.#state.status === 'unavailable') return
    this.#stop()
    if (this.#restarts < MAX_RESTARTS) {
      this.#restarts++
      logForDebugging(`[spellcheck] ${reason}; restarting once`, { level: 'warn' })
      this.#timer = setTimeout(() => void this.#pump(), RESTART_DELAY_MS)
      this.#timer.unref?.()
      return
    }
    logForDebugging(`[spellcheck] ${reason}; spell checking is off for this session`, {
      level: 'warn',
    })
    this.#state = { status: 'unavailable' }
    this.#pending.clear()
  }
}

let shared: { key: string; checker: SpellChecker } | undefined

export function getSpellChecker(
  checker: SpellCheckerName | 'auto',
  language: string | undefined,
): SpellChecker {
  const key = `${checker}:${language ?? ''}`
  if (shared?.key === key) return shared.checker
  shared?.checker.dispose()
  shared = { key, checker: new SpellChecker(() => resolveChecker(checker, language)) }
  return shared.checker
}

export function disposeSpellChecker(): void {
  shared?.checker.dispose()
  shared = undefined
}

const RAW_COLOR =
  /^(?:rgb\(\d{1,3},\d{1,3},\d{1,3}\)|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}|ansi256\(\d{1,3}\)|ansi:(?:black|red|green|yellow|blue|magenta|cyan|white)(?:Bright)?)$/

/** A terminal color name or raw color for misspelled words; the theme's error color otherwise. */
export function resolveSpellcheckColor(color: string | undefined): string {
  if (color === undefined) return 'error'
  const compact = color.trim().replace(/\s+(?=[^()]*\))/g, '')
  if (RAW_COLOR.test(`ansi:${compact}`)) return `ansi:${compact}`
  if (RAW_COLOR.test(compact)) return compact
  logForDebugging(
    `[spellcheck] ignoring unrecognized spellcheck.color "${color}"; using the theme's error color`,
  )
  return 'error'
}

export function resolveSpellCheckerName(
  checker: string | undefined,
): SpellCheckerName | 'auto' {
  if (checker === undefined || checker === 'auto') return 'auto'
  const known = SPELL_CHECKERS.find(name => name === checker)
  if (known) return known
  logForDebugging(
    `[spellcheck] unknown spellcheck.checker "${checker}"; looking for ${SPELL_CHECKERS.join(', ')} instead`,
  )
  return 'auto'
}

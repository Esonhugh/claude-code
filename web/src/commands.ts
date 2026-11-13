// The `/` palette in the input box. Its list is the `commands` of the
// session's initialize response, which the headless engine has already cut
// down to what `-p` can run (prompt commands and local commands that support
// non-interactive use). Sending passes the text through unchanged; the engine
// runs the command.

export type SlashCommand = {
  name: string
  description: string
  argumentHint: string
  aliases?: string[]
}

/** The partial command name while the draft is just `/name`, else undefined. */
export function paletteQuery(draft: string): string | undefined {
  const match = /^\/(\S*)$/.exec(draft)
  return match ? match[1]!.toLowerCase() : undefined
}

/**
 * Commands matching `query`: name or alias prefix matches first, then other
 * names containing it. `hidden` are the session's terminal-only commands
 * (`terminal_slash_commands` of `system/init`), which mean nothing in a page.
 */
export function filterCommands(
  commands: SlashCommand[],
  query: string,
  hidden: readonly string[] = [],
): SlashCommand[] {
  const visible = commands.filter(c => !hidden.includes(c.name))
  const names = (c: SlashCommand) => [c.name, ...(c.aliases ?? [])].map(n => n.toLowerCase())
  const prefix = visible.filter(c => names(c).some(n => n.startsWith(query)))
  const inner = visible.filter(
    c => !prefix.includes(c) && c.name.toLowerCase().includes(query),
  )
  return [...prefix, ...inner]
}

/** The commands an agent can be sent: its skills, which it runs with the Skill tool. */
export function agentCommands(commands: SlashCommand[], skills: readonly string[]): SlashCommand[] {
  return commands.filter(c => skills.includes(c.name))
}

/** Moves the highlighted row by `delta`, wrapping around. */
export function moveSelection(index: number, delta: number, length: number): number {
  if (length === 0) return 0
  return (((index + delta) % length) + length) % length
}

/**
 * ↑ / ↓ through the prompts already sent, like the TUI's history. `index`
 * counts back from the newest prompt; -1 is the empty input below them.
 * Undefined when there is nothing further that way.
 */
export function recallPrompt(
  prompts: readonly string[],
  index: number,
  delta: 1 | -1,
): { index: number; text: string } | undefined {
  const next = index + delta
  if (next < -1 || next >= prompts.length) return undefined
  return { index: next, text: next === -1 ? '' : prompts[prompts.length - 1 - next]! }
}

/**
 * The prompts ↑ walks, oldest first like `prompts`: this box's own, then the
 * folder's history (`shared`, newest first) before them, each text once.
 */
export function recallList(prompts: readonly string[], shared: readonly string[]): string[] {
  const seen = new Set<string>()
  const newestFirst = [...prompts].reverse().concat(shared).filter(p => !seen.has(p) && (seen.add(p), true))
  return newestFirst.reverse()
}

/** Slash commands the page answers with its own panel instead of sending them: name → panel (and Settings tab). */
const NATIVE_COMMANDS: Record<
  string,
  | { dialog: 'stats' | 'settings' | 'mcp' | 'hooks' | 'plugins' | 'memory' | 'skills' | 'keys'; tab?: 'general' | 'usage' | 'features' }
  | { menu: 'model' }
  | { clear: true }
  | { reload: true }
  | { panel: 'status' | 'files' | 'bg' | 'workflow' }
  | { search: true }
  | { export: true }
> = {
  // The CLI's /clear moves the process to a new session id the page and server would not follow.
  clear: { clear: true },
  reset: { clear: true },
  new: { clear: true },
  model: { menu: 'model' },
  effort: { menu: 'model' },
  stats: { dialog: 'stats' },
  config: { dialog: 'settings' },
  settings: { dialog: 'settings' },
  theme: { dialog: 'settings' },
  usage: { dialog: 'settings', tab: 'usage' },
  cost: { dialog: 'settings', tab: 'usage' },
  mcp: { dialog: 'mcp' },
  hooks: { dialog: 'hooks' },
  plugin: { dialog: 'plugins' },
  plugins: { dialog: 'plugins' },
  memory: { dialog: 'memory' },
  skills: { dialog: 'skills' },
  keybindings: { dialog: 'keys' },
  // Sent as text, -p reloads plugins without updating the session's commands, agents or MCP servers.
  'reload-plugins': { reload: true },
  // The CLI's dialogs that the page has as a side panel, the session search or a download.
  status: { panel: 'status' },
  diff: { panel: 'files' },
  tasks: { panel: 'bg' },
  bashes: { panel: 'bg' },
  workflows: { panel: 'workflow' },
  resume: { search: true },
  continue: { search: true },
  help: { dialog: 'keys' },
  export: { export: true },
}

/** Page commands that are not `-p` commands, so the session's list lacks them: name → description key. */
const PAGE_ROWS = [
  { name: 'reload-plugins', key: 'cmdReloadPlugins' },
  { name: 'plugin', aliases: ['plugins'], key: 'cmdPlugin' },
  { name: 'hooks', key: 'cmdHooks' },
  { name: 'memory', key: 'cmdMemory' },
  { name: 'skills', key: 'cmdSkills' },
  { name: 'theme', key: 'cmdTheme' },
  { name: 'keybindings', key: 'cmdKeybindings' },
  { name: 'status', key: 'cmdStatus' },
  { name: 'diff', key: 'cmdDiff' },
  { name: 'tasks', aliases: ['bashes'], key: 'cmdTasks' },
  { name: 'workflows', key: 'cmdWorkflows' },
  { name: 'resume', aliases: ['continue'], key: 'cmdResume' },
  { name: 'help', key: 'cmdHelp' },
  { name: 'export', key: 'cmdExport' },
] as const

export type PageCommandKey = (typeof PAGE_ROWS)[number]['key']

/**
 * The palette of a box whose page commands open (a session's own chat): the
 * session's commands, then the page commands it lacks. A terminal-only
 * command stays hidden unless the page runs it.
 */
export function withPageCommands(
  commands: SlashCommand[],
  hidden: readonly string[],
  describe: (key: PageCommandKey) => string,
): { commands: SlashCommand[]; hidden: string[] } {
  const taken = new Set(commands.flatMap(c => [c.name, ...(c.aliases ?? [])]))
  const rows = PAGE_ROWS.filter(r => !taken.has(r.name)).map(r => ({
    name: r.name,
    description: describe(r.key),
    argumentHint: '',
    ...('aliases' in r && { aliases: [...r.aliases] }),
  }))
  return { commands: [...commands, ...rows], hidden: hidden.filter(name => !nativeCommand(`/${name}`)) }
}

/** The page's own panel for a bare `/stats`, `/config`, …; undefined for anything else (it is sent). */
export function nativeCommand(text: string) {
  const match = /^\/([a-z-]+)$/.exec(text.trim())
  return match && Object.hasOwn(NATIVE_COMMANDS, match[1]!) ? NATIVE_COMMANDS[match[1]!] : undefined
}

/** The draft is `command` typed out (its name or an alias) or a page command, so Enter sends it rather than completing. */
export function typedInFull(draft: string, command: SlashCommand): boolean {
  return [command.name, ...(command.aliases ?? [])].some(n => draft === `/${n}`) || !!nativeCommand(draft)
}

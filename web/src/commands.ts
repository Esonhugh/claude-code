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
> = {
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

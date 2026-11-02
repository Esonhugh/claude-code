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

/** Moves the highlighted row by `delta`, wrapping around. */
export function moveSelection(index: number, delta: number, length: number): number {
  if (length === 0) return 0
  return (((index + delta) % length) + length) % length
}

import Fuse from 'fuse.js'
import {
  type Command,
  formatDescriptionWithSource,
  getCommand,
  getCommandName,
  getMenuDescription,
} from '../../commands.js'
import type { SuggestionItem } from '../../components/PromptInput/PromptInputFooterSuggestions.js'
import { getSkillUsageScore } from './skillUsageTracking.js'

// Treat these characters as word separators for command search
const SEPARATORS = /[:_-]/g

type CommandSearchItem = {
  partKey: string[] | undefined
  commandName: string
  command: Command
  aliasKey: string[] | undefined
  // Sorted, so a word-prefix lookup is a binary search.
  descriptionWords: string[]
}

// Description rows rank after every name, part or alias match.
const DESCRIPTION_BUCKET = 10

function getDescriptionWords(description: string): string[] {
  const words = new Set<string>()
  for (const word of description.toLowerCase().split(/\s+/)) {
    if (/[^a-z0-9]/.test(word)) {
      words.add(word.replace(/[^a-z0-9]/g, ''))
      for (const part of word.split(/[^a-z0-9]+/)) words.add(part)
    } else {
      words.add(word)
    }
  }
  words.delete('')
  return [...words].sort()
}

function countWordsWithPrefix(words: string[], prefix: string): number {
  let low = 0
  let high = words.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (words[mid]! < prefix) low = mid + 1
    else high = mid
  }
  let count = 0
  while (words[low + count]?.startsWith(prefix)) count++
  return count
}

// Cache the Fuse index keyed by the commands array identity. The commands
// array is stable (memoized in REPL.tsx), so we only rebuild when it changes
// rather than on every keystroke.
let fuseCache: {
  commands: Command[]
  items: CommandSearchItem[]
  fuse: Fuse<CommandSearchItem>
} | null = null

function getCommandFuse(commands: Command[]): {
  items: CommandSearchItem[]
  fuse: Fuse<CommandSearchItem>
} {
  if (fuseCache?.commands === commands) {
    return fuseCache
  }

  const items: CommandSearchItem[] = commands
    .filter(cmd => !cmd.isHidden)
    .map(cmd => {
      const commandName = getCommandName(cmd)
      const parts = commandName.split(SEPARATORS).filter(Boolean)

      return {
        partKey: parts.length > 1 ? parts : undefined,
        commandName,
        command: cmd,
        aliasKey: cmd.aliases,
        descriptionWords: getDescriptionWords(cmd.description ?? ''),
      }
    })

  // Official 2.1.311: only names, name parts and aliases go through Fuse;
  // descriptions match by word prefix in generateCommandSuggestions.
  const fuse = new Fuse(items, {
    includeScore: true,
    threshold: 0.3,
    location: 0,
    distance: 100,
    keys: [
      { name: 'commandName', weight: 3 },
      { name: 'partKey', weight: 2 },
      { name: 'aliasKey', weight: 2 },
    ],
  })

  fuseCache = { commands, items, fuse }
  return fuseCache
}

/**
 * Type guard to check if a suggestion's metadata is a Command.
 * Commands have a name string and a type property.
 */
function isCommandMetadata(metadata: unknown): metadata is Command {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    'name' in metadata &&
    typeof (metadata as { name: unknown }).name === 'string' &&
    'type' in metadata
  )
}

/**
 * Represents a slash command found mid-input (not at the start)
 */
export type MidInputSlashCommand = {
  token: string // e.g., "/com"
  startPos: number // Position of "/"
  partialCommand: string // e.g., "com"
}

/**
 * Finds a slash command token that appears mid-input (not at position 0).
 * A mid-input slash command is a "/" preceded by whitespace, where the cursor
 * is at or after the "/".
 *
 * @param input The full input string
 * @param cursorOffset The current cursor position
 * @returns The mid-input slash command info, or null if not found
 */
export function findMidInputSlashCommand(
  input: string,
  cursorOffset: number,
): MidInputSlashCommand | null {
  // If input starts with "/", this is start-of-input case (handled elsewhere)
  if (input.startsWith('/')) {
    return null
  }

  // Look backwards from cursor to find a "/" preceded by whitespace
  const beforeCursor = input.slice(0, cursorOffset)

  // Find the last "/" in the text before cursor
  // Pattern: whitespace followed by "/" then optional alphanumeric/dash characters.
  // Lookbehind (?<=\s) is avoided — it defeats YARR JIT in JSC, and the
  // interpreter scans O(n) even with the $ anchor. Capture the whitespace
  // instead and offset match.index by 1.
  const match = beforeCursor.match(/\s\/([a-zA-Z0-9_:-]*)$/)
  if (!match || match.index === undefined) {
    return null
  }

  // Get the full token (may extend past cursor)
  const slashPos = match.index + 1
  const textAfterSlash = input.slice(slashPos + 1)

  // Extract the command portion (until whitespace or end)
  const commandMatch = textAfterSlash.match(/^[a-zA-Z0-9_:-]*/)
  const fullCommand = commandMatch ? commandMatch[0] : ''

  // If cursor is past the command (after a space), don't show ghost text
  if (cursorOffset > slashPos + 1 + fullCommand.length) {
    return null
  }

  return {
    token: '/' + fullCommand,
    startPos: slashPos,
    partialCommand: fullCommand,
  }
}

/**
 * Finds the best matching command for a partial command string.
 * Delegates to generateCommandSuggestions and filters to prefix matches.
 *
 * @param partialCommand The partial command typed by the user (without "/")
 * @param commands Available commands
 * @returns The completion suffix (e.g., "mit" for partial "com" matching "commit"), or null
 */
export function getBestCommandMatch(
  partialCommand: string,
  commands: Command[],
): { suffix: string; fullCommand: string } | null {
  if (!partialCommand) {
    return null
  }

  // Use existing suggestion logic
  const suggestions = generateCommandSuggestions('/' + partialCommand, commands)
  if (suggestions.length === 0) {
    return null
  }

  // Find first suggestion that is a prefix match (for inline completion)
  const query = partialCommand.toLowerCase()
  for (const suggestion of suggestions) {
    if (!isCommandMetadata(suggestion.metadata)) {
      continue
    }
    const name = getCommandName(suggestion.metadata)
    if (name.toLowerCase().startsWith(query)) {
      const suffix = name.slice(partialCommand.length)
      // Only return if there's something to complete
      if (suffix) {
        return { suffix, fullCommand: name }
      }
    }
  }

  return null
}

/**
 * Whether the top command suggestion starts out selected, so Enter runs it.
 * Like 2.1.311, only when the typed text starts one of the command's
 * name/alias words; a fuzzy match stays unselected and Enter submits the input.
 */
export function shouldPreselectCommandSuggestion(
  input: string,
  suggestions: SuggestionItem[],
): boolean {
  const top = suggestions[0]
  if (!top) return false
  if (!isCommandMetadata(top.metadata)) return true
  const separators = /[:_-]/g
  const query = input.slice(1).toLowerCase().trim().split(separators).join('')
  if (query === '') return true
  const cmd = top.metadata
  return [cmd.name, getCommandName(cmd), ...(cmd.aliases ?? [])].some(name => {
    const words = name.toLowerCase().split(separators).filter(Boolean)
    return words.some((_, i) => words.slice(i).join('').startsWith(query))
  })
}

/**
 * Checks if input is a command (starts with slash)
 */
export function isCommandInput(input: string): boolean {
  return input.startsWith('/')
}

/**
 * Checks if a command input has arguments
 * A command with just a trailing space is considered to have no arguments
 */
export function hasCommandArgs(input: string): boolean {
  if (!isCommandInput(input)) return false

  if (!input.includes(' ')) return false

  if (input.endsWith(' ')) return false

  return true
}

/**
 * Formats a command with proper notation
 */
export function formatCommand(command: string): string {
  return `/${command} `
}

/**
 * Generates a deterministic unique ID for a command suggestion.
 * Commands with the same name from different sources get unique IDs.
 *
 * Only prompt commands can have duplicates (from user settings, project
 * settings, plugins, etc). Built-in commands (local, local-jsx) are
 * defined once in code and can't have duplicates.
 */
function getCommandId(cmd: Command): string {
  const commandName = getCommandName(cmd)
  if (cmd.type === 'prompt') {
    // For plugin commands, include the repository to disambiguate
    if (cmd.source === 'plugin' && cmd.pluginInfo?.repository) {
      return `${commandName}:${cmd.source}:${cmd.pluginInfo.repository}`
    }
    return `${commandName}:${cmd.source}`
  }
  // Built-in commands include type as fallback for future-proofing
  return `${commandName}:${cmd.type}`
}

/**
 * Checks if a query matches any of the command's aliases.
 * Returns the matched alias if found, otherwise undefined.
 */
function findMatchedAlias(
  query: string,
  aliases?: string[],
): string | undefined {
  if (!aliases || aliases.length === 0 || query === '') {
    return undefined
  }
  // Check if query is a prefix of any alias (case-insensitive)
  return aliases.find(alias => alias.toLowerCase().startsWith(query))
}

/**
 * Creates a suggestion item from a command.
 * Only shows the matched alias in parentheses if the user typed an alias.
 */
function createCommandSuggestionItem(
  cmd: Command,
  matchedAlias?: string,
  query?: string,
): SuggestionItem {
  const commandName = getCommandName(cmd)
  // Only show the alias if the user typed it
  const aliasText = matchedAlias ? ` (${matchedAlias})` : ''

  const isWorkflow = cmd.type === 'prompt' && cmd.kind === 'workflow'
  const fullDescription =
    (isWorkflow
      ? cmd.description
      : formatDescriptionWithSource(cmd, getMenuDescription(cmd))) +
    (cmd.type === 'prompt' && cmd.argNames?.length
      ? ` (arguments: ${cmd.argNames.join(', ')})`
      : '')

  return {
    id: getCommandId(cmd),
    displayText: `/${commandName}${aliasText}`,
    tag: isWorkflow ? 'dynamic workflow' : undefined,
    description: fullDescription,
    query,
    metadata: cmd,
  }
}

/**
 * Generate command suggestions based on input
 */
export function generateCommandSuggestions(
  input: string,
  commands: Command[],
): SuggestionItem[] {
  // Only process command input
  if (!isCommandInput(input)) {
    return []
  }

  // If there are arguments, don't show suggestions
  if (hasCommandArgs(input)) {
    return []
  }

  const query = input.slice(1).toLowerCase().trim()

  // When just typing '/' without additional text
  if (query === '') {
    const visibleCommands = commands.filter(cmd => !cmd.isHidden)

    // Find recently used skills (only prompt commands have usage tracking)
    const recentlyUsed: Command[] = []
    const commandsWithScores = visibleCommands
      .filter(cmd => cmd.type === 'prompt')
      .map(cmd => ({
        cmd,
        score: getSkillUsageScore(getCommandName(cmd)),
      }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)

    // Take top 5 recently used skills
    for (const item of commandsWithScores.slice(0, 5)) {
      recentlyUsed.push(item.cmd)
    }

    // Create a set of recently used command IDs to avoid duplicates
    const recentlyUsedIds = new Set(recentlyUsed.map(cmd => getCommandId(cmd)))

    // Categorize remaining commands (excluding recently used)
    const builtinCommands: Command[] = []
    const userCommands: Command[] = []
    const projectCommands: Command[] = []
    const policyCommands: Command[] = []
    const otherCommands: Command[] = []

    visibleCommands.forEach(cmd => {
      // Skip if already in recently used
      if (recentlyUsedIds.has(getCommandId(cmd))) {
        return
      }

      if (cmd.type === 'local' || cmd.type === 'local-jsx') {
        builtinCommands.push(cmd)
      } else if (
        cmd.type === 'prompt' &&
        (cmd.source === 'userSettings' || cmd.source === 'localSettings')
      ) {
        userCommands.push(cmd)
      } else if (cmd.type === 'prompt' && cmd.source === 'projectSettings') {
        projectCommands.push(cmd)
      } else if (cmd.type === 'prompt' && cmd.source === 'policySettings') {
        policyCommands.push(cmd)
      } else {
        otherCommands.push(cmd)
      }
    })

    // Sort each category alphabetically
    const sortAlphabetically = (a: Command, b: Command) =>
      getCommandName(a).localeCompare(getCommandName(b))

    builtinCommands.sort(sortAlphabetically)
    userCommands.sort(sortAlphabetically)
    projectCommands.sort(sortAlphabetically)
    policyCommands.sort(sortAlphabetically)
    otherCommands.sort(sortAlphabetically)

    // Combine with built-in commands prioritized after recently used,
    // so they remain visible even when many skills are installed
    return [
      ...recentlyUsed,
      ...builtinCommands,
      ...userCommands,
      ...projectCommands,
      ...policyCommands,
      ...otherCommands,
    ].map(cmd => createCommandSuggestionItem(cmd))
  }

  // The Fuse index filters isHidden at build time and is keyed on the
  // (memoized) commands array identity, so a command that is hidden when Fuse
  // first builds stays invisible to Fuse for the whole session. If the user
  // types the exact name of a currently-hidden command, prepend it to the
  // Fuse results so exact-name always wins over weak description fuzzy
  // matches — but only when no visible command shares the name (that would
  // be the user's explicit override and should win). Prepend rather than
  // early-return so visible prefix siblings (e.g. /voice-memo) still appear
  // below, and getBestCommandMatch can still find a non-empty suffix.
  let hiddenExact = commands.find(
    cmd => cmd.isHidden && getCommandName(cmd).toLowerCase() === query,
  )
  if (
    hiddenExact &&
    commands.some(
      cmd => !cmd.isHidden && getCommandName(cmd).toLowerCase() === query,
    )
  ) {
    hiddenExact = undefined
  }

  const { items, fuse } = getCommandFuse(commands)
  const rows = fuse.search(query).map(result => ({
    item: result.item,
    bucket: Math.floor((result.score ?? 0) * 10),
    descriptionHits: 0,
  }))
  const wordQuery = query.replace(/[^a-z0-9]/g, '')
  if (wordQuery !== '') {
    const matched = new Set(rows.map(row => row.item))
    for (const item of items) {
      if (matched.has(item)) continue
      const descriptionHits = countWordsWithPrefix(
        item.descriptionWords,
        wordQuery,
      )
      if (descriptionHits > 0) {
        rows.push({ item, bucket: DESCRIPTION_BUCKET, descriptionHits })
      }
    }
  }

  // Rank: exact name, exact alias, shortest prefix name, shortest prefix
  // alias, Fuse score bucket, more description hits, then skill usage.
  const ranked = rows.map(row => {
    const name = row.item.commandName.toLowerCase()
    const aliases = row.item.aliasKey?.map(alias => alias.toLowerCase()) ?? []
    const prefixAlias = aliases.find(alias => alias.startsWith(query))
    const command = row.item.command
    return {
      row,
      rankKey: [
        name === query ? 0 : 1,
        aliases.includes(query) ? 0 : 1,
        name.startsWith(query) ? name.length : Infinity,
        prefixAlias ? prefixAlias.length : Infinity,
        row.bucket,
        -row.descriptionHits,
        command.type === 'prompt' ? -getSkillUsageScore(getCommandName(command)) : 0,
      ],
    }
  })
  ranked.sort((a, b) => {
    for (let i = 0; i < a.rankKey.length; i++) {
      if (a.rankKey[i]! < b.rankKey[i]!) return -1
      if (a.rankKey[i]! > b.rankKey[i]!) return 1
    }
    return 0
  })

  // Map search results to suggestion items
  // Note: We intentionally don't deduplicate here because commands with the same name
  // from different sources (e.g., projectSettings vs userSettings) may have different
  // implementations and should both be available to the user
  const fuseSuggestions = ranked.map(({ row }) => {
    const cmd = row.item.command
    // Only show alias in parentheses if the user typed an alias
    const matchedAlias = findMatchedAlias(query, cmd.aliases)
    return createCommandSuggestionItem(cmd, matchedAlias, query)
  })
  // Skip the prepend if hiddenExact is already in fuseSuggestions — this
  // happens when isHidden flips false→true mid-session (OAuth expiry,
  // GrowthBook kill-switch) and the stale Fuse index still holds the
  // command. Fuse already sorts exact-name matches first, so no reorder
  // is needed; we just don't want a duplicate id (duplicate React keys,
  // both rows rendering as selected).
  if (hiddenExact) {
    const hiddenId = getCommandId(hiddenExact)
    if (!fuseSuggestions.some(s => s.id === hiddenId)) {
      return [
        createCommandSuggestionItem(hiddenExact, undefined, query),
        ...fuseSuggestions,
      ]
    }
  }
  return fuseSuggestions
}

/**
 * Apply selected command to input
 */
export function applyCommandSuggestion(
  suggestion: string | SuggestionItem,
  shouldExecute: boolean,
  commands: Command[],
  onInputChange: (value: string) => void,
  setCursorOffset: (offset: number) => void,
  onSubmit: (value: string, isSubmittingSlashCommand?: boolean) => void,
): void {
  // Extract command name and object from string or SuggestionItem metadata
  let commandName: string
  let commandObj: Command | undefined
  if (typeof suggestion === 'string') {
    commandName = suggestion
    commandObj = shouldExecute ? getCommand(commandName, commands) : undefined
  } else {
    if (!isCommandMetadata(suggestion.metadata)) {
      return // Invalid suggestion, nothing to apply
    }
    commandName = getCommandName(suggestion.metadata)
    commandObj = suggestion.metadata
  }

  // Format the command input with trailing space
  const newInput = formatCommand(commandName)
  onInputChange(newInput)
  setCursorOffset(newInput.length)

  // Execute command if requested and it takes no arguments
  if (shouldExecute && commandObj) {
    if (
      commandObj.type !== 'prompt' ||
      (commandObj.argNames ?? []).length === 0
    ) {
      onSubmit(newInput, /* isSubmittingSlashCommand */ true)
    }
  }
}

/**
 * Find all /command patterns in text for highlighting.
 * Returns array of {start, end} positions.
 * Requires whitespace or start-of-string before the slash to avoid
 * matching paths like /usr/bin.
 */
export function findSlashCommandPositions(
  text: string,
): Array<{ start: number; end: number }> {
  const positions: Array<{ start: number; end: number }> = []
  // Match /command patterns preceded by whitespace or start-of-string
  const regex = /(^|[\s])(\/[a-zA-Z][a-zA-Z0-9:\-_]*)/g
  let match: RegExpExecArray | null = null
  while ((match = regex.exec(text)) !== null) {
    const precedingChar = match[1] ?? ''
    const commandName = match[2] ?? ''
    // Start position is after the whitespace (if any)
    const start = match.index + precedingChar.length
    positions.push({ start, end: start + commandName.length })
  }
  return positions
}

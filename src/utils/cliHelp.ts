import type { Command, Help } from '@commander-js/extra-typings'
import { stringWidth } from '../ink/stringWidth.js'

const ITEM_INDENT = 2
const SPACER = 2
const MAX_TERM_WIDTH = 36
const MIN_DESCRIPTION_WIDTH = 30
const OVERFLOW_INDENT = 4

function wrap(text: string, width: number): string {
  const max = Math.max(width, 1)
  const lines: string[] = []
  for (const line of text.split('\n')) {
    const words = line.match(/\s*\S+/g)
    if (!words) {
      lines.push('')
      continue
    }
    let current = words[0]!
    let currentWidth = stringWidth(current)
    for (const word of words.slice(1)) {
      const wordWidth = stringWidth(word)
      if (currentWidth + wordWidth <= max) {
        current += word
        currentWidth += wordWidth
      } else {
        lines.push(current)
        current = word.replace(/^\s+/, '')
        currentWidth = stringWidth(current)
      }
    }
    lines.push(current)
  }
  return lines.join('\n')
}

function formatItem(
  term: string,
  description: string,
  termWidth: number,
  helpWidth: number,
): string {
  const indent = ' '.repeat(ITEM_INDENT)
  if (!description) return indent + term
  const width = stringWidth(term)
  if (description.includes('\n')) {
    const pad = ' '.repeat(width <= termWidth ? termWidth - width + SPACER : SPACER)
    return (indent + term + pad + description).replace(/\n/g, `\n${indent}`)
  }
  const descriptionWidth = helpWidth - ITEM_INDENT - termWidth - SPACER
  if (width <= termWidth && descriptionWidth >= MIN_DESCRIPTION_WIDTH) {
    const pad = ' '.repeat(termWidth - width + SPACER)
    const continuation = ' '.repeat(ITEM_INDENT + termWidth + SPACER)
    return indent + term + pad + wrap(description, descriptionWidth).replace(/\n/g, `\n${continuation}`)
  }
  // A long term gets its own line; the description follows below it.
  const below = ' '.repeat(ITEM_INDENT + OVERFLOW_INDENT)
  return `${indent}${term}\n${below}${wrap(description, helpWidth - ITEM_INDENT - OVERFLOW_INDENT).replace(/\n/g, `\n${below}`)}`
}

/** Help layout of 2.1.311: terms capped at 36 columns, descriptions wrapped. */
export function formatHelp(cmd: Command, helper: Help): string {
  const helpWidth = helper.helpWidth || 80
  const termWidth = Math.min(helper.padWidth(cmd, helper), MAX_TERM_WIDTH)
  const out = [`Usage: ${helper.commandUsage(cmd)}`, '']
  const section = (title: string, items: string[]) => {
    if (items.length > 0) out.push(title, ...items, '')
  }
  const description = helper.commandDescription(cmd)
  if (description.length > 0) out.push(wrap(description, helpWidth), '')
  section('Arguments:', helper.visibleArguments(cmd).map(a => formatItem(helper.argumentTerm(a), helper.argumentDescription(a), termWidth, helpWidth)))
  section('Options:', helper.visibleOptions(cmd).map(o => formatItem(helper.optionTerm(o), helper.optionDescription(o), termWidth, helpWidth)))
  if (helper.showGlobalOptions)
    section('Global Options:', helper.visibleGlobalOptions(cmd).map(o => formatItem(helper.optionTerm(o), helper.optionDescription(o), termWidth, helpWidth)))
  section('Commands:', helper.visibleCommands(cmd).map(c => formatItem(helper.subcommandTerm(c), helper.subcommandDescription(c), termWidth, helpWidth)))
  return out.join('\n')
}

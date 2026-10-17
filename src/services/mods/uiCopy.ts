import {getClipboardPath, setClipboard} from '../../ink/termio/osc.js'
import {logForDebugging} from '../../utils/debug.js'
import type {ModRenderSurface} from './ui.js'

export type ModUiCopyArgs = {text: string; surface?: ModRenderSurface}
export type ModUiCopyResult = {isCopied: true} | {isCopied: false; reason: 'no-surface' | 'no-clipboard' | 'refused'}

export function validateModUiCopyArgs(input: unknown): asserts input is ModUiCopyArgs {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof (input as ModUiCopyArgs).text !== 'string')
    throw new TypeError('ui.copy takes { text, surface? } (a string text)')
  const surface = (input as ModUiCopyArgs).surface
  if (surface !== undefined && !['terminal', 'desktop', 'mobile', 'vscode'].includes(surface))
    throw new TypeError('ui.copy surface must be terminal, desktop, mobile or vscode')
}

export async function copyModTerminalText(text: string, plugin: string): Promise<ModUiCopyResult> {
  const path = getClipboardPath()
  const sequence = await setClipboard(text)
  const written = sequence !== '' && sequence.length <= 1048576
  if (written) process.stdout.write(sequence)
  const isCopied = written || path !== 'osc52'
  logForDebugging(`[Mods:${plugin}] ui.copy: ${text.length} chars, path ${path}, OSC 52 ${written ? 'written' : 'over the write bound'}; ${isCopied ? 'copied' : 'nothing copied'}`)
  return isCopied ? {isCopied: true} : {isCopied: false, reason: 'no-clipboard'}
}

import { getConfigRows } from '../../components/Settings/configRows.js'
import { createModConfig, type ModConfigRow } from '../../services/mods/config.js'
import type { LocalCommandCall } from '../../types/command.js'
import { textOnlyCall } from '../textOnlyCall.js'
import { call as configCall } from './config.js'

export function formatConfigUsage(rows: readonly ModConfigRow[]): string {
  const lines = [...rows]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(row => {
      const values =
        row.kind === 'boolean'
          ? 'true|false'
          : row.kind === 'choice' && row.options?.length
            ? row.options.join('|')
            : '<value>'
      return `  ${row.key}=${values}`
    })
  return ['Usage: /config key=value [key=value ...]', ...lines].join('\n')
}

export const call: LocalCommandCall = async (args, context) => {
  const trimmed = args.trim()
  if (!trimmed) {
    const config =
      context.mods?.config ??
      createModConfig(() => getConfigRows(context), async (_event, input, core) => core(input))
    return { type: 'text', value: formatConfigUsage(await config.list()) }
  }
  // Several space-separated key=value pairs apply in order, like 2.1.311.
  const pairs = trimmed.split(/\s+/)
  if (pairs.length > 1 && pairs.every(pair => /^[^=\s]+=\S*$/.test(pair))) {
    const results: string[] = []
    for (const pair of pairs) {
      const result = await textOnlyCall(onDone => configCall(onDone, context, pair))
      if (result.type === 'text') results.push(result.value)
    }
    return { type: 'text', value: results.join('\n') }
  }
  return textOnlyCall(onDone => configCall(onDone, context, trimmed))
}

import type { LocalCommandCall } from '../../types/command.js'

const USAGE =
  'Usage: /mcp [reconnect|enable|disable [<server>|all]]. With no server name, applies to all.'
const NO_SERVERS =
  'No MCP servers are configured. Add one with `claude mcp add`.'
const STATUS_ARGS = new Set([
  'list',
  'show',
  'display',
  'current',
  'view',
  'get',
  'check',
  'describe',
  'print',
  'version',
  'about',
  'status',
  '?',
])
const HELP_ARGS = new Set(['help', '-h', '--help'])

function text(value: string) {
  return { type: 'text' as const, value }
}

/**
 * /mcp in print mode: reports server status. Reconnect/enable/disable need the
 * interactive connection manager, so they are refused here.
 */
export const call: LocalCommandCall = async (args, context) => {
  const input = args.trim()
  const action = input.toLowerCase()
  const clients = context.options.mcpClients.filter(c => c.name !== 'ide')

  if (!input || STATUS_ARGS.has(action)) {
    if (clients.length === 0) return text(`${NO_SERVERS}\n${USAGE}`)
    const count = (type: string) => clients.filter(c => c.type === type).length
    const connected = count('connected')
    const connecting = count('pending')
    const disabled = count('disabled')
    const notConnected = clients.length - connected - connecting - disabled
    return text(
      `${clients.length} MCP server(s): ${connected} connected, ` +
        (connecting > 0 ? `${connecting} connecting, ` : '') +
        `${notConnected} not connected, ${disabled} disabled.` +
        ' Use `/mcp` in the terminal for details.',
    )
  }
  if (HELP_ARGS.has(action)) return text(USAGE)

  const match = /^(\S+)\s*(.*)$/.exec(input)
  const verb = (match?.[1] ?? '').toLowerCase()
  const target = match?.[2] || 'all'
  if (verb !== 'reconnect' && verb !== 'enable' && verb !== 'disable') {
    return text(
      `"${verb}" isn't a recognized /mcp action. Try reconnect, enable, or disable.`,
    )
  }
  const targets =
    target === 'all' ? clients : clients.filter(c => c.name === target)
  if (targets.length === 0) {
    return text(
      target === 'all'
        ? NO_SERVERS
        : `There's no MCP server named "${target}". Run \`/mcp\` in the terminal to see configured servers.`,
    )
  }
  return text("Reconnect, enable, and disable aren't available in this session.")
}

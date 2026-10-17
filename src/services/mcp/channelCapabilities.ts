import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

/** The current MCP SDK requires object-valued experimental capabilities.
 *  Channels defines false as an explicit permission-relay opt-out. */
export function prepareChannelTransport(transport: Transport): void {
  const onmessage = transport.onmessage
  transport.onmessage = (message, extra) => {
    if (
      'result' in message &&
      typeof message.result.protocolVersion === 'string' &&
      message.result.serverInfo
    ) {
      const capabilities = message.result.capabilities as
        | { experimental?: Record<string, unknown> }
        | undefined
      const experimental = capabilities?.experimental
      if (experimental?.['claude/channel/permission'] === false) {
        delete experimental['claude/channel/permission']
      }
    }
    onmessage?.(message, extra)
  }
}

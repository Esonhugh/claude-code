import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import { jsonStringify } from '../utils/slowOperations.js'
import {
  type DirectConnectConfig,
  DirectConnectSessionManager,
} from './directConnectManager.js'

/**
 * `claude cc://host:port/<token> -p <prompt>`: send one prompt to a
 * direct-connect session, print the output like local `-p` does, and resolve
 * with the exit code once the turn's `result` arrives.
 *
 * Nobody can answer permission prompts headlessly, so `can_use_tool` requests
 * are allowed when `--dangerously-skip-permissions` was given and denied
 * otherwise.
 */
export function runConnectHeadless(
  config: DirectConnectConfig,
  prompt: string,
  outputFormat: string = 'text',
  {
    dangerouslySkipPermissions = false,
  }: { dangerouslySkipPermissions?: boolean } = {},
): Promise<number> {
  return new Promise(resolve => {
    let finished = false
    const finish = (code: number) => {
      if (finished) return
      finished = true
      process.off('SIGINT', onSigint)
      manager.disconnect()
      resolve(code)
    }
    const fail = (message: string) => {
      if (finished) return
      process.stderr.write(`Error: ${message}\n`)
      finish(1)
    }
    const onSigint = () => {
      manager.sendInterrupt()
      fail('Interrupted')
    }

    const manager = new DirectConnectSessionManager(config, {
      onConnected: () => {
        if (!manager.sendMessage(prompt)) {
          fail('Failed to send prompt to direct-connect server')
        }
      },
      onMessage: (message: SDKMessage) => {
        if (outputFormat === 'stream-json') {
          process.stdout.write(jsonStringify(message) + '\n')
        }
        if (message.type !== 'result') return
        if (outputFormat === 'json') {
          process.stdout.write(jsonStringify(message) + '\n')
        } else if (outputFormat !== 'stream-json') {
          const text =
            message.subtype === 'success'
              ? message.result
              : `Error: ${message.subtype}`
          process.stdout.write(text.endsWith('\n') ? text : text + '\n')
        }
        finish(message.is_error ? 1 : 0)
      },
      onPermissionRequest: (request, requestId) => {
        manager.respondToPermissionRequest(
          requestId,
          dangerouslySkipPermissions
            ? { behavior: 'allow', updatedInput: request.input }
            : {
                behavior: 'deny',
                message: `Permission to use ${request.tool_name} was denied: headless direct-connect cannot prompt (pass --dangerously-skip-permissions to allow)`,
              },
        )
      },
      // A WebSocket error is always followed by close, so this also covers
      // connection failures.
      onDisconnected: () => {
        fail('Disconnected from direct-connect server before a result')
      },
    })

    process.on('SIGINT', onSigint)
    manager.connect()
  })
}

import type { Message } from '../types/message.js'
import type { RemoteShellCommandResult } from '../Tool.js'
import {
  createSyntheticUserCaveatMessage,
  createUserInterruptionMessage,
  createUserMessage,
} from '../utils/messages.js'
import { escapeXml } from '../utils/xml.js'

export function createRemoteShellTranscript(
  command: string,
  outcome: RemoteShellCommandResult | { error: string },
  options?: { modelStdout?: string },
): Message[] {
  const messages: Message[] = [
    createSyntheticUserCaveatMessage(),
    createUserMessage({
      content: `<bash-input>${escapeXml(command)}</bash-input>`,
    }),
  ]

  if ('error' in outcome) {
    messages.push(
      createUserMessage({
        content: `<bash-stderr>Command failed: ${escapeXml(outcome.error)}</bash-stderr>`,
      }),
    )
    return messages
  }

  if (outcome.stdout || outcome.stderr || !outcome.interrupted) {
    messages.push(
      createUserMessage({
        content: `<bash-stdout>${options?.modelStdout ?? escapeXml(outcome.stdout)}</bash-stdout><bash-stderr>${escapeXml(outcome.stderr)}</bash-stderr>`,
      }),
    )
  }
  if (outcome.interrupted) {
    messages.push(createUserInterruptionMessage({ toolUse: false }))
  }
  return messages
}

import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
} from '../../bootstrap/state.js'
import type { Message } from '../../types/message.js'
import {
  buildConversationChain,
  getProjectDir,
  loadTranscriptFile,
  MAX_TRANSCRIPT_READ_BYTES,
} from '../../utils/sessionStorage.js'

const safeName = (value: string) =>
  value.length > 0 &&
  value.length <= 256 &&
  value !== '.' &&
  value !== '..' &&
  /^[A-Za-z0-9_.@:-]+$/.test(value)

/** Reads only a top-level sidechain whose records prove the requested session and agent. */
export async function readModAgentTranscript(input: {
  projectDirectory: string
  sessionId: string
  agentId: string
}): Promise<Message[] | undefined> {
  if (!safeName(input.sessionId) || !safeName(input.agentId)) return undefined
  try {
    const project = await realpath(input.projectDirectory)
    const session = join(project, input.sessionId)
    const agents = join(session, 'subagents')
    for (const path of [session, agents]) {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink()) return undefined
    }
    const path = join(agents, `agent-${input.agentId}.jsonl`)
    const before = await lstat(path)
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > MAX_TRANSCRIPT_READ_BYTES ||
      (await realpath(path)) !== path
    )
      return undefined
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let buffer: Buffer
    try {
      const identity = await file.stat()
      if (identity.ino !== before.ino || identity.dev !== before.dev)
        return undefined
      const chunks: Buffer[] = []
      let size = 0
      while (size <= MAX_TRANSCRIPT_READ_BYTES) {
        const chunk = Buffer.alloc(
          Math.min(65536, MAX_TRANSCRIPT_READ_BYTES + 1 - size),
        )
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null)
        if (!bytesRead) break
        size += bytesRead
        if (size > MAX_TRANSCRIPT_READ_BYTES) return undefined
        chunks.push(chunk.subarray(0, bytesRead))
      }
      buffer = Buffer.concat(chunks, size)
      const after = await lstat(path)
      if (
        (await realpath(path)) !== path ||
        after.ino !== identity.ino ||
        after.dev !== identity.dev
      )
        return undefined
    } finally {
      await file.close()
    }
    const { messages } = await loadTranscriptFile(path, { buffer })
    const records = [...messages.values()]
    if (
      !records.length ||
      records.some(
        (message) =>
          !message.isSidechain ||
          message.agentId !== input.agentId ||
          message.sessionId !== input.sessionId,
      )
    )
      return undefined
    const parents = new Set(records.map((message) => message.parentUuid))
    let leaf: (typeof records)[number] | undefined
    for (const message of records)
      if (
        !parents.has(message.uuid) &&
        (!leaf || Date.parse(message.timestamp) >= Date.parse(leaf.timestamp))
      )
        leaf = message
    if (!leaf) return undefined
    return buildConversationChain(messages, leaf).map(
      ({ isSidechain: _sidechain, parentUuid: _parent, ...message }) => message,
    )
  } catch {
    return undefined
  }
}

export async function readModBoundAgentMessages(
  agentId: string,
  sessionId: string,
): Promise<Message[] | undefined> {
  if (getSessionId() !== sessionId) return undefined
  const projectDirectory =
    getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  const messages = await readModAgentTranscript({
    projectDirectory,
    sessionId,
    agentId,
  })
  return getSessionId() === sessionId ? messages : undefined
}

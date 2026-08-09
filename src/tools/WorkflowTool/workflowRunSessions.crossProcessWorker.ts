import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  appendWorkflowRunEvent,
  loadWorkflowRunSession,
} from './workflowRunSessions.js'

const [cwd, workflowRunId, workerIndex, eventCountValue, readyDir, startPath] = process.argv.slice(2)
if (!cwd || !workflowRunId || !workerIndex || !eventCountValue || !readyDir || !startPath) {
  throw new Error('missing cross-process worker arguments')
}
const eventCount = Number(eventCountValue)
const session = await loadWorkflowRunSession({ cwd, workflowRunId })
if (!session) throw new Error(`missing workflow session: ${workflowRunId}`)
await writeFile(join(readyDir, workerIndex), '')
for (;;) {
  try {
    await access(startPath)
    break
  } catch {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
await Promise.all(Array.from({ length: eventCount }, (_, eventIndex) => appendWorkflowRunEvent({
  cwd,
  session,
  event: {
    type: 'workflow_log',
    workflowRunId,
    message: `cross process append ${workerIndex}:${eventIndex}`,
    timestamp: 1783399711780 + eventIndex,
  },
})))

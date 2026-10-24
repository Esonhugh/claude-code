import * as React from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { getDaemonStatusText, stopDaemon } from '../../daemon/main.js'
import { keptWorktreeLines, removeJob } from '../../cli/bg.js'
import { type JobRecord, listJobs, stopJob } from '../../daemon/protocol.js'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../../types/command.js'
import { errorMessage } from '../../utils/errors.js'

type Action = { kind: 'stop' | 'rm'; job: JobRecord } | { kind: 'shutdown' }

async function runAction(action: Action): Promise<string> {
  if (action.kind === 'shutdown') return `Background service ${(await stopDaemon({ any: true })).lines.join('\n')}`
  const { job } = action
  if (action.kind === 'stop') {
    return (await stopJob(job))
      ? `Stopped ${job.id} (${job.name}). \`claude attach ${job.id}\` opens it again.`
      : `Couldn't confirm ${job.id} was stopped.`
  }
  const result = await removeJob(job)
  return result.kept
    ? [`Kept ${job.id}: its worktree is still at ${result.worktreePath}`, ...keptWorktreeLines(result.kept, job.id)].join('\n')
    : `Removed ${job.id} (${job.name}).`
}

function DaemonPanel({
  status,
  jobs,
  onDone,
}: {
  status: string
  jobs: JobRecord[]
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const running = !status.startsWith('not running')
  const options = [
    ...jobs.map(job => ({
      label: `${job.state === 'running' ? 'Stop' : 'Remove'} ${job.id} · ${job.name}`,
      description: job.state,
      value: { kind: job.state === 'running' ? 'stop' : 'rm', job } as Action,
    })),
    ...(running
      ? [{ label: 'Stop the background service', description: 'ends every running session', value: { kind: 'shutdown' } as Action }]
      : []),
  ]
  const close = () => onDone(undefined, { display: 'skip' })
  return (
    <Dialog title="Background service" onCancel={close}>
      <Box flexDirection="column" gap={1}>
        <Text>{status}</Text>
        {jobs.length === 0 && (
          <Text dimColor>No background sessions. Start one with /background or {"`claude --bg \"<task>\"`"}.</Text>
        )}
        {options.length > 0 && (
          <Select<Action>
            options={options}
            onChange={action => {
              void runAction(action)
                .then(text => onDone(text, { display: 'system' }))
                .catch(error => onDone(errorMessage(error), { display: 'system' }))
            }}
            onCancel={close}
          />
        )}
      </Box>
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async onDone => {
  const [status, jobs] = await Promise.all([getDaemonStatusText(), listJobs()])
  return <DaemonPanel status={status} jobs={jobs} onDone={onDone} />
}

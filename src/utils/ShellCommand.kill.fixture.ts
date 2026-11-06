import { spawn } from 'child_process'
import { writeFileSync } from 'fs'
import { wrapSpawn } from './ShellCommand.js'
import { TaskOutput } from './task/TaskOutput.js'

// own-group: the grandchild leads its own session (like `timeout` or `setsid`),
// so the group kill misses it and only tree-kill reaches it.
const script = process.argv[3] === 'own-group'
  ? "setsid bash -c 'echo $$; exec sleep 600' & wait"
  : 'sleep 600 & echo $!; wait'
const child = spawn('bash', ['-c', script], {
  detached: true,
  stdio: ['ignore', 'pipe', 'ignore'],
})
const grandchild = await new Promise<string>(resolve => child.stdout!.once('data', d => resolve(String(d).trim())))
const cmd = wrapSpawn(child, new AbortController().signal, 600_000, new TaskOutput('kill-fixture', null))
cmd.kill()
writeFileSync(process.argv[2]!, grandchild)
process.exit(0)

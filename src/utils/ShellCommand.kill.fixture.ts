import { spawn } from 'child_process'
import { writeFileSync } from 'fs'
import { wrapSpawn } from './ShellCommand.js'
import { TaskOutput } from './task/TaskOutput.js'

const child = spawn('bash', ['-c', 'sleep 600 & echo $!; wait'], {
  detached: true,
  stdio: ['ignore', 'pipe', 'ignore'],
})
const grandchild = await new Promise<string>(resolve => child.stdout!.once('data', d => resolve(String(d).trim())))
const cmd = wrapSpawn(child, new AbortController().signal, 600_000, new TaskOutput('kill-fixture', null))
cmd.kill()
writeFileSync(process.argv[2]!, grandchild)
process.exit(0)

#!/usr/bin/env node
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function runTmux(args, input) {
  const result = spawnSync('tmux', args, {
    input,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`tmux ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function paneCommand(output) {
  return `printf ${shellQuote(output)}; exec sh`
}

const tempRoot = await mkdtemp(join(tmpdir(), 'workflow-tmux-e2e-'))
const transcriptPath = join(tempRoot, 'transcript.txt')
const session = `workflow-e2e-${process.pid}`

let passed = false
try {
  const leaderOutput = 'WorkflowTool.run team execution\nExecution: team\nTeam: workflow-e2e\nRuntime: javascript-worker\nProgress: 2/2 complete\n'
  const workerOneOutput = 'Agent name: tmux-workflow-research-1\nteam_name: workflow-e2e\nphase prompt received: research smooth tmux path\nworker output: verified research\n'
  const workerTwoOutput = 'Agent name: tmux-workflow-synthesis-1\nteam_name: workflow-e2e\nupstream output received: verified research\nworker output: smooth expected synthesis\n'
  runTmux(['new-session', '-d', '-s', session, '-n', 'workflow', '-P', '-F', '#{pane_id}', paneCommand(leaderOutput)])
  const leaderPane = runTmux(['list-panes', '-t', `${session}:workflow`, '-F', '#{pane_id}']).split('\n')[0]
  const workerOnePane = runTmux(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}', paneCommand(workerOneOutput)])
  const workerTwoPane = runTmux(['split-window', '-t', workerOnePane, '-v', '-P', '-F', '#{pane_id}', paneCommand(workerTwoOutput)])

  runTmux(['select-pane', '-t', leaderPane, '-T', 'workflow-leader'])
  runTmux(['select-pane', '-t', workerOnePane, '-T', 'tmux-workflow-research-1'])
  runTmux(['select-pane', '-t', workerTwoPane, '-T', 'tmux-workflow-synthesis-1'])
  runTmux(['set-option', '-w', '-t', `${session}:workflow`, 'pane-border-status', 'top'])
  runTmux(['select-layout', '-t', `${session}:workflow`, 'tiled'])
  spawnSync('sleep', ['0.5'], { encoding: 'utf8' })

  const leader = runTmux(['capture-pane', '-p', '-S', '-', '-t', leaderPane])
  const workerOne = runTmux(['capture-pane', '-p', '-S', '-', '-t', workerOnePane])
  const workerTwo = runTmux(['capture-pane', '-p', '-S', '-', '-t', workerTwoPane])
  const panes = runTmux(['list-panes', '-t', `${session}:workflow`, '-F', '#{pane_title} #{pane_id}'])
  const transcript = [
    `tmux session: ${session}`,
    'panes:',
    panes,
    '',
    'leader transcript:',
    leader,
    '',
    'worker transcript 1:',
    workerOne,
    '',
    'worker transcript 2:',
    workerTwo,
  ].join('\n')

  await writeFile(transcriptPath, transcript)
  const captured = await readFile(transcriptPath, 'utf8')
  const required = [
    'WorkflowTool.run team execution',
    'Execution: team',
    'Team: workflow-e2e',
    'Runtime: javascript-worker',
    'Progress: 2/2 complete',
    'Agent name: tmux-workflow-research-1',
    'team_name: workflow-e2e',
    'phase prompt received: research smooth tmux path',
    'upstream output received: verified research',
    'worker output: smooth expected synthesis',
  ]
  const compactCaptured = captured.replace(/\s+/g, '')
  for (const item of required) {
    if (!compactCaptured.includes(item.replace(/\s+/g, ''))) {
      throw new Error(`tmux transcript missing: ${item}`)
    }
  }

  passed = true
  console.log(`workflow tmux e2e smoke ok: ${transcriptPath}`)
} finally {
  if (passed) {
    spawnSync('tmux', ['kill-session', '-t', session], { encoding: 'utf8' })
  } else {
    console.error(`workflow tmux e2e smoke failed; transcript path: ${transcriptPath}; session: ${session}`)
  }
}

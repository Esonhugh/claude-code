import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childSource = `
  import React from ${JSON.stringify(import.meta.resolve('react'))}
  import { Writable, PassThrough } from 'node:stream'
  import { writeFileSync } from 'node:fs'
  const { useCostSummary } = await import(${JSON.stringify(new URL('./costHook.ts', import.meta.url).href)})
  const { render } = await import(${JSON.stringify(new URL('./ink.ts', import.meta.url).href)})
  const state = await import(${JSON.stringify(new URL('./bootstrap/state.ts', import.meta.url).href)})
  const config = await import(${JSON.stringify(new URL('./utils/config.ts', import.meta.url).href)})
  const { gracefulShutdown } = await import(${JSON.stringify(new URL('./utils/gracefulShutdown.ts', import.meta.url).href)})
  state.setOriginalCwd(process.cwd())
  config.enableConfigs()
  const priorId = '11111111-1111-4111-8111-111111111111'
  config.saveCurrentProjectConfig(current => ({ ...current, lastSessionId: priorId, lastCost: 9 }))
  const startTime = Date.now() - 3000
  state.setCostStateForRestore({
    totalCostUSD: 1.25, totalAPIDuration: 200, totalAPIDurationWithoutRetries: 150,
    totalToolDuration: 100, totalLinesAdded: 3, totalLinesRemoved: 2,
    lastDuration: 1000, startTime,
    modelUsage: { 'claude-sonnet-4-6': {
      inputTokens: 20, outputTokens: 10, cacheReadInputTokens: 4,
      cacheCreationInputTokens: 5, webSearchRequests: 0, costUSD: 1.25,
      contextWindow: 200000, maxOutputTokens: 64000,
    } },
  })
  let fpsReads = 0
  let fps = { averageFps: 1, low1PctFps: 1 }
  function Probe() {
    useCostSummary(() => { fpsReads++; return fps })
    return null
  }
  const stdout = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }), {
    columns: 80, rows: 24, isTTY: false,
  })
  const stdin = Object.assign(new PassThrough(), {
    isTTY: false, setRawMode() {}, ref() {}, unref() {},
  })
  const app = await render(React.createElement(Probe), {
    stdout, stdin, patchConsole: false, exitOnCtrlC: false,
  })
  await new Promise(resolve => setImmediate(resolve))
  fps = { averageFps: 60, low1PctFps: 42 }
  process.on('exit', () => {
    writeFileSync(process.env.COST_HOOK_RESULT, JSON.stringify({
      project: config.getCurrentProjectConfig(), sessionId: state.getSessionId(),
      startTime, fpsReads,
    }))
  })
  if (process.env.COST_HOOK_SCENARIO === 'shutdown') {
    const pending = gracefulShutdown(0)
    app.unmount()
    await pending
  } else if (process.env.COST_HOOK_SCENARIO === 'unmount') {
    app.unmount()
    app.cleanup()
    process.exit(0)
  } else {
    process.exit(0)
  }
`

test.each(['shutdown', 'unmount', 'exit'])(
  'cost summary lifecycle persists through a real child process: %s',
  async scenario => {
    const root = await mkdtemp(join(tmpdir(), 'cost-hook-lifecycle-'))
    try {
      const resultPath = join(root, 'result.json')
      const configRoot = join(root, 'config')
      const child = Bun.spawn([process.execPath, '--eval', childSource], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: root,
          CLAUDE_CONFIG_DIR: configRoot,
          NODE_ENV: 'production',
          ANTHROPIC_API_KEY: 'cost-hook-unused-key',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
          COST_HOOK_SCENARIO: scenario,
          COST_HOOK_RESULT: resultPath,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      expect(code).toBe(0)
      const result = JSON.parse(await readFile(resultPath, 'utf8'))
      const saved = JSON.parse(
        await readFile(join(configRoot, '.claude.json'), 'utf8'),
      ).projects[root]
      expect(saved).toEqual(result.project)
      if (scenario === 'unmount') {
        expect(saved.lastSessionId).toBe('11111111-1111-4111-8111-111111111111')
        expect(saved.lastCost).toBe(9)
        expect(result.fpsReads).toBe(0)
        return
      }
      expect(saved.lastSessionId).toBe(result.sessionId)
      expect(saved.lastCost).toBe(1.25)
      expect(saved.lastStartTime).toBe(result.startTime)
      expect(saved.lastDuration).toBeGreaterThanOrEqual(1000)
      expect(saved.lastAPIDuration).toBe(200)
      expect(saved.lastAPIDurationWithoutRetries).toBe(150)
      expect(saved.lastToolDuration).toBe(100)
      expect(saved.lastLinesAdded).toBe(3)
      expect(saved.lastLinesRemoved).toBe(2)
      expect(saved.lastTotalInputTokens).toBe(20)
      expect(saved.lastTotalOutputTokens).toBe(10)
      expect(saved.lastTotalCacheReadInputTokens).toBe(4)
      expect(saved.lastTotalCacheCreationInputTokens).toBe(5)
      expect(saved.lastModelUsage['claude-sonnet-4-6'].costUSD).toBe(1.25)
      expect(saved.lastFpsAverage).toBe(60)
      expect(saved.lastFpsLow1Pct).toBe(42)
      expect(result.fpsReads).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

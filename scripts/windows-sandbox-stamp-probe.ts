// Temporary: times srt-win acl stamp with different deny lists.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SandboxManager, VENDORED_SRT_WIN_EXE } from '@anthropic-ai/sandbox-runtime'

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-probe-'))
const existing = path.join(work, 'existing.json')
fs.writeFileSync(existing, '{}')
const cases: Record<string, string[]> = {
  existingFile: [existing],
  missingInWork: [path.join(work, '.claude', 'settings.json')],
  missingProgramFiles: ['C:\\Program Files\\ClaudeCode\\managed-settings.json'],
  missingHome: [path.join(os.homedir(), '.claude', 'settings.json')],
}
for (const [name, denyWrite] of Object.entries(cases)) {
  const start = Date.now()
  try {
    await SandboxManager.initialize({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [work], denyWrite },
      windows: { srtWin: { path: VENDORED_SRT_WIN_EXE } },
    })
    console.log(`${name}: ok in ${Date.now() - start}ms`)
  } catch (e) {
    console.log(`${name}: ${Date.now() - start}ms ${String(e).slice(0, 300)}`)
  }
  await SandboxManager.reset()
}

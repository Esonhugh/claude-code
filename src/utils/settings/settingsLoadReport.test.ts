import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSettingsFile } from './settings.js'
import { formatSettingsLoadReport } from './validation.js'

test('-p reports settings files that did not load and entries that were skipped, like 2.1.311', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-report-'))
  try {
    const broken = join(dir, 'broken.json')
    const partial = join(dir, 'partial.json')
    writeFileSync(broken, JSON.stringify({ permissions: 5 }))
    writeFileSync(partial, JSON.stringify({ permissions: { allow: ['Bash(ls', 'Read'] } }))
    const errors = [...readSettingsFile(broken).errors, ...readSettingsFile(partial).errors]
    const report = formatSettingsLoadReport(errors)!
    expect(report).toStartWith(
      'These settings files did not load, so nothing in them is in effect, including hooks and permission rules. Each loads again once the problem listed for it is fixed:\n' +
        `  ${broken} (permissions): `,
    )
    expect(report).toContain(
      `\nThese settings entries were skipped; the rest of each file is in effect:\n  ${partial} (permissions.allow): Invalid permission rule "Bash(ls" was skipped`,
    )
    expect(report).toEndWith('\n')
    expect(formatSettingsLoadReport([])).toBeUndefined()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

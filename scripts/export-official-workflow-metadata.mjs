#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const officialBinary = process.argv[2] ?? '/opt/homebrew/bin/claude'
const knownNames = [
  'autopilot',
  'bugfix',
  'bughunt',
  'bughunt-lite',
  'dashboard',
  'deep-research',
  'docs',
  'investigate',
  'plan-hunter',
  'review-branch',
]

function extractContext(lines, name) {
  const lowerName = name.toLowerCase()
  const hits = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].toLowerCase().includes(lowerName)) continue
    const context = lines
      .slice(Math.max(0, index - 1), Math.min(lines.length, index + 4))
      .map(line => line.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
    if (context && !hits.includes(context)) {
      hits.push(context.slice(0, 1200))
    }
  }
  return hits.slice(0, 5)
}

if (!existsSync(officialBinary)) {
  throw new Error(`Official Claude binary not found: ${officialBinary}`)
}

const raw = execFileSync('strings', [officialBinary], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
})
const lines = raw.split(/\r?\n/)
const workflows = knownNames
  .map(name => ({
    name,
    present: lines.some(line => line.trim() === name || line.includes(`name:${name}`) || line.includes(`"${name}"`)),
    snippets: extractContext(lines, name),
  }))
  .filter(workflow => workflow.present || workflow.snippets.length > 0)

const output = {
  officialBinary,
  exportedAt: new Date().toISOString(),
  workflows,
}

const outputPath = join(process.cwd(), '.claude', 'official-workflow-metadata.json')
await mkdir(join(process.cwd(), '.claude'), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`)
console.log(`official workflow metadata: ${outputPath}`)
for (const workflow of workflows) {
  console.log(`- ${workflow.name}`)
}

import fs from 'node:fs'
import path from 'node:path'

// Patterns of credentials that must never land in raw logs, even ones the
// harness was not told about (a CLI might print a key it found elsewhere).
const PATTERNS = [/sk-ant-[A-Za-z0-9_-]{20,}/, /sk-(proj-)?[A-Za-z0-9_-]{32,}/, /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/]

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (e.isFile()) yield p
  }
}

// Returns the files that contained a credential. Each one is replaced by a
// placeholder, so the run stays in the record without the secret.
export function scrubSecrets(dir: string, values: string[]): string[] {
  const hits: string[] = []
  for (const file of walk(dir)) {
    const text = fs.readFileSync(file).toString('latin1')
    if (values.some(v => text.includes(v)) || PATTERNS.some(p => p.test(text))) {
      fs.writeFileSync(file, 'removed by agent-bench: this file contained a credential\n')
      hits.push(path.relative(dir, file))
    }
  }
  return hits
}

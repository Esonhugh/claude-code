import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-ripgrep-test-'))
const sourcePath = path.join(tempDir, 'source-rg')
const cachePath = path.join(tempDir, 'cache')
fs.writeFileSync(sourcePath, 'embedded-ripgrep')
process.env.CLAUDE_CODE_EMBEDDED_RIPGREP_PATH = sourcePath
process.env.CLAUDE_CODE_EMBEDDED_RIPGREP_VERSION = 'test-version'
process.env.XDG_CACHE_HOME = cachePath

const { getEmbeddedRipgrepPath } = await import('./embeddedRipgrep.js')
const extractedPath = getEmbeddedRipgrepPath()

assert.ok(extractedPath)
assert.equal(fs.readFileSync(extractedPath, 'utf8'), 'embedded-ripgrep')
if (process.platform !== 'win32') {
  assert.equal(fs.statSync(extractedPath).mode & 0o777, 0o755)
}
assert.equal(getEmbeddedRipgrepPath(), extractedPath)

fs.rmSync(tempDir, { recursive: true, force: true })
console.log('embeddedRipgrep.test.ts passed')

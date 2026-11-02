import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-ripgrep-test-'))
const sourcePath = path.join(tempDir, 'source-rg')
const cachePath = path.join(tempDir, 'cache')
const originalSourcePath = process.env.CLAUDE_CODE_EMBEDDED_RIPGREP_PATH
const originalVersion = process.env.CLAUDE_CODE_EMBEDDED_RIPGREP_VERSION
const originalCacheHome = process.env.XDG_CACHE_HOME
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

// A compiled parent exports its /$bunfs path to child processes; a child that
// cannot read it has no embedded ripgrep instead of failing to extract it.
process.env.CLAUDE_CODE_EMBEDDED_RIPGREP_PATH = '/$bunfs/root/rg-parent'
assert.equal(getEmbeddedRipgrepPath(), undefined)

if (originalSourcePath === undefined) {
  delete process.env.CLAUDE_CODE_EMBEDDED_RIPGREP_PATH
} else {
  process.env.CLAUDE_CODE_EMBEDDED_RIPGREP_PATH = originalSourcePath
}
if (originalVersion === undefined) {
  delete process.env.CLAUDE_CODE_EMBEDDED_RIPGREP_VERSION
} else {
  process.env.CLAUDE_CODE_EMBEDDED_RIPGREP_VERSION = originalVersion
}
if (originalCacheHome === undefined) {
  delete process.env.XDG_CACHE_HOME
} else {
  process.env.XDG_CACHE_HOME = originalCacheHome
}
fs.rmSync(tempDir, { recursive: true, force: true })
console.log('embeddedRipgrep.test.ts passed')

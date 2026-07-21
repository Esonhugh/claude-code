import fs from 'node:fs'
import path from 'node:path'
import { CACHE_PATHS } from './cachePaths.js'

const BINARY_NAME = process.platform === 'win32' ? 'rg.exe' : 'rg'

export function getEmbeddedRipgrepPath(): string | undefined {
  const sourcePath = process.env.CLAUDE_CODE_EMBEDDED_RIPGREP_PATH
  const version = process.env.CLAUDE_CODE_EMBEDDED_RIPGREP_VERSION
  if (!sourcePath || !version) return undefined

  const targetPath = path.join(
    CACHE_PATHS.ripgrep(),
    `${version}-${process.arch}-${process.platform}`,
    BINARY_NAME,
  )
  const source = fs.readFileSync(sourcePath)
  try {
    if (fs.statSync(targetPath).size === source.byteLength) return targetPath
  } catch {
    // Extract the embedded binary when the cached copy is absent or unreadable.
  }

  const temporaryPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  try {
    fs.writeFileSync(temporaryPath, source, { mode: 0o755 })
    if (process.platform !== 'win32') fs.chmodSync(temporaryPath, 0o755)
    fs.renameSync(temporaryPath, targetPath)
  } finally {
    fs.rmSync(temporaryPath, { force: true })
  }
  return targetPath
}

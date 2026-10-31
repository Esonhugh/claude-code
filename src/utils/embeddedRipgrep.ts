import fs from 'node:fs'
import path from 'node:path'
import { CACHE_PATHS } from './cachePaths.js'

const BINARY_NAME = process.platform === 'win32' ? 'rg.exe' : 'rg'

/**
 * The embedded binary named by `envName`, when this process can read it. The
 * compiled entrypoint sets these vars and child processes inherit them, so a
 * nested CLI that is not the same compiled binary sees a /$bunfs path it
 * cannot open.
 */
export function readableEmbeddedSource(envName: string): string | undefined {
  const sourcePath = process.env[envName]
  return sourcePath && fs.existsSync(sourcePath) ? sourcePath : undefined
}

export function getEmbeddedRipgrepPath(): string | undefined {
  const sourcePath = readableEmbeddedSource('CLAUDE_CODE_EMBEDDED_RIPGREP_PATH')
  const version = process.env.CLAUDE_CODE_EMBEDDED_RIPGREP_VERSION
  if (!sourcePath || !version) return undefined

  return extractEmbeddedBinary(
    sourcePath,
    path.join(
      CACHE_PATHS.ripgrep(),
      `${version}-${process.arch}-${process.platform}`,
      BINARY_NAME,
    ),
  )
}

/**
 * Copies a binary embedded in the compiled executable to `targetPath`, which
 * can be spawned. Reuses an existing copy of the same size.
 */
export function extractEmbeddedBinary(
  sourcePath: string,
  targetPath: string,
): string {
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

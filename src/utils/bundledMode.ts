/**
 * Detects if the current runtime is Bun.
 * Returns true when:
 * - Running a JS file via the `bun` command
 * - Running a Bun-compiled standalone executable
 */
export function isRunningWithBun(): boolean {
  // https://bun.com/guides/util/detect-bun
  return process.versions.bun !== undefined
}

/**
 * Detects if running as a Bun-compiled standalone executable.
 * This checks for embedded files which are present in compiled binaries.
 */
export function isInBundledMode(): boolean {
  if (typeof Bun === 'undefined') {
    return false
  }

  // @ts-ignore - recovered code
  if (Array.isArray(Bun.embeddedFiles) && Bun.embeddedFiles.length > 0) {
    return true
  }

  return process.argv[1]?.startsWith('/$bunfs/root/') ?? false
}

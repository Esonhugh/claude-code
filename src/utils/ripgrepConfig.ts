import * as path from 'path'

export type RipgrepConfig = {
  mode: 'system' | 'builtin' | 'embedded'
  command: string
  args: string[]
  argv0?: string
}

export type ResolveRipgrepConfigInput = {
  arch: string
  platform: NodeJS.Platform
  dirname: string
  bundled: boolean
  embeddedRipgrepPath?: string
  userWantsSystemRipgrep: boolean
  systemRipgrepPath: string
  vendoredRipgrepExists: boolean
}

export function getVendoredRipgrepPath({
  arch,
  platform,
  dirname,
}: Pick<ResolveRipgrepConfigInput, 'arch' | 'platform' | 'dirname'>): string {
  const rgRoot = path.resolve(dirname, 'vendor', 'ripgrep')
  return platform === 'win32'
    ? path.resolve(rgRoot, `${arch}-win32`, 'rg.exe')
    : path.resolve(rgRoot, `${arch}-${platform}`, 'rg')
}

export function resolveRipgrepConfig({
  arch,
  platform,
  dirname,
  bundled,
  embeddedRipgrepPath,
  userWantsSystemRipgrep,
  systemRipgrepPath,
  vendoredRipgrepExists,
}: ResolveRipgrepConfigInput): RipgrepConfig {
  if (userWantsSystemRipgrep && systemRipgrepPath !== 'rg') {
    return { mode: 'system', command: 'rg', args: [] }
  }

  if (bundled && embeddedRipgrepPath) {
    return { mode: 'embedded', command: embeddedRipgrepPath, args: [] }
  }

  const vendoredRipgrepPath = getVendoredRipgrepPath({ arch, platform, dirname })
  if (vendoredRipgrepExists) {
    return { mode: 'builtin', command: vendoredRipgrepPath, args: [] }
  }

  if (systemRipgrepPath !== 'rg') {
    return { mode: 'system', command: 'rg', args: [] }
  }

  return { mode: 'builtin', command: vendoredRipgrepPath, args: [] }
}

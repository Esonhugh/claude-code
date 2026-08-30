import { env } from '../env.js'
import { envDynamic } from '../envDynamic.js'

export function getPlatform(): string {
  const arch =
    process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : null

  if (!arch) {
    throw new Error(`Unsupported architecture: ${process.arch}`)
  }

  if (env.platform === 'linux' && envDynamic.isMuslEnvironment()) {
    return `linux-${arch}-musl`
  }

  return `${env.platform}-${arch}`
}

export function getBinaryName(platform: string): string {
  return platform.startsWith('win32') ? 'claude.exe' : 'claude'
}

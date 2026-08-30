/**
 * Download functionality for the native installer.
 *
 * Public native builds are distributed as GitHub Release assets. Each binary is
 * verified against the SHA256SUMS.txt asset from the same tagged release before
 * it is installed.
 */

import { feature } from 'bun:bundle'
import axios from 'axios'
import { createHash } from 'crypto'
import { chmod, writeFile } from 'fs/promises'
import { join } from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import type { ReleaseChannel } from '../config.js'
import { logForDebugging } from '../debug.js'
import { toError } from '../errors.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import { sleep } from '../sleep.js'
import { getBinaryName, getPlatform } from './platform.js'

const GITHUB_RELEASES_API_URL =
  'https://api.github.com/repos/Esonhugh/claude-code/releases/latest'
const GITHUB_RELEASES_DOWNLOAD_URL =
  'https://github.com/Esonhugh/claude-code/releases/download'

function releaseAssetName(version: string, platform: string): string {
  const extension = platform.startsWith('win32') ? '.exe' : ''
  return `claude-code-v${version}-${platform}${extension}`
}

function releaseAssetUrl(version: string, assetName: string): string {
  return `${GITHUB_RELEASES_DOWNLOAD_URL}/v${version}/${assetName}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function parseReleaseChecksum(
  checksums: string,
  assetName: string,
): string | null {
  const match = checksums.match(
    new RegExp(`^([0-9a-f]{64})\\s+\\*?${escapeRegExp(assetName)}\\s*$`, 'im'),
  )
  return match?.[1]?.toLowerCase() ?? null
}

export async function getLatestVersionFromGitHubRelease(
  _channel: ReleaseChannel = 'latest',
): Promise<string> {
  const startTime = Date.now()
  try {
    // GitHub's latest Release endpoint excludes draft and prerelease releases.
    // Both public channels currently resolve to that supported release stream.
    const response = await axios.get(GITHUB_RELEASES_API_URL, {
      timeout: 30000,
      responseType: 'json',
      headers: { Accept: 'application/vnd.github+json' },
    })
    const tagName = (response.data as { tag_name?: unknown }).tag_name
    const match =
      typeof tagName === 'string' &&
      /^v?(\d+\.\d+\.\d+(?:-\S+)?)$/.exec(tagName)
    if (!match) {
      throw new Error('GitHub latest release has an invalid tag name')
    }

    logEvent('tengu_version_check_success', {
      latency_ms: Date.now() - startTime,
    })
    return match[1]!
  } catch (error) {
    const latencyMs = Date.now() - startTime
    logEvent('tengu_version_check_failure', { latency_ms: latencyMs })
    const fetchError = new Error(
      `Failed to fetch the latest Claude release from GitHub: ${toError(error).message}`,
      { cause: error },
    )
    logError(fetchError)
    throw fetchError
  }
}

export async function getReleaseVersion(
  channel: ReleaseChannel,
): Promise<string | null> {
  try {
    return await getLatestVersionFromGitHubRelease(channel)
  } catch {
    return null
  }
}

export async function getReleaseDistTags(): Promise<{
  latest: string | null
  stable: string | null
}> {
  const latest = await getReleaseVersion('latest')
  return { latest, stable: latest }
}

export async function getLatestVersion(
  channelOrVersion: string,
): Promise<string> {
  // Direct version - match internal format too (e.g. 1.0.30-dev.shaf4937ce)
  if (/^v?\d+\.\d+\.\d+(-\S+)?$/.test(channelOrVersion)) {
    const normalized = channelOrVersion.startsWith('v')
      ? channelOrVersion.slice(1)
      : channelOrVersion
    // 99.99.x is reserved for CI smoke-test fixtures on a private bucket.
    // feature() is false in all shipped builds — DCE collapses this to an
    // unconditional throw. Only the source-level smoke test bypasses it.
    if (/^99\.99\./.test(normalized) && !feature('ALLOW_TEST_VERSIONS')) {
      throw new Error(
        `Version ${normalized} is not available for installation. Use 'stable' or 'latest'.`,
      )
    }
    return normalized
  }

  const channel = channelOrVersion as ReleaseChannel
  if (channel !== 'stable' && channel !== 'latest') {
    throw new Error(
      `Invalid channel: ${channelOrVersion}. Use 'stable' or 'latest'`,
    )
  }

  return getLatestVersionFromGitHubRelease(channel)
}

export async function getReleaseChecksum(
  version: string,
  assetName: string,
): Promise<string> {
  try {
    const response = await axios.get(
      releaseAssetUrl(version, 'SHA256SUMS.txt'),
      {
        timeout: 30000,
        responseType: 'text',
      },
    )
    const checksum = parseReleaseChecksum(response.data, assetName)
    if (!checksum) {
      throw new Error(
        `Claude ${version} release does not provide a checksum for ${assetName}`,
      )
    }
    return checksum
  } catch (error) {
    const fetchError = new Error(
      `Failed to fetch Claude ${version} release checksums: ${toError(error).message}`,
      { cause: error },
    )
    logError(fetchError)
    throw fetchError
  }
}

// Stall timeout: abort if no bytes received for this duration
const DEFAULT_STALL_TIMEOUT_MS = 60000 // 60 seconds
const MAX_DOWNLOAD_RETRIES = 3

function getStallTimeoutMs(): number {
  return (
    Number(process.env.CLAUDE_CODE_STALL_TIMEOUT_MS_FOR_TESTING) ||
    DEFAULT_STALL_TIMEOUT_MS
  )
}

class StallTimeoutError extends Error {
  constructor() {
    super('Download stalled: no data received for 60 seconds')
    this.name = 'StallTimeoutError'
  }
}

/**
 * Common logic for downloading and verifying a binary.
 * Includes stall detection (aborts if no bytes for 60s) and retry logic.
 */
async function downloadAndVerifyBinary(
  binaryUrl: string,
  expectedChecksum: string,
  binaryPath: string,
  requestConfig: Record<string, unknown> = {},
) {
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
    const controller = new AbortController()
    let stallTimer: ReturnType<typeof setTimeout> | undefined

    const clearStallTimer = () => {
      if (stallTimer) {
        clearTimeout(stallTimer)
        stallTimer = undefined
      }
    }

    const resetStallTimer = () => {
      clearStallTimer()
      stallTimer = setTimeout(c => c.abort(), getStallTimeoutMs(), controller)
    }

    try {
      resetStallTimer()

      const response = await axios.get(binaryUrl, {
        timeout: 5 * 60000,
        responseType: 'arraybuffer',
        signal: controller.signal,
        onDownloadProgress: () => {
          resetStallTimer()
        },
        ...requestConfig,
      })

      clearStallTimer()

      const hash = createHash('sha256')
      hash.update(response.data)
      const actualChecksum = hash.digest('hex')

      if (actualChecksum !== expectedChecksum) {
        throw new Error(
          `Checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`,
        )
      }

      await writeFile(binaryPath, Buffer.from(response.data))
      await chmod(binaryPath, 0o755)
      return
    } catch (error) {
      clearStallTimer()

      const isStallTimeout = axios.isCancel(error)
      lastError = isStallTimeout ? new StallTimeoutError() : toError(error)

      if (isStallTimeout && attempt < MAX_DOWNLOAD_RETRIES) {
        logForDebugging(
          `Download stalled on attempt ${attempt}/${MAX_DOWNLOAD_RETRIES}, retrying...`,
        )
        await sleep(1000)
        continue
      }

      throw lastError
    }
  }

  throw lastError ?? new Error('Download failed after all retries')
}

export async function downloadVersionFromGitHubRelease(
  version: string,
  stagingPath: string,
) {
  const fs = getFsImplementation()
  await fs.rm(stagingPath, { recursive: true, force: true })

  const platform = getPlatform()
  const assetName = releaseAssetName(version, platform)
  const expectedChecksum = await getReleaseChecksum(version, assetName)
  const binaryUrl = releaseAssetUrl(version, assetName)
  const binaryName = getBinaryName(platform)

  await fs.mkdir(stagingPath)
  const binaryPath = join(stagingPath, binaryName)
  const startTime = Date.now()
  logEvent('tengu_binary_download_attempt', {})

  try {
    await downloadAndVerifyBinary(binaryUrl, expectedChecksum, binaryPath)
    logEvent('tengu_binary_download_success', {
      latency_ms: Date.now() - startTime,
    })
  } catch (error) {
    const errorMessage = toError(error).message
    logEvent('tengu_binary_download_failure', {
      latency_ms: Date.now() - startTime,
      is_timeout: errorMessage.includes('timeout'),
      is_checksum_mismatch: errorMessage.includes('Checksum mismatch'),
    })
    logError(
      new Error(`Failed to download Claude from ${binaryUrl}: ${errorMessage}`),
    )
    throw error
  }
}

// This is retained exclusively for source-level CI smoke-test fixtures. It is
// dead-code eliminated from shipped builds because ALLOW_TEST_VERSIONS is false.
async function downloadVersionFromTestBucket(
  version: string,
  stagingPath: string,
) {
  const { stdout } = await execFileNoThrowWithCwd('gcloud', [
    'auth',
    'print-access-token',
  ])
  const baseUrl = 'https://storage.googleapis.com/claude-code-ci-sentinel'
  const fs = getFsImplementation()
  await fs.rm(stagingPath, { recursive: true, force: true })

  const platform = getPlatform()
  const manifestResponse = await axios.get(
    `${baseUrl}/${version}/manifest.json`,
    {
      timeout: 10000,
      responseType: 'json',
      headers: { Authorization: `Bearer ${stdout.trim()}` },
    },
  )
  const platformInfo = manifestResponse.data.platforms[platform]
  if (!platformInfo) {
    throw new Error(
      `Platform ${platform} not found in manifest for version ${version}`,
    )
  }

  await fs.mkdir(stagingPath)
  const binaryName = getBinaryName(platform)
  await downloadAndVerifyBinary(
    `${baseUrl}/${version}/${platform}/${binaryName}`,
    platformInfo.checksum,
    join(stagingPath, binaryName),
    { headers: { Authorization: `Bearer ${stdout.trim()}` } },
  )
}

export async function downloadVersion(
  version: string,
  stagingPath: string,
): Promise<'binary'> {
  if (feature('ALLOW_TEST_VERSIONS') && /^99\.99\./.test(version)) {
    await downloadVersionFromTestBucket(version, stagingPath)
    return 'binary'
  }

  await downloadVersionFromGitHubRelease(version, stagingPath)
  return 'binary'
}

export { StallTimeoutError, MAX_DOWNLOAD_RETRIES }
export const STALL_TIMEOUT_MS = DEFAULT_STALL_TIMEOUT_MS
export const _downloadAndVerifyBinaryForTesting = downloadAndVerifyBinary

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import axios from 'axios'
;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: '2.1.666',
  PACKAGE_URL: '@esonhugh/claude-code',
  NATIVE_PACKAGE_URL: null,
}

const originalAxiosGet = axios.get
const stagingPath = await mkdtemp(join(tmpdir(), 'claude-native-download-'))

try {
  const {
    downloadVersionFromGitHubRelease,
    getLatestVersion,
    parseReleaseChecksum,
  } = await import('./download.js')

  const checksum = 'a'.repeat(64)
  assert.equal(
    parseReleaseChecksum(
      `${checksum}  claude-code-v2.1.667-darwin-arm64\n`,
      'claude-code-v2.1.667-darwin-arm64',
    ),
    checksum,
  )
  assert.equal(
    parseReleaseChecksum(
      `${checksum}  claude-code-v2.1.667-darwin-arm64.backup\n`,
      'claude-code-v2.1.667-darwin-arm64',
    ),
    null,
  )

  const requests: string[] = []
  axios.get = (async (url: string) => {
    requests.push(url)
    return { data: { tag_name: 'v2.1.667' } }
  }) as typeof axios.get

  assert.equal(await getLatestVersion('latest'), '2.1.667')
  assert.equal(
    requests[0],
    'https://api.github.com/repos/Esonhugh/claude-code/releases/latest',
  )

  const binary = Buffer.from('release-binary')
  const binaryChecksum = createHash('sha256').update(binary).digest('hex')
  const platform = `${process.platform}-${process.arch}`
  const assetName = `claude-code-v2.1.667-${platform}${
    process.platform === 'win32' ? '.exe' : ''
  }`
  requests.length = 0
  axios.get = (async (url: string) => {
    requests.push(url)
    if (url.endsWith('/SHA256SUMS.txt')) {
      return { data: `${binaryChecksum}  ${assetName}\n` }
    }
    return { data: binary }
  }) as typeof axios.get

  await downloadVersionFromGitHubRelease('2.1.667', stagingPath)

  assert.deepEqual(requests, [
    'https://github.com/Esonhugh/claude-code/releases/download/v2.1.667/SHA256SUMS.txt',
    `https://github.com/Esonhugh/claude-code/releases/download/v2.1.667/${assetName}`,
  ])
  assert.deepEqual(
    await readFile(
      join(stagingPath, process.platform === 'win32' ? 'claude.exe' : 'claude'),
    ),
    binary,
  )
} finally {
  axios.get = originalAxiosGet
  await rm(stagingPath, { recursive: true, force: true })
}

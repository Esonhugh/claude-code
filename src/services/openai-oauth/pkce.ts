import { createHash, randomBytes } from 'node:crypto'

function base64Url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export function createOpenAIPKCE(): {
  codeVerifier: string
  codeChallenge: string
  state: string
} {
  const codeVerifier = base64Url(randomBytes(64))
  const codeChallenge = base64Url(
    createHash('sha256').update(codeVerifier).digest(),
  )
  const state = base64Url(randomBytes(32))
  return { codeVerifier, codeChallenge, state }
}

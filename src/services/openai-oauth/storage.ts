import { chmod, mkdir, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import {
  decodeOpenAIIdTokenClaims,
  getChatGPTOAuthInfo,
  getOpenAIApiKey,
  getOpenAIAuthInfo,
} from '../../utils/auth.js'
import type { OpenAIAuthDotJson } from './types.js'

export function getOpenAIAuthPath(homeDir: string = process.env.HOME ?? homedir()): string {
  return join(homeDir, '.codex', 'auth.json')
}

async function writeOpenAIAuthFile(
  auth: unknown,
  opts: { homeDir?: string } = {},
): Promise<string> {
  const home = opts.homeDir ?? process.env.HOME ?? homedir()
  const authPath = getOpenAIAuthPath(home)
  await mkdir(join(home, '.codex'), { recursive: true })
  await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  })
  await chmod(authPath, 0o600)
  getOpenAIAuthInfo.cache.clear?.()
  getChatGPTOAuthInfo.cache.clear?.()
  getOpenAIApiKey.cache.clear?.()
  return authPath
}

export async function saveOpenAIAuth(
  auth: OpenAIAuthDotJson,
  opts: { homeDir?: string } = {},
): Promise<string> {
  const accountId =
    auth.tokens.account_id ??
    decodeOpenAIIdTokenClaims(auth.tokens.id_token)?.chatgptAccountId
  return writeOpenAIAuthFile(
    accountId
      ? { ...auth, tokens: { ...auth.tokens, account_id: accountId } }
      : auth,
    opts,
  )
}

export async function saveOpenAIApiKey(
  apiKey: string,
  opts: { homeDir?: string } = {},
): Promise<string> {
  return writeOpenAIAuthFile({ OPENAI_API_KEY: apiKey }, opts)
}

import { chmod, mkdir, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { getOpenAIAuthInfo } from '../../utils/auth.js'
import type { OpenAIAuthDotJson } from './types.js'

export function getOpenAIAuthPath(homeDir: string = homedir()): string {
  return join(homeDir, '.codex', 'auth.json')
}

export async function saveOpenAIAuth(
  auth: OpenAIAuthDotJson,
  opts: { homeDir?: string } = {},
): Promise<string> {
  const home = opts.homeDir ?? homedir()
  const authPath = getOpenAIAuthPath(home)
  await mkdir(join(home, '.codex'), { recursive: true })
  await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  })
  await chmod(authPath, 0o600)
  getOpenAIAuthInfo.cache.clear?.()
  return authPath
}

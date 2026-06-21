import axios from 'axios'
import { readFile } from 'fs/promises'
import { getOpenAIProxyConfig } from './client.js'
import { getOpenAIAuthPath, saveOpenAIAuth } from './storage.js'
import type { OpenAIAuthDotJson, OpenAITokenExchangeResponse } from './types.js'

const OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const ACCESS_TOKEN_REFRESH_WINDOW_SECONDS = 5 * 60
const LAST_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60 * 1000

type RefreshOptions = {
  homeDir?: string
  force?: boolean
}

type OpenAIAuthFile = Partial<OpenAIAuthDotJson> & {
  OPENAI_API_KEY?: string
}

function parseJwtExpirationSeconds(jwt: string): number | null {
  const parts = jwt.split('.')
  if (parts.length !== 3 || !parts[1]) return null

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'))
    return typeof payload.exp === 'number' ? payload.exp : null
  } catch {
    return null
  }
}

function shouldRefreshOpenAIAuth(auth: OpenAIAuthDotJson, force: boolean): boolean {
  if (force) return true

  const expiresAt = parseJwtExpirationSeconds(auth.tokens.access_token)
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (
    expiresAt !== null &&
    expiresAt <= nowSeconds + ACCESS_TOKEN_REFRESH_WINDOW_SECONDS
  ) {
    return true
  }

  const lastRefresh = Date.parse(auth.last_refresh)
  return Number.isFinite(lastRefresh) &&
    lastRefresh <= Date.now() - LAST_REFRESH_INTERVAL_MS
}

async function readOpenAIAuth(homeDir?: string): Promise<OpenAIAuthFile | null> {
  try {
    return JSON.parse(await readFile(getOpenAIAuthPath(homeDir), 'utf-8'))
  } catch {
    return null
  }
}

export async function checkAndRefreshOpenAITokenIfNeeded({
  homeDir,
  force = false,
}: RefreshOptions = {}): Promise<boolean> {
  const auth = await readOpenAIAuth(homeDir)
  if (
    !auth ||
    auth.OPENAI_API_KEY ||
    auth.auth_mode !== 'chatgpt' ||
    !auth.tokens?.access_token ||
    !auth.tokens.refresh_token ||
    !auth.last_refresh
  ) {
    return false
  }

  const chatgptAuth = auth as OpenAIAuthDotJson
  if (!shouldRefreshOpenAIAuth(chatgptAuth, force)) return false

  const response = await axios.post(
    OPENAI_OAUTH_TOKEN_URL,
    {
      client_id: OPENAI_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: chatgptAuth.tokens.refresh_token,
    },
    {
      headers: { 'Content-Type': 'application/json' },
      proxy: getOpenAIProxyConfig(),
      timeout: 15000,
    },
  )

  if (response.status !== 200 || !response.data?.access_token) {
    throw new Error(`OpenAI OAuth token refresh failed (${response.status})`)
  }

  const tokens = response.data as OpenAITokenExchangeResponse
  await saveOpenAIAuth(
    {
      auth_mode: 'chatgpt',
      tokens: {
        ...chatgptAuth.tokens,
        ...tokens,
        refresh_token: tokens.refresh_token ?? chatgptAuth.tokens.refresh_token,
      },
      last_refresh: new Date().toISOString(),
    },
    { homeDir },
  )
  return true
}

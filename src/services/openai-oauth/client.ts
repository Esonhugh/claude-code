import axios, { type AxiosProxyConfig } from 'axios'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createOpenAIPKCE } from './pkce.js'
import { OpenAIAuthCodeListener } from './auth-code-listener.js'
import { saveOpenAIAuth } from './storage.js'
import type { OpenAITokenExchangeResponse } from './types.js'

const execFileAsync = promisify(execFile)
const OPENAI_OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OPENAI_OAUTH_SCOPE =
  'openid profile email offline_access api.connectors.read api.connectors.invoke'
const OPENAI_OAUTH_CALLBACK_PATH = '/auth/callback'
const OPENAI_OAUTH_ORIGINATOR = 'codex_cli_rs'

export { createOpenAIPKCE }

function getOpenAIProxyConfig(): AxiosProxyConfig | undefined {
  const proxyUrl = process.env.https_proxy
    ?? process.env.HTTPS_PROXY
    ?? process.env.http_proxy
    ?? process.env.HTTP_PROXY
  if (!proxyUrl) return undefined

  const parsed = new URL(proxyUrl)
  return {
    protocol: parsed.protocol.replace(/:$/, ''),
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : undefined,
  }
}

export function buildOpenAIAuthUrl({
  codeChallenge,
  state,
  port,
}: {
  codeChallenge: string
  state: string
  port: number
}): string {
  const url = new URL(OPENAI_OAUTH_AUTHORIZE_URL)
  url.searchParams.set('client_id', OPENAI_OAUTH_CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set(
    'redirect_uri',
    `http://localhost:${port}${OPENAI_OAUTH_CALLBACK_PATH}`,
  )
  url.searchParams.set('scope', OPENAI_OAUTH_SCOPE)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', OPENAI_OAUTH_ORIGINATOR)
  url.searchParams.set('state', state)
  return url.toString()
}

export async function exchangeOpenAICodeForTokens({
  authorizationCode,
  codeVerifier,
  port,
}: {
  authorizationCode: string
  codeVerifier: string
  port: number
}): Promise<OpenAITokenExchangeResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: `http://localhost:${port}${OPENAI_OAUTH_CALLBACK_PATH}`,
    client_id: OPENAI_OAUTH_CLIENT_ID,
    code_verifier: codeVerifier,
  })
  const response = await axios.post(OPENAI_OAUTH_TOKEN_URL, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    proxy: getOpenAIProxyConfig(),
    timeout: 15000,
  }).catch(error => {
    const response = error?.response
    if (response?.status) {
      throw new Error(
        `token endpoint returned status ${response.status}: ${JSON.stringify(response.data)}`,
      )
    }
    throw error
  })

  if (response.status !== 200 || !response.data?.access_token) {
    throw new Error(`OpenAI OAuth token exchange failed (${response.status})`)
  }

  return response.data as OpenAITokenExchangeResponse
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  await execFileAsync(command, args)
}

export async function loginOpenAIWithOAuth({
  openBrowser: openBrowserOverride,
  homeDir,
  onAuthUrl,
}: {
  openBrowser?: (url: string) => Promise<void>
  homeDir?: string
  onAuthUrl?: (url: string) => void
} = {}): Promise<string> {
  const pkce = createOpenAIPKCE()
  const listener = new OpenAIAuthCodeListener(OPENAI_OAUTH_CALLBACK_PATH)
  const port = await listener.start()
  const authUrl = buildOpenAIAuthUrl({
    codeChallenge: pkce.codeChallenge,
    state: pkce.state,
    port,
  })
  onAuthUrl?.(authUrl)

  try {
    const authorizationCode = await listener.waitForAuthorization(
      pkce.state,
      async () => {
        await (openBrowserOverride ?? openBrowser)(authUrl)
      },
    )
    const tokens = await exchangeOpenAICodeForTokens({
      authorizationCode,
      codeVerifier: pkce.codeVerifier,
      port,
    })
    return await saveOpenAIAuth(
      {
        auth_mode: 'chatgpt',
        tokens,
        last_refresh: new Date().toISOString(),
      },
      { homeDir },
    )
  } finally {
    listener.close()
  }
}

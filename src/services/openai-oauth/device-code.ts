import axios from 'axios'
import {
  exchangeOpenAICodeForTokens,
  getOpenAIProxyConfig,
  OPENAI_OAUTH_CLIENT_ID,
  OPENAI_OAUTH_ISSUER,
} from './client.js'
import { saveOpenAIAuth } from './storage.js'

const OPENAI_DEVICE_USERCODE_URL = `${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`
const OPENAI_DEVICE_TOKEN_URL = `${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/token`
const OPENAI_DEVICE_VERIFICATION_URL = `${OPENAI_OAUTH_ISSUER}/codex/device`
const OPENAI_DEVICE_REDIRECT_URI = `${OPENAI_OAUTH_ISSUER}/deviceauth/callback`
const DEFAULT_MAX_WAIT_MS = 15 * 60 * 1000

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

export type OpenAIDeviceCode = {
  verificationUrl: string
  userCode: string
  deviceAuthId: string
  interval: number
}

export type OpenAIDeviceCodePollResult = {
  authorizationCode: string
  codeChallenge: string
  codeVerifier: string
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('device code login cancelled')
  }
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        reject(new Error('device code login cancelled'))
      },
      { once: true },
    )
  })
}

function parseInterval(value: unknown): number {
  const parsed = Number(value ?? 5)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5
}

export async function requestOpenAIDeviceCode({
  signal,
}: {
  signal?: AbortSignal
} = {}): Promise<OpenAIDeviceCode> {
  throwIfAborted(signal)
  const response = await axios.post(
    OPENAI_DEVICE_USERCODE_URL,
    JSON.stringify({ client_id: OPENAI_OAUTH_CLIENT_ID }),
    {
      headers: { 'Content-Type': 'application/json' },
      proxy: getOpenAIProxyConfig(),
      signal,
      timeout: 15000,
      validateStatus: () => true,
    },
  )

  if (response.status === 404) {
    throw new Error('device code login is not enabled for OpenAI')
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`device code request failed with status ${response.status}`)
  }

  return {
    verificationUrl: OPENAI_DEVICE_VERIFICATION_URL,
    userCode: response.data.user_code,
    deviceAuthId: response.data.device_auth_id,
    interval: parseInterval(response.data.interval),
  }
}

export async function pollOpenAIDeviceCode({
  deviceAuthId,
  userCode,
  interval,
  signal,
  sleep = defaultSleep,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
}: {
  deviceAuthId: string
  userCode: string
  interval: number
  signal?: AbortSignal
  sleep?: Sleep
  maxWaitMs?: number
}): Promise<OpenAIDeviceCodePollResult> {
  const startedAt = Date.now()

  while (true) {
    throwIfAborted(signal)
    if (Date.now() - startedAt >= maxWaitMs) {
      throw new Error('device auth timed out after 15 minutes')
    }

    const response = await axios.post(
      OPENAI_DEVICE_TOKEN_URL,
      JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: userCode,
      }),
      {
        headers: { 'Content-Type': 'application/json' },
        proxy: getOpenAIProxyConfig(),
        signal,
        timeout: 15000,
        validateStatus: () => true,
      },
    )

    if (response.status === 200) {
      return {
        authorizationCode: response.data.authorization_code,
        codeChallenge: response.data.code_challenge,
        codeVerifier: response.data.code_verifier,
      }
    }

    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`device auth failed with status ${response.status}`)
    }

    const elapsed = Date.now() - startedAt
    const remaining = Math.max(maxWaitMs - elapsed, 0)
    await sleep(Math.min(interval * 1000, remaining), signal)
  }
}

export async function loginOpenAIWithDeviceCode({
  homeDir,
  onDeviceCode,
  signal,
  sleep,
  maxWaitMs,
}: {
  homeDir?: string
  onDeviceCode?: (deviceCode: OpenAIDeviceCode) => void
  signal?: AbortSignal
  sleep?: Sleep
  maxWaitMs?: number
} = {}): Promise<string> {
  const deviceCode = await requestOpenAIDeviceCode({ signal })
  onDeviceCode?.(deviceCode)
  const result = await pollOpenAIDeviceCode({
    deviceAuthId: deviceCode.deviceAuthId,
    userCode: deviceCode.userCode,
    interval: deviceCode.interval,
    signal,
    sleep,
    maxWaitMs,
  })
  const tokens = await exchangeOpenAICodeForTokens({
    authorizationCode: result.authorizationCode,
    codeVerifier: result.codeVerifier,
    port: 0,
    redirectUri: OPENAI_DEVICE_REDIRECT_URI,
  })
  throwIfAborted(signal)
  return await saveOpenAIAuth(
    {
      auth_mode: 'chatgpt',
      tokens,
      last_refresh: new Date().toISOString(),
    },
    { homeDir },
  )
}

export type ParsedConnectUrl = {
  url: string
  serverUrl: string
  authToken?: string
  host?: string
  token?: string
}

export function parseConnectUrl(url: string): ParsedConnectUrl {
  const parsed = new URL(url)
  const authToken = parsed.searchParams.get('token') ?? undefined
  const host = parsed.host || undefined
  const serverUrl = parsed.searchParams.get('serverUrl') ?? url

  return {
    url,
    serverUrl,
    authToken,
    host,
    token: authToken,
  }
}

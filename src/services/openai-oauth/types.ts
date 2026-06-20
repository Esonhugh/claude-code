export type OpenAITokenData = {
  id_token?: string
  access_token: string
  refresh_token?: string
  account_id?: string
}

export type OpenAIAuthDotJson = {
  auth_mode: 'chatgpt'
  tokens: OpenAITokenData
  last_refresh: string
}

export type OpenAITokenExchangeResponse = {
  id_token?: string
  access_token: string
  refresh_token?: string
  account_id?: string
}

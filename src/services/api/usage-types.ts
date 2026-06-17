export type RateLimit = {
  utilization: number | null // a percentage from 0 to 100
  resets_at: string | null // ISO 8601 timestamp
  window_minutes?: number | null
}

export type ExtraUsage = {
  is_enabled: boolean
  monthly_limit: number | null
  used_credits: number | null
  utilization: number | null
}

export type UsageLimit = {
  title: string
  limit: RateLimit
  extraSubtext?: string
}

export type ChatGPTUsageCredits = {
  has_credits?: boolean
  unlimited?: boolean
  balance?: number | null
  overage_limit_reached?: boolean
}

export type ChatGPTMonthlyCreditLimit = {
  limit: string
  used: string
  remaining: string | null
  utilization: number | null
  resets_at: string | null
}

export type Utilization = {
  five_hour?: RateLimit | null
  seven_day?: RateLimit | null
  seven_day_oauth_apps?: RateLimit | null
  seven_day_opus?: RateLimit | null
  seven_day_sonnet?: RateLimit | null
  extra_usage?: ExtraUsage | null
  source?: 'claude' | 'chatgpt'
  plan_type?: string | null
  credits?: ChatGPTUsageCredits | null
  chatgpt_limits?: UsageLimit[]
  monthly_credit_limit?: ChatGPTMonthlyCreditLimit | null
}

// Subscription tier returned after OAuth profile lookup.
export type SubscriptionType = 'max' | 'pro' | 'enterprise' | 'team'

export type RateLimitTier = string | null

export type BillingType = string | null

// Raw token exchange response from the OAuth server.
export interface OAuthTokenExchangeResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  scope?: string
  token_type?: string
  account?: {
    uuid: string
    email_address: string
  }
  organization?: {
    uuid: string
  }
}

// Profile response from the OAuth profile endpoint.
export interface OAuthProfileResponse {
  account?: {
    uuid: string
    email?: string
    display_name?: string
    created_at?: string
  }
  organization?: {
    uuid: string
    organization_type?: string
    rate_limit_tier?: string | null
    billing_type?: string | null
    has_extra_usage_enabled?: boolean
    subscription_created_at?: string
  }
  [key: string]: unknown
}

// Persisted OAuth tokens with derived metadata.
export interface OAuthTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
  subscriptionType: SubscriptionType | null
  rateLimitTier: RateLimitTier
  profile?: OAuthProfileResponse
  tokenAccount?: {
    uuid: string
    emailAddress: string
    organizationUuid?: string
  }
}

// User roles response from the roles endpoint.
export interface UserRolesResponse {
  [key: string]: unknown
}

// Referral campaign identifier.
export type ReferralCampaign = string

// Referrer reward info for referral v1 campaigns.
export interface ReferrerRewardInfo {
  amount_minor_units: number
  currency: string
  [key: string]: unknown
}

// Referral eligibility response.
export interface ReferralEligibilityResponse {
  referrer_reward?: ReferrerRewardInfo | null
  remaining_passes?: number | null
  [key: string]: unknown
}

// Referral redemptions response.
export interface ReferralRedemptionsResponse {
  [key: string]: unknown
}

import type { MarketplaceSource } from './schemas.js'

export const ESONHUGH_MARKETPLACE_SOURCE = {
  source: 'github',
  repo: 'Esonhugh/Marketplace',
} as const satisfies MarketplaceSource

export const ESONHUGH_MARKETPLACE_NAME = 'Esonhugh-Marketplace'

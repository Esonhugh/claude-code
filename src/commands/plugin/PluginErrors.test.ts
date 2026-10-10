import { expect, test } from 'bun:test'
import { getPluginErrorMessage, type PluginError } from '../../types/plugin.js'
import { formatErrorMessage, getErrorGuidance } from './PluginErrors.js'

const refusal = {
  type: 'marketplace-not-found', source: 'guard@corp', marketplace: 'corp',
  availableMarketplaces: [], registrationHidden: 'declaration',
  registrationHiddenReason: "its source doesn't match its extraKnownMarketplaces entry in user or managed settings",
} as const

test('refused registered marketplaces retain the official cause and repair action in logs', () => {
  expect(getPluginErrorMessage({ ...refusal, availableMarketplaces: [] })).toBe(
    "Marketplace corp is added but ignored. Its source doesn't match its extraKnownMarketplaces entry in user or managed settings. Re-add the marketplace from the source that entry lists, or change the entry.",
  )
})

test('plugin settings distinguish ignored registrations from missing marketplaces', () => {
  const error = { ...refusal, availableMarketplaces: [] }
  expect(formatErrorMessage(error)).toBe(
    "Marketplace \"corp\" is added but ignored. Its source doesn't match its extraKnownMarketplaces entry in user or managed settings",
  )
  expect(getErrorGuidance(error)).toBe('Re-add the marketplace from the source that entry lists, or change the entry')
})

test('refusal without a known cause directs users to the log and re-registration', () => {
  const error = { ...refusal, availableMarketplaces: [], registrationHiddenReason: undefined }
  expect(getPluginErrorMessage(error)).toBe('Marketplace corp is added but ignored (see the debug log)')
  expect(formatErrorMessage(error)).toBe('Marketplace "corp" is added but ignored (see the debug log)')
  expect(getErrorGuidance(error)).toBe('Remove and re-add the marketplace')
})

test('ordinary missing marketplaces keep their existing message and available alternatives', () => {
  const error: PluginError = {type:'marketplace-not-found',source:'guard@corp',marketplace:'corp',availableMarketplaces:['other']}
  expect(getPluginErrorMessage(error)).toBe('Marketplace corp not found')
  expect(formatErrorMessage(error)).toBe('Marketplace "corp" not found')
  expect(getErrorGuidance(error)).toBe('Available marketplaces: other')
})

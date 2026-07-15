import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getToolNameForPermissionCheck } from '../mcp/mcpStringUtils.js'
import { readCodexAppsConnectorInfo } from './toolMetadata.js'
import {
  buildCodexAppsModelToolName,
  buildCodexAppsSearchHint,
  normalizeCodexAppsCallableName,
  normalizeCodexAppsTitle,
  sanitizeCodexAppsName,
} from './toolNormalization.js'

describe('Codex Apps tool normalization', () => {
  it('mirrors Codex connector slug sanitization', () => {
    assert.equal(sanitizeCodexAppsName('Google Drive'), 'google_drive')
    assert.equal(sanitizeCodexAppsName('---'), 'app')
  })

  it('separates the wire name from the connector-qualified model name', () => {
    const connector = { id: 'connector_gmail', name: 'Gmail' }
    assert.equal(
      normalizeCodexAppsCallableName('gmail_capture-file-upload', connector),
      'capture_file_upload',
    )
    assert.deepEqual(
      buildCodexAppsModelToolName('gmail_capture-file-upload', connector),
      {
        name: 'mcp__codex_apps__gmail__capture_file_upload',
        permissionToolName: 'gmail__capture_file_upload',
        callableName: 'capture_file_upload',
      },
    )
  })

  it('normalizes connector-prefixed titles without touching other titles', () => {
    const connector = { name: 'Gmail' }
    assert.equal(normalizeCodexAppsTitle('Gmail_Search', connector), 'Search')
    assert.equal(normalizeCodexAppsTitle('Search mail', connector), 'Search mail')
  })

  it('supports connector metadata aliases from the Apps backend', () => {
    assert.deepEqual(
      readCodexAppsConnectorInfo({
        connector_id: 'connector_drive',
        connector_display_name: 'Google Drive',
        connectorDescription: 'Search and read Drive files',
      }),
      {
        id: 'connector_drive',
        name: 'Google Drive',
        description: 'Search and read Drive files',
      },
    )
  })

  it('uses the model-visible connector name for exact permission rules', () => {
    assert.equal(
      getToolNameForPermissionCheck({
        name: 'mcp__codex_apps__gmail__search',
        mcpInfo: {
          serverName: 'codex_apps',
          toolName: 'gmail_search_v2',
          permissionToolName: 'gmail__search',
        },
      }),
      'mcp__codex_apps__gmail__search',
    )
  })

  it('adds the plugin projection name and connector metadata to search hints', () => {
    assert.equal(
      buildCodexAppsSearchHint(
        {
          id: 'connector_github',
          name: 'GitHub',
          description: 'Search repositories and issues',
        },
        'code   hosting',
      ),
      'CodexApp_GitHub GitHub Search repositories and issues code hosting',
    )
  })
})

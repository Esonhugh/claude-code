import assert from 'node:assert/strict'
import { describe, it } from 'bun:test'
import {
  shouldPrefetchLogoRecentActivity,
  shouldRejectRootBypassPermissions,
} from './setup.js'

describe('Logo recent activity prefetch', () => {
  it('runs only for ordinary interactive sessions', () => {
    assert.equal(
      shouldPrefetchLogoRecentActivity({ bare: false, sshLocalUI: false }),
      true,
    )
    assert.equal(
      shouldPrefetchLogoRecentActivity({ bare: true, sshLocalUI: false }),
      false,
    )
    assert.equal(
      shouldPrefetchLogoRecentActivity({ bare: false, sshLocalUI: true }),
      false,
    )
  })
})

describe('root bypass permission safety', () => {
  it('rejects ordinary root sessions', () => {
    assert.equal(
      shouldRejectRootBypassPermissions({
        platform: 'linux',
        uid: 0,
        environment: {},
      }),
      true,
    )
  })

  it('allows ordinary non-root sessions', () => {
    assert.equal(
      shouldRejectRootBypassPermissions({
        platform: 'linux',
        uid: 1000,
        environment: {},
      }),
      false,
    )
  })

  it('allows a host-managed SSH remote child to inherit bypass mode', () => {
    assert.equal(
      shouldRejectRootBypassPermissions({
        platform: 'linux',
        uid: 0,
        environment: {
          CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
          CLAUDE_CODE_SSH_REMOTE: '1',
          CLAUDE_CODE_SSH_REMOTE_TOKEN: 'test-ssh-token',
        },
      }),
      false,
    )
  })

  it('does not trust incomplete SSH markers', () => {
    for (const environment of [
      { CLAUDE_CODE_SSH_REMOTE: '1' },
      { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1' },
      {
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
        CLAUDE_CODE_SSH_REMOTE: '1',
      },
      {
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
        CLAUDE_CODE_SSH_REMOTE: '1',
        CLAUDE_CODE_SSH_REMOTE_TOKEN: '',
      },
    ]) {
      assert.equal(
        shouldRejectRootBypassPermissions({
          platform: 'linux',
          uid: 0,
          environment,
        }),
        true,
      )
    }
  })
})

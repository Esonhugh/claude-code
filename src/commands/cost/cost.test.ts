import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import * as auth from '../../utils/auth.js'
import { call } from './cost.js'

afterEach(() => mock.restore())

const run = async () => ((await call('', {} as never)) as { value: string }).value

test('/cost shows the totals for an OAuth token without profile or plan info, like official', async () => {
  spyOn(auth, 'isClaudeAISubscriber').mockReturnValue(true)
  spyOn(auth, 'getSubscriptionType').mockReturnValue(null)
  spyOn(auth, 'hasProfileScope').mockReturnValue(false)
  expect(await run()).toContain('Total cost:')
})

test('/cost names the subscription for a signed-in plan, and not for usage-based billing', async () => {
  spyOn(auth, 'isClaudeAISubscriber').mockReturnValue(true)
  spyOn(auth, 'getSubscriptionType').mockReturnValue('max')
  const account = spyOn(auth, 'getOauthAccountInfo').mockReturnValue({ billingType: 'stripe_subscription' } as never)
  expect(await run()).toContain('using your subscription')
  account.mockReturnValue({ billingType: 'usage_based' } as never)
  expect(await run()).toContain('Total cost:')
})

import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Account, Usage } from '../api'
import { translate, type Lang } from '../i18n'
import { PlanLimits, usageByModel } from './Settings'

describe('usageByModel', () => {
  it('merges ids of one model into one row, like /cost', () => {
    const rows = usageByModel({
      opus: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 100, cacheCreationInputTokens: 5, canonicalModel: 'claude-opus-5-5' },
      'claude-opus-5-5': { inputTokens: 20, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, canonicalModel: 'claude-opus-5-5' },
      'deepseek-v4.1-flash': { inputTokens: 3, outputTokens: 4 },
    })
    expect(rows).toEqual([
      ['claude-opus-5-5', { inputTokens: 30, outputTokens: 3, cacheReadInputTokens: 100, cacheCreationInputTokens: 5, costUSD: 0 }],
      ['deepseek-v4.1-flash', { inputTokens: 3, outputTokens: 4, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 }],
    ])
  })
})


describe('PlanLimits', () => {
  // Root Bun tests use the classic JSX transform; the Web build uses the automatic runtime.
  ;(globalThis as { React?: typeof React }).React ??= React
  const render = (usage: Usage, lang: Lang = 'en', account?: Account) => {
    const props = { usage, lang, account, t: (key: Parameters<typeof translate>[1], vars?: Record<string, string>) => translate(lang, key, vars) }
    return renderToStaticMarkup(React.createElement(PlanLimits, props))
  }
  const firstReset = '2026-11-04T19:38:00Z'
  const secondReset = '2026-11-05T21:47:00Z'

  it('keeps unrelated Claude weeks, deduplicates a model week, and retains its valid reset', () => {
    const usage: Usage = { source: 'claude', rate_limits: {
      five_hour: { utilization: 0, resets_at: firstReset },
      extra_usage: { is_enabled: false },
      seven_day_oauth_apps: { utilization: null, resets_at: firstReset },
      seven_day_opus: { utilization: 17, resets_at: firstReset },
      seven_day_sonnet: { utilization: 29, resets_at: firstReset },
      model_scoped: [
        { display_name: 'Current week (Opus)', model_name: 'OPUS', utilization: 87, resets_at: 'bad' },
        { display_name: 'Current week (Sonnet)', model_name: 'sonnet', utilization: 66, resets_at: secondReset },
        { display_name: 'Current week (Fable)', model_name: 'Fable', utilization: 20 },
      ],
    } }
    const html = render(usage)
    expect(html.match(/This week · Opus/g)).toHaveLength(1)
    expect(html.match(/This week · Sonnet/g)).toHaveLength(1)
    expect(html).toContain('This week · Fable')
    expect(html).toContain('Current week (OAuth apps)')
    expect(html).toContain('87%')
    expect(html).toContain('66%')
    expect(html).toContain('0%')
    expect(html.match(/Resets /g)).toHaveLength(4)
    expect(html).not.toContain('17%')
    expect(html).not.toContain('29%')
    expect(html).not.toContain('Invalid Date')
    expect(html).toContain('Extra usage: off')
    // An unrelated scoped row must not hide either legacy row.
    const scoped = usage.rate_limits!.model_scoped!
    usage.rate_limits!.model_scoped = scoped.slice(2)
    expect(render(usage)).toContain('17%')
    expect(render(usage)).toContain('29%')
  })

  it('uses older snapshot values even when the global account is an API key', () => {
    const account: Account = { kind: 'apikey', provider: 'openai', keys: [], oauth: [] }
    const snapshot: Usage = { credits: { balance: '4' }, rate_limits: {
      five_hour: { utilization: 0, resets_at: firstReset }, extra_usage: { is_enabled: true },
    } }
    const html = render(snapshot, 'en', account)
    expect(html).toContain('0%')
    expect(html).toContain('Resets ')
    expect(html).toContain('Extra usage: on')
    expect(html).not.toContain('ChatGPT credit balance')
    expect(html).not.toContain('pay as you go')
    expect(render({ rate_limits: { extra_usage: { is_enabled: false } } }, 'en', account)).toContain('Extra usage: off')
    expect(render({ rate_limits: { five_hour: { utilization: 1 } } }, 'en', account)).not.toContain('Extra usage')
    expect(render({ rate_limits: { five_hour: { utilization: null, resets_at: 'bad' } } }, 'en', account)).toContain('pay as you go')
    const chatgpt = render({ ...snapshot, source: 'chatgpt' }, 'en', account)
    expect(chatgpt).not.toContain('Extra usage')
    expect(chatgpt).toContain('ChatGPT credit balance')
  })

  it('does not display invalid resets from snapshots without a source', () => {
    const account: Account = { kind: 'apikey', provider: 'openai', keys: [], oauth: [] }
    const usage: Usage = { rate_limits: {
      seven_day_oauth_apps: { utilization: null, resets_at: '2026-02-30T15:58:17Z' },
      seven_day_opus: { utilization: 0, resets_at: '7' },
      seven_day_sonnet: { utilization: null, resets_at: '2028-02-29T15:58:17.123456+05:30' },
      model_scoped: [
        { display_name: 'Current week (Opus)', model_name: 'Opus', utilization: 41, resets_at: '2027-02-29T15:58:17Z' },
        { display_name: 'Current week (Opus)', model_name: 'OPUS', utilization: 0, resets_at: firstReset },
        { display_name: 'Current week (Fable)', model_name: 'Fable', utilization: 15, resets_at: '7' },
      ],
    } }
    const html = render(usage, 'en', account)
    expect(html).not.toContain('Current week (OAuth apps)')
    expect(html).not.toContain('41%')
    expect(html).toContain('This week · Opus</b><span class="mono">0%</span>')
    expect(html).toContain('This week · Sonnet</b></div><small>Resets ')
    expect(html).toContain('This week · Fable</b><span class="mono">15%</span>')
    expect(html.match(/Resets /g)).toHaveLength(2)
    expect(html).not.toContain('pay as you go')
    delete usage.rate_limits!.model_scoped
    const legacy = render(usage, 'en', account)
    expect(legacy).toContain('This week · Opus</b><span class="mono">0%</span>')
    expect(legacy.match(/Resets /g)).toHaveLength(1)
  })

  it('shows reported ChatGPT balances and vouchers independently of limits or global account state', () => {
    const usage: Usage = {
      source: 'chatgpt', credits: { balance: '0' }, rate_limit_reset_credits: { available_count: 0 },
      rate_limits: { model_scoped: [{ display_name: 'Codex Review monthly usage', utilization: 7, resets_at: firstReset }] },
    }
    const html = render(usage)
    expect(html).toContain('ChatGPT credit balance</dt><dd>0</dd>')
    expect(html).toContain('Available reset credits</dt><dd>0</dd>')
    expect(html).toContain('Codex Review monthly usage')
    expect(html).not.toContain('Extra usage')
    expect(render({ ...usage, credits: { unlimited: true } }, 'zh-Hant')).toContain('ChatGPT 點數餘額</dt><dd>無限</dd>')
    expect(render({ ...usage, rate_limit_reset_credits: undefined }, 'zh-Hans')).toContain('ChatGPT 积分余额</dt><dd>0</dd>')
    expect(render({ ...usage, credits: { balance: '3.142857' } })).toContain('<dd>3.142857</dd>')
    expect(render({ ...usage, credits: undefined })).not.toContain('ChatGPT credit balance')
    expect(render({ ...usage, source: undefined })).not.toContain('ChatGPT credit balance')
    expect(render({ ...usage, source: 'claude' })).not.toContain('Available reset credits')
  })
})

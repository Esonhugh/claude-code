import { describe, expect, it } from 'bun:test'
import { zh } from './zhText'

describe('zh', () => {
  it('translates the prototype strings by substring, longest first', () => {
    expect(zh('zh-Hans', '停用全部 hooks')).toBe('停用全部 hooks')
    expect(zh('en', '停用全部 hooks')).toBe('Disable all hooks')
    expect(zh('en', '3 个启用 / 12')).toBe('3 enabled / 12')
    expect(zh('en', '最常用模型')).toBe('Favorite model')
    expect(zh('en', '晚上最常用')).toBe('Evenings are busiest')
    expect(zh('en', 'Stats')).toBe('Stats')
  })

  it('maps to traditional characters for zh-Hant', () => {
    expect(zh('zh-Hant', '自动记忆')).toBe('自動記憶')
  })
})

import { describe, expect, mock, test } from 'bun:test'
import * as realOptions from './modelOptions.js'
import * as realOpenAI from './openaiModelOptions.js'

const options = { ...realOptions }
const openai = { ...realOpenAI }

mock.module('./modelOptions.js', () => ({
  ...options,
  getModelOptions: () => [
    { value: null, label: 'Default', description: 'default' },
    { value: 'glm-5.3', label: 'GLM-5.3', description: 'From gateway' },
  ],
}))
mock.module('./openaiModelOptions.js', () => ({
  ...openai,
  getGatewayModelOptions: () => [{ value: 'glm-5.3', label: 'GLM-5.3', description: 'From gateway' }],
}))

const { getModelInfos } = await import('./modelInfos.js')

describe('getModelInfos', () => {
  test('a gateway model offers every effortLevel setting level; Claude models keep their allowlist', () => {
    const [def, glm] = getModelInfos()
    expect(glm).toMatchObject({
      value: 'glm-5.3',
      supportsEffort: true,
      supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    })
    expect(def!.supportedEffortLevels).not.toContain('ultra')
  })
})

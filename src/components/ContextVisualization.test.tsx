import { expect, test } from 'bun:test'
import React from 'react'
import type { ContextData } from '../utils/analyzeContext.js'
import { renderToString } from '../utils/staticRender.js'
import { ContextVisualization } from './ContextVisualization.js'

const data = {
  categories: [],
  totalTokens: 2_000,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  autocompactSource: 'auto',
  percentage: 1,
  gridRows: [],
  model: 'claude-test',
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  skills: {
    totalSkills: 2,
    includedSkills: 2,
    tokens: 1_200,
    skillFrontmatter: [
      { name: 'alpha', source: 'userSettings', tokens: 700 },
      { name: 'beta', source: 'projectSettings', tokens: 500 },
    ],
  },
  isAutoCompactEnabled: true,
  apiUsage: null,
} as unknown as ContextData

test('like official, /context folds skills to one count line until /context all', async () => {
  const folded = await renderToString(<ContextVisualization data={data} collapsed />, 100)
  expect(folded).toContain('└ 2 skills · 1.2k tokens')
  expect(folded).toContain('/context all to expand')
  expect(folded).not.toContain('alpha')

  const expanded = await renderToString(<ContextVisualization data={data} />, 100)
  expect(expanded).toContain('└ alpha: 700 tokens')
  expect(expanded).not.toContain('/context all to expand')
})

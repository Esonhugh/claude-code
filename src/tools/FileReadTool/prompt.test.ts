import { expect, test } from 'bun:test'
import { renderPromptTemplate } from './prompt.js'

test('Read prompt asks for the needed range instead of the whole file', () => {
  const prompt = renderPromptTemplate('- Results are returned using cat -n format', '')

  expect(prompt).toContain('- When you already know which part of the file you need, only read that part.')
  expect(prompt).not.toContain('read the whole file')
})

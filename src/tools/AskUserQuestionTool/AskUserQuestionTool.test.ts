import { afterEach, expect, test } from 'bun:test'
import {
  getIsNonInteractiveSession,
  setIsInteractive,
  setPermissionPromptToolName,
} from '../../bootstrap/state.js'
import { AskUserQuestionTool } from './AskUserQuestionTool.js'

const wasInteractive = !getIsNonInteractiveSession()

afterEach(() => {
  setIsInteractive(wasInteractive)
  setPermissionPromptToolName(undefined)
})

test('headless sessions offer AskUserQuestion only when someone answers prompts', () => {
  setIsInteractive(false)
  expect(AskUserQuestionTool.isEnabled()).toBe(false)
  setPermissionPromptToolName('stdio')
  expect(AskUserQuestionTool.isEnabled()).toBe(true)
})

test('interactive sessions always offer AskUserQuestion', () => {
  setIsInteractive(true)
  expect(AskUserQuestionTool.isEnabled()).toBe(true)
})

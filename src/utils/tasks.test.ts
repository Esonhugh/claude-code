import { afterEach, expect, test } from 'bun:test'
import {
  setMainLoopModelOverride,
  setTodoToolsOptIn,
} from '../bootstrap/state.js'
import { TaskCreateTool } from '../tools/TaskCreateTool/TaskCreateTool.js'
import { TodoWriteTool } from '../tools/TodoWriteTool/TodoWriteTool.js'
import { isTaskToolsEnabled, isTodoToolsEnabled } from './tasks.js'

const ENV_KEYS = [
  'CLAUDE_CODE_ENABLE_TASKS',
  'CLAUDE_CODE_ENABLE_TODO_TOOLS',
  'CLAUDE_JOB_DIR',
] as const

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  setTodoToolsOptIn(false)
  setMainLoopModelOverride(undefined)
})

test('newer models get no todo or task tools by default', () => {
  setMainLoopModelOverride('claude-opus-5-5')
  expect(isTodoToolsEnabled()).toBe(false)
  expect(TaskCreateTool.isEnabled()).toBe(false)
  expect(TodoWriteTool.isEnabled()).toBe(false)
})

test('older models get the task tools, TodoWrite only when tasks are off', () => {
  setMainLoopModelOverride('claude-sonnet-4-6')
  expect(TaskCreateTool.isEnabled()).toBe(true)
  expect(TodoWriteTool.isEnabled()).toBe(false)
  process.env.CLAUDE_CODE_ENABLE_TASKS = 'false'
  expect(TaskCreateTool.isEnabled()).toBe(false)
  expect(TodoWriteTool.isEnabled()).toBe(true)
})

test('opt-ins turn the tools back on for newer models', () => {
  setMainLoopModelOverride('claude-haiku-5-5')
  setTodoToolsOptIn(true)
  expect(isTaskToolsEnabled()).toBe(true)
  setTodoToolsOptIn(false)
  process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '1'
  expect(isTaskToolsEnabled()).toBe(true)
  delete process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS
  process.env.CLAUDE_JOB_DIR = '/tmp/job'
  expect(isTaskToolsEnabled()).toBe(true)
})

test('Bedrock application inference profiles keep the tools', () => {
  setMainLoopModelOverride(
    'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc',
  )
  expect(isTodoToolsEnabled()).toBe(true)
})

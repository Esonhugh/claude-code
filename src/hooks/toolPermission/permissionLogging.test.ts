import { afterEach, expect, mock, test } from 'bun:test'
import type { ToolUseContext, Tool } from '../../Tool.js'
import type { PermissionDecisionReason } from '../../types/permissions.js'

const events: { name: string; attributes: Record<string, string | undefined> }[] = []
mock.module('../../utils/telemetry/events.js', () => ({
  logOTelEvent: async (name: string, attributes: Record<string, string | undefined>) => {
    events.push({ name, attributes })
  },
}))

const { classifierVerdictAttributes, logPermissionDecision } = await import('./permissionLogging.js')
const { getClassifierCategory } = await import('../../utils/permissions/yoloClassifier.js')

afterEach(() => {
  events.length = 0
  delete process.env.OTEL_LOG_TOOL_DETAILS
})

const classifier = (reason: string, extra: object = {}): PermissionDecisionReason =>
  ({ type: 'classifier', classifier: 'auto-mode', reason, ...extra }) as PermissionDecisionReason

function decide(
  args: Parameters<typeof logPermissionDecision>[1],
  mode = 'auto',
) {
  const toolUseContext = {
    getAppState: () => ({ toolPermissionContext: { mode } }),
  } as unknown as ToolUseContext
  logPermissionDecision(
    { tool: { name: 'Bash' } as Tool, input: {}, toolUseContext, messageId: 'msg', toolUseID: 'tu' },
    args,
  )
  return events.find(event => event.name === 'tool_decision')!.attributes
}

test('like official 2.1.301, tool_decision reports the classifier verdict and the permission mode', () => {
  expect(decide({ decision: 'accept', source: 'config', decisionReason: classifier('looks fine') })).toMatchObject({
    decision: 'accept', source: 'config', tool_name: 'Bash', classifier_verdict: 'allow', permission_mode: 'auto',
  })
  events.length = 0
  const blocked = decide({
    decision: 'reject', source: 'config',
    decisionReason: classifier('[Code from External] pipes a remote script into sh', { category: 'code_from_external' }),
  })
  expect(blocked).toMatchObject({ classifier_verdict: 'block', permission_mode: 'auto' })
  expect(blocked.classifier_category).toBeUndefined()
})

test('a rule decision has no classifier verdict', () => {
  const attributes = decide({ decision: 'accept', source: 'config' }, 'default')
  expect(attributes.classifier_verdict).toBeUndefined()
  expect(attributes.permission_mode).toBe('default')
})

test('the block category is only reported with OTEL_LOG_TOOL_DETAILS', () => {
  const reason = classifier('[Code from External] pipes a remote script into sh', { category: 'code_from_external' })
  expect(classifierVerdictAttributes('reject', reason)).toEqual({ classifier_verdict: 'block' })
  process.env.OTEL_LOG_TOOL_DETAILS = '1'
  expect(classifierVerdictAttributes('reject', reason)).toEqual({
    classifier_verdict: 'block', classifier_category: 'code_from_external',
  })
  expect(classifierVerdictAttributes('reject', classifier('Classifier unavailable'))).toEqual({ classifier_verdict: 'unavailable' })
  expect(classifierVerdictAttributes('reject', classifier('too long', { noVerdict: true }))).toEqual({ classifier_verdict: 'no_verdict' })
})

test('only built-in block rules become a category', () => {
  expect(getClassifierCategory('[Code from External] pipes a remote script into sh')).toBe('code_from_external')
  expect(getClassifierCategory('[Logging/Audit Tampering] clears the audit log')).toBe('logging_audit_tampering')
  expect(getClassifierCategory('[Never touch billing] custom rule')).toBeUndefined()
  expect(getClassifierCategory('no rule named')).toBeUndefined()
})

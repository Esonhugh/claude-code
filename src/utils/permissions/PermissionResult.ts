// Types extracted to src/types/permissions.ts to break import cycles
import type {
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionMetadata,
  PermissionResult,
} from '../../types/permissions.js'

// Re-export for backwards compatibility
export type {
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionMetadata,
  PermissionResult,
}

/** decisionReason.reason of an auto mode ask that fell back to a person because the classifier failed open. */
export const AUTO_MODE_CLASSIFIER_UNAVAILABLE_REASON =
  'Auto mode classifier unavailable — falling back to manual approval'

export function requiresExplicitUserApproval(
  reason: PermissionDecisionReason | undefined,
): boolean {
  if (reason?.type === 'safetyCheck') return !reason.classifierApprovable
  if (reason?.type === 'subcommandResults') {
    return Array.from(reason.reasons.values()).some(result =>
      requiresExplicitUserApproval(result.decisionReason),
    )
  }
  return false
}

/** A safety check that still asks in bypassPermissions mode. */
export function isBypassImmune(
  reason: PermissionDecisionReason | undefined,
): boolean {
  if (reason?.type === 'safetyCheck') return reason.bypassImmune === true
  if (reason?.type === 'subcommandResults') {
    return Array.from(reason.reasons.values()).some(result =>
      isBypassImmune(result.decisionReason),
    )
  }
  return false
}

// Helper function to get the appropriate prose description for rule behavior
export function getRuleBehaviorDescription(
  permissionResult: PermissionResult['behavior'],
): string {
  switch (permissionResult) {
    case 'allow':
      return 'allowed'
    case 'deny':
      return 'denied'
    default:
      return 'asked for confirmation for'
  }
}

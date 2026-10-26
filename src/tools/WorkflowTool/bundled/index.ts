import { loadOfficialWorkflowScriptSpec } from '../workflowDsl.js'
import type { WorkflowSpec } from '../workflowSpec.js'
import DEEP_RESEARCH_SCRIPT from './deepResearch.workflow.txt'

// Official 2.1.303 and 2.1.310 bundle exactly one workflow, deep-research, with this script.
const BUNDLED_WORKFLOWS: WorkflowSpec[] = [
  {
    // Official registers deep-research with disableModelInvocation unless GrowthBook
    // tengu_sorrel_avocet is on; GrowthBook is off in the fork, so it keeps that default.
    ...loadOfficialWorkflowScriptSpec('bundled:deep-research', DEEP_RESEARCH_SCRIPT),
    disableModelInvocation: true,
  },
]

export function initBundledWorkflows(): void {}

export function getBundledWorkflowSpecs(): WorkflowSpec[] {
  return BUNDLED_WORKFLOWS.map(workflow => structuredClone(workflow))
}

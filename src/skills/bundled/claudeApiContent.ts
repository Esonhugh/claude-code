// Content for the claude-api bundled skill (official 2.1.311).
// Each file is inlined as a string via Bun's text loader (also under bun test,
// where a plain .md import would be rendered to HTML).

import skillPrompt from './claude-api/SKILL.md' with { type: 'text' }
import csharpClaudeApiREADME from './claude-api/csharp/claude-api/README.md' with { type: 'text' }
import csharpClaudeApiBatches from './claude-api/csharp/claude-api/batches.md' with { type: 'text' }
import csharpClaudeApiFilesApi from './claude-api/csharp/claude-api/files-api.md' with { type: 'text' }
import csharpClaudeApiOpentelemetry from './claude-api/csharp/claude-api/opentelemetry.md' with { type: 'text' }
import csharpClaudeApiStreaming from './claude-api/csharp/claude-api/streaming.md' with { type: 'text' }
import csharpClaudeApiToolUse from './claude-api/csharp/claude-api/tool-use.md' with { type: 'text' }
import curlExamples from './claude-api/curl/examples.md' with { type: 'text' }
import curlManagedAgents from './claude-api/curl/managed-agents.md' with { type: 'text' }
import goClaudeApiREADME from './claude-api/go/claude-api/README.md' with { type: 'text' }
import goClaudeApiFilesApi from './claude-api/go/claude-api/files-api.md' with { type: 'text' }
import goClaudeApiOpentelemetry from './claude-api/go/claude-api/opentelemetry.md' with { type: 'text' }
import goClaudeApiStreaming from './claude-api/go/claude-api/streaming.md' with { type: 'text' }
import goClaudeApiToolUse from './claude-api/go/claude-api/tool-use.md' with { type: 'text' }
import goManagedAgentsREADME from './claude-api/go/managed-agents/README.md' with { type: 'text' }
import javaClaudeApiREADME from './claude-api/java/claude-api/README.md' with { type: 'text' }
import javaClaudeApiFilesApi from './claude-api/java/claude-api/files-api.md' with { type: 'text' }
import javaClaudeApiOpentelemetry from './claude-api/java/claude-api/opentelemetry.md' with { type: 'text' }
import javaClaudeApiStreaming from './claude-api/java/claude-api/streaming.md' with { type: 'text' }
import javaClaudeApiToolUse from './claude-api/java/claude-api/tool-use.md' with { type: 'text' }
import javaManagedAgentsREADME from './claude-api/java/managed-agents/README.md' with { type: 'text' }
import phpClaudeApiREADME from './claude-api/php/claude-api/README.md' with { type: 'text' }
import phpClaudeApiBatches from './claude-api/php/claude-api/batches.md' with { type: 'text' }
import phpClaudeApiFilesApi from './claude-api/php/claude-api/files-api.md' with { type: 'text' }
import phpClaudeApiOpentelemetry from './claude-api/php/claude-api/opentelemetry.md' with { type: 'text' }
import phpClaudeApiStreaming from './claude-api/php/claude-api/streaming.md' with { type: 'text' }
import phpClaudeApiToolUse from './claude-api/php/claude-api/tool-use.md' with { type: 'text' }
import phpManagedAgentsREADME from './claude-api/php/managed-agents/README.md' with { type: 'text' }
import pythonClaudeApiREADME from './claude-api/python/claude-api/README.md' with { type: 'text' }
import pythonClaudeApiBatches from './claude-api/python/claude-api/batches.md' with { type: 'text' }
import pythonClaudeApiFilesApi from './claude-api/python/claude-api/files-api.md' with { type: 'text' }
import pythonClaudeApiOpentelemetry from './claude-api/python/claude-api/opentelemetry.md' with { type: 'text' }
import pythonClaudeApiSdkUpgrade from './claude-api/python/claude-api/sdk-upgrade.md' with { type: 'text' }
import pythonClaudeApiStreaming from './claude-api/python/claude-api/streaming.md' with { type: 'text' }
import pythonClaudeApiToolUse from './claude-api/python/claude-api/tool-use.md' with { type: 'text' }
import pythonManagedAgentsREADME from './claude-api/python/managed-agents/README.md' with { type: 'text' }
import rubyClaudeApiREADME from './claude-api/ruby/claude-api/README.md' with { type: 'text' }
import rubyClaudeApiOpentelemetry from './claude-api/ruby/claude-api/opentelemetry.md' with { type: 'text' }
import rubyClaudeApiStreaming from './claude-api/ruby/claude-api/streaming.md' with { type: 'text' }
import rubyClaudeApiToolUse from './claude-api/ruby/claude-api/tool-use.md' with { type: 'text' }
import rubyManagedAgentsREADME from './claude-api/ruby/managed-agents/README.md' with { type: 'text' }
import sharedAdminApi from './claude-api/shared/admin-api.md' with { type: 'text' }
import sharedAgentDesign from './claude-api/shared/agent-design.md' with { type: 'text' }
import sharedAnthropicCli from './claude-api/shared/anthropic-cli.md' with { type: 'text' }
import sharedApiVersionMigration from './claude-api/shared/api-version-migration.md' with { type: 'text' }
import sharedClaudePlatformOnAws from './claude-api/shared/claude-platform-on-aws.md' with { type: 'text' }
import sharedCostOptimization from './claude-api/shared/cost-optimization.md' with { type: 'text' }
import sharedErrorCodes from './claude-api/shared/error-codes.md' with { type: 'text' }
import sharedEvalsBuildEval from './claude-api/shared/evals/build-eval.md' with { type: 'text' }
import sharedEvalsCostHillclimb from './claude-api/shared/evals/cost-hillclimb.md' with { type: 'text' }
import sharedEvalsEvalAudit from './claude-api/shared/evals/eval-audit.md' with { type: 'text' }
import sharedEvalsEvalHillclimb from './claude-api/shared/evals/eval-hillclimb.md' with { type: 'text' }
import sharedEvalsReportSCHEMA from './claude-api/shared/evals/report/SCHEMA.md' with { type: 'text' }
import sharedEvalsReportBuildReportLiteMjs from './claude-api/shared/evals/report/build-report-lite.mjs.txt' with { type: 'text' }
import sharedEvalsReportRunnerScaffoldMjs from './claude-api/shared/evals/report/runner-scaffold.mjs.txt' with { type: 'text' }
import sharedGoogleCloudAnthropicManaged from './claude-api/shared/google-cloud-anthropic-managed.md' with { type: 'text' }
import sharedLiveSources from './claude-api/shared/live-sources.md' with { type: 'text' }
import sharedManagedAgentsApiReference from './claude-api/shared/managed-agents-api-reference.md' with { type: 'text' }
import sharedManagedAgentsClientPatterns from './claude-api/shared/managed-agents-client-patterns.md' with { type: 'text' }
import sharedManagedAgentsCore from './claude-api/shared/managed-agents-core.md' with { type: 'text' }
import sharedManagedAgentsEnvironments from './claude-api/shared/managed-agents-environments.md' with { type: 'text' }
import sharedManagedAgentsEvents from './claude-api/shared/managed-agents-events.md' with { type: 'text' }
import sharedManagedAgentsMemory from './claude-api/shared/managed-agents-memory.md' with { type: 'text' }
import sharedManagedAgentsMultiagent from './claude-api/shared/managed-agents-multiagent.md' with { type: 'text' }
import sharedManagedAgentsOnboardingFromQuickstart from './claude-api/shared/managed-agents-onboarding-from-quickstart.md' with { type: 'text' }
import sharedManagedAgentsOnboardingFromUrl from './claude-api/shared/managed-agents-onboarding-from-url.md' with { type: 'text' }
import sharedManagedAgentsOnboarding from './claude-api/shared/managed-agents-onboarding.md' with { type: 'text' }
import sharedManagedAgentsOutcomes from './claude-api/shared/managed-agents-outcomes.md' with { type: 'text' }
import sharedManagedAgentsOverview from './claude-api/shared/managed-agents-overview.md' with { type: 'text' }
import sharedManagedAgentsQuickstartsBugHunter from './claude-api/shared/managed-agents-quickstarts/bug-hunter.md' with { type: 'text' }
import sharedManagedAgentsQuickstartsContractTracker from './claude-api/shared/managed-agents-quickstarts/contract-tracker.md' with { type: 'text' }
import sharedManagedAgentsQuickstartsDataAnalyst from './claude-api/shared/managed-agents-quickstarts/data-analyst.md' with { type: 'text' }
import sharedManagedAgentsQuickstartsDeepResearcher from './claude-api/shared/managed-agents-quickstarts/deep-researcher.md' with { type: 'text' }
import sharedManagedAgentsQuickstartsExplainerVideoMaker from './claude-api/shared/managed-agents-quickstarts/explainer-video-maker.md' with { type: 'text' }
import sharedManagedAgentsQuickstartsFieldMonitor from './claude-api/shared/managed-agents-quickstarts/field-monitor.md' with { type: 'text' }
import sharedManagedAgentsQuickstartsIncidentCommander from './claude-api/shared/managed-agents-quickstarts/incident-commander.md' with { type: 'text' }
import sharedManagedAgentsQuickstartsPerformanceTuner from './claude-api/shared/managed-agents-quickstarts/performance-tuner.md' with { type: 'text' }
import sharedManagedAgentsQuickstartsSprintRetroFacilitator from './claude-api/shared/managed-agents-quickstarts/sprint-retro-facilitator.md' with { type: 'text' }
import sharedManagedAgentsQuickstartsStructuredExtractor from './claude-api/shared/managed-agents-quickstarts/structured-extractor.md' with { type: 'text' }
import sharedManagedAgentsQuickstartsSupportAgent from './claude-api/shared/managed-agents-quickstarts/support-agent.md' with { type: 'text' }
import sharedManagedAgentsQuickstartsSupportToEngEscalator from './claude-api/shared/managed-agents-quickstarts/support-to-eng-escalator.md' with { type: 'text' }
import sharedManagedAgentsQuickstartsWatchlistScanner from './claude-api/shared/managed-agents-quickstarts/watchlist-scanner.md' with { type: 'text' }
import sharedManagedAgentsScheduledDeployments from './claude-api/shared/managed-agents-scheduled-deployments.md' with { type: 'text' }
import sharedManagedAgentsSecure from './claude-api/shared/managed-agents-secure.md' with { type: 'text' }
import sharedManagedAgentsSelfHostedSandboxes from './claude-api/shared/managed-agents-self-hosted-sandboxes.md' with { type: 'text' }
import sharedManagedAgentsTools from './claude-api/shared/managed-agents-tools.md' with { type: 'text' }
import sharedManagedAgentsWebhooks from './claude-api/shared/managed-agents-webhooks.md' with { type: 'text' }
import sharedModelMigration from './claude-api/shared/model-migration.md' with { type: 'text' }
import sharedModels from './claude-api/shared/models.md' with { type: 'text' }
import sharedOpentelemetry from './claude-api/shared/opentelemetry.md' with { type: 'text' }
import sharedPlatformAvailability from './claude-api/shared/platform-availability.md' with { type: 'text' }
import sharedPreservedThinkingMigration from './claude-api/shared/preserved-thinking-migration.md' with { type: 'text' }
import sharedPreservedThinkingMigrationCauses from './claude-api/shared/preserved-thinking-migration/causes.md' with { type: 'text' }
import sharedPreservedThinkingMigrationDropBlockProbePy from './claude-api/shared/preserved-thinking-migration/drop_block_probe.py.txt' with { type: 'text' }
import sharedPreservedThinkingMigrationPrefixDiffPy from './claude-api/shared/preserved-thinking-migration/prefix_diff.py.txt' with { type: 'text' }
import sharedPromptAudit from './claude-api/shared/prompt-audit.md' with { type: 'text' }
import sharedPromptCaching from './claude-api/shared/prompt-caching.md' with { type: 'text' }
import sharedTokenCounting from './claude-api/shared/token-counting.md' with { type: 'text' }
import sharedToolUseConcepts from './claude-api/shared/tool-use-concepts.md' with { type: 'text' }
import typescriptClaudeApiREADME from './claude-api/typescript/claude-api/README.md' with { type: 'text' }
import typescriptClaudeApiBatches from './claude-api/typescript/claude-api/batches.md' with { type: 'text' }
import typescriptClaudeApiFilesApi from './claude-api/typescript/claude-api/files-api.md' with { type: 'text' }
import typescriptClaudeApiOpentelemetry from './claude-api/typescript/claude-api/opentelemetry.md' with { type: 'text' }
import typescriptClaudeApiStreaming from './claude-api/typescript/claude-api/streaming.md' with { type: 'text' }
import typescriptClaudeApiToolUse from './claude-api/typescript/claude-api/tool-use.md' with { type: 'text' }
import typescriptManagedAgentsREADME from './claude-api/typescript/managed-agents/README.md' with { type: 'text' }

// @[MODEL LAUNCH]: Update the model IDs/names below. These are substituted into {{VAR}}
// placeholders in the .md files at runtime before the skill prompt is sent.
export const SKILL_MODEL_VARS = {
  FABLE_ID: 'claude-fable-5-1',
  FABLE_NAME: 'Claude Fable 5.1',
  MYTHOS_ID: 'claude-mythos-5-1',
  MYTHOS_NAME: 'Claude Mythos 5.1',
  PREV_FABLE_ID: 'claude-fable-5',
  PREV_FABLE_NAME: 'Claude Fable 5',
  PREV_MYTHOS_ID: 'claude-mythos-5',
  PREV_MYTHOS_NAME: 'Claude Mythos 5',
  OPUS_ID: 'claude-opus-5-5',
  OPUS_NAME: 'Claude Opus 5.5',
  PREV_OPUS_ID: 'claude-opus-5',
  PREV_OPUS_NAME: 'Claude Opus 5',
  SONNET_ID: 'claude-sonnet-5-5',
  SONNET_NAME: 'Claude Sonnet 5.5',
  HAIKU_ID: 'claude-haiku-5-5',
  HAIKU_NAME: 'Claude Haiku 5.5',
  PREV_SONNET_ID: 'claude-sonnet-5',
  PREV_SONNET_NAME: 'Claude Sonnet 5',
} satisfies Record<string, string>

export const SKILL_PROMPT: string = skillPrompt

export const SKILL_FILES: Record<string, string> = {
  'csharp/claude-api/README.md': csharpClaudeApiREADME,
  'csharp/claude-api/batches.md': csharpClaudeApiBatches,
  'csharp/claude-api/files-api.md': csharpClaudeApiFilesApi,
  'csharp/claude-api/opentelemetry.md': csharpClaudeApiOpentelemetry,
  'csharp/claude-api/streaming.md': csharpClaudeApiStreaming,
  'csharp/claude-api/tool-use.md': csharpClaudeApiToolUse,
  'curl/examples.md': curlExamples,
  'curl/managed-agents.md': curlManagedAgents,
  'go/claude-api/README.md': goClaudeApiREADME,
  'go/claude-api/files-api.md': goClaudeApiFilesApi,
  'go/claude-api/opentelemetry.md': goClaudeApiOpentelemetry,
  'go/claude-api/streaming.md': goClaudeApiStreaming,
  'go/claude-api/tool-use.md': goClaudeApiToolUse,
  'go/managed-agents/README.md': goManagedAgentsREADME,
  'java/claude-api/README.md': javaClaudeApiREADME,
  'java/claude-api/files-api.md': javaClaudeApiFilesApi,
  'java/claude-api/opentelemetry.md': javaClaudeApiOpentelemetry,
  'java/claude-api/streaming.md': javaClaudeApiStreaming,
  'java/claude-api/tool-use.md': javaClaudeApiToolUse,
  'java/managed-agents/README.md': javaManagedAgentsREADME,
  'php/claude-api/README.md': phpClaudeApiREADME,
  'php/claude-api/batches.md': phpClaudeApiBatches,
  'php/claude-api/files-api.md': phpClaudeApiFilesApi,
  'php/claude-api/opentelemetry.md': phpClaudeApiOpentelemetry,
  'php/claude-api/streaming.md': phpClaudeApiStreaming,
  'php/claude-api/tool-use.md': phpClaudeApiToolUse,
  'php/managed-agents/README.md': phpManagedAgentsREADME,
  'python/claude-api/README.md': pythonClaudeApiREADME,
  'python/claude-api/batches.md': pythonClaudeApiBatches,
  'python/claude-api/files-api.md': pythonClaudeApiFilesApi,
  'python/claude-api/opentelemetry.md': pythonClaudeApiOpentelemetry,
  'python/claude-api/sdk-upgrade.md': pythonClaudeApiSdkUpgrade,
  'python/claude-api/streaming.md': pythonClaudeApiStreaming,
  'python/claude-api/tool-use.md': pythonClaudeApiToolUse,
  'python/managed-agents/README.md': pythonManagedAgentsREADME,
  'ruby/claude-api/README.md': rubyClaudeApiREADME,
  'ruby/claude-api/opentelemetry.md': rubyClaudeApiOpentelemetry,
  'ruby/claude-api/streaming.md': rubyClaudeApiStreaming,
  'ruby/claude-api/tool-use.md': rubyClaudeApiToolUse,
  'ruby/managed-agents/README.md': rubyManagedAgentsREADME,
  'shared/admin-api.md': sharedAdminApi,
  'shared/agent-design.md': sharedAgentDesign,
  'shared/anthropic-cli.md': sharedAnthropicCli,
  'shared/api-version-migration.md': sharedApiVersionMigration,
  'shared/claude-platform-on-aws.md': sharedClaudePlatformOnAws,
  'shared/cost-optimization.md': sharedCostOptimization,
  'shared/error-codes.md': sharedErrorCodes,
  'shared/evals/build-eval.md': sharedEvalsBuildEval,
  'shared/evals/cost-hillclimb.md': sharedEvalsCostHillclimb,
  'shared/evals/eval-audit.md': sharedEvalsEvalAudit,
  'shared/evals/eval-hillclimb.md': sharedEvalsEvalHillclimb,
  'shared/evals/report/SCHEMA.md': sharedEvalsReportSCHEMA,
  'shared/evals/report/build-report-lite.mjs': sharedEvalsReportBuildReportLiteMjs,
  'shared/evals/report/runner-scaffold.mjs': sharedEvalsReportRunnerScaffoldMjs,
  'shared/google-cloud-anthropic-managed.md': sharedGoogleCloudAnthropicManaged,
  'shared/live-sources.md': sharedLiveSources,
  'shared/managed-agents-api-reference.md': sharedManagedAgentsApiReference,
  'shared/managed-agents-client-patterns.md': sharedManagedAgentsClientPatterns,
  'shared/managed-agents-core.md': sharedManagedAgentsCore,
  'shared/managed-agents-environments.md': sharedManagedAgentsEnvironments,
  'shared/managed-agents-events.md': sharedManagedAgentsEvents,
  'shared/managed-agents-memory.md': sharedManagedAgentsMemory,
  'shared/managed-agents-multiagent.md': sharedManagedAgentsMultiagent,
  'shared/managed-agents-onboarding-from-quickstart.md': sharedManagedAgentsOnboardingFromQuickstart,
  'shared/managed-agents-onboarding-from-url.md': sharedManagedAgentsOnboardingFromUrl,
  'shared/managed-agents-onboarding.md': sharedManagedAgentsOnboarding,
  'shared/managed-agents-outcomes.md': sharedManagedAgentsOutcomes,
  'shared/managed-agents-overview.md': sharedManagedAgentsOverview,
  'shared/managed-agents-quickstarts/bug-hunter.md': sharedManagedAgentsQuickstartsBugHunter,
  'shared/managed-agents-quickstarts/contract-tracker.md': sharedManagedAgentsQuickstartsContractTracker,
  'shared/managed-agents-quickstarts/data-analyst.md': sharedManagedAgentsQuickstartsDataAnalyst,
  'shared/managed-agents-quickstarts/deep-researcher.md': sharedManagedAgentsQuickstartsDeepResearcher,
  'shared/managed-agents-quickstarts/explainer-video-maker.md': sharedManagedAgentsQuickstartsExplainerVideoMaker,
  'shared/managed-agents-quickstarts/field-monitor.md': sharedManagedAgentsQuickstartsFieldMonitor,
  'shared/managed-agents-quickstarts/incident-commander.md': sharedManagedAgentsQuickstartsIncidentCommander,
  'shared/managed-agents-quickstarts/performance-tuner.md': sharedManagedAgentsQuickstartsPerformanceTuner,
  'shared/managed-agents-quickstarts/sprint-retro-facilitator.md': sharedManagedAgentsQuickstartsSprintRetroFacilitator,
  'shared/managed-agents-quickstarts/structured-extractor.md': sharedManagedAgentsQuickstartsStructuredExtractor,
  'shared/managed-agents-quickstarts/support-agent.md': sharedManagedAgentsQuickstartsSupportAgent,
  'shared/managed-agents-quickstarts/support-to-eng-escalator.md': sharedManagedAgentsQuickstartsSupportToEngEscalator,
  'shared/managed-agents-quickstarts/watchlist-scanner.md': sharedManagedAgentsQuickstartsWatchlistScanner,
  'shared/managed-agents-scheduled-deployments.md': sharedManagedAgentsScheduledDeployments,
  'shared/managed-agents-secure.md': sharedManagedAgentsSecure,
  'shared/managed-agents-self-hosted-sandboxes.md': sharedManagedAgentsSelfHostedSandboxes,
  'shared/managed-agents-tools.md': sharedManagedAgentsTools,
  'shared/managed-agents-webhooks.md': sharedManagedAgentsWebhooks,
  'shared/model-migration.md': sharedModelMigration,
  'shared/models.md': sharedModels,
  'shared/opentelemetry.md': sharedOpentelemetry,
  'shared/platform-availability.md': sharedPlatformAvailability,
  'shared/preserved-thinking-migration.md': sharedPreservedThinkingMigration,
  'shared/preserved-thinking-migration/causes.md': sharedPreservedThinkingMigrationCauses,
  'shared/preserved-thinking-migration/drop_block_probe.py': sharedPreservedThinkingMigrationDropBlockProbePy,
  'shared/preserved-thinking-migration/prefix_diff.py': sharedPreservedThinkingMigrationPrefixDiffPy,
  'shared/prompt-audit.md': sharedPromptAudit,
  'shared/prompt-caching.md': sharedPromptCaching,
  'shared/token-counting.md': sharedTokenCounting,
  'shared/tool-use-concepts.md': sharedToolUseConcepts,
  'typescript/claude-api/README.md': typescriptClaudeApiREADME,
  'typescript/claude-api/batches.md': typescriptClaudeApiBatches,
  'typescript/claude-api/files-api.md': typescriptClaudeApiFilesApi,
  'typescript/claude-api/opentelemetry.md': typescriptClaudeApiOpentelemetry,
  'typescript/claude-api/streaming.md': typescriptClaudeApiStreaming,
  'typescript/claude-api/tool-use.md': typescriptClaudeApiToolUse,
  'typescript/managed-agents/README.md': typescriptManagedAgentsREADME,
}

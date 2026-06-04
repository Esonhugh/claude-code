 Implementation Plan                                                                                                   

 Context

 The project is the Claude Code source tree. The requested changes add an autonomous /goal workflow, embed
 github.com/Esonhugh/Marketplace as a built-in marketplace source, add user favorites for installed plugins, expose
 marketplace autoUpdate from the marketplace browsing page, and change telemetry defaults so Claude Code does not send
 extra Anthropic-bound analytics/OTEL-derived information by default.

 The implementation should reuse the existing slash command, plugin marketplace, settings, and telemetry gates rather
 than introducing a parallel runtime.

 1. Add /goal slash command

 Recommended behavior

 Implement /goal <objective> as a built-in prompt slash command that instructs the main assistant to work autonomously
 toward the objective under the current permission mode. The command should direct the assistant to:

 - treat the command arguments as the goal;
 - continue tool use until the goal is complete, impossible, or blocked by permissions/user input;
 - use todo/task tracking when useful;
 - verify success before claiming completion;
 - if the goal is not achieved and another agent can continue productively, invoke the existing Agent tool with a
 self-contained continuation prompt.

 This is intentionally prompt-level orchestration, not a new scheduler/state machine. It fits the existing command flow
 and avoids changing the REPL turn lifecycle.

 Files to change

 - src/commands/goal.ts
   - Add a new Command with type: 'prompt', name: 'goal', argumentHint: '<goal>', source: 'builtin', and
 getPromptForCommand(args).
   - Import AGENT_TOOL_NAME from src/tools/AgentTool/constants.ts and include it in allowedTools so the command turn may
  spawn continuation agents.
   - The prompt must state that autonomy is bounded by current Claude Code permission mode and must not imply bypassing
 prompts.
 - src/commands.ts
   - Import goal and add it to the COMMANDS() list near other built-in user-facing commands.
   - Do not add it to internal-only commands or remote-safe command lists unless later explicitly decided.

 Avoid for this iteration

 - Do not modify src/utils/processUserInput/processSlashCommand.tsx or src/screens/REPL.tsx for a runtime completion
 detector.
 - Do not automatically change permission mode.

 2. Embed github.com/Esonhugh/Marketplace as a marketplace source

 Recommended behavior

 Add Esonhugh Marketplace as a low-precedence built-in/default marketplace declaration. It should be available
 automatically but remain overridable by user/project settings and blockable by enterprise marketplace policy.

 Do not default it to autoUpdate: true because it is third-party content.

 Files to change

 - src/utils/plugins/esonhughMarketplace.ts
   - Add constants:
       - ESONHUGH_MARKETPLACE_NAME = 'Esonhugh-Marketplace'
     - ESONHUGH_MARKETPLACE_SOURCE = { source: 'github', repo: 'Esonhugh/Marketplace' } satisfies MarketplaceSource
   - Keep this separate from officialMarketplace.ts because it is not an Anthropic official marketplace.
 - src/utils/plugins/marketplaceManager.ts
   - Import the constants.
   - Update getDeclaredMarketplaces() to include an implicit low-precedence declaration:
       - key: Esonhugh-Marketplace
     - source: ESONHUGH_MARKETPLACE_SOURCE
     - sourceIsFallback: true
   - Keep existing precedence: implicit defaults < --add-dir < merged settings.
   - Existing strict/blocklist checks should continue to govern materialization.

 Notes

 - The declaration key should match the upstream manifest name to avoid reconcile loops.
 - If “embed” later means vendoring the marketplace contents for offline use, that is a separate seed-marketplace
 packaging task.

 3. Add plugin favorites and prioritize favorites in /plugin Installed

 Recommended behavior

 Favorites are a user preference, not installation metadata. Store them in user settings and use them only to affect
 installed-list display and row badges.

 Favorites should appear before non-favorites within their existing scope section first. This preserves current grouping
  (project, local, user, managed, builtin, etc.) while satisfying “Installed 插件自动优先输出 favorite 插件.”

 Files to change

 - src/utils/settings/types.ts
   - Add optional setting:
       - favoritePlugins?: string[]
   - Describe values as plugin IDs in plugin@marketplace format.
 - src/entrypoints/sdk/settingsTypes.generated.ts
   - Update generated settings types if this repository expects the generated settings schema to be checked in.
 - src/utils/plugins/pluginFavorites.ts
   - Add helper functions around user settings:
       - getFavoritePluginIds(): Set<string>
     - isPluginFavorite(pluginId: string): boolean
     - setPluginFavorite(pluginId: string, favorite: boolean): void
     - togglePluginFavorite(pluginId: string): boolean
   - Write to userSettings via existing settings update helpers.
   - Deduplicate and sort IDs before persisting for stable diffs.
 - src/commands/plugin/ManagePlugins.tsx
   - Load favorites into React state when installed plugins are loaded.
   - Mark plugin items with isFavorite when constructing pluginsWithChildren / unified items.
   - Add a detail-menu action near the top:
       - Add to favorites / Remove from favorites
   - Toggle favorites through pluginFavorites.ts, update local state, and keep the user in details view.
   - Change plugin group sort from only name.localeCompare to:
       i. favorite plugin group first;
     ii. then existing alphabetical order.
   - Include favorites in relevant useMemo dependencies.
 - src/commands/plugin/UnifiedInstalledCell.tsx
   - Render a subtle favorite marker for plugin rows, e.g. ★ or [favorite], next to the plugin name.
   - Do not apply favorite UI to failed or flagged plugin rows for the first iteration.
 - Optional cleanup: src/commands/plugin/unifiedTypes.ts
   - Replace any with a real discriminated union or extend plugin items with isFavorite?: boolean if the surrounding
 recovered code allows it cleanly.

 Notes

 - Favorited-but-uninstalled plugin IDs can remain in settings harmlessly; only installed items are displayed.
 - Built-in plugins can be favorited if they appear in Installed. If that is not desired, gate the menu action by scope.

 4. Expose marketplace autoUpdate from the Plugin Marketplace page

 Current state

 src/commands/plugin/ManageMarketplaces.tsx already supports auto-update toggling through setMarketplaceAutoUpdate().
 BrowseMarketplace.tsx loads marketplace data but does not surface the setting.

 Files to change

 - src/commands/plugin/BrowseMarketplace.tsx
   - Import:
       - isMarketplaceAutoUpdate from src/utils/plugins/schemas.ts
     - setMarketplaceAutoUpdate from src/utils/plugins/marketplaceManager.ts
     - shouldSkipPluginAutoupdate from src/utils/config.ts
   - Extend MarketplaceInfo with autoUpdate?: boolean.
   - While loading marketplaces, set autoUpdate: isMarketplaceAutoUpdate(name, marketplaceConfig).
   - Add handleToggleMarketplaceAutoUpdate(marketplaceName) that:
       i. finds the marketplace in state;
     ii. calls setMarketplaceAutoUpdate(name, !current.autoUpdate);
     iii. updates local marketplaces state;
     iv. surfaces any error through existing setError/warning state.
   - Add UI state text in marketplace rows and the selected marketplace plugin-list header.
   - Add a keybinding/action (u if consistent with existing plugin marketplace UI) in both:
       - marketplace-list view;
     - plugin-list view, because single-marketplace setups auto-skip the marketplace list.
   - If shouldSkipPluginAutoupdate() is true, show disabled state or omit the toggle, matching Manage Marketplaces
 behavior.

 Notes

 - Reuse setMarketplaceAutoUpdate() rather than duplicating persistence; it already updates known_marketplaces.json and
 mirrors to the declaring settings source.
 - Seed-managed marketplace errors should be surfaced as-is.

 5. Disable Anthropic-bound telemetry by default

 Recommended behavior

 Make the default build avoid sending extra telemetry/analytics information to Anthropic. Preserve explicitly
 user-configured/customer OTEL export only when the user deliberately enables it with CLAUDE_CODE_ENABLE_TELEMETRY and
 OTEL exporter settings.

 Anthropic-bound paths to disable by default:

 - BigQuery/internal metrics exporter to https://api.anthropic.com/api/claude_code/metrics;
 - organization metrics opt-in check to https://api.anthropic.com/api/claude_code/organizations/metrics_enabled;
 - first-party event logging to /api/event_logging/batch;
 - automatic ANT_OTEL_* to OTEL_* propagation for internal users unless explicitly opted in.

 Files to change

 - src/services/analytics/config.ts
   - Add a default-off gate for Anthropic analytics, for example:
       - isAnthropicTelemetryEnabled(): boolean
     - return true only for an explicit env/config opt-in such as CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY=1.
   - Update isAnalyticsDisabled() to return true unless this explicit gate is enabled, while preserving existing hard
 disables for tests, Bedrock/Vertex/Foundry, and privacy levels.
 - src/services/analytics/firstPartyEventLogger.ts
   - Ensure is1PEventLoggingEnabled() uses the new default-off Anthropic telemetry gate through isAnalyticsDisabled().
   - No exporter should be constructed by default.
 - src/utils/telemetry/instrumentation.ts
   - Change isBigQueryMetricsEnabled() to require the explicit Anthropic telemetry opt-in before adding
 BigQueryMetricsExporter.
   - Guard bootstrapTelemetry() so ANT_OTEL_* variables are not copied into active OTEL_* variables by default; copy
 them only when the explicit Anthropic telemetry opt-in is enabled.
   - Keep customer/user OTEL path gated by existing CLAUDE_CODE_ENABLE_TELEMETRY.
   - Continue returning a meter provider so local counters do not crash, but with no Anthropic exporter unless opted in.
 - src/services/api/metricsOptOut.ts
   - Add an early return in checkMetricsEnabled() or its caller path so the Anthropic metrics-enabled API is not
 contacted unless Anthropic telemetry opt-in is enabled.
   - This prevents even the opt-in status check from becoming default outbound telemetry traffic.
 - src/utils/telemetry/bigqueryExporter.ts
   - No functional change should be needed if isBigQueryMetricsEnabled() is gated correctly, but verify no direct
 construction remains.
 - src/services/analytics/firstPartyEventLoggingExporter.ts
   - No functional change should be needed if first-party logging initialization is gated correctly.

 Notes

 - This plan removes/default-disables Anthropic-bound telemetry, not all OpenTelemetry code. User-owned OTEL export is
 still useful for enterprise/local observability and remains explicitly opt-in.
 - If the desired behavior is to remove all OTEL dependencies/code entirely, that is a much larger dependency and
 instrumentation removal; do not mix it into this feature pass unless explicitly requested.

 Verification

 Static/build checks

 - Run the project’s typecheck/build command, likely pnpm build or the repository’s existing equivalent.
 - Run formatting/lint if available in package scripts.

 Manual CLI checks

 - /goal
   - Confirm /goal appears in slash command autocomplete/help.
   - Run /goal with a small local task and verify it proceeds autonomously under current permissions.
   - Run /goal with an impossible/blocked task and verify it reports the blocker or delegates to Agent when useful.
 - Marketplace embedding
   - Start with no known_marketplaces.json entry for Esonhugh and verify Esonhugh-Marketplace materializes through
 existing marketplace reconciliation.
   - Verify it appears in /plugin Browse/Manage views.
   - Restart and confirm it does not repeatedly reinstall or duplicate.
   - Verify strict/blocklisted marketplace policy still blocks it gracefully.
 - Favorites
   - Favorite an installed plugin, return to Installed list, and confirm it appears before non-favorites in the same
 scope.
   - Restart CLI and confirm favorite persists.
   - Unfavorite and confirm order returns to alphabetical.
   - Confirm filtering/search and enable/disable operations still work.
 - Marketplace autoUpdate UI
   - Toggle auto-update from Browse Marketplace marketplace-list view.
   - Toggle auto-update from plugin-list header when only one marketplace exists.
   - Open Manage Marketplaces and confirm the state matches.
   - Confirm seed-managed marketplace errors are displayed.
   - Confirm global auto-update disable hides/disables the toggle.
 - Telemetry default-off
   - Run without telemetry env vars and verify no calls are made to:
     - Telemetry default-off
       - Run without telemetry env vars and verify no calls are made to:
           - /api/claude_code/metrics
         - /api/claude_code/organizations/metrics_enabled
         - /api/event_logging/batch
       - Verify initializeTelemetryAfterTrust() still completes without crashing.
       - Set explicit user OTEL env (CLAUDE_CODE_ENABLE_TELEMETRY=1 plus OTEL exporter settings) and confirm customer
     OTEL export still works.
       - Set explicit Anthropic telemetry opt-in env and confirm internal BigQuery/1P paths can still initialize when
     intentionally enabled.

     Open assumptions

     - /goal will use prompt-level autonomy and the existing Agent tool, not a hard runtime detector after every
     assistant stop.
     - Esonhugh Marketplace should be auto-declared but not vendored offline.
     - Plugin favorites are user-local and sorted within existing scope sections.
     - Anthropic-bound telemetry is default-off, while explicitly user-configured OTEL remains available.
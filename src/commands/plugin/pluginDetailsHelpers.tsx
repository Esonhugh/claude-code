/**
 * Shared helper functions and types for plugin details views
 *
 * Used by both DiscoverPlugins and BrowseMarketplace components.
 */

import * as React from 'react'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { Byline } from '../../components/design-system/Byline.js'
import { Box, Text } from '../../ink.js'
import type { InstallActivation } from '../../utils/plugins/refresh.js'
import type { PluginMarketplaceEntry } from '../../utils/plugins/schemas.js'

/**
 * Represents a plugin available for installation from a marketplace
 */
export type InstallablePlugin = {
  entry: PluginMarketplaceEntry
  marketplaceName: string
  pluginId: string
  isInstalled: boolean
}

/**
 * Menu option for plugin details view
 */
/** Official 2.1.329 ending of an install result, by what activation did. */
export function installActivationNote(
  outcome: InstallActivation,
  count = 1,
): string {
  switch (outcome) {
    case 'activated':
      return count === 1 ? ' Plugin is now active.' : ' Plugins are now active.'
    case 'load-failed':
      return count === 1
        ? " The plugin couldn't load. See /plugin for details."
        : " Some plugins couldn't load. See /plugin for details."
    case 'reload-required':
      return ' Run /reload-plugins to apply.'
  }
}

export type PluginDetailsMenuOption = {
  label: string
  action: string
}

/**
 * Extract GitHub repo info from a plugin's source
 */
export function extractGitHubRepo(plugin: InstallablePlugin): string | null {
  const isGitHub =
    plugin.entry.source &&
    typeof plugin.entry.source === 'object' &&
    'source' in plugin.entry.source &&
    plugin.entry.source.source === 'github'

  if (
    isGitHub &&
    typeof plugin.entry.source === 'object' &&
    'repo' in plugin.entry.source
  ) {
    return plugin.entry.source.repo
  }

  return null
}

/**
 * Build menu options for plugin details view with scoped installation options
 */
export function buildPluginDetailsMenuOptions(
  hasHomepage: string | undefined,
  githubRepo: string | null,
): PluginDetailsMenuOption[] {
  const options: PluginDetailsMenuOption[] = [
    { label: 'Install for you (user scope)', action: 'install-user' },
    {
      label: 'Install for all collaborators on this repository (project scope)',
      action: 'install-project',
    },
    {
      label: 'Install for you, in this repo only (local scope)',
      action: 'install-local',
    },
  ]
  if (hasHomepage) {
    options.push({ label: 'Open homepage', action: 'homepage' })
  }
  if (githubRepo) {
    options.push({ label: 'View on GitHub', action: 'github' })
  }
  options.push({ label: 'Back to plugin list', action: 'back' })
  return options
}

/**
 * Key hint component for plugin selection screens
 */
export function PluginSelectionKeyHint({
  hasSelection,
}: {
  hasSelection: boolean
}): React.ReactNode {
  return (
    <Box marginTop={1}>
      <Text dimColor italic>
        <Byline>
          {hasSelection && (
            <ConfigurableShortcutHint
              action="plugin:install"
              context="Plugin"
              fallback="i"
              description="install"
              bold
            />
          )}
          <ConfigurableShortcutHint
            action="plugin:toggle"
            context="Plugin"
            fallback="Space"
            description="toggle"
          />
          <ConfigurableShortcutHint
            action="select:accept"
            context="Select"
            fallback="Enter"
            description="details"
          />
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="back"
          />
        </Byline>
      </Text>
    </Box>
  )
}

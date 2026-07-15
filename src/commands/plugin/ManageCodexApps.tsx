import figures from 'figures'
import * as React from 'react'
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { Byline } from '../../components/design-system/Byline.js'
import { SearchBox } from '../../components/SearchBox.js'
import { useSearchInput } from '../../hooks/useSearchInput.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text, useInput, useTerminalFocus } from '../../ink.js'
import {
  useKeybinding,
  useKeybindings,
} from '../../keybindings/useKeybinding.js'
import {
  buildCodexAppPluginProjections,
  type CodexAppPluginProjection,
} from '../../services/apps/pluginProjection.js'
import {
  getDisabledCodexAppConnectorIds,
  refreshCodexAppToolExposure,
  setCodexAppEnabled,
} from '../../services/apps/preferences.js'
import {
  codexAppAuthorizationLabel,
  codexAppUsabilityLabel,
  getCodexAppRuntimeStatus,
  getCodexAppStatusesRevision,
  subscribeCodexAppStatuses,
} from '../../services/apps/status.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import {
  getFavoritePluginIds,
  togglePluginFavorite,
} from '../../utils/plugins/pluginFavorites.js'
import { UnifiedInstalledCell } from './UnifiedInstalledCell.js'
import type { UnifiedInstalledItem } from './unifiedTypes.js'
import { usePagination } from './usePagination.js'

type Props = {
  onBack: () => void
  onSearchModeChange?: (active: boolean) => void
}

type CodexAppsView =
  | { type: 'list' }
  | { type: 'details'; app: CodexAppPluginProjection }

export function ManageCodexApps({
  onBack,
  onSearchModeChange,
}: Props): React.ReactNode {
  const mcpTools = useAppState((state) => state.mcp.tools)
  const setAppState = useSetAppState()
  const apps = useMemo(
    () => buildCodexAppPluginProjections(mcpTools),
    [mcpTools],
  )
  const [view, setView] = useState<CodexAppsView>({ type: 'list' })
  const [favoriteIds, setFavoriteIds] = useState(() => getFavoritePluginIds())
  const [disabledIds, setDisabledIds] = useState(() =>
    getDisabledCodexAppConnectorIds(),
  )
  useSyncExternalStore(
    subscribeCodexAppStatuses,
    getCodexAppStatusesRevision,
    getCodexAppStatusesRevision,
  )
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [detailsMenuIndex, setDetailsMenuIndex] = useState(0)
  const [processError, setProcessError] = useState<string | null>(null)
  const [isSearchMode, setIsSearchModeRaw] = useState(false)
  const setIsSearchMode = useCallback(
    (active: boolean) => {
      setIsSearchModeRaw(active)
      onSearchModeChange?.(active)
    },
    [onSearchModeChange],
  )
  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    cursorOffset,
  } = useSearchInput({
    isActive: view.type === 'list' && isSearchMode,
    onExit: () => setIsSearchMode(false),
  })
  const isTerminalFocused = useTerminalFocus()
  const { columns: terminalWidth } = useTerminalSize()

  const items: UnifiedInstalledItem[] = apps
    .map((app) => {
      const isFavorite = favoriteIds.has(app.pluginId)
      const isEnabled = !disabledIds.has(app.connectorId)
      const runtimeStatus = getCodexAppRuntimeStatus(app.connectorId)
      return {
        type: 'codex-app',
        id: app.pluginId,
        name: app.displayName,
        description: app.description,
        marketplace: app.marketplace,
        scope: isFavorite ? 'favorite' : 'codex-app',
        status: isEnabled ? 'available' : 'disabled',
        isEnabled,
        isFavorite,
        runtimeStatus,
        app,
      }
    })
    .sort((a, b) => {
      if (a.scope !== b.scope) return a.scope === 'favorite' ? -1 : 1
      return a.name.localeCompare(b.name)
    })

  const filteredItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return items
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        item.app.connectorName.toLowerCase().includes(query) ||
        item.description?.toLowerCase().includes(query),
    )
  }, [items, searchQuery])

  const pagination = usePagination<UnifiedInstalledItem>({
    totalItems: filteredItems.length,
    selectedIndex,
    maxVisible: 8,
  })

  const updateEnabled = useCallback(
    (app: CodexAppPluginProjection, enabled: boolean) => {
      try {
        setCodexAppEnabled(app.connectorId, enabled)
        setDisabledIds(getDisabledCodexAppConnectorIds())
        setAppState((previous) => ({
          ...previous,
          mcp: {
            ...previous.mcp,
            tools: refreshCodexAppToolExposure(previous.mcp.tools),
          },
        }))
        setProcessError(null)
      } catch (error) {
        setProcessError(
          error instanceof Error
            ? error.message
            : 'Failed to update Codex App state',
        )
      }
    },
    [setAppState],
  )

  const toggleFavorite = useCallback((app: CodexAppPluginProjection) => {
    try {
      togglePluginFavorite(app.pluginId)
      setFavoriteIds(getFavoritePluginIds())
      setProcessError(null)
    } catch (error) {
      setProcessError(
        error instanceof Error
          ? error.message
          : 'Failed to update Codex App favorite',
      )
    }
  }, [])

  useEffect(() => {
    setSelectedIndex(0)
  }, [searchQuery])

  useEffect(() => {
    if (selectedIndex >= filteredItems.length && filteredItems.length > 0) {
      setSelectedIndex(filteredItems.length - 1)
    }
  }, [filteredItems.length, selectedIndex])

  useInput(
    (input, key) => {
      if (isSearchMode) return
      const printable =
        !key.ctrl &&
        !key.meta &&
        input.length > 0 &&
        !/^\s+$/.test(input) &&
        input !== 'j' &&
        input !== 'k' &&
        input !== ' '
      if (input === '/' && !key.ctrl && !key.meta) {
        setIsSearchMode(true)
        setSearchQuery('')
      } else if (printable) {
        setIsSearchMode(true)
        setSearchQuery(input)
      }
    },
    { isActive: view.type === 'list' },
  )

  useKeybindings(
    {
      'select:previous': () => {
        if (selectedIndex === 0) setIsSearchMode(true)
        else
          pagination.handleSelectionChange(selectedIndex - 1, setSelectedIndex)
      },
      'select:next': () => {
        if (selectedIndex < filteredItems.length - 1) {
          pagination.handleSelectionChange(selectedIndex + 1, setSelectedIndex)
        }
      },
      'select:accept': () => {
        const item = filteredItems[selectedIndex]
        if (!item) return
        setView({ type: 'details', app: item.app })
        setDetailsMenuIndex(0)
        setProcessError(null)
      },
    },
    {
      context: 'Select',
      isActive: view.type === 'list' && !isSearchMode,
    },
  )

  useKeybindings(
    {
      'plugin:toggle': () => {
        const item = filteredItems[selectedIndex]
        if (item) updateEnabled(item.app, !item.isEnabled)
      },
    },
    {
      context: 'Plugin',
      isActive: view.type === 'list' && !isSearchMode,
    },
  )

  const selectedApp = view.type === 'details' ? view.app : undefined
  const selectedAppEnabled = selectedApp
    ? !disabledIds.has(selectedApp.connectorId)
    : false
  const selectedAppFavorite = selectedApp
    ? favoriteIds.has(selectedApp.pluginId)
    : false
  const selectedAppRuntimeStatus = selectedApp
    ? getCodexAppRuntimeStatus(selectedApp.connectorId)
    : undefined
  const detailsMenu = selectedApp
    ? [
        {
          label: selectedAppFavorite
            ? 'Remove from favorites'
            : 'Add to favorites',
          action: () => toggleFavorite(selectedApp),
        },
        {
          label: selectedAppEnabled ? 'Disable Codex App' : 'Enable Codex App',
          action: () => updateEnabled(selectedApp, !selectedAppEnabled),
        },
        {
          label: 'Back to Codex Apps',
          action: () => {
            setView({ type: 'list' })
            setProcessError(null)
          },
        },
      ]
    : []

  useKeybindings(
    {
      'select:previous': () =>
        setDetailsMenuIndex((index) => Math.max(0, index - 1)),
      'select:next': () =>
        setDetailsMenuIndex((index) =>
          Math.min(detailsMenu.length - 1, index + 1),
        ),
      'select:accept': () => detailsMenu[detailsMenuIndex]?.action(),
    },
    { context: 'Select', isActive: view.type === 'details' },
  )

  useKeybinding(
    'confirm:no',
    () => {
      if (view.type === 'details') {
        setView({ type: 'list' })
        setProcessError(null)
      } else {
        onBack()
      }
    },
    {
      context: 'Confirmation',
      isActive: view.type === 'details' || !isSearchMode,
    },
  )

  if (view.type === 'details') {
    const app = view.app
    const visibleTools = app.tools.slice(0, 8)
    const readOnlyToolCount = app.tools.filter((tool) => tool.isReadOnly()).length
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>{app.displayName}</Text>
          <Text dimColor> Codex App</Text>
        </Box>
        <Box>
          <Text dimColor>Connector: </Text>
          <Text>{app.connectorName}</Text>
        </Box>
        <Box>
          <Text dimColor>Runtime: </Text>
          <Text>shared codex_apps MCP</Text>
        </Box>
        <Box>
          <Text dimColor>Health check: </Text>
          <Text>
            Read-only calls only ({readOnlyToolCount} declared read-only tools)
          </Text>
        </Box>
        <Box>
          <Text dimColor>Local state: </Text>
          <Text color={selectedAppEnabled ? 'success' : 'warning'}>
            {selectedAppEnabled ? 'Enabled' : 'Disabled'}
          </Text>
          <Text dimColor>
            {selectedAppEnabled
              ? ' (exposed to the AI tool pool)'
              : ' (hidden from the AI tool pool)'}
          </Text>
        </Box>
        {selectedAppRuntimeStatus && (
          <>
            <Box>
              <Text dimColor>Authorization: </Text>
              <Text
                color={
                  selectedAppRuntimeStatus.kind === 'needs-auth'
                    ? 'warning'
                    : selectedAppRuntimeStatus.kind === 'checking'
                      ? 'suggestion'
                    : selectedAppRuntimeStatus.kind === 'ready'
                      ? 'success'
                      : undefined
                }
              >
                {codexAppAuthorizationLabel(selectedAppRuntimeStatus)}
              </Text>
            </Box>
            <Box>
              <Text dimColor>Usability: </Text>
              <Text
                color={
                  !selectedAppEnabled
                    ? 'warning'
                    : selectedAppRuntimeStatus.kind === 'ready'
                      ? 'success'
                      : selectedAppRuntimeStatus.kind === 'checking'
                        ? 'suggestion'
                      : selectedAppRuntimeStatus.kind === 'needs-auth' ||
                          selectedAppRuntimeStatus.kind === 'error'
                        ? 'warning'
                        : undefined
                }
              >
                {codexAppUsabilityLabel(
                  selectedAppRuntimeStatus,
                  selectedAppEnabled,
                )}
              </Text>
            </Box>
            {'checkedAt' in selectedAppRuntimeStatus && (
              <Box>
                <Text dimColor>Last checked: </Text>
                <Text dimColor>
                  {new Date(
                    selectedAppRuntimeStatus.checkedAt,
                  ).toLocaleString()}
                </Text>
              </Box>
            )}
          </>
        )}
        <Box>
          <Text dimColor>Favorite: </Text>
          <Text color={selectedAppFavorite ? 'warning' : undefined}>
            {selectedAppFavorite ? 'Yes ★' : 'No'}
          </Text>
        </Box>
        {app.description && (
          <Box marginTop={1}>
            <Text>{app.description}</Text>
          </Box>
        )}
        <Box marginTop={1} flexDirection="column">
          <Text bold>Tools ({app.tools.length})</Text>
          {visibleTools.map((tool) => (
            <Text key={tool.name} dimColor>
              {'  '}
              {tool.name}
            </Text>
          ))}
          {app.tools.length > visibleTools.length && (
            <Text dimColor>
              {'  '}… and {app.tools.length - visibleTools.length} more
            </Text>
          )}
        </Box>
        <Box marginTop={1} flexDirection="column">
          {detailsMenu.map((item, index) => (
            <Box key={item.label}>
              <Text>
                {index === detailsMenuIndex ? `${figures.pointer} ` : '  '}
              </Text>
              <Text bold={index === detailsMenuIndex}>{item.label}</Text>
            </Box>
          ))}
        </Box>
        {processError && (
          <Box marginTop={1}>
            <Text color="error">{processError}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Byline>
            <ConfigurableShortcutHint
              action="select:previous"
              context="Select"
              fallback="↑"
              description="navigate"
            />
            <ConfigurableShortcutHint
              action="select:accept"
              context="Select"
              fallback="Enter"
              description="select"
            />
            <ConfigurableShortcutHint
              action="confirm:no"
              context="Confirmation"
              fallback="Esc"
              description="back"
            />
          </Byline>
        </Box>
      </Box>
    )
  }

  if (items.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>Codex Apps</Text>
        <Text>
          No accessible Codex Apps are available for this OAuth account.
        </Text>
        <Text dimColor>Wait for codex_apps to connect or run /login.</Text>
      </Box>
    )
  }

  const visibleItems = pagination.getVisibleItems(filteredItems)
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <SearchBox
          query={searchQuery}
          isFocused={isSearchMode}
          isTerminalFocused={isTerminalFocused}
          width={terminalWidth - 4}
          cursorOffset={cursorOffset}
        />
      </Box>
      {filteredItems.length === 0 && searchQuery && (
        <Box marginBottom={1}>
          <Text dimColor>No Apps match &quot;{searchQuery}&quot;</Text>
        </Box>
      )}
      {pagination.scrollPosition.canScrollUp && (
        <Text dimColor> {figures.arrowUp} more above</Text>
      )}
      {visibleItems.map((item, visibleIndex) => {
        const actualIndex = pagination.toActualIndex(visibleIndex)
        const previous =
          visibleIndex > 0 ? visibleItems[visibleIndex - 1] : null
        const showHeader = !previous || previous.scope !== item.scope
        return (
          <React.Fragment key={item.id}>
            {showHeader && (
              <Box marginTop={visibleIndex > 0 ? 1 : 0} paddingLeft={2}>
                <Text dimColor>
                  {item.scope === 'favorite' ? 'Favorite' : 'Codex Apps'}
                </Text>
              </Box>
            )}
            <UnifiedInstalledCell
              item={item}
              isSelected={actualIndex === selectedIndex && !isSearchMode}
            />
          </React.Fragment>
        )
      })}
      {pagination.scrollPosition.canScrollDown && (
        <Text dimColor> {figures.arrowDown} more below</Text>
      )}
      <Box marginTop={1} marginLeft={1}>
        <Text dimColor>
          Status comes from successful read-only calls; write actions are never
          used as health checks.
        </Text>
      </Box>
      <Box marginTop={1} marginLeft={1}>
        <Text dimColor italic>
          <Byline>
            <Text>type to search</Text>
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
      {processError && (
        <Box marginLeft={1}>
          <Text color="error">{processError}</Text>
        </Box>
      )}
    </Box>
  )
}

import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../settings/settings.js'

function normalizeFavoritePluginIds(ids: Iterable<string>): string[] {
  return [...new Set([...ids].map(id => id.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  )
}

function saveFavoritePluginIds(ids: Iterable<string>): void {
  const favoritePlugins = normalizeFavoritePluginIds(ids)
  const { error } = updateSettingsForSource('userSettings', {
    favoritePlugins: favoritePlugins.length > 0 ? favoritePlugins : undefined,
  })
  if (error) throw error
}

export function getFavoritePluginIds(): Set<string> {
  return new Set(
    normalizeFavoritePluginIds(
      getSettingsForSource('userSettings')?.favoritePlugins ?? [],
    ),
  )
}

export function isPluginFavorite(pluginId: string): boolean {
  return getFavoritePluginIds().has(pluginId)
}

export function setPluginFavorite(pluginId: string, favorite: boolean): void {
  const favorites = getFavoritePluginIds()
  if (favorite) {
    favorites.add(pluginId)
  } else {
    favorites.delete(pluginId)
  }
  saveFavoritePluginIds(favorites)
}

export function togglePluginFavorite(pluginId: string): boolean {
  const nextFavorite = !isPluginFavorite(pluginId)
  setPluginFavorite(pluginId, nextFavorite)
  return nextFavorite
}

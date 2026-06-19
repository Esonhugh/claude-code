import { clearCommandMemoizationCaches } from '../../commands.js'
import { clearSkillCaches } from '../../skills/loadSkillsDir.js'

type ReloadSkillsOptions = {
  clearCommandMemoizationCaches?: () => void
  clearSkillCaches?: () => void
  clearPluginCommandCache?: () => void
  clearPluginSkillsCache?: () => void
  refreshActivePlugins?: () => void
}

type ReloadSkillsResult = {
  message: string
}

export function reloadSkills(options: ReloadSkillsOptions = {}): ReloadSkillsResult {
  ;(options.clearCommandMemoizationCaches ?? clearCommandMemoizationCaches)()
  ;(options.clearSkillCaches ?? clearSkillCaches)()
  void options.clearPluginCommandCache
  void options.clearPluginSkillsCache
  void options.refreshActivePlugins

  return { message: 'Reloaded skills' }
}

export async function call() {
  return { type: 'text' as const, value: reloadSkills().message }
}

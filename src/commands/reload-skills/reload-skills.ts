import { clearCommandMemoizationCaches } from '../../commands.js'
import {
  clearSkillCaches,
  getSkillDirCommands,
} from '../../skills/loadSkillsDir.js'
import { getCwd } from '../../utils/cwd.js'
import {
  clearPluginSkillsCache,
  getPluginSkills,
} from '../../utils/plugins/loadPluginCommands.js'

type ReloadedSkill = {
  source?: string
}

type ReloadSkillsOptions = {
  clearCommandMemoizationCaches?: () => void
  clearSkillCaches?: () => void
  loadSkills?: () => ReloadedSkill[] | Promise<ReloadedSkill[]>
  clearPluginCommandCache?: () => void
  clearPluginSkillsCache?: () => void
  loadPluginSkills?: () => ReloadedSkill[] | Promise<ReloadedSkill[]>
  refreshActivePlugins?: () => void
}

type ReloadSkillsResult = {
  message: string
}

export async function reloadSkills(
  options: ReloadSkillsOptions = {},
): Promise<ReloadSkillsResult> {
  ;(options.clearCommandMemoizationCaches ?? clearCommandMemoizationCaches)()
  ;(options.clearSkillCaches ?? clearSkillCaches)()
  ;(options.clearPluginSkillsCache ?? clearPluginSkillsCache)()
  void options.clearPluginCommandCache
  void options.refreshActivePlugins

  const [skills, pluginSkills] = await Promise.all([
    (options.loadSkills ?? (() => getSkillDirCommands(getCwd())))(),
    (options.loadPluginSkills ?? getPluginSkills)(),
  ])

  const userCount = countSkillsFromSource(skills, 'userSettings')
  const projectCount = countSkillsFromSource(skills, 'projectSettings')
  const pluginCount = pluginSkills.length
  const totalCount = userCount + projectCount + pluginCount

  return {
    message: `Reloaded ${totalCount} skills (user ${userCount} skills, project ${projectCount} skills, plugin ${pluginCount} skills)`,
  }
}

export async function call() {
  return { type: 'text' as const, value: (await reloadSkills()).message }
}

function countSkillsFromSource(skills: readonly unknown[], source: string): number {
  return skills.filter(
    skill =>
      typeof skill === 'object' &&
      skill !== null &&
      'source' in skill &&
      skill.source === source,
  ).length
}

import capitalize from 'lodash-es/capitalize.js'
import figures from 'figures'
import * as React from 'react'
import { useMemo, useState } from 'react'
import {
  type Command,
  type CommandBase,
  type CommandResultDisplay,
  getCommandName,
  type PromptCommand,
} from '../../commands.js'
import { Box, Text, useInput } from '../../ink.js'
import {
  estimateSkillFrontmatterTokens,
  getSkillsPath,
} from '../../skills/loadSkillsDir.js'
import { getDisplayPath } from '../../utils/file.js'
import { formatTokens } from '../../utils/format.js'
import {
  getSettingSourceName,
  type SettingSource,
} from '../../utils/settings/constants.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import {
  getSkillOverride,
  isSkillOverridable,
  nextSkillOverride,
  type SkillOverride,
} from '../../utils/skillOverrides.js'
import { plural } from '../../utils/stringUtils.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { Dialog } from '../design-system/Dialog.js'

// Skills are always PromptCommands with CommandBase properties
type SkillCommand = CommandBase & PromptCommand

type SkillSource = SettingSource | 'plugin' | 'mcp' | 'codex_app'

type Props = {
  onExit: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  commands: Command[]
}

function getSourceTitle(source: SkillSource): string {
  if (source === 'plugin') {
    return 'Plugin skills'
  }
  if (source === 'mcp') {
    return 'MCP skills'
  }
  if (source === 'codex_app') {
    return 'Codex skills'
  }
  return `${capitalize(getSettingSourceName(source))} skills`
}

function getSourceSubtitle(
  source: SkillSource,
  skills: SkillCommand[],
): string | undefined {
  // MCP skills show server names; file-based skills show filesystem paths.
  // Skill names are `<server>:<skill>`, not `mcp__<server>__…`.
  if (source === 'mcp' || source === 'codex_app') {
    const servers = [
      ...new Set(
        skills
          .map(s => {
            const idx = s.name.indexOf(':')
            return idx > 0 ? s.name.slice(0, idx) : null
          })
          .filter((n): n is string => n != null),
      ),
    ]
    return servers.length > 0 ? servers.join(', ') : undefined
  }
  const skillsPath = getDisplayPath(getSkillsPath(source, 'skills'))
  const hasCommandsSkills = skills.some(
    s => s.loadedFrom === 'commands_DEPRECATED',
  )
  return hasCommandsSkills
    ? `${skillsPath}, ${getDisplayPath(getSkillsPath(source, 'commands'))}`
    : skillsPath
}

const SOURCE_ORDER: SkillSource[] = [
  'projectSettings',
  'userSettings',
  'policySettings',
  'plugin',
  'mcp',
  'codex_app',
]

export function SkillsMenu({ onExit, commands }: Props): React.ReactNode {
  // Filter commands for skills and cast to SkillCommand
  const skills = useMemo(() => {
    return commands.filter(
      (cmd): cmd is SkillCommand =>
        cmd.type === 'prompt' &&
        (cmd.loadedFrom === 'skills' ||
          cmd.loadedFrom === 'commands_DEPRECATED' ||
          cmd.loadedFrom === 'plugin' ||
          cmd.loadedFrom === 'mcp' ||
          cmd.loadedFrom === 'codex_app'),
    )
  }, [commands])

  const skillsBySource = useMemo((): Record<SkillSource, SkillCommand[]> => {
    const groups: Record<SkillSource, SkillCommand[]> = {
      policySettings: [],
      userSettings: [],
      projectSettings: [],
      localSettings: [],
      flagSettings: [],
      plugin: [],
      mcp: [],
      codex_app: [],
    }

    for (const skill of skills) {
      const source: SkillSource =
        skill.loadedFrom === 'codex_app'
          ? 'codex_app'
          : (skill.source as SkillSource)
      if (source in groups) {
        groups[source].push(skill)
      }
    }

    for (const group of Object.values(groups)) {
      group.sort((a, b) => getCommandName(a).localeCompare(getCommandName(b)))
    }

    return groups
  }, [skills])

  const handleCancel = (): void => {
    onExit('Skills dialog dismissed', { display: 'system' })
  }

  const orderedSkills = useMemo(
    () => SOURCE_ORDER.flatMap(source => skillsBySource[source]),
    [skillsBySource],
  )
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [overrides, setOverrides] = useState<Record<string, SkillOverride>>(
    () =>
      Object.fromEntries(
        orderedSkills.map(skill => [skill.name, getSkillOverride(skill)]),
      ),
  )

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex(i => Math.max(0, i - 1))
    } else if (key.downArrow) {
      setSelectedIndex(i => Math.min(orderedSkills.length - 1, i + 1))
    } else if (key.return || input === ' ') {
      const skill = orderedSkills[selectedIndex]
      if (!skill || !isSkillOverridable(skill)) return
      const next = nextSkillOverride(overrides[skill.name] ?? 'on')
      // "on" is the default, so it removes the entry instead of storing it.
      updateSettingsForSource('localSettings', {
        skillOverrides: { [skill.name]: next === 'on' ? undefined : next },
      })
      setOverrides(prev => ({ ...prev, [skill.name]: next }))
    }
  })

  if (skills.length === 0) {
    return (
      <Dialog
        title="Skills"
        subtitle="No skills found"
        onCancel={handleCancel}
        hideInputGuide
      >
        <Text dimColor>
          Create skills in .claude/skills/ or ~/.claude/skills/
        </Text>
        <Text dimColor italic>
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="close"
          />
        </Text>
      </Dialog>
    )
  }

  const renderSkill = (skill: SkillCommand) => {
    const selected = orderedSkills[selectedIndex] === skill
    const override = overrides[skill.name] ?? 'on'
    const estimatedTokens = estimateSkillFrontmatterTokens(skill)
    const tokenDisplay = `~${formatTokens(estimatedTokens)}`
    const pluginName =
      skill.source === 'plugin'
        ? skill.pluginInfo?.pluginManifest.name
        : undefined

    return (
      <Box key={`${skill.name}-${skill.source}`}>
        <Text color={selected ? 'suggestion' : undefined}>
          {selected ? figures.pointer : ' '}{' '}
          {override === 'off' ? figures.circle : figures.tick}{' '}
          {getCommandName(skill)}
        </Text>
        <Text dimColor>
          {override === 'name-only' || override === 'user-invocable-only'
            ? ` · ${override === 'name-only' ? 'name-only' : 'user-only'}`
            : ''}
          {pluginName ? ` · ${pluginName}` : ''} · {tokenDisplay} description
          tokens
        </Text>
      </Box>
    )
  }

  const renderSkillGroup = (source: SkillSource) => {
    const groupSkills = skillsBySource[source]
    if (groupSkills.length === 0) return null

    const title = getSourceTitle(source)
    const subtitle = getSourceSubtitle(source, groupSkills)

    return (
      <Box flexDirection="column" key={source}>
        <Box>
          <Text bold dimColor>
            {title}
          </Text>
          {subtitle && <Text dimColor> ({subtitle})</Text>}
        </Box>
        {groupSkills.map(skill => renderSkill(skill))}
      </Box>
    )
  }

  return (
    <Dialog
      title="Skills"
      subtitle={`${skills.length} ${plural(skills.length, 'skill')} · enter/space to cycle`}
      onCancel={handleCancel}
      hideInputGuide
    >
      <Box flexDirection="column" gap={1}>
        {SOURCE_ORDER.map(renderSkillGroup)}
      </Box>
      <Text dimColor italic>
        <ConfigurableShortcutHint
          action="confirm:no"
          context="Confirmation"
          fallback="Esc"
          description="close"
        />
      </Text>
    </Dialog>
  )
}

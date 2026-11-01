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
import { estimateSkillFrontmatterTokens } from '../../skills/loadSkillsDir.js'
import { formatTokens } from '../../utils/format.js'
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
import { MenuList, type MenuListRow } from '../design-system/MenuList.js'
import { SearchBox } from '../SearchBox.js'

// Skills are always PromptCommands with CommandBase properties
type SkillCommand = CommandBase & PromptCommand

type Props = {
  onExit: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  commands: Command[]
}

// 2.1.311 lists every skill in one flat list; the source is a meta column.
function getSourceLabel(skill: SkillCommand): string {
  if (skill.loadedFrom === 'codex_app') return 'codex'
  if (skill.source === 'plugin') {
    return skill.pluginInfo?.pluginManifest.name ?? 'plugin'
  }
  if (skill.source === 'mcp') {
    const idx = skill.name.indexOf(':')
    return idx > 0 ? skill.name.slice(0, idx) : 'mcp'
  }
  switch (skill.source) {
    case 'userSettings':
      return 'user'
    case 'projectSettings':
      return 'project'
    case 'localSettings':
      return 'local'
    case 'policySettings':
      return 'managed'
    default:
      return String(skill.source)
  }
}

export function formatSkillTokens(tokens: number): string {
  return tokens < 20 ? '< 20' : `~${formatTokens(Math.round(tokens / 10) * 10)}`
}

const OVERRIDE_WORD: Partial<Record<SkillOverride, string>> = {
  'name-only': 'name-only',
  'user-invocable-only': 'user-only',
}

export function SkillsMenu({ onExit, commands }: Props): React.ReactNode {
  const skills = useMemo(() => {
    return commands
      .filter(
        (cmd): cmd is SkillCommand =>
          cmd.type === 'prompt' &&
          (cmd.loadedFrom === 'skills' ||
            cmd.loadedFrom === 'commands_DEPRECATED' ||
            cmd.loadedFrom === 'plugin' ||
            cmd.loadedFrom === 'mcp' ||
            cmd.loadedFrom === 'codex_app'),
      )
      .sort((a, b) => getCommandName(a).localeCompare(getCommandName(b)))
  }, [commands])
  const [sortByTokens, setSortByTokens] = useState(false)
  const ordered = useMemo(
    () =>
      sortByTokens
        ? [...skills].sort(
            (a, b) =>
              estimateSkillFrontmatterTokens(b) -
              estimateSkillFrontmatterTokens(a),
          )
        : skills,
    [skills, sortByTokens],
  )
  const [initial] = useState<Record<string, SkillOverride>>(() =>
    Object.fromEntries(skills.map(skill => [skill.name, getSkillOverride(skill)])),
  )
  const [overrides, setOverrides] = useState(initial)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [focused, setFocused] = useState(0)

  const lowered = query.toLowerCase()
  const visible = query
    ? ordered.filter(
        skill =>
          getCommandName(skill).toLowerCase().includes(lowered) ||
          (skill.description ?? '').toLowerCase().includes(lowered) ||
          getSourceLabel(skill).toLowerCase().includes(lowered),
      )
    : ordered

  // Changes are saved together when the menu closes, like 2.1.311.
  const close = (): void => {
    const changed = skills.filter(
      skill => overrides[skill.name] !== initial[skill.name],
    )
    if (changed.length > 0) {
      // "on" is the default, so it removes the entry instead of storing it.
      updateSettingsForSource('localSettings', {
        skillOverrides: Object.fromEntries(
          changed.map(skill => {
            const value = overrides[skill.name]
            return [skill.name, value === 'on' ? undefined : value]
          }),
        ),
      })
    }
    onExit(
      changed.length > 0
        ? `Updated ${changed.length} skill ${plural(changed.length, 'override')}`
        : 'No changes',
      { display: 'system' },
    )
  }

  const cycle = (index: number): void => {
    const skill = visible[index]
    if (!skill || !isSkillOverridable(skill)) return
    setOverrides(prev => ({
      ...prev,
      [skill.name]: nextSkillOverride(prev[skill.name] ?? 'on'),
    }))
  }

  useInput((input, key) => {
    if (searching) {
      if (key.escape) {
        setQuery('')
        setSearching(false)
      } else if (key.downArrow || key.return) {
        setSearching(false)
      } else if (key.backspace || key.delete) {
        setQuery(q => q.slice(0, -1))
      } else if (input && !key.ctrl && !key.meta) {
        setQuery(q => q + input)
      }
      return
    }
    if (key.escape) {
      close()
    } else if (input === 't' && !key.ctrl && !key.meta && visible.length > 0) {
      setSortByTokens(sorted => !sorted)
    } else if (
      input &&
      input !== ' ' &&
      !key.ctrl &&
      !key.meta &&
      !key.return &&
      !key.tab
    ) {
      setSearching(true)
      setQuery(q => q + (input.startsWith('/') ? input.slice(1) : input))
    }
  })

  if (skills.length === 0) {
    return (
      <Dialog
        title="Skills"
        subtitle="No skills found"
        onCancel={() => onExit('Skills dialog dismissed', { display: 'system' })}
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

  const count = query
    ? `${visible.length}/${skills.length} ${plural(skills.length, 'skill')}`
    : `${skills.length} ${plural(skills.length, 'skill')}`
  const hints = searching
    ? 'type to filter · ↓/enter to select · esc to clear'
    : visible.length === 0
      ? '/ to search, Esc to close'
      : 'enter/space to cycle, / to search, t to sort, Esc to close'

  const rows: MenuListRow[] = visible.map(skill => {
    const override = overrides[skill.name] ?? 'on'
    return {
      kind: 'item',
      key: `${skill.name}-${skill.source}`,
      icon: override === 'off' ? figures.circle : figures.tick,
      iconColor: override === 'off' ? undefined : 'success',
      label: getCommandName(skill),
      meta: [
        OVERRIDE_WORD[override] ?? '',
        getSourceLabel(skill),
        `${formatSkillTokens(estimateSkillFrontmatterTokens(skill))} tok`,
      ],
    }
  })

  return (
    <Dialog
      title="Skills"
      subtitle={`${count}${sortByTokens ? ' · sorted by tokens' : ''} · ${hints}`}
      onCancel={close}
      isCancelActive={false}
      hideInputGuide
    >
      <SearchBox
        query={query}
        isFocused={searching}
        isTerminalFocused
        placeholder="Search skills…"
      />
      {visible.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No skills match &quot;{query}&quot;</Text>
        </Box>
      ) : (
        <MenuList
          key={`${query}-${sortByTokens ? 'tok' : 'name'}`}
          rows={rows}
          defaultFocusIndex={Math.min(focused, rows.length - 1)}
          onFocus={setFocused}
          onSelect={cycle}
          isDisabled={searching}
        />
      )}
      {skills.some(skill => skill.source === 'plugin') && (
        <Box marginTop={1}>
          <Text dimColor>Plugin skills are managed via /plugin</Text>
        </Box>
      )}
    </Dialog>
  )
}

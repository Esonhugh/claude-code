import figures from 'figures'
import * as React from 'react'
import { useState } from 'react'
import { Select } from '../../../components/CustomSelect/select.js'
import TextInput from '../../../components/TextInput.js'
import { useExitOnCtrlCDWithKeybindings } from '../../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { Box, Text } from '../../../ink.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { getSettingSourceDisplayNameLowercase } from '../../../utils/settings/constants.js'
import { getDefaultExternalAutoModeRules } from '../../../utils/permissions/yoloClassifier.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../../../utils/settings/settings.js'
import type { Option } from '../../ui/option.js'

export type AutoModeSection = 'allow' | 'soft_deny' | 'hard_deny' | 'environment'

// Titles and descriptions follow official 2.1.303's Auto mode tab.
export const AUTO_MODE_SECTIONS: readonly {
  key: AutoModeSection
  title: string
  description: string
}[] = [
  {
    key: 'allow',
    title: 'Soft allow',
    description: 'Actions the classifier lets run without blocking',
  },
  {
    key: 'soft_deny',
    title: 'Soft deny',
    description:
      'Actions the classifier blocks, unless a soft allow rule or your explicit direction applies',
  },
  {
    key: 'hard_deny',
    title: 'Hard deny',
    description:
      'Actions the classifier always blocks — soft allow rules cannot override',
  },
  {
    key: 'environment',
    title: 'Environment',
    description:
      'Facts about this machine or project the classifier should take into account',
  },
]

// Like the classifier itself, project and local settings cannot set auto mode
// rules: a repository could otherwise grant itself classifier allow rules.
const AUTO_MODE_RULE_SOURCES = [
  'userSettings',
  'flagSettings',
  'policySettings',
] as const

type AutoModeRuleSource = (typeof AUTO_MODE_RULE_SOURCES)[number] | 'builtin'

export type AutoModeRuleEntry = {
  section: AutoModeSection
  rule: string
  source: AutoModeRuleSource
}

const DEFAULTS_MARKER = '$defaults'

function readSection(
  source: (typeof AUTO_MODE_RULE_SOURCES)[number],
  section: AutoModeSection,
): string[] {
  const autoMode = (
    getSettingsForSource(source) as { autoMode?: Record<string, unknown> } | null
  )?.autoMode
  const list = autoMode?.[section]
  return Array.isArray(list)
    ? list.filter((rule): rule is string => typeof rule === 'string')
    : []
}

/**
 * Every rule the classifier applies, by section: configured rules first, then
 * the built-in rules while the section has none of its own or keeps
 * "$defaults" (the same resolution the classifier prompt uses).
 */
export function getAutoModeRuleEntries(): AutoModeRuleEntry[] {
  const defaults = getDefaultExternalAutoModeRules()
  const entries: AutoModeRuleEntry[] = []
  for (const { key } of AUTO_MODE_SECTIONS) {
    let configured = false
    let keepsDefaults = false
    for (const source of AUTO_MODE_RULE_SOURCES) {
      for (const rule of readSection(source, key)) {
        configured = true
        if (rule === DEFAULTS_MARKER) keepsDefaults = true
        else entries.push({ section: key, rule, source })
      }
    }
    if (!configured || keepsDefaults) {
      entries.push(
        ...defaults[key].map(rule => ({
          section: key,
          rule,
          source: 'builtin' as const,
        })),
      )
    }
  }
  return entries
}

/**
 * Saves a rule to the user settings. The first rule of a section that still
 * uses the built-ins keeps them with "$defaults", so adding a rule extends the
 * section instead of replacing it.
 */
export function addAutoModeRule(
  section: AutoModeSection,
  rule: string,
): { error: Error | null } {
  const current = readSection('userSettings', section)
  const configuredElsewhere = AUTO_MODE_RULE_SOURCES.some(
    source => source !== 'userSettings' && readSection(source, section).length > 0,
  )
  const next =
    current.length === 0 && !configuredElsewhere
      ? [DEFAULTS_MARKER, rule]
      : [...current, rule]
  return updateSettingsForSource('userSettings', {
    autoMode: { [section]: next },
  })
}

/** Removes a rule from the user settings; a section left with only "$defaults" is dropped. */
export function removeAutoModeRule(
  section: AutoModeSection,
  rule: string,
): { error: Error | null } {
  const current = readSection('userSettings', section)
  const index = current.indexOf(rule)
  if (index === -1) return { error: null }
  const next = current.filter((_, i) => i !== index)
  return updateSettingsForSource('userSettings', {
    autoMode: {
      [section]: next.every(entry => entry === DEFAULTS_MARKER) ? undefined : next,
    },
  })
}

function sectionTitle(section: AutoModeSection): string {
  return AUTO_MODE_SECTIONS.find(s => s.key === section)?.title ?? section
}

function sourceLabel(source: AutoModeRuleSource): string {
  return source === 'builtin'
    ? 'Built-in'
    : `From ${getSettingSourceDisplayNameLowercase(source)}`
}

export const ADD_AUTO_MODE_RULE_VALUE = 'add-auto-mode-rule'

export function getAutoModeRuleOptions(
  entries: readonly AutoModeRuleEntry[],
  query = '',
): Option[] {
  const options: Option[] = []
  if (!query) {
    options.push({
      label: `Add auto mode rule${figures.ellipsis}`,
      value: ADD_AUTO_MODE_RULE_VALUE,
    })
  }
  const lowerQuery = query.toLowerCase()
  entries.forEach((entry, index) => {
    if (query && !entry.rule.toLowerCase().includes(lowerQuery)) return
    const firstLine = entry.rule.split('\n')[0] ?? ''
    options.push({
      label:
        firstLine.length > 100 ? `${firstLine.slice(0, 99)}${figures.ellipsis}` : firstLine,
      value: String(index),
      description: `${sectionTitle(entry.section)} · ${sourceLabel(entry.source)}`,
    })
  })
  return options
}

export function AutoModeRuleDetails({
  entry,
  onDelete,
  onCancel,
}: {
  entry: AutoModeRuleEntry
  onDelete: () => void
  onCancel: () => void
}): React.ReactNode {
  const exitState = useExitOnCtrlCDWithKeybindings()
  useKeybinding('confirm:no', onCancel, { context: 'Confirmation' })
  const editable = entry.source === 'userSettings'
  const readOnlyReason =
    entry.source === 'policySettings'
      ? 'This rule is configured by managed settings and cannot be modified.'
      : entry.source === 'flagSettings'
        ? 'This rule comes from a read-only source (the --settings flag) and cannot be modified here.'
        : entry.source === 'builtin'
          ? 'Built-in rules apply while this section has no rules of its own or keeps "$defaults".'
          : undefined

  return (
    <>
      <Box
        flexDirection="column"
        gap={1}
        borderStyle="round"
        paddingLeft={1}
        paddingRight={1}
        borderColor={editable ? 'error' : 'permission'}
      >
        <Text bold color={editable ? 'error' : 'permission'}>
          {editable ? 'Delete auto mode rule?' : 'Rule details'}
        </Text>
        <Box flexDirection="column" marginX={2}>
          <Text bold>{entry.rule}</Text>
          <Text dimColor>
            {sectionTitle(entry.section)} {'·'} {sourceLabel(entry.source)}
          </Text>
        </Box>
        {editable ? (
          <>
            <Text>
              Are you sure you want to delete this rule? The classifier stops
              applying it on your next request.
            </Text>
            <Select
              onChange={value => (value === 'yes' ? onDelete() : onCancel())}
              onCancel={onCancel}
              options={[
                { label: 'Yes', value: 'yes' },
                { label: 'No', value: 'no' },
              ]}
            />
          </>
        ) : (
          <Text italic>{readOnlyReason}</Text>
        )}
      </Box>
      <Box marginLeft={3}>
        {exitState.pending ? (
          <Text dimColor>Press {exitState.keyName} again to exit</Text>
        ) : (
          <Text dimColor>Esc to cancel</Text>
        )}
      </Box>
    </>
  )
}

export function AddAutoModeRule({
  onSubmit,
  onCancel,
}: {
  onSubmit: (section: AutoModeSection, rule: string) => void
  onCancel: () => void
}): React.ReactNode {
  const [section, setSection] = useState<AutoModeSection | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const exitState = useExitOnCtrlCDWithKeybindings()
  const { columns } = useTerminalSize()
  // Settings context so 'n' can be typed into the rule.
  useKeybinding('confirm:no', onCancel, { context: 'Settings' })

  return (
    <>
      <Box
        flexDirection="column"
        gap={1}
        borderStyle="round"
        paddingLeft={1}
        paddingRight={1}
        borderColor="permission"
      >
        <Text bold color="permission">
          Add auto mode rule
        </Text>
        {section === null ? (
          <Box flexDirection="column">
            <Text>What kind of rule is this?</Text>
            <Select
              options={AUTO_MODE_SECTIONS.map(s => ({
                label: s.title,
                value: s.key,
                description: s.description,
              }))}
              onChange={value => setSection(value as AutoModeSection)}
              onCancel={onCancel}
            />
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text>
              {sectionTitle(section)}: write the rule as a plain sentence. A
              short label up front helps, e.g.,{' '}
              <Text bold>Deploys: never run kubectl apply against prod.</Text>
            </Text>
            <Text dimColor>New rules are saved to your user settings.</Text>
            <Box borderDimColor borderStyle="round" marginY={1} paddingLeft={1}>
              <TextInput
                showCursor
                value={inputValue}
                onChange={setInputValue}
                onSubmit={value => {
                  const rule = value.trim()
                  if (rule) onSubmit(section, rule)
                }}
                placeholder={`Enter rule${figures.ellipsis}`}
                columns={columns - 6}
                cursorOffset={cursorOffset}
                onChangeCursorOffset={setCursorOffset}
              />
            </Box>
          </Box>
        )}
      </Box>
      <Box marginLeft={3}>
        {exitState.pending ? (
          <Text dimColor>Press {exitState.keyName} again to exit</Text>
        ) : (
          <Text dimColor>
            {section === null ? 'Enter to select' : 'Enter to save'} {'·'} Esc
            to cancel
          </Text>
        )}
      </Box>
    </>
  )
}

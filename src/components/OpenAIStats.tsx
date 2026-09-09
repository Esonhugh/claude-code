import React, { useMemo, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import type { OpenAIActivityStats } from '../services/api/usage-types.js'
import {
  aggregateOpenAIActivity,
  formatOpenAITokens,
} from '../utils/openAIStats.js'
import { useTabHeaderFocus } from './design-system/Tabs.js'

export function OpenAIStatsTab({
  stats,
  loading,
  error,
}: {
  stats: OpenAIActivityStats | null
  loading: boolean
  error: boolean
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold>Codex activity</Text>
      <Text dimColor>
        Token activity, not remaining quota or all ChatGPT activity.
      </Text>
      {loading && <Text>Loading OpenAI activity…</Text>}
      {error && (
        <Text color="error">
          Failed to load OpenAI activity. Press r to retry.
        </Text>
      )}
      {!loading && !error && !stats && (
        <Text>No Codex activity available.</Text>
      )}
      {stats && (
        <Box flexDirection="column">
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Summary</Text>
            <Box flexWrap="wrap" columnGap={3}>
              <Text>
                Lifetime tokens: {formatOpenAITokens(stats.lifetime_tokens)}
              </Text>
              <Text>
                Peak daily tokens: {formatOpenAITokens(stats.peak_daily_tokens)}
              </Text>
            </Box>
            <Box flexWrap="wrap" columnGap={3}>
              <Text>Streak: {metric(stats.current_streak_days)} days</Text>
              <Text>
                Longest streak: {metric(stats.longest_streak_days)} days
              </Text>
            </Box>
            <Text>
              Longest turn: {duration(stats.longest_running_turn_sec)}
            </Text>
          </Box>
          <ActivityChart stats={stats} />
        </Box>
      )}
    </Box>
  )
}

function metric(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value.toLocaleString('en-US')
    : '—'
}

function duration(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0)
    return '—'
  const total = Math.floor(seconds)
  if (total < 60) return `${total}s`
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`
}

function ActivityChart({
  stats,
}: {
  stats: OpenAIActivityStats
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const { headerFocused, focusHeader } = useTabHeaderFocus()
  const [view, setView] = useState<'daily' | 'weekly' | 'cumulative'>('daily')
  const today = new Date().toLocaleDateString('en-CA')
  const activity = useMemo(
    () => aggregateOpenAIActivity(stats.daily_usage_buckets, today),
    [stats, today],
  )
  const todayIndex = activity.daily.findIndex(day => day.date === today)
  const [selected, setSelected] = useState(todayIndex)
  const selectedWeek = Math.floor(selected / 7)
  const width = Math.max(1, Math.min(52, Math.floor((columns - 12) / 2)))
  const start = Math.max(0, Math.min(52 - width, selectedWeek - width + 1))
  const values = activity[view]
  const max = Math.max(1, ...values.map(day => day.tokens))
  useInput(
    (input, key) => {
      if (key.ctrl || key.meta) return
      if (key.tab) {
        focusHeader()
        return
      }
      if (input === 'v') {
        setView(current =>
          current === 'daily'
            ? 'weekly'
            : current === 'weekly'
              ? 'cumulative'
              : 'daily',
        )
      }
      const step = key.leftArrow
        ? -7
        : key.rightArrow
          ? 7
          : key.upArrow
            ? -1
            : key.downArrow
              ? 1
              : 0
      if (step && !(view === 'cumulative' && Math.abs(step) === 1)) {
        setSelected(index => {
          const withinWeek = view === 'weekly' && Math.abs(step) === 1
          const lower = withinWeek ? Math.floor(index / 7) * 7 : 0
          const upper = withinWeek
            ? Math.min(todayIndex, lower + 6)
            : todayIndex
          return Math.max(lower, Math.min(upper, index + step))
        })
      }
    },
    { isActive: !headerFocused },
  )
  const point = values[view === 'daily' ? selected : selectedWeek]!
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box gap={2} flexWrap="wrap">
        {(['daily', 'weekly', 'cumulative'] as const).map(option => (
          <Text
            key={option}
            bold={view === option}
            color={view === option ? 'success' : undefined}
            underline={view === option}
          >
            {option[0]!.toUpperCase() + option.slice(1)}
          </Text>
        ))}
      </Box>
      <Text dimColor>
        {view === 'cumulative'
          ? 'Cumulative within the 52-week window, not lifetime'
          : view === 'weekly'
            ? 'Weekly (Sunday–Saturday)'
            : 'Daily: one cell per day; columns are Sunday–Saturday'}
      </Text>
      <Text dimColor>
        {activity.daily[0]!.date} – {today}
      </Text>
      {!activity.daily.some(day => day.tokens > 0) && (
        <Text>No token usage in this window.</Text>
      )}
      {Array.from({ length: 7 }, (_, row) => (
        <Box key={row}>
          <Text dimColor>
            {view === 'daily'
              ? ['Su ', 'Mo ', 'Tu ', 'We ', 'Th ', 'Fr ', 'Sa '][row]
              : '   '}
          </Text>
          {Array.from({ length: width }, (_, column) => {
            const week = start + column
            const index = view === 'daily' ? week * 7 + row : week
            const tokens = values[index]!.tokens
            const filled =
              view === 'daily'
                ? tokens > 0
                : Math.ceil((tokens / max) * 7) >= 7 - row
            const isSelected =
              view === 'daily' ? index === selected : week === selectedWeek
            return (
              <Text
                key={week}
                color={
                  filled
                    ? view === 'daily'
                      ? tokens / max > 0.66
                        ? '#39d353'
                        : tokens / max > 0.33
                          ? '#26a641'
                          : '#238636'
                      : 'success'
                    : undefined
                }
                dimColor={!filled && !isSelected}
                inverse={isSelected && !headerFocused}
              >
                {view === 'daily' && index > todayIndex
                  ? '  '
                  : filled
                    ? '■ '
                    : '· '}
              </Text>
            )
          })}
        </Box>
      ))}
      <Text dimColor>
        {view === 'daily'
          ? 'Intensity: low → medium → high · · = zero · blank = future · inverse = selected'
          : 'One column per week; height relative to the window maximum'}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Selected activity</Text>
        <Text>
          {view === 'daily'
            ? point.date
            : `Week ${point.date} – ${activity.daily[Math.min(selectedWeek * 7 + 6, todayIndex)]!.date}`}
          : {metric(point.tokens)} tokens ({formatOpenAITokens(point.tokens)})
          {view === 'cumulative' ? ' (window cumulative)' : ''}
        </Text>
        {view === 'weekly' && (
          <Text>
            Day {activity.daily[selected]!.date}:{' '}
            {metric(activity.daily[selected]!.tokens)} tokens
          </Text>
        )}
        {view === 'cumulative' && (
          <Text>
            Since {activity.daily[0]!.date} · Week increment:{' '}
            {metric(activity.weekly[selectedWeek]!.tokens)} tokens
          </Text>
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>K = thousand · M = million · B = billion</Text>
        <Text dimColor>
          Weeks {start + 1}–{start + width} of 52
        </Text>
        <Text dimColor>
          {headerFocused
            ? 'Tabs: ←/→ or Tab/Shift+Tab · ↓ enter chart'
            : view === 'daily'
              ? '↑/↓ ±1 day · ←/→ ±7 days · Tab/Shift+Tab focus tabs'
              : view === 'weekly'
                ? '←/→ select week · ↑/↓ day within week · Tab/Shift+Tab focus tabs'
                : '←/→ select week · Tab/Shift+Tab focus tabs'}
        </Text>
        {!headerFocused && (
          <Text dimColor>v: Daily → Weekly → Cumulative → Daily</Text>
        )}
      </Box>
    </Box>
  )
}

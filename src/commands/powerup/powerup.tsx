import figures from 'figures'
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { computeShimmerSegments } from '../../bridge/bridgeStatusUtil.js'
import { Byline } from '../../components/design-system/Byline.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { Pane } from '../../components/design-system/Pane.js'
import { ProgressBar } from '../../components/design-system/ProgressBar.js'
import { StatusIcon } from '../../components/design-system/StatusIcon.js'
import { Select } from '../../components/CustomSelect/select.js'
import {
  BLACK_CIRCLE,
  DIAMOND_FILLED,
  DIAMOND_OPEN,
} from '../../constants/figures.js'
import { useSettings } from '../../hooks/useSettings.js'
import { Box, Text } from '../../ink.js'
import { useAnimationFrame } from '../../ink/hooks/use-animation-frame.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { logEvent } from '../../services/analytics/index.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import type { Theme } from '../../utils/theme.js'
import { type Lesson, LESSONS } from './lessons.js'

const SHIMMER_FRAME_MS = 80
const CONFETTI_FRAME_MS = 60
const CONFETTI_FALL_MS = 1400
const CONFETTI_ROWS = 16
const CONFETTI_MARGIN = 60
const CONFETTI_WIDTH = 100
const CONFETTI_CHARS = [DIAMOND_FILLED, DIAMOND_OPEN, BLACK_CIRCLE, '·']
const CONFETTI_COLORS: (keyof Theme)[] = [
  'claude',
  'success',
  'warning',
  'suggestion',
  'autoAccept',
]

type Particle = {
  x: number
  delay: number
  speed: number
  char: string
  color: keyof Theme
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!
}

function makeParticles(count: number): Particle[] {
  return Array.from({ length: count }, () => ({
    x: Math.floor(Math.random() * CONFETTI_WIDTH),
    delay: Math.random() * 400,
    speed: 0.7 + Math.random() * 0.6,
    char: pick(CONFETTI_CHARS),
    color: pick(CONFETTI_COLORS),
  }))
}

function Confetti({ onDone }: { onDone: () => void }): React.ReactNode {
  const [particles] = useState(() => makeParticles(40))
  const reducedMotion = useSettings().prefersReducedMotion ?? false
  const [ref, time] = useAnimationFrame(reducedMotion ? null : CONFETTI_FRAME_MS)
  const [start] = useState(time)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  useEffect(() => {
    const timer = setTimeout(() => onDoneRef.current(), CONFETTI_FALL_MS + 600)
    return () => clearTimeout(timer)
  }, [])
  const elapsed = time - start
  const rows: Particle[][] = Array.from({ length: CONFETTI_ROWS }, () => [])
  for (const particle of particles) {
    const t = Math.max(0, elapsed - particle.delay)
    const row = Math.floor((t / CONFETTI_FALL_MS) * CONFETTI_ROWS * particle.speed)
    if (row >= 0 && row < CONFETTI_ROWS) rows[row]!.push(particle)
  }
  for (const row of rows) row.sort((a, b) => a.x - b.x)
  return (
    <Box
      ref={ref}
      position="absolute"
      marginLeft={CONFETTI_MARGIN}
      flexDirection="column"
      width={CONFETTI_WIDTH}
      height={CONFETTI_ROWS}
    >
      {rows.map((row, i) => {
        let col = 0
        return (
          <Box key={i} height={1}>
            {row.map((particle, j) => {
              const gap = Math.max(0, particle.x - col)
              col = Math.max(col, particle.x) + 1
              return (
                <Text key={j}>
                  {' '.repeat(gap)}
                  <Text color={particle.color}>{particle.char}</Text>
                </Text>
              )
            })}
          </Box>
        )
      })}
    </Box>
  )
}

function ShimmerTitle({ text }: { text: string }): React.ReactNode {
  const reducedMotion = useSettings().prefersReducedMotion ?? false
  const [ref, time] = useAnimationFrame(reducedMotion ? null : SHIMMER_FRAME_MS)
  const cycle = stringWidth(text) + 20
  const index = (Math.floor(time / SHIMMER_FRAME_MS) % cycle) - 10
  const { before, shimmer, after } = computeShimmerSegments(text, index)
  return (
    <Box ref={ref}>
      <Text bold color="claude">
        {before}
      </Text>
      <Text bold color="claudeShimmer">
        {shimmer}
      </Text>
      <Text bold color="claude">
        {after}
      </Text>
    </Box>
  )
}

function LessonView({
  lesson,
  isUnlocked,
  onDone,
  onBack,
}: {
  lesson: Lesson
  isUnlocked: boolean
  onDone: () => void
  onBack: () => void
}): React.ReactNode {
  useKeybindings(
    { 'confirm:yes': onDone, 'confirm:no': onBack },
    { context: 'Confirmation' },
  )
  return (
    <Pane color="claude">
      <Box flexDirection="column" gap={1}>
        <Box>
          <StatusIcon status={isUnlocked ? 'success' : 'pending'} withSpace />
          <Text bold color="claude">
            {lesson.title}
          </Text>
        </Box>
        {lesson.body}
        <Text dimColor italic>
          <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="mark done" />
            <KeyboardShortcutHint shortcut="Esc" action="back" />
          </Byline>
        </Text>
      </Box>
    </Pane>
  )
}

function readUnlocked(): Set<string> {
  const ids = getGlobalConfig().powerupsUnlocked ?? []
  return new Set(ids.filter(id => LESSONS.some(lesson => lesson.id === id)))
}

export function PowerupMenu({
  onExit,
}: {
  onExit: (message: string) => void
}): React.ReactNode {
  const [unlocked, setUnlocked] = useState(readUnlocked)
  const [openLesson, setOpenLesson] = useState<Lesson | null>(null)
  const [focusedId, setFocusedId] = useState(LESSONS[0]!.id)
  const [celebrating, setCelebrating] = useState(false)

  const open = (lesson: Lesson) => {
    setFocusedId(lesson.id)
    setOpenLesson(lesson)
    logEvent('tengu_powerup_lesson_opened', {
      was_already_unlocked: unlocked.has(lesson.id),
      unlocked_count: unlocked.size,
    })
  }

  const markDone = (id: string) => {
    if (unlocked.has(id)) return
    const next = new Set(unlocked).add(id)
    setUnlocked(next)
    saveGlobalConfig(current => ({ ...current, powerupsUnlocked: [...next] }))
    logEvent('tengu_powerup_lesson_completed', {
      unlocked_count: next.size,
      all_unlocked: next.size === LESSONS.length,
    })
    if (next.size === LESSONS.length) setCelebrating(true)
  }

  if (openLesson) {
    return (
      <LessonView
        lesson={openLesson}
        isUnlocked={unlocked.has(openLesson.id)}
        onDone={() => {
          markDone(openLesson.id)
          setOpenLesson(null)
        }}
        onBack={() => setOpenLesson(null)}
      />
    )
  }

  const allUnlocked = unlocked.size === LESSONS.length
  const options = LESSONS.map(lesson => {
    const done = unlocked.has(lesson.id)
    const label = `${done ? figures.tick : figures.circle} ${lesson.title}`
    return {
      label: done ? <Text color="success">{label}</Text> : label,
      value: lesson.id,
      description: lesson.tagline,
    }
  })

  return (
    <Pane color="claude">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          {allUnlocked ? (
            <ShimmerTitle text="All powered up" />
          ) : (
            <Text bold color="claude">
              Power-ups
            </Text>
          )}
          <Text dimColor>
            {' '}
            {unlocked.size}/{LESSONS.length} unlocked{' '}
          </Text>
          <ProgressBar
            ratio={unlocked.size / LESSONS.length}
            width={16}
            fillColor="claude"
            emptyColor="inactive"
          />
        </Box>
        <Box marginBottom={1}>
          <Text dimColor wrap="wrap">
            {allUnlocked
              ? 'Now go build something.'
              : 'Each power-up teaches one thing Claude Code can do that most people miss. Open one, read it, try it, mark it done.'}
          </Text>
        </Box>
        <Select
          options={options}
          hideIndexes
          visibleOptionCount={LESSONS.length}
          defaultFocusValue={focusedId}
          onChange={id => {
            const lesson = LESSONS.find(l => l.id === id)
            if (lesson) open(lesson)
          }}
          onCancel={() => onExit('Power-ups closed')}
        />
        <Box marginTop={1}>
          <Text dimColor italic>
            <Byline>
              <KeyboardShortcutHint shortcut="↑/↓" action="select" />
              <KeyboardShortcutHint shortcut="Enter" action="open" />
              <KeyboardShortcutHint shortcut="Esc" action="close" />
            </Byline>
          </Text>
        </Box>
        {celebrating && <Confetti onDone={() => setCelebrating(false)} />}
      </Box>
    </Pane>
  )
}

export const call: LocalJSXCommandCall = async onDone => (
  <PowerupMenu onExit={message => onDone(message, { display: 'system' })} />
)

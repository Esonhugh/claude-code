import * as React from 'react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { Box, Text } from '../../ink.js'
import { expandTabs } from '../../ink/tabstops.js'
import { env } from '../../utils/env.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

// Cache custom clawd art from ~/.claude/clawd.txt
let customClawdLines: string[] | null = null
let customClawdLoaded = false


export function getCustomClawd(): string[] | null {
  if (!customClawdLoaded) {
    customClawdLoaded = true
    try {
      const content = readFileSync(
        join(getClaudeConfigHomeDir(), 'clawd.txt'),
        'utf-8',
      )
      if (content.trim()) {
        const lines = content.split('\n')
        while (lines.at(-1) === '') lines.pop()
        customClawdLines = lines
      }
    } catch {
      // file doesn't exist or unreadable
      // customClawdLines =  _default.split("\n")
    }
  }
  return customClawdLines
}

export type ClawdPose =
  | 'default'
  | 'arms-up' // both arms raised (used during jump)
  | 'look-left' // both pupils shifted left
  | 'look-right' // both pupils shifted right

type Props = {
  pose?: ClawdPose
  maxWidth?: number
}

// Standard-terminal pose fragments. Each row is split into segments so we can
// vary only the parts that change (eyes, arms) while keeping the body/bg spans
// stable. All poses end up 9 cols wide.
//
// arms-up: the row-2 arm shapes (▝▜ / ▛▘) move to row 1 as their
// bottom-heavy mirrors (▗▟ / ▙▖) — same silhouette, one row higher.
//
// look-* use top-quadrant eye chars (▙/▟) so both eyes change from the
// default (▛/▜, bottom pupils) — otherwise only one eye would appear to move.
type Segments = {
  /** row 1 left (no bg): optional raised arm + side */
  r1L: string
  /** row 1 eyes (with bg): left-eye, forehead, right-eye */
  r1E: string
  /** row 1 right (no bg): side + optional raised arm */
  r1R: string
  /** row 2 left (no bg): arm + body curve */
  r2L: string
  /** row 2 right (no bg): body curve + arm */
  r2R: string
}

const POSES: Record<ClawdPose, Segments> = {
  default: { r1L: ' ▐', r1E: '▛███▜', r1R: '▌', r2L: '▝▜', r2R: '▛▘' },
  'look-left': { r1L: ' ▐', r1E: '▟███▟', r1R: '▌', r2L: '▝▜', r2R: '▛▘' },
  'look-right': { r1L: ' ▐', r1E: '▙███▙', r1R: '▌', r2L: '▝▜', r2R: '▛▘' },
  'arms-up': { r1L: '▗▟', r1E: '▛███▜', r1R: '▙▖', r2L: ' ▜', r2R: '▛ ' },
}

// Apple Terminal uses a bg-fill trick (see below), so only eye poses make
// sense. Arm poses fall back to default.
const APPLE_EYES: Record<ClawdPose, string> = {
  default: ' ▗   ▖ ',
  'look-left': ' ▘   ▘ ',
  'look-right': ' ▝   ▝ ',
  'arms-up': ' ▗   ▖ ',
}

export function Clawd({ pose = 'default', maxWidth }: Props = {}): React.ReactNode {
  const custom = getCustomClawd()
  if (custom) {
    return (
      <Box flexDirection="column" width={maxWidth}>
        {custom.map((line, i) => (
          <Text key={i} color="clawd_body" wrap="truncate-end">
            {expandTabs(line)}
          </Text>
        ))}
      </Box>
    )
  }
  if (env.terminal === 'Apple_Terminal') {
    return <AppleTerminalClawd pose={pose} maxWidth={maxWidth} />
  }
  const p = POSES[pose]
  return (
    <Box flexDirection="column" width={maxWidth}>
      <Text wrap="truncate-end">
        <Text color="clawd_body">{p.r1L}</Text>
        <Text color="clawd_body" backgroundColor="clawd_background">
          {p.r1E}
        </Text>
        <Text color="clawd_body">{p.r1R}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color="clawd_body">{p.r2L}</Text>
        <Text color="clawd_body" backgroundColor="clawd_background">
          █████
        </Text>
        <Text color="clawd_body">{p.r2R}</Text>
      </Text>
      <Text color="clawd_body" wrap="truncate-end">
        {'  '}▘▘ ▝▝{'  '}
      </Text>
    </Box>
  )
}

function AppleTerminalClawd({
  pose,
  maxWidth,
}: {
  pose: ClawdPose
  maxWidth?: number
}): React.ReactNode {
  // Apple's Terminal renders vertical space between chars by default.
  // It does NOT render vertical space between background colors
  // so we use background color to draw the main shape.
  return (
    <Box flexDirection="column" alignItems="center" width={maxWidth}>
      <Text wrap="truncate-end">
        <Text color="clawd_body">▗</Text>
        <Text color="clawd_background" backgroundColor="clawd_body">
          {APPLE_EYES[pose]}
        </Text>
        <Text color="clawd_body">▖</Text>
      </Text>
      <Text backgroundColor="clawd_body" wrap="truncate-end">
        {' '.repeat(7)}
      </Text>
      <Text color="clawd_body" wrap="truncate-end">▘▘ ▝▝</Text>
    </Box>
  )
}

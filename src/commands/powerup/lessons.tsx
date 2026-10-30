import * as React from 'react'
import { useState } from 'react'
import {
  DIAMOND_FILLED,
  EFFORT_MEDIUM,
  PAUSE_ICON,
} from '../../constants/figures.js'
import { useSettings } from '../../hooks/useSettings.js'
import { Box, Text } from '../../ink.js'
import { useAnimationFrame } from '../../ink/hooks/use-animation-frame.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import type { Theme } from '../../utils/theme.js'

// Lesson texts of official 2.1.311 /powerup, verbatim.

export type Lesson = {
  id: string
  title: string
  tagline: string
  body: React.ReactNode
}

const DEMO_FRAME_MS = 3000
const DEMO_WIDTH = 48
const DEMO_HEIGHT = 3

function Key({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <Text bold color="claude">
      {children}
    </Text>
  )
}

function Cmd({ children }: { children: React.ReactNode }): React.ReactNode {
  return <Text color="suggestion">{children}</Text>
}

function DemoBox({
  live,
  boxRef,
  children,
}: {
  live?: boolean
  boxRef?: (element: never) => void
  children: React.ReactNode
}): React.ReactNode {
  return (
    <Box
      ref={boxRef}
      borderStyle="round"
      borderColor="inactive"
      paddingX={1}
      width={DEMO_WIDTH}
      height={DEMO_HEIGHT + 2}
    >
      <Box flexDirection="column" width={DEMO_WIDTH - 4} height={DEMO_HEIGHT}>
        {children}
      </Box>
      <Box position="absolute" marginLeft={DEMO_WIDTH - 12}>
        <Text dimColor={!live} color={live ? 'claude' : undefined}>
          {live ? `${DIAMOND_FILLED} try it` : `  ${EFFORT_MEDIUM} demo`}
        </Text>
      </Box>
    </Box>
  )
}

type Segment = { text: string; color?: keyof Theme }

// A frame line starting with # is dim; [color:text] colors a span.
function parseLine(line: string): { dim: boolean; segments: Segment[] } {
  const dim = line.startsWith('#')
  const text = dim ? line.slice(1) : line
  const segments: Segment[] = []
  let last = 0
  for (const match of text.matchAll(/\[(\w+):([^\]]*)\]/g)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index) })
    segments.push({ text: match[2]!, color: match[1] as keyof Theme })
    last = match.index + match[0].length
  }
  if (last < text.length) segments.push({ text: text.slice(last) })
  if (segments.length === 0) segments.push({ text: '' })
  return { dim, segments }
}

function Demo({ frames }: { frames: string[] }): React.ReactNode {
  const reducedMotion = useSettings().prefersReducedMotion ?? false
  const [ref, time] = useAnimationFrame(reducedMotion ? null : DEMO_FRAME_MS)
  const frame = frames[Math.floor(time / DEMO_FRAME_MS) % frames.length]!
  return (
    <DemoBox boxRef={ref}>
      {frame.split('\n').map((line, i) => {
        const { dim, segments } = parseLine(line)
        return (
          <Text key={i} dimColor={dim}>
            {segments.map((segment, j) => (
              <Text key={j} color={segment.color}>
                {segment.text}
              </Text>
            ))}
          </Text>
        )
      })}
    </DemoBox>
  )
}

const MODES: { label: string; symbol: string; color: keyof Theme }[] = [
  { label: 'default', symbol: '', color: 'text' },
  { label: 'accept edits on', symbol: '⏵⏵', color: 'autoAccept' },
  { label: 'plan mode on', symbol: PAUSE_ICON, color: 'planMode' },
  { label: 'auto mode on', symbol: '⏵⏵', color: 'warning' },
]

function ModeCycler(): React.ReactNode {
  const [index, setIndex] = useState(0)
  const mode = MODES[index]!
  const shortcut = useShortcutDisplay(
    'confirm:cycleMode',
    'Confirmation',
    'shift+tab',
  )
  useKeybindings(
    { 'confirm:cycleMode': () => setIndex(i => (i + 1) % MODES.length) },
    { context: 'Confirmation' },
  )
  return (
    <DemoBox live>
      <Text>
        <Text dimColor>
          Press {shortcut} now
          {'\n\n'}
        </Text>
        <Text color={mode.color}>
          {mode.symbol ? `${mode.symbol} ` : '  '}
          {mode.label}
        </Text>
      </Text>
    </DemoBox>
  )
}

function ModesBody(): React.ReactNode {
  return (
    <Box flexDirection="column" gap={1}>
      <Text>
        Press <Key>shift+tab</Key> to cycle permission modes. Each mode changes
        how much Claude asks before acting:
      </Text>
      <ModeCycler />
      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          <Text color="success">default</Text> — ask before every edit
        </Text>
        <Text>
          <Text color="autoAccept">accept edits</Text> — edit freely, ask for
          commands
        </Text>
        <Text>
          <Text color="planMode">plan</Text> — research and propose, never
          touch files
        </Text>
        <Text>
          <Text color="warning">auto</Text> — Claude decides what is safe
        </Text>
      </Box>
      <Text dimColor>
        Use <Text color="planMode">plan</Text> for big refactors you want to
        review first. Use <Text color="warning">auto</Text> for long unattended
        tasks. Run <Cmd>/permissions</Cmd> to pre-allow specific commands so
        Claude stops asking about them.
      </Text>
    </Box>
  )
}

export const LESSONS: Lesson[] = [
  {
    id: 'at-mentions',
    title: 'Talk to your codebase',
    tagline: '@ files, line refs',
    body: (
      <Box flexDirection="column" gap={1}>
        <Text>
          Type <Key>@</Key> anywhere in your prompt to fuzzy-find and attach a
          file. Claude reads it before answering — no more pasting code.
        </Text>
        <Demo
          frames={[
            '> what does [suggestion:@]\n#type a file name…',
            '> what does [suggestion:@src/auth.ts]\n  [suggestion:❯ src/auth.ts]\n#   src/auth.test.ts',
            '> what does [suggestion:@src/auth.ts] do?\n#◐ Reading src/auth.ts…',
            '> what does [suggestion:@src/auth.ts] do?\nExports validateToken() which\nchecks JWT expiry and signature.',
          ]}
        />
        <Text>
          Reference specific lines with <Cmd>src/app.ts:42</Cmd> and Claude
          jumps straight there. Works in both directions: Claude cites files
          the same way, so you can click to open them in your editor.
        </Text>
        <Text dimColor>
          Also try: <Cmd>@folder/</Cmd> to attach a whole directory tree.
        </Text>
      </Box>
    ),
  },
  {
    id: 'modes',
    title: 'Steer with modes',
    tagline: 'shift+tab, plan, auto',
    body: <ModesBody />,
  },
  {
    id: 'undo',
    title: 'Undo anything',
    tagline: '/rewind, Esc-Esc',
    body: (
      <Box flexDirection="column" gap={1}>
        <Text>
          Claude checkpoints your files before every edit. Press{' '}
          <Key>Esc Esc</Key> (double-tap) to open <Cmd>/rewind</Cmd> and roll
          back to any prior state — code, conversation, or both.
        </Text>
        <Demo
          frames={[
            '[success:✓] Updated regex in parser.ts\n#[error:8 tests failing]',
            '#press Esc Esc\nRewind to:\n  [suggestion:❯ before parser.ts edit]',
            '#[success:✓] parser.ts restored\n> try a simpler approach\n#◐ thinking…',
          ]}
        />
        <Text>
          Went down the wrong path? Rewind to before the detour and try a
          different prompt. Your git history stays clean.
        </Text>
        <Text dimColor>
          Also: <Cmd>/clear</Cmd> wipes conversation but keeps files.{' '}
          <Cmd>/branch</Cmd> forks the conversation to try two approaches.
        </Text>
      </Box>
    ),
  },
  {
    id: 'background',
    title: 'Run in the background',
    tagline: 'tasks, /tasks',
    body: (
      <Box flexDirection="column" gap={1}>
        <Text>
          Long builds and test suites do not have to block you. Add{' '}
          <Key>&amp;</Key> to any bash command and it runs in the background —
          you keep chatting, Claude notifies you when it finishes.
        </Text>
        <Demo
          frames={[
            '> run the test suite [claude:&]\n#task started in background',
            '> now fix the lint in app.ts\n#◐ Editing app.ts…\n#[warning:◐] bun test · 12s',
            '> now fix the lint in app.ts\n[success:✓] Removed unused import\n#[warning:◐] bun test · 28s',
            '> now fix the lint in app.ts\n[success:✓] Removed unused import\n#[success:✓] bun test · 284 pass',
          ]}
        />
        <Text>
          Run <Cmd>/tasks</Cmd> to see everything in flight. Claude can read
          task output mid-run and react to failures automatically.
        </Text>
        <Text dimColor>
          Subagents also run as tasks — it is all one queue.
        </Text>
      </Box>
    ),
  },
  {
    id: 'memory',
    title: 'Teach Claude your rules',
    tagline: 'CLAUDE.md, /memory',
    body: (
      <Box flexDirection="column" gap={1}>
        <Text>
          Drop a <Cmd>CLAUDE.md</Cmd> file in your repo and Claude reads it at
          the start of every session. Put your conventions there: test
          commands, style rules, do-not-touch directories.
        </Text>
        <Demo
          frames={[
            '#─ CLAUDE.md ─\n#Run tests with: [suggestion:bun test]\n#Never edit src/legacy/',
            '> add tests for the cache\n#◐ reading CLAUDE.md…',
            '> add tests for the cache\nWriting cache.test.ts,\nrunning [suggestion:bun test] to verify.',
          ]}
        />
        <Text>
          Run <Cmd>/init</Cmd> to generate a starter CLAUDE.md from your
          codebase. Run <Cmd>/memory</Cmd> to edit it inline.
        </Text>
        <Text dimColor>
          Works at three levels: repo, your home directory (all projects), and
          per-directory overrides.
        </Text>
      </Box>
    ),
  },
  {
    id: 'mcp',
    title: 'Extend with tools',
    tagline: 'MCP, /mcp',
    body: (
      <Box flexDirection="column" gap={1}>
        <Text>
          MCP servers give Claude new tools: read your Slack, query your
          database, control your browser. Run <Cmd>/mcp</Cmd> to browse and
          connect servers.
        </Text>
        <Demo
          frames={[
            '> [suggestion:/mcp]\nConnected servers:\n  [success:✓] slack    [success:✓] github',
            '> anything urgent in #eng?\n#◐ [suggestion:slack] · reading channel…',
            'Boris posted about the merge\nfreeze. Also 3 PRs await\nyour review on github.',
          ]}
        />
        <Text>
          Once connected, tools appear automatically — ask Claude to "check my
          calendar" or "search our Notion" and it just works.
        </Text>
        <Text dimColor>
          From your shell:{' '}
          <Cmd>claude mcp add my-server -- npx some-mcp-pkg</Cmd> to wire one up
          without leaving the terminal.
        </Text>
      </Box>
    ),
  },
  {
    id: 'automate',
    title: 'Automate your workflow',
    tagline: 'skills, hooks',
    body: (
      <Box flexDirection="column" gap={1}>
        <Text>
          Save a prompt to <Cmd>.claude/skills/deploy/SKILL.md</Cmd> and it
          becomes <Cmd>/deploy</Cmd> — type it, Claude runs it. Run{' '}
          <Cmd>/skills</Cmd> to see what you have.
        </Text>
        <Demo
          frames={[
            '> [suggestion:/deploy] staging\n#◐ skill: deploy',
            '[success:✓] built\n[success:✓] tests pass\n#◐ pushing to staging…',
            '[success:✓] deployed\n#[suggestion:staging.app.com]\n#PostToolUse hook ran prettier',
          ]}
        />
        <Text>
          Hooks run your own scripts on events: before a tool call, after a
          response, on session start. Use them to enforce rules, log activity,
          or inject context. Run <Cmd>/hooks</Cmd> to see what fires when.
        </Text>
        <Text dimColor>
          Run <Cmd>/install-github-app</Cmd> to let Claude review PRs when
          tagged.
        </Text>
      </Box>
    ),
  },
  {
    id: 'subagents',
    title: 'Multiply yourself',
    tagline: 'subagents',
    body: (
      <Box flexDirection="column" gap={1}>
        <Text>
          Claude can spawn copies of itself to work in parallel. Ask it to "use
          subagents to search these 5 directories" and watch the fan-out.
        </Text>
        <Demo
          frames={[
            '> find any error handling bugs\n#◐ Spawning 3 agents…',
            '#[warning:◐] agent-1 · scanning api\n#[warning:◐] agent-2 · scanning utils\n#[warning:◐] agent-3 · scanning cli',
            '#[success:✓] agent-1 · found reject\n#[warning:◐] agent-2 · scanning utils\n#[success:✓] agent-3 · no issues',
            'Found 2 issues:\n  [suggestion:api/fetch.ts:42] unhandled\n  [suggestion:utils/retry.ts:18] swallowed',
          ]}
        />
        <Text dimColor>
          Subagents run in isolated context. For true parallel sessions on
          separate branches, launch with <Cmd>claude --worktree</Cmd>.
        </Text>
      </Box>
    ),
  },
  {
    id: 'cross-device',
    title: 'Code from anywhere',
    tagline: '/remote-control, /teleport',
    body: (
      <Box flexDirection="column" gap={1}>
        <Text>
          Run <Cmd>/remote-control</Cmd> to take this session with you and
          pick up right where you left off on any device. Open the Code tab in
          the Claude mobile app, or visit claude.ai/code in a browser. The
          session keeps running on this machine while your other devices act
          as a remote control.
        </Text>
        <Demo
          frames={[
            '> [suggestion:/remote-control]\n#◐ connecting…',
            '[success:✓] connected\nsee this session at\n[suggestion:claude.ai/code/abc123]',
            '#─ on your phone ─\n#abc123 · running tests\n[warning:◐] 142 of 284',
            '#─ on your phone ─\n#abc123 · [success:✓] all pass\n> ship it',
          ]}
        />
        <Text>
          Run <Cmd>/teleport</Cmd> to move a session between here and the cloud
          — send this one up to keep it going after you close the lid, or pull
          a cloud session into this terminal with full history.
        </Text>
        <Text dimColor>
          Kick off a long task, close your laptop, check progress from your
          phone.
        </Text>
      </Box>
    ),
  },
  {
    id: 'model-dial',
    title: 'Dial the model',
    tagline: '/model, /effort',
    body: (
      <Box flexDirection="column" gap={1}>
        <Text>
          Run <Cmd>/model</Cmd> to switch models. Fable for the hardest
          problems, Opus for complex work, Sonnet for most tasks, Haiku for
          quick questions. Each trades speed for depth.
        </Text>
        <Demo
          frames={[
            '> [suggestion:/effort] high\n#effort set to [claude:high]',
            '> why is the list page slow?\n#[claude:◐ thinking deeply…]',
            'Three hypotheses, ranked:\n 1. N+1 query in loader\n 2. missing index on users',
          ]}
        />
        <Text>
          <Cmd>/effort</Cmd> controls how long Claude thinks before answering.{' '}
          <Key>high</Key> for tricky bugs, <Key>low</Key> when you just need a
          quick edit.
        </Text>
        <Text dimColor>
          Also: <Cmd>/fast</Cmd> toggles fast mode — same model, faster output.
        </Text>
      </Box>
    ),
  },
]

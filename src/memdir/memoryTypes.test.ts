import { expect, test } from 'bun:test'
import { buildExtractAutoOnlyPrompt } from '../services/extractMemories/prompts.js'
import { buildMemoryLines } from './memdir.js'

test('excludes project instructions from auto-memory', () => {
  const prompt = buildMemoryLines('auto memory', '/tmp/memory/').join('\n')

  expect(prompt).toContain(
    'anything already documented in AGENTS.md or CLAUDE.md files',
  )
})

test('auto-memory prompts use the compact rules, not the long type taxonomy', () => {
  const system = buildMemoryLines('auto memory', '/tmp/memory/').join('\n')
  const extract = buildExtractAutoOnlyPrompt(2, '')

  for (const prompt of [system, extract]) {
    expect(prompt).not.toContain('<types>')
    expect(prompt).toContain('`feedback`: guidance the user has given')
    expect(prompt).toContain('add a one-line pointer in `MEMORY.md`')
  }
  expect(system.length).toBeLessThan(3500)
  expect(extract.length).toBeLessThan(3500)
})

test('skipIndex drops the MEMORY.md pointer rule', () => {
  const system = buildMemoryLines('auto memory', '/tmp/memory/', undefined, true).join('\n')
  expect(system).not.toContain('one-line pointer')
  expect(buildExtractAutoOnlyPrompt(2, '', true)).not.toContain('one-line pointer')
})

// Official 2.1.311 fa(): "# Memory", slug/metadata frontmatter, [[name]] links, inline index hook.
test('auto-memory system prompt matches official 2.1.311 layout', () => {
  const system = buildMemoryLines('Memory', '/tmp/memory/').join('\n')
  expect(system).toStartWith('# Memory\n\nYou have a persistent file-based memory at `/tmp/memory/`. This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence). Each memory is one file holding one fact, with frontmatter:\n\n```markdown\n---\nname: <short-kebab-case-slug>\ndescription: <one-line summary, used to decide relevance during recall>\nmetadata:\n  type: user | feedback | project | reference\n---\n\n<the fact; for feedback/project, follow with **Why:** and **How to apply:** lines. Link related memories with [[their-name]].>\n```\n\nIn the body, link to related memories with `[[name]]`, where `name` is the other memory\'s `name:` slug. Link liberally')
  expect(system).toContain('\n\nAfter writing the file, add a one-line pointer in `MEMORY.md` (`- [Title](file.md) — hook`). `MEMORY.md` is the index loaded into context each session — one line per memory, no frontmatter, never put memory content there.\n\nBefore saving, check for an existing file')
  expect(system).not.toContain('save it immediately')
  expect(system).not.toContain('Keep each memory file under')
  expect(system).toEndWith('verify it still exists before recommending it.')
  const skip = buildMemoryLines('Memory', '/tmp/memory/', undefined, true).join('\n')
  expect(skip).toContain('not an error. Keep each memory file under 4KB including frontmatter (recall shows only the first 4KB) and the description to one specific line; when a file outgrows that, split or summarize it rather than continuing it in a second file.')
})

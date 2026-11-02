import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import securityReview from './security-review.js'
import { runWithCwdOverride } from '../utils/cwd.js'

test('/security-review tells the user to cd into a git repository first, like 2.1.311', async () => {
  const command = securityReview
  if (command.type !== 'prompt') throw new Error('security-review is not a prompt command')
  const dir = mkdtempSync(join(tmpdir(), 'security-review-'))
  try {
    const blocks = await runWithCwdOverride(dir, () =>
      command.getPromptForCommand('', {} as never),
    )
    expect(blocks).toHaveLength(1)
    const text = (blocks[0] as { text: string }).text
    expect(text).toStartWith(
      `Tell the user: /security-review needs to run inside a git repository, but the current working directory (\`${dir}\`) is not one.`,
    )
    expect(text).toContain('`cd` into it first and then re-run /security-review.')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

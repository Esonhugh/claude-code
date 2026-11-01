import { expect, test } from 'bun:test'
import * as React from 'react'

const { renderToString } = await import('../../utils/staticRender.js')
const { UserLocalCommandOutputMessage } = await import(
  './UserLocalCommandOutputMessage.js'
)

test('stderr is plain text, so <placeholders> and backticks survive (2.1.311)', async () => {
  const stderr =
    "Shell command failed for pattern \"!`git log`\": Use '--' like this:\n'git <command> [<revision>...] -- [<file>...]'"
  const out = await renderToString(
    <UserLocalCommandOutputMessage
      content={`<local-command-stderr>${stderr}</local-command-stderr>`}
    />,
  )
  expect(out).toContain('!`git log`')
  expect(out).toContain("'git <command> [<revision>...] -- [<file>...]'")
})

test('a command with no output renders nothing, not "(no content)" (2.1.311 /clear)', async () => {
  for (const content of [
    '<local-command-stdout></local-command-stdout>',
    '<local-command-stdout>(no content)</local-command-stdout>',
  ]) {
    const out = await renderToString(<UserLocalCommandOutputMessage content={content} />)
    expect(out.trim()).toBe('')
  }
})

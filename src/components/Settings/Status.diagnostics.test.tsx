import { expect, test } from 'bun:test'
import figures from 'figures'
import React, { Suspense } from 'react'
import { renderToString } from '../../utils/staticRender.js'
import { Diagnostics } from './Status.js'

test('like official, a wrapped diagnostic keeps the space after the icon and a flush hanging indent', async () => {
  const message = `claude command at /tmp/${'a'.repeat(70)}/.local/bin/claude missing or broken`
  // A settled thenable lets use() read it in a single static render.
  const promise = Object.assign(Promise.resolve([message]), { status: 'fulfilled', value: [message] })
  const out = await renderToString(
    <Suspense fallback={null}>
      <Diagnostics promise={promise} />
    </Suspense>,
    60,
  )
  const lines = out.split('\n')
  const first = lines.findIndex(line => line.includes(figures.warning))
  expect(lines[first]).toContain(`${figures.warning} claude command at`)
  const indent = lines[first]!.indexOf(figures.warning) + 2
  for (const line of lines.slice(first + 1).filter(line => line.trim())) {
    expect(line.length - line.trimStart().length).toBe(indent)
  }
})

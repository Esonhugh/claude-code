import { expect, test } from 'bun:test'
import React from 'react'
import { Text } from '../../ink.js'
import { renderToString } from '../../utils/staticRender.js'
import { Byline } from './Byline.js'

test('an empty-string child adds no separator', async () => {
  const hint = ''
  const out = await renderToString(
    <Text>
      <Byline>
        <Text>Type to search</Text>
        <Text>Esc to cancel</Text>
        {hint && <Text>{hint}</Text>}
      </Byline>
    </Text>,
  )
  expect(out.trimEnd()).toBe('Type to search · Esc to cancel')
})

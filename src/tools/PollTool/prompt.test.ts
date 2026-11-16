import { expect, test } from 'bun:test'
import { PROMPT } from './prompt.js'

test('the Poll prompt keeps the official opening and the sentences on events queued for the end of the turn', () => {
  expect(PROMPT).toStartWith(
    'Receives events addressed to you, delivered by your harness (for example notifications from the surface hosting this session).\n\n',
  )
  expect(PROMPT).toContain(
    'with a line saying what is still running; if something is queued for the end of your turn, it ends by then with "(no pending events)" instead. "(no pending events)" means only that this call delivered no event. Something may still be queued that this tool never delivers, for example a scheduled prompt or a message held for the end of your turn: it reaches you only after you end your turn.\n\n',
  )
})

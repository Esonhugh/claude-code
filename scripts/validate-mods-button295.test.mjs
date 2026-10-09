import { expect, test } from 'bun:test'
import { buttonAcceptanceFailures } from './validate-mods-button295.mjs'

const complete = () => ({ mode: 'local', businessPassed: true,
  binarySHA256: 'pinned', binarySHA256After: 'pinned', launchedBinarySHA256: 'pinned', expectedBinarySHA256: 'pinned',
  captureId: 'one-run', socketExists: false,
  hoverObservations: [['focus-stop', false, 4, false], ['focus-other', false, 4], ['hover-enter', true, 4], ['hover-paint-leave', false, 5],
    ['hover-paint-enter', true, 6], ['hover-resize-leave', false, 6], ['hover-resize-enter', true, 6]].map(([label, inverse, count, otherInverse = true]) =>
      ({ label, count, captureId: 'one-run', col: inverse ? 20 : 8, row: 3, pointer: label.startsWith('focus-') ? null : { col: 22, row: 3 },
        cells: Array.from('[ Save 2m ]', text => ({ text, inverse })),
        otherCells: Array.from('[ Other control ]', text => ({ text, inverse: otherInverse })) })),
  childCompletion: { start: { childPid: 101, binarySha256: 'pinned' },
    launch: { captureId: 'one-run', binarySha256: 'pinned' },
    broker: { captureId: 'one-run', childPid: 101, childExitCode: 0, childReaped: true, physicalEof: true,
      signalsSent: [], cleanupErrors: [], failure: null, normalCompletion: true },
    cleanup: { captureId: 'one-run', childPid: 101, childExitCode: 0, childReaped: true, physicalEof: true,
      signalsSent: [], cleanupErrors: [], failure: null, normalCompletion: true } },
  cleanup: { verdict: 'passed', paneDead: true, tmuxKill: { status: 0 }, socketRemove: { status: 0 },
    terminalCapture: { binarySha256: 'pinned', captureId: 'one-run', boundedVerdict: 'passed', framePhysicalVerdict: 'passed',
      nativeResizeBracketsCovered: true, frameCount: 58, eofPassed: true, nativeContentMatched: true, nativeIOMatched: true } } })

test('completed button interactions cannot hide the original failed physical capture', () => {
  const result = complete()
  result.cleanup.terminalCapture = { ...result.cleanup.terminalCapture,
    boundedVerdict: 'failed', framePhysicalVerdict: 'failed', frameCount: 0,
    nativeResizeBracketsCovered: false, failure: 'Native resize lacks a unique successful original send/return and ACK' }
  expect(buttonAcceptanceFailures(result)).toContain('Local native frame/resize evidence did not pass')
  expect(buttonAcceptanceFailures(complete())).toEqual([])
})

test('another binary or capture cannot supply a passing physical result', () => {
  const result = complete()
  result.cleanup.terminalCapture.captureId = 'another-run'
  expect(buttonAcceptanceFailures(result)).toContain('Local native frame/resize evidence did not pass')
  result.binarySHA256After = 'changed'
  expect(buttonAcceptanceFailures(result)).toContain('Binary identity changed')
})

test('official comparison records business completion without claiming local logical frames', () => {
  const result = complete()
  result.mode = 'official'
  result.cleanup.terminalCapture = undefined
  expect(buttonAcceptanceFailures(result)).toEqual([])
  result.businessPassed = false
  expect(buttonAcceptanceFailures(result)).toContain('Button interaction did not complete')
  result.businessPassed = true; result.cleanup.paneDead = false
  expect(buttonAcceptanceFailures(result)).toContain('Owned terminal did not close normally')
})


test('business completion and a dead pane cannot hide nonzero child exit or broken reap/EOF', () => {
  for (const mode of ['local', 'official']) {
    for (const mutation of [
      {childExitCode: 1}, {childExitCode: null}, {childReaped: false}, {physicalEof: false},
      {childPid: 999}, {captureId: 'foreign'}, {signalsSent: ['SIGTERM']}, {cleanupErrors: ['failed reap']},
    ]) {
      const result = complete(); result.mode = mode
      result.childCompletion = {start: {childPid: 101, binarySha256: 'pinned'},
        launch: {captureId: 'one-run', binarySha256: 'pinned'},
        broker: {captureId: 'one-run', childPid: 101, childExitCode: 0, childReaped: true,
          physicalEof: true, signalsSent: [], cleanupErrors: [], failure: null, normalCompletion: true}}
      Object.assign(result.childCompletion.broker, mutation)
      result.childCompletion.cleanup = {...result.childCompletion.broker}
      expect(buttonAcceptanceFailures(result)).toContain('Original child completion did not pass')
    }
  }
})

test('official producer absence never excuses a child failure or unrelated collection error', () => {
  const result = complete(); result.mode = 'official'
  result.childCompletion.broker.normalCompletion = false
  result.childCompletion.broker.failure = { type: 'JournalError', message: 'Foreign or absent native producer' }
  result.childCompletion.cleanup = globalThis.structuredClone(result.childCompletion.broker)
  expect(buttonAcceptanceFailures(result)).toEqual([])
  result.childCompletion.broker.childExitCode = 1
  result.childCompletion.cleanup = globalThis.structuredClone(result.childCompletion.broker)
  expect(buttonAcceptanceFailures(result)).toContain('Original child completion did not pass')
  result.childCompletion.broker.childExitCode = 0
  result.childCompletion.broker.failure.message = 'Native capture overflow'
  result.childCompletion.cleanup = globalThis.structuredClone(result.childCompletion.broker)
  expect(buttonAcceptanceFailures(result)).toContain('Original child completion did not pass')
})


test('Button acceptance requires stationary hover entry, leave, return, and resize observations', () => {
  const result = complete()
  result.hoverObservations = []
  expect(buttonAcceptanceFailures(result)).toContain('Hover paint interaction did not complete')
})


test('hover observations reject stale style, foreign capture, wrong geometry, and missing rows', () => {
  for (const mode of ['local', 'official']) {
    for (const mutate of [
      result => { result.hoverObservations.find(value => value.label === 'hover-paint-leave').cells[2].inverse = true },
      result => { result.hoverObservations[3].captureId = 'foreign' },
      result => { result.hoverObservations[3].pointer.col = 99 },
      result => { result.hoverObservations[4].count = 7 },
      result => { result.hoverObservations[4].otherCells[0].inverse = false },
      result => { result.hoverObservations[1] = null },
      result => { result.hoverObservations.pop() },
    ]) {
      const result = complete(); result.mode = mode
      mutate(result)
      expect(buttonAcceptanceFailures(result)).toContain('Hover paint interaction did not complete')
    }
  }
})

test('Button acceptance requires mouse-preserved focus and the terminal stop slot', () => {
  const result = complete()
  result.hoverObservations.shift()
  expect(buttonAcceptanceFailures(result)).toContain('Hover paint interaction did not complete')
})

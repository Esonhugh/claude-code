import { expect, test } from 'bun:test'
import { validateDiffChildTestRun } from './testChildEvidence.js'

const roster = ['first scenario', 'second scenario']
const output = '(pass) first scenario [1.00ms]\n(pass) second scenario [12.34ms]\n\n 2 pass\n 0 fail\n 3 expect() calls\n'

test('child evidence requires the exact completed roster and zero-failure runner summary', () => {
  expect(validateDiffChildTestRun(0, '', output, roster)).toEqual({
    exitCode: 0, completedTests: roster, passed: 2, failed: 0,
  })
})

test('a successful exit with no tests or missing summary cannot pass', () => {
  expect(() => validateDiffChildTestRun(0, '', '', roster)).toThrow()
  expect(() => validateDiffChildTestRun(0, '', output.split('\n\n')[0]!, roster)).toThrow()
  expect(() => validateDiffChildTestRun(0, '', ' 0 pass\n 0 fail\n', [])).toThrow()
})

test('dropped, duplicated and foreign completed cases cannot pass', () => {
  for (const changed of [
    output.replace('(pass) second scenario [12.34ms]\n', ''),
    output.replace('second scenario', 'first scenario'),
    output.replace('second scenario', 'unrelated scenario'),
    output + '(pass) foreign scenario [1.00ms]\n',
  ]) expect(() => validateDiffChildTestRun(0, '', changed, roster)).toThrow()
})

test('a failed exit, skipped case or inconsistent summary cannot pass', () => {
  expect(() => validateDiffChildTestRun(1, '', output, roster)).toThrow()
  for (const changed of [
    output.replace('2 pass', '1 pass'),
    output.replace('0 fail', '1 fail'),
    output + '(skip) third scenario\n',
    output + ' 1 todo\n',
    output + ' 2 pass\n 0 fail\n',
  ]) expect(() => validateDiffChildTestRun(0, '', changed, roster)).toThrow()
})

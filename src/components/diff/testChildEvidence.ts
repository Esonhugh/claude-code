export function validateDiffChildTestRun(
  exitCode: number,
  stdout: string,
  stderr: string,
  expectedTests: readonly string[],
) {
  const output = stdout + '\n' + stderr
  const completedTests = [...output.matchAll(/^\(pass\) (.+?) \[[\d.]+ms\]\r?$/gm)]
    .map(match => match[1]!)
  const summaries = [...output.matchAll(/^\s*(\d+) pass\r?\n\s*(\d+) fail\r?$/gm)]
  const summary = summaries[0]
  if (exitCode !== 0 || expectedTests.length === 0 ||
      new Set(expectedTests).size !== expectedTests.length ||
      summaries.length !== 1 || !summary ||
      Number(summary[1]) !== expectedTests.length || Number(summary[2]) !== 0 ||
      /^(?:\((?:fail|skip|todo)\)|\s*\d+ (?:skip|todo))/m.test(output) ||
      completedTests.length !== expectedTests.length ||
      new Set(completedTests).size !== completedTests.length ||
      [...completedTests].sort().some((name, index) => name !== [...expectedTests].sort()[index])) {
    throw new Error(`Incomplete diff child test run: exit=${exitCode}, expected=${expectedTests.length}, completed=${completedTests.length}\n${output}`)
  }
  return { exitCode, completedTests, passed: completedTests.length, failed: 0 }
}

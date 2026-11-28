import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProjectGithub } from './projectGithub.js'

async function fixture(body: string, remote: string, check: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'project-github-'))
  const original = process.env.PATH
  try {
    await mkdir(join(root, '.git'))
    await mkdir(join(root, 'bin'))
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(root, '.git', 'config'), `[remote "origin"]\n url = ${remote}\n`)
    if (body) await writeFile(join(root, 'bin', 'gh'), '#!/bin/sh\n' + body, { mode: 0o700 })
    process.env.PATH = join(root, 'bin')
    await check(root)
  } finally {
    process.env.PATH = original
    await rm(root, { recursive: true, force: true })
  }
}

test('requests only bounded list fields from the selected GitHub origin', async () => {
  const issue = (number: number, state: string, stateReason?: string | null) => ({
    number, title: '<b>No HTML</b>', state, stateReason, url: `https://github.com/fake/demo/issues/${number}`,
  })
  const firstIssue = { ...issue(1, 'OPEN'), body: 'private' }
  const older = { ...issue(42, 'CLOSED', 'NOT_PLANNED'), repository: { nameWithOwner: 'Fake/Demo' } }
  const foreign = { ...firstIssue, url: 'https://github.com/elsewhere/demo/issues/1', repository: { nameWithOwner: 'elsewhere/demo' } }
  const pulls = ['OPEN', 'OPEN', 'CLOSED', 'MERGED'].map((state, i) => ({
    number: i + 2, title: `${state} mentions #1`, state, isDraft: i === 0, url: `https://github.com/fake/demo/pull/${i + 2}`,
    closingIssuesReferences: { nodes: i === 2 ? [foreign] : i === 3 ? [older, older, { ...firstIssue, repository: { nameWithOwner: 'fake/demo' } }] : [] },
  }))
  const graph = { data: { repository: { nameWithOwner: 'FAKE/Demo', pullRequests: { nodes: pulls } } } }
  await fixture(`
[ "$GH_HOST" = github.com ] && [ "$GH_PROMPT_DISABLED" = 1 ] && [ "$GH_DEBUG" = '' ] || exit 3
printf '%s\n' "$1" >> "\${0%/bin/gh}/calls"
if [ "$*" = 'issue list --repo github.com/fake/demo --state all --limit 12 --json number,title,state,url,stateReason' ]; then
  printf '%s' '${JSON.stringify([firstIssue, issue(8, 'CLOSED', 'COMPLETED'), issue(9, 'CLOSED', 'NOT_PLANNED'), issue(10, 'CLOSED'), issue(11, 'CLOSED', null), issue(12, 'CLOSED', 'FUTURE_REASON')])}'
elif [ "$1 $2 $3 $4 $5" = 'api graphql --hostname github.com -f' ] && [ "$#" -eq 14 ] &&
  [ "$7 $8 $9 \${10} \${11} \${12} \${13} \${14}" = '-f owner=fake -f repo=demo -F limit=12 -F refs=10' ]; then
  case "$6" in query=*'pullRequests(first: $limit'*'closingIssuesReferences(first: $refs'*'stateReason'*) ;; *) exit 4 ;; esac
  printf '%s' '${JSON.stringify(graph)}'
else
  exit 5
fi
`, 'git@github.com:fake/demo.git', async root => {
    const { body: _body, stateReason: _reason, ...safeIssue } = firstIssue
    const result = await readProjectGithub(root)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.issues[0]).toEqual({ ...safeIssue, state: 'open' })
    expect(result.issues.map(row => row.state)).toEqual(['open', 'completed', 'not_planned', 'closed', 'closed', 'closed'])
    expect(result.pulls.map(row => row.state)).toEqual(['draft', 'open', 'rejected', 'merged'])
    expect(result.pulls.map(row => row.closingIssues.map(issue => [issue.number, issue.state]))).toEqual([
      [], [], [], [[42, 'not_planned'], [1, 'open']],
    ])
    expect(await readProjectGithub(join(root, 'nested'))).toEqual({ status: 'unsupported' })
    expect((await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').sort()).toEqual(['api', 'issue'])
  })
})

test('rejects an issue stateReason with the wrong JSON type', async () => {
  const graph = { data: { repository: { nameWithOwner: 'fake/demo', pullRequests: { nodes: [] } } } }
  const issues = [{ number: 1, title: 'Issue', state: 'CLOSED', stateReason: false, url: 'https://github.com/fake/demo/issues/1' }]
  await fixture(`if [ "$1" = issue ]; then printf '%s' '${JSON.stringify(issues)}'; else printf '%s' '${JSON.stringify(graph)}'; fi`,
    'https://github.com/fake/demo', async root => {
      expect(await readProjectGithub(root)).toEqual({ status: 'error' })
    })
})

test('rejects an invalid URL within an otherwise valid closing reference', async () => {
  const graph = { data: { repository: { nameWithOwner: 'fake/demo', pullRequests: { nodes: [{
    number: 2, title: 'PR', state: 'MERGED', isDraft: false, url: 'https://github.com/fake/demo/pull/2',
    closingIssuesReferences: { nodes: [{ number: 1, title: 'Issue', state: 'OPEN', repository: { nameWithOwner: 'fake/demo' }, url: 'https://github.com/elsewhere/demo/issues/1' }] },
  }] } } } }
  await fixture(`if [ "$1" = issue ]; then printf '[]'; else printf '%s' '${JSON.stringify(graph)}'; fi`,
    'https://github.com/fake/demo', async root => {
      expect(await readProjectGithub(root)).toEqual({ status: 'error' })
    })
})

test('rejects unsupported origins and off-repo rows; errors never contain stderr', async () => {
  await fixture('', 'https://github.com@invalid.test/fake/demo', async root => {
    expect(await readProjectGithub(root)).toEqual({ status: 'unsupported' })
  })
  await fixture('', 'https://github.com/fake/demo', async root => {
    expect(await readProjectGithub(root)).toEqual({ status: 'gh_missing' })
  })
  await fixture(`printf '%s' '[{"number":1,"title":"other","state":"OPEN","isDraft":false,"url":"https://github.com/other/repo/pull/1"}]'`,
    'ssh://git@github.com/fake/demo', async root => {
      expect(await readProjectGithub(root)).toEqual({ status: 'error' })
    })
  await fixture("printf '%s' 'hidden-path' >&2; exit 1", 'https://github.com/fake/demo', async root => {
    expect(await readProjectGithub(root)).toEqual({ status: 'error' })
  })
})

test('rejects an oversized config even when the origin is at the start', async () => {
  await fixture("printf '%s' '[]'", 'https://github.com/fake/demo', async root => {
    await writeFile(join(root, '.git', 'config'), '[remote "origin"]\n url = https://github.com/fake/demo\n# ' + 'x'.repeat(256 * 1024))
    expect(await readProjectGithub(root)).toEqual({ status: 'unsupported' })
  })
})

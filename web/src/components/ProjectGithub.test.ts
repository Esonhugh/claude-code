import { expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { GithubIssue, GithubPull } from '../../../src/web/projectGithub'
import type { T } from './ui'

test('groups official references, keeps unmatched sides, and renders independent accessible ID statuses', async () => {
  ;(globalThis as { React?: unknown }).React ??= React
  const { GithubTable, githubRows, githubModProps, githubModRows } = await import('./ProjectGithub')
  const issue = (number: number, state: GithubIssue['state']): GithubIssue => ({ number, state, title: `Issue <${number}>`, url: `https://github.com/fake/demo/issues/${number}` })
  const pull = (number: number, state: GithubPull['state'], closingIssues: GithubIssue[]): GithubPull => ({ number, state, title: `PR ${number}`, url: `https://github.com/fake/demo/pull/${number}`, closingIssues })
  const a = issue(1, 'open')
  const b = issue(2, 'closed')
  const older = issue(3, 'completed')
  const x = pull(4, 'merged', [a, older])
  const y = pull(5, 'rejected', [a])
  const z = pull(6, 'draft', [])
  const rows = githubRows([a, b], [x, y, z])
  expect(rows.map(row => [row.issue?.number, row.pulls.map(pr => pr.number), row.title])).toEqual([
    [1, [4, 5], 'Issue <1>'], [2, [], 'Issue <2>'], [3, [4], 'Issue <3>'], [undefined, [6], 'PR 6'],
  ])
  const cell = (urls: string[]) => ({ type: 'Box', children: urls.map(href => ({ type: 'Link', props: { href } })) })
  const modTree = { type: 'Box', children: rows.map(row => ({
    type: 'Box', children: [cell(row.issue ? [row.issue.url] : []), cell(row.pulls.map(pr => pr.url)), { type: 'Text', children: [row.title] }],
  })) }
  expect(githubModRows(modTree, rows)).toEqual(rows)
  modTree.children[0]!.children[1] = cell([z.url])
  expect(githubModRows(modTree, rows)).toBeUndefined()

  const t: T = (key, vars) => vars ? `${vars.kind} ${vars.number}: ${vars.state}` : key
  const sections = githubModProps({ status: 'ok', issues: [a, b], pulls: [x, y, z] }, rows, t)
  // The old renderer iterates the two sections and reads row labels directly.
  expect(sections.map(({ title, empty, rows }) => [title, empty, rows.map(({ number, state, label }) => [number, state, label])])).toEqual([
    ['githubIssueID', 'githubEmpty', [[1, 'open', 'github_open'], [2, 'closed', 'github_closed']]],
    ['githubPullID', 'githubEmpty', [[4, 'merged', 'github_merged'], [5, 'closed', 'github_rejected'], [6, 'draft', 'github_draft']]],
  ])
  expect(sections[0]?.tableRows?.[2]).toEqual({ issue: older.url, pulls: [x.url], title: older.title })
  const legacyTree = { type: 'Box', children: sections.map(({ title, rows }) => ({
    type: 'Box', children: [{ type: 'Text', children: [title] }, ...rows.map(({ url }) => ({ type: 'Link', props: { href: url } }))],
  })) }
  expect(githubModRows(legacyTree, rows)).toBeUndefined()
  const html = renderToStaticMarkup(React.createElement(GithubTable, { rows, t }))
  expect(html.match(/<table\b/g)).toHaveLength(1)
  expect(html.match(/<th scope="col">[^<]+<\/th>/g)).toEqual([
    '<th scope="col">githubIssueID</th>', '<th scope="col">githubPullID</th>', '<th scope="col">githubTitle</th>',
  ])
  expect(html.match(/href="https:\/\/github.com\/fake\/demo\/pull\/4"/g)).toHaveLength(2)
  expect(html).toContain('Issue &lt;1&gt;')
  expect(html).not.toContain('PR 4')
  expect(html.match(/>—</g)).toHaveLength(2)
  for (const [role, number, label, shape] of [
    ['githubIssueID', 1, 'open', 'open'], ['githubIssueID', 2, 'closed', 'closed'], ['githubIssueID', 3, 'completed', 'accepted'],
    ['githubPullID', 4, 'merged', 'accepted'], ['githubPullID', 5, 'rejected', 'rejected'], ['githubPullID', 6, 'draft', 'draft'],
  ] as const) {
    expect(html).toContain(`aria-label="${role} #${number}: github_${label}"`)
    expect(html).toContain(`title="${role} #${number}: github_${label}"`)
    expect(html).toContain(`data-state="${shape}"`)
  }
})

import { order } from './semver.js'

export const REQUIRED_RELEASE_SECTIONS = [
  '版本状态',
  '关联提交',
  '变更内容',
  '测试覆盖',
] as const

const BASE_HEADING = '2.1.88 base'
const VERSIONED_HEADING =
  /^(\d{4}-\d{2}-\d{2}) - v(\d+\.\d+\.\d+) - (.+)$/
const UNVERSIONED_HEADING = /^(\d{4}-\d{2}-\d{2}) - (.+)$/
const VERSION_TOKEN = /\bv?\d+\.\d+\.\d+\b/

type ChangelogEntry = {
  heading: string
  line: number
  body: string[]
}

export type ChangelogRelease = {
  date: string
  version: string
  title: string
  line: number
  notes: string[]
}

export type ChangelogValidationResult = {
  errors: string[]
  releases: ChangelogRelease[]
}

function getEntries(content: string): ChangelogEntry[] {
  const lines = content.replaceAll('\r\n', '\n').split('\n')
  const headingIndexes: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.startsWith('## ')) {
      headingIndexes.push(index)
    }
  }

  return headingIndexes.map((headingIndex, index) => ({
    heading: lines[headingIndex]?.slice(3).trim() ?? '',
    line: headingIndex + 1,
    body: lines.slice(headingIndex + 1, headingIndexes[index + 1] ?? lines.length),
  }))
}

function isValidDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function getThirdLevelSections(body: string[]): Array<{
  title: string
  lineOffset: number
  body: string[]
}> {
  const indexes: number[] = []
  for (let index = 0; index < body.length; index += 1) {
    if (body[index]?.startsWith('### ')) {
      indexes.push(index)
    }
  }

  return indexes.map((sectionIndex, index) => ({
    title: body[sectionIndex]?.slice(4).trim() ?? '',
    lineOffset: sectionIndex,
    body: body.slice(sectionIndex + 1, indexes[index + 1] ?? body.length),
  }))
}

function getReleaseNotes(body: string[]): string[] {
  const sections = getThirdLevelSections(body)
  const changes = sections.find(section => section.title === '变更内容')
  if (!changes) return []
  return changes.body
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim())
    .filter(Boolean)
}

export function parseChangelog(content: string): Record<string, string[]> {
  const releaseNotes: Record<string, string[]> = {}
  for (const entry of getEntries(content)) {
    const match = entry.heading.match(VERSIONED_HEADING)
    if (!match) continue
    const version = match[2]
    if (!version) continue
    const notes = getReleaseNotes(entry.body)
    if (notes.length > 0 && releaseNotes[version] === undefined) {
      releaseNotes[version] = notes
    }
  }
  return releaseNotes
}

export function validateChangelog(
  content: string,
  expectedVersion?: string,
): ChangelogValidationResult {
  const errors: string[] = []
  const entries = getEntries(content)
  const releases: ChangelogRelease[] = []
  const versions = new Set<string>()
  let previousDate: string | undefined
  let baseCount = 0

  if (!content.startsWith('# 变更日志\n')) {
    errors.push('line 1: changelog must start with "# 变更日志"')
  }
  if (entries.length === 0) {
    errors.push('changelog must contain at least one second-level entry')
  }

  for (const [entryIndex, entry] of entries.entries()) {
    if (entry.heading === BASE_HEADING) {
      baseCount += 1
      if (entryIndex !== entries.length - 1) {
        errors.push(`line ${entry.line}: base entry must be the final entry`)
      }
      continue
    }

    const versionedMatch = entry.heading.match(VERSIONED_HEADING)
    const unversionedMatch = entry.heading.match(UNVERSIONED_HEADING)
    if (!versionedMatch && !unversionedMatch) {
      errors.push(`line ${entry.line}: invalid entry heading "${entry.heading}"`)
      continue
    }

    const date = (versionedMatch ?? unversionedMatch)?.[1]
    if (!date || !isValidDate(date)) {
      errors.push(`line ${entry.line}: invalid calendar date "${date ?? ''}"`)
    } else if (previousDate && date > previousDate) {
      errors.push(`line ${entry.line}: entries must be ordered newest date first`)
    } else {
      previousDate = date
    }

    if (!versionedMatch) {
      const title = unversionedMatch?.[2] ?? ''
      if (VERSION_TOKEN.test(title)) {
        errors.push(
          `line ${entry.line}: unversioned entry title must not contain a semantic version`,
        )
      }
      continue
    }

    const version = versionedMatch[2] ?? ''
    const title = versionedMatch[3]?.trim() ?? ''
    if (!title) {
      errors.push(`line ${entry.line}: release title must not be empty`)
    }
    if (versions.has(version)) {
      errors.push(`line ${entry.line}: duplicate release version v${version}`)
    }
    versions.add(version)

    const previousRelease = releases.at(-1)
    if (previousRelease && order(previousRelease.version, version) <= 0) {
      errors.push(
        `line ${entry.line}: release versions must be strictly descending`,
      )
    }

    const sections = getThirdLevelSections(entry.body)
    const sectionTitles = sections.map(section => section.title)
    if (
      sectionTitles.length !== REQUIRED_RELEASE_SECTIONS.length ||
      sectionTitles.some(
        (titleValue, index) => titleValue !== REQUIRED_RELEASE_SECTIONS[index],
      )
    ) {
      errors.push(
        `line ${entry.line}: release sections must be exactly ${REQUIRED_RELEASE_SECTIONS.map(section => `"${section}"`).join(', ')}`,
      )
    }

    for (const section of sections) {
      if (
        !section.body.some(
          line => line.startsWith('- ') && line.slice(2).trim().length > 0,
        )
      ) {
        errors.push(
          `line ${entry.line + section.lineOffset + 1}: section "${section.title}" must contain a non-empty top-level bullet`,
        )
      }
    }

    const changes = sections.find(section => section.title === '变更内容')
    if (changes) {
      for (const [lineOffset, line] of changes.body.entries()) {
        if (/[。；;.]\s*- /.test(line)) {
          errors.push(
            `line ${entry.line + changes.lineOffset + lineOffset + 2}: release note bullets must use separate lines`,
          )
        }
        if (
          line.trim() &&
          !line.startsWith('- ') &&
          !line.startsWith('#### ')
        ) {
          errors.push(
            `line ${entry.line + changes.lineOffset + lineOffset + 2}: change content must use top-level bullets or fourth-level group headings`,
          )
        }
      }
    }

    releases.push({
      date: date ?? '',
      version,
      title,
      line: entry.line,
      notes: getReleaseNotes(entry.body),
    })
  }

  if (baseCount !== 1) {
    errors.push(`changelog must contain exactly one "## ${BASE_HEADING}" entry`)
  }

  const normalizedExpectedVersion = expectedVersion?.replace(/^v/, '')
  if (
    normalizedExpectedVersion &&
    releases[0]?.version !== normalizedExpectedVersion
  ) {
    errors.push(
      `latest release version must be v${normalizedExpectedVersion}, got ${releases[0] ? `v${releases[0].version}` : 'none'}`,
    )
  }

  return { errors, releases }
}

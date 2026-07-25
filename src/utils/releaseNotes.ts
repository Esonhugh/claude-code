import { coerce } from 'semver'
import bundledChangelog from '../../CHANGELOG.md' with { type: 'text' }
import { parseChangelog as parseChangelogContent } from './changelog.js'
import { toError } from './errors.js'
import { logError } from './log.js'
import { gt, order } from './semver.js'
import { isAnt } from 'src/utils/userType.js'

const MAX_RELEASE_NOTES_SHOWN = 5
let parsedBundledChangelog: Record<string, string[]> | undefined

/**
 * Parses a changelog string in markdown format into a structured format
 * @param content - The changelog content string
 * @returns Record mapping version numbers to arrays of release notes
 */
export function parseChangelog(content: string): Record<string, string[]> {
  try {
    return parseChangelogContent(content)
  } catch (error) {
    logError(toError(error))
    return {}
  }
}

/**
 * Gets release notes to show based on the previously seen version.
 * Shows up to MAX_RELEASE_NOTES_SHOWN items total, prioritizing the most recent versions.
 *
 * @param currentVersion - The current app version
 * @param previousVersion - The last version where release notes were seen (or null if first time)
 * @returns Array of release notes to display
 */
function getParsedChangelog(changelogContent?: string): Record<string, string[]> {
  if (changelogContent !== undefined) {
    return parseChangelog(changelogContent)
  }
  parsedBundledChangelog ??= parseChangelog(bundledChangelog)
  return parsedBundledChangelog
}

export function getRecentReleaseNotes(
  currentVersion: string,
  previousVersion: string | null | undefined,
  changelogContent?: string,
): string[] {
  try {
    const baseCurrentVersion = coerce(currentVersion)
    const basePreviousVersion = previousVersion ? coerce(previousVersion) : null
    if (
      basePreviousVersion &&
      (!baseCurrentVersion || !gt(baseCurrentVersion.version, basePreviousVersion.version))
    ) {
      return []
    }

    return Object.entries(getParsedChangelog(changelogContent))
      .filter(
        ([version]) =>
          (!basePreviousVersion || gt(version, basePreviousVersion.version)) &&
          (!baseCurrentVersion || !gt(version, baseCurrentVersion.version)),
      )
      .sort(([versionA], [versionB]) => order(versionB, versionA))
      .flatMap(([_, notes]) => notes)
      .filter(Boolean)
      .slice(0, MAX_RELEASE_NOTES_SHOWN)
  } catch (error) {
    logError(toError(error))
    return []
  }
}

/**
 * Gets all release notes as an array of [version, notes] arrays.
 * Versions are sorted with oldest first.
 *
 * @returns Array of [version, notes[]] arrays
 */
export function getAllReleaseNotes(
  changelogContent?: string,
): Array<[string, string[]]> {
  try {
    const releaseNotes = getParsedChangelog(changelogContent)
    const sortedVersions = Object.keys(releaseNotes).sort(order)

    // Return array of [version, notes] arrays
    return sortedVersions
      .map(version => {
        const versionNotes = releaseNotes[version]
        if (!versionNotes || versionNotes.length === 0) return null

        const notes = versionNotes.filter(Boolean)
        if (notes.length === 0) return null

        return [version, notes] as [string, string[]]
      })
      .filter((item): item is [string, string[]] => item !== null)
  } catch (error) {
    logError(toError(error))
    return []
  }
}

/**
 * Checks if the bundled changelog has release notes newer than the last seen version.
 * Can be used by multiple components to determine whether to display release notes.
 *
 * @param lastSeenVersion The last version of release notes the user has seen
 * @param currentVersion The current application version, defaults to MACRO.VERSION
 * @returns An object with hasReleaseNotes and the releaseNotes content
 */
export async function checkForReleaseNotes(
  lastSeenVersion: string | null | undefined,
  currentVersion: string = MACRO.VERSION,
): Promise<{ hasReleaseNotes: boolean; releaseNotes: string[] }> {
  return checkForReleaseNotesSync(lastSeenVersion, currentVersion)
}

/**
 * Synchronous variant of checkForReleaseNotes for React render paths.
 */
export function checkForReleaseNotesSync(
  lastSeenVersion: string | null | undefined,
  currentVersion: string = MACRO.VERSION,
): { hasReleaseNotes: boolean; releaseNotes: string[] } {
  // For Ant builds, use VERSION_CHANGELOG bundled at build time
  if (isAnt()) {
    const changelog = MACRO.VERSION_CHANGELOG
    if (changelog) {
      const commits = changelog.trim().split('\n').filter(Boolean)
      return {
        hasReleaseNotes: commits.length > 0,
        releaseNotes: commits,
      }
    }
    return {
      hasReleaseNotes: false,
      releaseNotes: [],
    }
  }

  const releaseNotes = getRecentReleaseNotes(currentVersion, lastSeenVersion)
  return {
    hasReleaseNotes: releaseNotes.length > 0,
    releaseNotes,
  }
}

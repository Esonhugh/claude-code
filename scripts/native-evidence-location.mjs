import { join, dirname, relative, resolve, isAbsolute } from 'node:path'
import { realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readOwnedNativeFile } from './native-evidence-files.mjs'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const locations = new WeakSet()

/** One checked original-to-archive mapping; never use the old cache as fallback. */
export function nativeEvidenceLocation(run, receiptPath) {
  run = realpathSync(run)
  let originalRun = run, manifest, prefix
  if (receiptPath !== undefined) {
    receiptPath = resolve(receiptPath)
    const receipt = JSON.parse(readOwnedNativeFile(receiptPath)),
      launch = JSON.parse(readOwnedNativeFile(join(run, 'capture-launch.json')))
    originalRun = launch.run
    if (typeof receipt.source !== 'string' || typeof receipt.archive !== 'string' ||
        typeof originalRun !== 'string' || ![receipt.source, receipt.archive, originalRun].every(path =>
          isAbsolute(path) && resolve(path) === path))
      throw Error('Native archive mapping has noncanonical paths')
    prefix = relative(receipt.source, originalRun)
    if (!/^runs\/r-[0-9a-f]{12}$/.test(prefix) ||
        receiptPath !== join(dirname(receipt.archive), 'builtin-cache-archive.json') ||
        receipt.archive !== realpathSync(join(dirname(receiptPath), 'acceptance-cache')) ||
        run !== join(receipt.archive, prefix) ||
        ['archiveComplete', 'sourceFilesStable', 'archiveFilesMatch'].some(key => receipt[key] !== true))
      throw Error('Native archive run is not bound to its original receipt')
    manifest = receipt.sourceManifest
  }
  const read = (name, mode) => {
    if (typeof name !== 'string' || isAbsolute(name) || relative('.', name) !== name || name.split('/').includes('..'))
      throw Error('Native evidence relative path is invalid')
    const bytes = readOwnedNativeFile(join(run, name), mode)
    if (manifest) {
      const held = manifest[join(prefix, name)]
      if (held?.type !== 'file' || held.sha256 !== hash(bytes))
        throw Error('Native archived original differs from held source digest: ' + name)
    }
    return bytes
  }
  if (manifest) read('capture-launch.json')
  const location = Object.freeze({ run, originalRun, receiptPath, read })
  locations.add(location)
  return location
}
export function checkNativeEvidenceLocation(location, run) {
  if (!locations.has(location) || location.run !== realpathSync(run))
    throw Error('Native evidence location was not independently verified')
  return location
}

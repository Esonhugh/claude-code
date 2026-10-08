import { constants, openSync, closeSync, lstatSync, fstatSync, readFileSync } from 'node:fs'

/** Closed originals only: reject special files before open and after any replacement. */
export function readOwnedNativeFile(path, mode) {
  const named = lstatSync(path)
  if (!named.isFile() || named.uid !== process.getuid() || named.nlink !== 1 ||
      (mode !== undefined && (named.mode & 0o777) !== mode))
    throw Error('Native original is not an owned regular file: ' + path)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.uid !== named.uid || opened.nlink !== 1 ||
        opened.dev !== named.dev || opened.ino !== named.ino ||
        (mode !== undefined && (opened.mode & 0o777) !== mode))
      throw Error('Native original file identity changed: ' + path)
    const bytes = readFileSync(fd), after = lstatSync(path), final = fstatSync(fd)
    if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino ||
        after.nlink !== 1 || final.nlink !== 1 || after.uid !== opened.uid || final.uid !== opened.uid || final.size !== bytes.length || opened.size !== bytes.length ||
        (mode !== undefined && ((after.mode & 0o777) !== mode || (final.mode & 0o777) !== mode)))
      throw Error('Native original changed during read: ' + path)
    return bytes
  } finally { closeSync(fd) }
}

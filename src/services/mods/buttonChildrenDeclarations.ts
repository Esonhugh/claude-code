import deltaText from '../../../assets/mods-button-2.1.295.json.txt' with {type: 'text'}
import {createHash} from 'node:crypto'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const baselineSHA256 = 'ec9fb8b86b52427c134e267749aa04ca84e419735e75810f5d2e5fa23f657ab3'
const deltaSHA256 = '528493b3222e0be73a7a8bac76a5cb89c079bf118524d41863bb0e7f47d2c4b0'
export const buttonChildrenDeclarationNote = '// Declaration baseline: official 2.1.292; implemented Button children from 2.1.295.\n'

/** Apply only the two verified Button blocks; all other public contracts stay byte-identical. */
export function withButtonChildrenDeclarations(source: string): string {
  if (sha(source) !== baselineSHA256 || sha(deltaText) !== deltaSHA256)
    throw new Error('Mods Button declaration source identity changed')
  const delta = JSON.parse(deltaText) as {blocks: {before: string; after: string; beforeSHA256: string; afterSHA256: string}[]}
  let output = source
  for (const block of delta.blocks) {
    const start = output.indexOf(block.before)
    if (start < 0 || output.indexOf(block.before, start + 1) !== -1 ||
        sha(block.before) !== block.beforeSHA256 || sha(block.after) !== block.afterSHA256)
      throw new Error('Mods Button declaration block identity changed')
    output = output.slice(0, start) + block.after + output.slice(start + block.before.length)
  }
  return output
}

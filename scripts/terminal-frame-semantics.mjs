export function screenLines(frame) {
  const cells = new Map(
    frame.cells.map(([x, y, char, width]) => [`${x}:${y}`, { char, width }]),
  )
  const lines = []
  for (let y = 0; y < frame.rows; y++) {
    let line = ''
    for (let x = 0; x < frame.columns; x++) {
      const cell = cells.get(`${x}:${y}`)
      if (cell?.width === 0) continue
      line += cell?.char || ' '
    }
    lines.push(line.trimEnd())
  }
  return lines
}

export function semanticEvidence(text) {
  const rendered = text.join('\n')
  const diffMode = rendered.includes('Diff · detail')
    ? 'detail'
    : rendered.includes('Diff · files') ||
        (text.some(line => /(?:^|│)\s*Diff\s*(?:✕)?\s*$/.test(line)) &&
          rendered.includes('Base:') && rendered.includes('Source:'))
      ? 'files'
      : null
  if (!diffMode) {
    return {
      diffMode: null,
      alphaBody: false,
      omegaBody: false,
      loading: false,
      alphaFile: false,
      omegaFile: false,
    }
  }
  return {
    diffMode,
    alphaBody: rendered.includes('ALPHA_RELEASE_BODY') || rendered.includes('ALPHA_BODY'),
    omegaBody: rendered.includes('OMEGA_RELEASE_BODY') || rendered.includes('OMEGA_BODY'),
    loading:
      rendered.includes('Loading diff…') ||
      rendered.includes('Refreshing diff…') ||
      rendered.includes('Loading diff body…'),
    alphaFile: rendered.includes('alpha.txt') || rendered.includes('alpha.ts'),
    omegaFile: rendered.includes('omega.txt') || rendered.includes('omega.ts'),
  }
}

// Turns `tmux capture-pane -e -p` snapshots into the compact recording the site's ReplayTerminal plays.
// Only the SGR codes the CLI emits are kept (bold, dim, italic, underline, inverse, 16/256/truecolor).

export type Style = { fg?: string; bg?: string; b?: 1; d?: 1; i?: 1; u?: 1; inv?: 1 }
export type Run = [text: string, style: number]
export type Recording = { cols: number; rows: number; styles: Style[]; lines: Run[][]; frames: [ms: number, lines: number[]][] }

const BASIC = ['0,0,0', '205,49,49', '13,188,121', '229,229,16', '36,114,200', '188,63,188', '17,168,205', '229,229,229']
const BRIGHT = ['102,102,102', '241,76,76', '35,209,139', '245,245,67', '59,142,234', '214,112,214', '41,184,219', '255,255,255']

function color256(n: number): string {
  if (n < 8) return `rgb(${BASIC[n]})`
  if (n < 16) return `rgb(${BRIGHT[n - 8]})`
  if (n < 232) {
    const v = [0, 95, 135, 175, 215, 255]
    const i = n - 16
    return `rgb(${v[Math.floor(i / 36)]},${v[Math.floor(i / 6) % 6]},${v[i % 6]})`
  }
  const g = 8 + (n - 232) * 10
  return `rgb(${g},${g},${g})`
}

function applySgr(style: Style, params: number[]): Style {
  const s = { ...style }
  for (let i = 0; i < params.length; i++) {
    const p = params[i]
    if (p === 0) for (const k of Object.keys(s)) delete s[k as keyof Style]
    else if (p === 1) s.b = 1
    else if (p === 2) s.d = 1
    else if (p === 3) s.i = 1
    else if (p === 4) s.u = 1
    else if (p === 7) s.inv = 1
    else if (p === 22) delete s.b, delete s.d
    else if (p === 23) delete s.i
    else if (p === 24) delete s.u
    else if (p === 27) delete s.inv
    else if (p === 39) delete s.fg
    else if (p === 49) delete s.bg
    else if (p >= 30 && p <= 37) s.fg = `rgb(${BASIC[p - 30]})`
    else if (p >= 90 && p <= 97) s.fg = `rgb(${BRIGHT[p - 90]})`
    else if (p >= 40 && p <= 47) s.bg = `rgb(${BASIC[p - 40]})`
    else if (p >= 100 && p <= 107) s.bg = `rgb(${BRIGHT[p - 100]})`
    else if (p === 38 || p === 48) {
      const key = p === 38 ? 'fg' : 'bg'
      if (params[i + 1] === 2) {
        s[key] = `rgb(${params.slice(i + 2, i + 5).join(',')})`
        i += 4
      } else if (params[i + 1] === 5) {
        s[key] = color256(params[i + 2])
        i += 2
      }
    }
  }
  return s
}

export function convert(snapshots: { t: number; screen: string }[], cols: number, rows: number): Recording {
  const styles: Style[] = [{}]
  const styleIds = new Map<string, number>([['{}', 0]])
  const lines: Run[][] = []
  const lineIds = new Map<string, number>()
  const frames: Recording['frames'] = []
  const t0 = snapshots[0]?.t ?? 0
  for (const snap of snapshots) {
    const ids: number[] = []
    let style: Style = {}
    for (const raw of snap.screen.replace(/\n$/, '').split('\n').slice(0, rows)) {
      const runs: Run[] = []
      for (const part of raw.split(/(\x1b\[[0-9;:]*m)/)) {
        const sgr = /^\x1b\[([0-9;:]*)m$/.exec(part)
        if (sgr) {
          style = applySgr(style, (sgr[1] || '0').split(/[;:]/).map(Number))
          continue
        }
        if (!part) continue
        const key = JSON.stringify(style)
        let id = styleIds.get(key)
        if (id === undefined) {
          id = styles.push(style) - 1
          styleIds.set(key, id)
        }
        const last = runs[runs.length - 1]
        if (last && last[1] === id) last[0] += part
        else runs.push([part, id])
      }
      // Trailing blanks in the default style add nothing on screen.
      while (runs.length && runs[runs.length - 1][1] === 0 && !runs[runs.length - 1][0].trimEnd()) runs.pop()
      if (runs.length && runs[runs.length - 1][1] === 0) runs[runs.length - 1][0] = runs[runs.length - 1][0].trimEnd()
      const key = JSON.stringify(runs)
      let id = lineIds.get(key)
      if (id === undefined) {
        id = lines.push(runs) - 1
        lineIds.set(key, id)
      }
      ids.push(id)
    }
    while (ids.length && lines[ids[ids.length - 1]].length === 0) ids.pop()
    frames.push([Math.round((snap.t - t0) * 1000), ids])
  }
  return { cols, rows, styles, lines, frames }
}

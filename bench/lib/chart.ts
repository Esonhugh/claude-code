// Artificial-Analysis-style scatter: x = tokens or API-equivalent $ per task (log),
// y = cache hit rate. Colour = CLI, marker shape = account side, dashed Pareto
// front, shaded "better" quadrant (x <= median and y >= median). SVG, light + dark.
import { PRODUCTS, type Side } from './clis'
import type { CellSummary } from './metrics'

type Theme = { bg: string; ink: string; ink2: string; muted: string; grid: string; axis: string; zone: string; zoneOp: number; cat: Record<string, string> }

export const THEMES: Record<'light' | 'dark', Theme> = {
  light: {
    bg: '#fcfcfb', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', zone: '#2a78d6', zoneOp: 0.07,
    cat: { fork: '#2a78d6', official: '#eb6834', codex: '#1baf7a', opencode: '#eda100', pi: '#e87ba4', omp: '#008300', dsh: '#6250d6' },
  },
  dark: {
    bg: '#1a1a19', ink: '#f0efec', ink2: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', axis: '#383835', zone: '#3987e5', zoneOp: 0.12,
    cat: { fork: '#3987e5', official: '#d95926', codex: '#199e70', opencode: '#c98500', pi: '#d55181', omp: '#008300', dsh: '#9085e9' },
  },
}

const SHORT: Record<string, string> = { fork: '本仓库', official: '官方', codex: 'Codex', opencode: 'opencode', pi: 'pi', omp: 'omp', dsh: 'dsh' }
const SIDE_NAME: Record<Side, string> = { claude: 'Claude', chatgpt: 'ChatGPT', 'claude-key': 'Claude API' }
const FONT = "'WenQuanYi Zen Hei', system-ui, sans-serif"
const TAB = 'style="font-variant-numeric:tabular-nums"'
const W = 880

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
const f1 = (n: number) => n.toFixed(1)
const text = (x: number, y: number, s: string, fill: string, size = 12, anchor = 'start', weight = 400, extra = '') =>
  `<text x="${f1(x)}" y="${f1(y)}" fill="${fill}" font-size="${size}" text-anchor="${anchor}" font-weight="${weight}" ${extra}>${esc(s)}</text>`

// Approximate rendered width: CJK glyphs are square, Latin about 0.58 em.
const textWidth = (s: string, size: number) => [...s].reduce((w, ch) => w + (ch.codePointAt(0)! > 0x2e80 ? size : size * 0.58), 0)

export type Point = { x: number; y: number; cell: string; product: string; side: Side; label: string }

export function marker(t: Theme, x: number, y: number, product: string, side: Side, r = 6): string {
  const c = t.cat[product] ?? t.muted
  if (side === 'claude-key') return `<circle cx="${f1(x)}" cy="${f1(y)}" r="${r - 1}" fill="${t.bg}" stroke="${c}" stroke-width="2.5"/>`
  if (side === 'claude') return `<circle cx="${f1(x)}" cy="${f1(y)}" r="${r}" fill="${c}" stroke="${t.bg}" stroke-width="2"/>`
  const d = r * 1.3
  return `<path d="M${f1(x)},${f1(y - d)} L${f1(x + d)},${f1(y)} L${f1(x)},${f1(y + d)} L${f1(x - d)},${f1(y)} Z" fill="${c}" stroke="${t.bg}" stroke-width="2" stroke-linejoin="round"/>`
}

// Points not beaten on both axes (fewer-or-equal x and higher y) by any other point.
export function paretoFront<T extends { x: number; y: number }>(pts: T[]): T[] {
  const sorted = [...pts].sort((a, b) => a.x - b.x || b.y - a.y)
  const front: T[] = []
  let best = -Infinity
  for (const p of sorted) {
    if (p.y > best) {
      front.push(p)
      best = p.y
    }
  }
  return front
}

export function logTicks(lo: number, hi: number): number[] {
  const out: number[] = []
  for (let e = Math.floor(Math.log10(lo)) - 1; e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of [1, 2, 3, 5]) {
      const v = Number((m * 10 ** e).toPrecision(3))
      if (v >= lo && v <= hi) out.push(v)
    }
  }
  return out
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

type Box = [number, number, number, number]
const overlaps = (a: Box, b: Box) => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3])
const markBox = (x: number, y: number, r: number): Box => [x - r - 1, y - r - 1, x + r + 1, y + r + 1]

// Greedy label placement around each mark, farther out with a leader line when crowded.
function placeLabels(t: Theme, items: { x: number; y: number; label: string; bold: boolean }[], boxes: Box[], bounds: Box, size: number): string {
  let o = ''
  for (const { x, y, label, bold } of items) {
    const w = textWidth(label, size)
    const h = size + 2
    let rect: Box | null = null
    let leader = false
    search: for (const r of [9, 14, 20, 27, 36, 46, 58, 72, 90, 110]) {
      for (const ang of [0, 180, -35, 35, -145, 145, -90, 90, -60, 60, -120, 120]) {
        const a = (ang * Math.PI) / 180
        const px = x + r * Math.cos(a)
        const py = y + r * Math.sin(a)
        const x0 = Math.abs(ang) === 90 ? px - w / 2 : ang > -95 && ang < 95 ? px : px - w
        const cand: Box = [x0, py - h / 2, x0 + w, py + h / 2]
        if (cand[0] < bounds[0] || cand[2] > bounds[2] || cand[1] < bounds[1] || cand[3] > bounds[3]) continue
        if (boxes.some(b => overlaps(cand, b))) continue
        rect = cand
        leader = r >= 27
        break search
      }
    }
    rect ??= [x + 10, y - h / 2, x + 10 + w, y + h / 2]
    boxes.push([rect[0] - 2, rect[1] - 1, rect[2] + 2, rect[3] + 1])
    if (leader) {
      const cx = Math.min(Math.max(x, rect[0]), rect[2])
      const cy = Math.min(Math.max(y, rect[1]), rect[3])
      o += `<line x1="${f1(x)}" y1="${f1(y)}" x2="${f1(cx)}" y2="${f1(cy)}" stroke="${t.axis}" stroke-width="1"/>`
    }
    o += text(rect[0], rect[3] - 3, label, bold ? t.ink : t.ink2, size, 'start', bold ? 700 : 400, `${TAB} stroke="${t.bg}" stroke-width="3" paint-order="stroke" stroke-linejoin="round"`)
  }
  return o
}

class Plot {
  constructor(public x0: number, public x1: number, public y0: number, public y1: number, public xlo: number, public xhi: number, public ylo: number, public yhi: number) {}
  sx(v: number) {
    return this.x0 + ((Math.log10(v) - Math.log10(this.xlo)) / (Math.log10(this.xhi) - Math.log10(this.xlo))) * (this.x1 - this.x0)
  }
  sy(v: number) {
    return this.y1 - ((v - this.ylo) / (this.yhi - this.ylo)) * (this.y1 - this.y0)
  }
  axes(t: Theme, xt: number[], yt: number[], fmt: (v: number) => string) {
    let o = ''
    for (const v of xt) o += `<line x1="${f1(this.sx(v))}" x2="${f1(this.sx(v))}" y1="${this.y0}" y2="${this.y1}" stroke="${t.grid}"/>` + text(this.sx(v), this.y1 + 15, fmt(v), t.muted, 11, 'middle', 400, TAB)
    for (const v of yt) o += `<line x1="${this.x0}" x2="${this.x1}" y1="${f1(this.sy(v))}" y2="${f1(this.sy(v))}" stroke="${t.grid}"/>` + text(this.x0 - 6, this.sy(v) + 4, `${v}%`, t.muted, 11, 'end', 400, TAB)
    return o + `<line x1="${this.x0}" x2="${this.x1}" y1="${this.y1}" y2="${this.y1}" stroke="${t.axis}"/>`
  }
}

function legend(t: Theme, y: number, products: string[], productNames: Record<string, string>, sides: Side[]): string {
  const gray = (m: string) => m.replaceAll(t.cat.fork, t.muted)
  const items: [string, string][] = products.map(p => [`<circle cx="0" cy="0" r="5" fill="${t.cat[p] ?? t.muted}"/>`, productNames[p] ?? p])
  const sideLabel: Record<Side, string> = { claude: 'Claude 订阅', chatgpt: 'ChatGPT 订阅', 'claude-key': 'Claude API key' }
  for (const s of sides) items.push([gray(marker(t, 0, 0, 'fork', s, s === 'chatgpt' ? 4.2 : 5)), sideLabel[s]])
  items.push([`<line x1="-8" x2="12" y1="0" y2="0" stroke="${t.ink2}" stroke-width="1.5" stroke-dasharray="2 4" stroke-linecap="round"/>`, 'Pareto 前沿'])
  items.push([`<rect x="-6" y="-6" width="14" height="12" rx="2" fill="${t.zone}" fill-opacity="${t.zoneOp * 2.5}"/>`, '更优区域'])
  let o = ''
  let x = 24
  let row = 0
  for (const [mk, label] of items) {
    const w = 16 + textWidth(label, 12) * 1.08 + 18
    if (x + w > W - 16) {
      x = 24
      row++
    }
    const yy = y + row * 22
    o += `<g transform="translate(${x + 5},${yy - 4})">${mk}</g>` + text(x + 16, yy, label, t.ink2, 12)
    x += w
  }
  return o
}

export type ScatterInput = {
  metric: 'tokens' | 'cost'
  summaries: CellSummary[] // one per cell, group 'all'
  facets?: CellSummary[] // one per cell and task type, drawn as small marks
  productNames?: Record<string, string> // e.g. { codex: 'Codex CLI 0.167.0' }
  title?: string
  notes?: string[]
}

export function toPoint(s: CellSummary, metric: 'tokens' | 'cost'): Point | null {
  const x = metric === 'cost' ? s.costPerTask?.mean : s.tokensPerTask.mean / 1000
  if (x == null || !(x > 0)) return null
  return { x, y: s.hitRate * 100, cell: s.cell, product: s.product, side: s.side as Side, label: `${SHORT[s.product] ?? s.product} · ${SIDE_NAME[s.side as Side]}` }
}

// Every cell states the model and effort it ran with, three cells per line.
export function modelEffortNotes(summaries: CellSummary[]): string[] {
  const parts = summaries.map(s => `${s.cell}: ${s.model} / ${s.effort}`)
  const lines: string[] = []
  for (let i = 0; i < parts.length; i += 3) lines.push((i ? '' : '模型 / effort：') + parts.slice(i, i + 3).join('；'))
  return lines
}

export function scatterSvg(input: ScatterInput, theme: 'light' | 'dark'): string {
  const t = THEMES[theme]
  const pts = input.summaries.map(s => toPoint(s, input.metric)).filter((p): p is Point => p !== null)
  const sub = (input.facets ?? []).map(s => toPoint(s, input.metric)).filter((p): p is Point => p !== null)
  if (!pts.length) throw new Error('no points to plot')
  const all = [...pts, ...sub]
  const xs = all.map(p => p.x)
  const xlo = Math.min(...xs) / 1.4
  const xhi = Math.max(...xs) * 1.4
  const ylo = Math.max(0, Math.floor(Math.min(...all.map(p => p.y)) / 5) * 5 - 5)
  const p = new Plot(70, W - 40, 130, 560, xlo, xhi, ylo, 100)
  const products = PRODUCTS.filter(pr => pts.some(q => q.product === pr))
  const sides = (['claude', 'chatgpt', 'claude-key'] as Side[]).filter(sd => pts.some(q => q.side === sd))
  // legend names carry the CLI version the runs recorded, e.g. "Codex 0.167.0"
  const versions = Object.fromEntries(input.summaries.filter(x => x.cliVersion).map(x => [x.product, `${SHORT[x.product] ?? x.product} ${x.cliVersion!.match(/\d+\.\d+\.\d+(-[\w.]+)?/)?.[0] ?? ''}`.trim()]))
  const names = { ...SHORT, ...versions, ...input.productNames }
  let o = legend(t, 84, products, names, sides)
  const zx = p.sx(median(pts.map(q => q.x)))
  const zy = p.sy(median(pts.map(q => q.y)))
  o += `<rect x="${p.x0}" y="${p.y0}" width="${f1(zx - p.x0)}" height="${f1(zy - p.y0)}" fill="${t.zone}" fill-opacity="${t.zoneOp}"/>`
  const yt: number[] = []
  for (let v = ylo; v <= 100; v += ylo < 50 ? 10 : 5) yt.push(v)
  const cost = input.metric === 'cost'
  o += p.axes(t, logTicks(xlo, xhi), yt, v => (cost ? `$${v}` : `${v}k`))
  o += text((p.x0 + p.x1) / 2, p.y1 + 34, cost ? '平均每任务 API 等价花费（美元，对数轴，越左越省）' : '平均每任务总 token（对数轴，越左越省）', t.ink2, 12, 'middle')
  o += text(18, (p.y0 + p.y1) / 2, '缓存命中率（越高越好）', t.ink2, 12, 'middle', 400, `transform="rotate(-90 18 ${f1((p.y0 + p.y1) / 2)})"`)
  for (const q of sub) o += `<g opacity="0.45">${marker(t, p.sx(q.x), p.sy(q.y), q.product, q.side, 3.5)}</g>`
  const front = paretoFront(pts)
  o += `<polyline points="${front.map(q => `${f1(p.sx(q.x))},${f1(p.sy(q.y))}`).join(' ')}" fill="none" stroke="${t.ink2}" stroke-width="1.5" stroke-dasharray="2 4" stroke-linecap="round"/>`
  const onFront = new Set(front.map(q => q.cell))
  const boxes: Box[] = [...pts.map(q => markBox(p.sx(q.x), p.sy(q.y), 9)), ...sub.map(q => markBox(p.sx(q.x), p.sy(q.y), 4))]
  for (let i = 1; i < front.length; i++) {
    const [a, b] = [front[i - 1], front[i]]
    const [ax, ay, bx, by] = [p.sx(a.x), p.sy(a.y), p.sx(b.x), p.sy(b.y)]
    const n = Math.max(1, Math.floor(Math.hypot(bx - ax, by - ay) / 4))
    for (let k = 0; k <= n; k++) boxes.push(markBox(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, 2))
  }
  for (const q of [...pts].sort((a, b) => Number(onFront.has(a.cell)) - Number(onFront.has(b.cell)))) o += marker(t, p.sx(q.x), p.sy(q.y), q.product, q.side, 7)
  const items = [...pts].sort((a, b) => b.y - a.y).map(q => ({ x: p.sx(q.x), y: p.sy(q.y), label: q.label, bold: onFront.has(q.cell) }))
  o += placeLabels(t, items, boxes, [p.x0, p.y0, p.x1, p.y1], 12)
  const title = input.title ?? `每任务${cost ? '花费' : ' token '}与缓存命中率：${pts.length} 个 CLI × 账号`
  const notes = input.notes ?? [
    `左上 = ${cost ? '花得少' : '用更少 token'}、命中高。更优区域 = 横轴不高于中位数且命中率不低于中位数；粗体点在 Pareto 前沿上。`,
    '命中率按 token 加权。大点 = 全部任务的平均；小点 = 各任务类型的平均。',
    ...modelEffortNotes(input.summaries),
  ]
  const h = p.y1 + 64 + notes.length * 16
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" font-family="${FONT}">` +
    `<rect width="${W}" height="${h}" rx="10" fill="${t.bg}"/>` +
    text(24, 34, title, t.ink, 17, 'start', 700) +
    text(24, 56, '颜色 = CLI，形状 = 账号类型。', t.ink2, 13) +
    o +
    notes.map((n, i) => text(24, h - 18 - 16 * (notes.length - 1) + i * 16, n, t.muted, 11)).join('') +
    '</svg>'
  )
}

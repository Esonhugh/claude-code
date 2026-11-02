import { type MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ext, type Stats } from '../extApi'
import {
  dayPart,
  dayTotal,
  dLabel,
  fmtDuration,
  fmtK,
  heatDays,
  heatLevels,
  hourShares,
  rangeDays,
  SERIES_COLORS,
  type StatRange,
  statDays,
  statSeries,
  summary,
  topModels,
} from '../statsView'
import type { Z } from './zhText'

const W = 600
const H = 170
const L = 40
const B = 20
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** The prototype's `/stats` dialog: KPI tiles, daily chart, model share, heatmap, hours. */
export function StatsBody({ z }: { z: Z }) {
  const [stats, setStats] = useState<Stats>()
  const [error, setError] = useState<string>()
  const [range, setRange] = useState<StatRange>('30d')
  const [hover, setHover] = useState<{ i: number; left: number }>()
  const [heatTip, setHeatTip] = useState<{ i: number; x: number; top: number; bottom: number }>()
  const chartRef = useRef<HTMLDivElement>(null)
  const heatRef = useRef<HTMLDivElement>(null)
  const heatTipRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ext.stats().then(setStats, (e: Error) => setError(e.message))
  }, [])
  // Centered above the cell, kept inside the heatmap, below the cell when there is no room above.
  useLayoutEffect(() => {
    const tip = heatTipRef.current
    if (!tip || !heatTip) return
    const width = heatRef.current!.getBoundingClientRect().width
    tip.style.left = `${Math.min(width - tip.offsetWidth, Math.max(0, heatTip.x - tip.offsetWidth / 2))}px`
    const up = heatTip.top - tip.offsetHeight - 6
    tip.style.top = `${up >= 0 ? up : heatTip.bottom + 6}px`
  }, [heatTip])
  const models = useMemo(() => (stats ? topModels(stats) : []), [stats])
  const allDays = useMemo(() => (stats ? statDays(stats, models) : []), [stats, models])
  if (error) return <p className="note">{error}</p>
  if (!stats) return <p className="note">{z('加载中…')}</p>

  const days = rangeDays(allDays, range)
  const s = summary(days, stats)
  const pts = statSeries(days, range, models.length)
  const np = pts.length
  const max = Math.max(10, ...pts.flatMap(d => d.tok))
  const top = Math.ceil(max / 20) * 20
  const X = (i: number) => L + (W - L - 60) * (np === 1 ? 0 : i / (np - 1))
  const Y = (v: number) => H - B - ((H - B - 8) * v) / top
  const path = (m: number) => pts.map((d, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(d.tok[m]!).toFixed(1)}`).join('')
  const ticks = [0, top / 2, top]
  const xt = [0, Math.floor((np - 1) / 2), np - 1]
  const heat = heatDays(allDays)
  const levels = heatLevels(heat)
  const shares = hourShares(stats.hours)
  const hourMax = Math.max(1, ...shares)
  const pct = (v: number) => (s.all ? Math.round((v / s.all) * 100) : 0)

  const onChartMove = (e: MouseEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement!
    const box = svg.getBoundingClientRect()
    const x = ((e.clientX - box.left) / box.width) * W
    const w = W - L - 60
    const i = Math.max(0, Math.min(np - 1, Math.round(((x - L) / w) * (np - 1))))
    const wrap = chartRef.current!.getBoundingClientRect()
    setHover({ i, left: Math.min(wrap.width - 150, Math.max(0, e.clientX - wrap.left + 12)) })
  }
  const onHeatMove = (e: MouseEvent<HTMLDivElement>) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('i[data-i]')
    if (!cell) return setHeatTip(undefined)
    const wrap = heatRef.current!.getBoundingClientRect()
    const box = cell.getBoundingClientRect()
    setHeatTip({
      i: Number(cell.dataset.i),
      x: box.left - wrap.left + box.width / 2,
      top: box.top - wrap.top,
      bottom: box.bottom - wrap.top,
    })
  }
  const tile = (k: string, v: string | number, sub: string) => (
    <div key={k}>
      <small>{z(k)}</small>
      <b>{v}</b>
      <small>{sub}</small>
    </div>
  )
  const hovered = hover && pts[hover.i]
  const heatDay = heatTip && heat[heatTip.i]

  return (
    <div>
      <div className="usegroup">
        <div className="seg" role="radiogroup" aria-label={z('时间范围')} style={{ alignSelf: 'flex-start' }}>
          {(
            [
              ['7d', '7 天'],
              ['30d', '30 天'],
              ['all', '全部'],
            ] as const
          ).map(([k, l]) => (
            <button type="button" role="radio" key={k} aria-checked={range === k} onClick={() => setRange(k)}>
              {z(l)}
            </button>
          ))}
        </div>
        <div className="mgrid mgrid3">
          {tile('最常用模型', models[s.fav] ?? '—', z(`${pct(s.tot[s.fav] ?? 0)}% 的 tokens`))}
          {tile('输出 tokens', fmtK(s.all), z(`${s.active} 个活跃天`))}
          {tile('会话', s.sessions, z(`最长 ${fmtDuration(stats.longestSessionMs)}`))}
          {tile('连续使用', z(`${s.current} 天`), z(`最长 ${s.best} 天`))}
          {tile('最活跃的一天', dLabel(s.peak.dt), `${fmtK(dayTotal(s.peak))} tokens`)}
          {tile(
            '高峰时段',
            s.peakHour === undefined ? '—' : `${s.peakHour}:00`,
            s.peakHour === undefined ? '' : z(`${dayPart(s.peakHour)}最常用`),
          )}
        </div>
      </div>
      <div className="usegroup">
        <h4>
          {z(range === 'all' ? '每周输出 tokens' : '每日输出 tokens')} <small>{z('按模型')}</small>
        </h4>
        <div className="legend">
          {models.map((nm, m) => (
            <span key={nm}>
              <i className="sw" style={{ background: SERIES_COLORS[m] }} />
              {nm}
            </span>
          ))}
        </div>
        <div className="chartwrap" id="stat-chart" ref={chartRef}>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={z('每日输出 tokens，按模型')}>
            <g className="grid">
              {ticks.map(v => (
                <g key={v}>
                  <line x1={L} x2={W - 60} y1={Y(v)} y2={Y(v)} />
                  <text x={L - 6} y={Y(v) + 4} textAnchor="end">
                    {fmtK(v)}
                  </text>
                </g>
              ))}
            </g>
            {[...new Set(xt)].map(i => (
              <text key={i} x={X(i)} y={H - 4} textAnchor="middle">
                {pts[i]!.label}
              </text>
            ))}
            {models.map((nm, m) => (
              <path key={nm} className="series" d={path(m)} stroke={SERIES_COLORS[m]} />
            ))}
            {models.map((nm, m) => (
              <text key={nm} x={X(np - 1) + 8} y={Y(pts[np - 1]!.tok[m]!) + 4 + (m - 1) * 3} style={{ fill: 'var(--fg)' }}>
                {nm.split(' ')[0]}
              </text>
            ))}
            <line
              id="stat-x"
              x1={hover ? X(hover.i) : 0}
              x2={hover ? X(hover.i) : 0}
              y1={8}
              y2={H - B}
              stroke="var(--muted)"
              strokeDasharray="3 3"
              visibility={hover ? 'visible' : 'hidden'}
            />
            <rect
              id="stat-hit"
              x={L}
              y={0}
              width={W - L - 60}
              height={H - B}
              fill="transparent"
              onMouseMove={onChartMove}
              onMouseLeave={() => setHover(undefined)}
            />
          </svg>
          {hovered && (
            <div className="stip" id="stat-tip" style={{ left: hover.left, top: 8 }}>
              <b>{hovered.week ? z(`${hovered.label} 起一周`) : hovered.label}</b>
              {models.map((nm, m) => (
                <span key={nm}>
                  <span>
                    <i className="sw" style={{ background: SERIES_COLORS[m] }} />
                    {nm}
                  </span>
                  {fmtK(hovered.tok[m]!)}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="usegroup">
        <h4>{z('模型占比')}</h4>
        <div className="mshare">
          {models.map((nm, m) => (
            <span key={nm} style={{ display: 'contents' }}>
              <span>{nm}</span>
              <span className="track">
                <i style={{ width: `${s.all ? ((s.tot[m]! / s.all) * 100).toFixed(1) : 0}%`, background: SERIES_COLORS[m] }} />
              </span>
              <span className="v">
                {pct(s.tot[m]!)}% · {fmtK(s.tot[m]!)}
              </span>
            </span>
          ))}
        </div>
      </div>
      <div className="usegroup">
        <h4>
          {z('活跃度')} <small>{z('最近 25 周')}</small>
        </h4>
        <div className="heatwrap" ref={heatRef} onMouseMove={onHeatMove} onMouseLeave={() => setHeatTip(undefined)}>
          <div className="heat" role="img" aria-label={z('最近 25 周每天的使用量')}>
            {heat.map((d, i) => (
              <i key={d.key} data-i={i} data-l={levels[i]} />
            ))}
          </div>
          {heatDay && (
            <div className="stip heattip" id="heat-tip" ref={heatTipRef}>
              <b>
                {dLabel(heatDay.dt)} {z(WEEKDAYS[heatDay.dt.getDay()]!)}
              </b>
              {dayTotal(heatDay) ? (
                <>
                  <span>
                    <span>{z('输出 tokens')}</span>
                    {fmtK(dayTotal(heatDay))}
                  </span>
                  <span>
                    <span>{z('会话')}</span>
                    {heatDay.sessions}
                  </span>
                </>
              ) : (
                <span>{z('没有使用')}</span>
              )}
            </div>
          )}
        </div>
        <div className="heatleg">
          <span>{z('较少')}</span>
          {[0, 1, 2, 3, 4].map(l => (
            <i key={l} data-l={l} />
          ))}
          <span>{z('较多')}</span>
        </div>
      </div>
      <div className="usegroup">
        <h4>
          {z('一天中的使用')} <small>{z('按小时')}</small>
        </h4>
        <div className="hours">
          {shares.map((v, i) => (
            <i key={i} style={{ height: `${(v / hourMax) * 100}%` }} title={`${i}:00 · ${v}%`} />
          ))}
        </div>
        <div className="hourax">
          <span>0:00</span>
          <span>6:00</span>
          <span>12:00</span>
          <span>18:00</span>
          <span>23:00</span>
        </div>
      </div>
    </div>
  )
}

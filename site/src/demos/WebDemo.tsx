import { interpolate, useCurrentFrame } from 'remotion'
import { clamp, MONO } from './Terminal'
import { type Lang, ui } from './i18n'

// A scripted claude web session, laid out after docs/features/images/web-tour-chat.png.
export const WEB_DEMO_FRAMES = 600

const c = {
  bg: '#ffffff',
  side: '#fbfaf8',
  line: '#e7e4df',
  ink: '#1f1e1c',
  muted: '#77746d',
  accent: 'rgb(217,119,87)',
  accentSoft: '#f6e3d9',
  userBubble: '#f3e1d6',
  chip: '#f4f2ee',
  ok: '#3f9a57',
  del: '#fbe1e1',
  add: '#e2f3e6',
}
const SANS = '"IBM Plex Sans", "Noto Sans TC", system-ui, sans-serif'

const copy = {
  en: {
    prompt: 'Check retrieval.py, change TOP_K to 20, then run the tests',
    look: 'Looking at the current implementation first.',
    found: 'TOP_K is on line 3; changing it to 20.',
    rerun: 'Running the tests again.',
    done: 'Done. All tests pass.',
    item: 'Item',
    before: 'Before',
    after: 'After',
    tests: 'Tests',
    session: 'Check retrieval.py, change…',
  },
  zh: {
    prompt: '檢查 retrieval.py，把 TOP_K 改成 20，再跑一下測試',
    look: '先看一下目前的實作。',
    found: 'TOP_K 在第 3 行，改成 20。',
    rerun: '再跑一下測試。',
    done: '改好了，測試全部通過。',
    item: '項目',
    before: '改動前',
    after: '改動後',
    tests: '測試',
    session: '檢查 retrieval.py，把…',
  },
}

// Timeline (30 fps).
const T = {
  type: 30,
  send: 95,
  look: 115,
  read: 130,
  readDone: 160,
  found: 175,
  edit: 190,
  rerun: 245,
  bash: 260,
  ask: 275,
  cursor: 300,
  click: 330,
  bashDone: 370,
  done: 385,
  table: 400,
  ready: 420,
}

const fade = (f: number, at: number) => ({
  opacity: interpolate(f, [at, at + 6], [0, 1], clamp),
  translate: `0px ${interpolate(f, [at, at + 8], [10, 0], clamp)}px`,
})

const Spinner: React.FC<{ frame: number }> = ({ frame }) => (
  <span
    style={{
      display: 'inline-block',
      width: 12,
      height: 12,
      borderRadius: 6,
      border: `2px solid ${c.line}`,
      borderTopColor: c.muted,
      rotate: `${frame * 18}deg`,
    }}
  />
)

const ToolCard: React.FC<{ name: string; arg: string; right: React.ReactNode; children?: React.ReactNode; style?: React.CSSProperties }> = ({
  name,
  arg,
  right,
  children,
  style,
}) => (
  <div style={{ border: `1px solid ${c.line}`, borderRadius: 8, background: c.bg, overflow: 'hidden', ...style }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', fontSize: 13 }}>
      <b>{name}</b>
      <span style={{ fontFamily: MONO, fontSize: 12.5 }}>{arg}</span>
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, color: c.muted, fontSize: 12 }}>{right}</span>
    </div>
    {children}
  </div>
)

const Check = () => <span style={{ color: c.ok }}>✓</span>

export const WebDemo: React.FC<{ lang: Lang }> = ({ lang }) => {
  const f = useCurrentFrame()
  const t = copy[lang]
  const running = f >= T.send && f < T.ready
  const typed = t.prompt.slice(0, Math.round(interpolate(f, [T.type, T.send - 10], [0, t.prompt.length], clamp)))
  const diffOpen = interpolate(f, [T.edit, T.edit + 18], [0, 1], { ...clamp })
  const askIn = interpolate(f, [T.ask, T.ask + 10, T.click + 4, T.click + 12], [0, 1, 1, 0], clamp)
  const ctx = interpolate(f, [T.send, T.ready], [8, 64], clamp)
  const cursorX = interpolate(f, [T.cursor, T.click - 6], [1020, 520], { ...clamp })
  const cursorY = interpolate(f, [T.cursor, T.click - 6], [700, 548], { ...clamp })
  const pressed = f >= T.click && f < T.click + 5
  const elapsed = Math.max(1, Math.floor((Math.min(f, T.ready) - T.send) / 30))

  return (
    <div style={{ position: 'absolute', inset: 0, background: c.bg, color: c.ink, fontFamily: SANS, fontSize: 14, display: 'flex' }}>
      {/* sidebar */}
      <div style={{ width: 200, background: c.side, borderRight: `1px solid ${c.line}`, padding: '14px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 22, height: 14, background: c.accent, borderRadius: 2 }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>EsonClaw</div>
            <div style={{ fontFamily: MONO, fontSize: 10, color: c.muted }}>claude web</div>
          </div>
        </div>
        <div style={{ border: `1px solid ${c.line}`, borderRadius: 6, padding: '6px 8px', background: c.bg }}>{ui(lang, 'newSession')}</div>
        <div style={{ border: `1px solid ${c.line}`, borderRadius: 6, padding: '6px 8px', color: c.muted, background: c.chip, fontSize: 13 }}>
          {ui(lang, 'searchSessionsPh')}
        </div>
        <div style={{ display: 'grid', gap: 6, padding: '4px 6px', fontSize: 13 }}>
          {['MCP', 'Skills', ui(lang, 'plugins'), ui(lang, 'memoryLabel'), 'Hooks'].map(x => (
            <div key={x}>{x}</div>
          ))}
        </div>
        <div style={{ borderTop: `1px solid ${c.line}`, paddingTop: 10, fontSize: 12, color: c.muted }}>▾ {ui(lang, 'sbRecentFolders')}</div>
        <div style={{ fontSize: 13, fontWeight: 600, paddingLeft: 6 }}>search-demo</div>
        {f >= T.send && (
          <div style={{ ...fade(f, T.send), background: '#efebe5', borderRadius: 6, padding: '5px 8px', fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ width: 7, height: 7, borderRadius: 4, background: running ? c.ok : c.accent }} />
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.session}</span>
          </div>
        )}
      </div>

      {/* conversation */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative' }}>
        <div style={{ display: 'flex', gap: 8, padding: '10px 18px', borderBottom: `1px solid ${c.line}`, fontSize: 12.5 }}>
          <span style={{ background: c.chip, borderRadius: 12, padding: '2px 10px', display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ width: 7, height: 7, borderRadius: 4, background: running ? c.ok : c.accent }} />
            {running ? ui(lang, 'elapsedRunning', { time: `${elapsed}s` }) : ui(lang, 'statusReady')}
          </span>
          <span style={{ background: c.chip, borderRadius: 12, padding: '2px 10px', fontFamily: MONO }}>~/projects/search-demo</span>
          <span style={{ background: c.chip, borderRadius: 12, padding: '2px 10px' }}>
            {Math.round(ctx)}% {ui(lang, 'contextChip')}
          </span>
          <span style={{ marginLeft: 'auto', color: c.muted }}>{ui(lang, 'export')}</span>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 10, padding: '14px 22px', overflow: 'hidden' }}>
          {f >= T.send && (
            <div style={{ ...fade(f, T.send), alignSelf: 'flex-end', textAlign: 'right' }}>
              <div style={{ fontSize: 11, color: c.muted, marginBottom: 4 }}>{ui(lang, 'you')}</div>
              <div style={{ background: c.userBubble, borderRadius: 10, padding: '8px 12px' }}>{t.prompt}</div>
            </div>
          )}
          {f >= T.look && (
            <div style={fade(f, T.look)}>
              <div style={{ fontSize: 11, color: c.muted }}>Claude (Opus 5.5)</div>
              <div>{t.look}</div>
            </div>
          )}
          {f >= T.read && (
            <ToolCard style={fade(f, T.read)} name="Read" arg="retrieval.py" right={f >= T.readDone ? <Check /> : <Spinner frame={f} />} />
          )}
          {f >= T.found && <div style={fade(f, T.found)}>{t.found}</div>}
          {f >= T.edit && (
            <ToolCard
              style={fade(f, T.edit)}
              name="Edit"
              arg="retrieval.py"
              right={
                <>
                  <span style={{ color: c.ok }}>+1</span>
                  <span style={{ color: '#c4473a' }}>−1</span>
                </>
              }
            >
              <div style={{ height: 96 * diffOpen, overflow: 'hidden', fontFamily: MONO, fontSize: 12, borderTop: `1px solid ${c.line}` }}>
                <div style={{ padding: '2px 12px', color: c.muted, background: '#f6f4f0' }}>@@ -1,6 +1,6 @@</div>
                <div style={{ padding: '2px 12px' }}>  from index import Index</div>
                <div style={{ padding: '2px 12px', background: c.del }}>- TOP_K = 10</div>
                <div style={{ padding: '2px 12px', background: c.add }}>+ TOP_K = 20</div>
              </div>
            </ToolCard>
          )}
          {f >= T.rerun && <div style={fade(f, T.rerun)}>{t.rerun}</div>}
          {f >= T.bash && (
            <ToolCard
              style={fade(f, T.bash)}
              name="Bash"
              arg="sh run_tests.sh"
              right={
                f >= T.bashDone ? (
                  <>
                    {ui(lang, 'decisionAllow')} <Check />
                  </>
                ) : (
                  <Spinner frame={f} />
                )
              }
            />
          )}
          {f >= T.done && <div style={fade(f, T.done)}>{t.done}</div>}
          {f >= T.table && (
            <div style={{ ...fade(f, T.table), display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', fontSize: 13, borderTop: `1px solid ${c.line}` }}>
              {[t.item, t.before, t.after, 'TOP_K', '10', '20', t.tests, '—', '6 passed'].map((x, i) => (
                <div key={i} style={{ padding: '5px 6px', borderBottom: `1px solid ${c.line}`, fontWeight: i < 3 ? 600 : 400, color: i < 3 ? c.muted : c.ink }}>
                  {x}
                </div>
              ))}
            </div>
          )}
          {running && f >= T.look && (
            <div style={{ color: c.muted, fontSize: 13 }}>
              <span style={{ color: c.accent }}>✻</span> Pondering… <span style={{ border: `1px solid ${c.line}`, borderRadius: 4, padding: '0 5px', fontSize: 11 }}>{ui(lang, 'escInterrupt')}</span>
            </div>
          )}
        </div>

        {/* approval dialog */}
        {askIn > 0 && (
          <div
            style={{
              position: 'absolute',
              left: 22,
              right: 22,
              bottom: 76,
              opacity: askIn,
              translate: `0px ${(1 - askIn) * 20}px`,
              background: c.bg,
              border: `1px solid ${c.line}`,
              borderRadius: 10,
              boxShadow: '0 12px 40px rgba(0,0,0,.12)',
              padding: 14,
              display: 'grid',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', fontSize: 13.5 }}>
              <b>{ui(lang, 'wantsToRunCommand')}</b>
              <span style={{ marginLeft: 'auto', color: c.muted, fontSize: 12 }}>Bash · ~/projects/search-demo</span>
            </div>
            <div style={{ background: c.chip, borderRadius: 6, padding: '7px 10px', fontFamily: MONO, fontSize: 12.5 }}>sh run_tests.sh</div>
            {[ui(lang, 'allowOnce'), ui(lang, 'allowSession'), ui(lang, 'denyTell')].map((x, i) => (
              <div
                key={x}
                style={{
                  padding: '7px 10px',
                  borderRadius: 6,
                  border: `1px solid ${i === 0 ? c.accent : 'transparent'}`,
                  background: i === 0 ? (pressed ? '#efc7b5' : c.accentSoft) : 'transparent',
                  fontSize: 13.5,
                }}
              >
                <span style={{ color: c.muted, marginRight: 10 }}>{i + 1}</span>
                {x}
              </div>
            ))}
            <div style={{ fontSize: 11, color: c.muted }}>{ui(lang, 'askKeys', { n: 3 })}</div>
          </div>
        )}

        <div style={{ padding: '0 22px 14px' }}>
          <div style={{ border: `1px solid ${c.line}`, borderRadius: 10, padding: '11px 14px', display: 'flex', alignItems: 'center', minHeight: 44 }}>
            <span style={{ color: f < T.type || f >= T.send ? c.muted : c.ink, whiteSpace: 'nowrap', overflow: 'hidden' }}>
              {f >= T.type && f < T.send ? typed : ui(lang, 'composerPlaceholder')}
              {f >= T.type && f < T.send && <span style={{ opacity: Math.floor(f / 12) % 2 ? 0 : 1 }}>|</span>}
            </span>
            <span style={{ marginLeft: 'auto', width: 26, height: 26, borderRadius: 13, background: c.chip, display: 'grid', placeItems: 'center', fontSize: 12 }}>
              {running ? '■' : '↑'}
            </span>
          </div>
        </div>
      </div>

      {/* status panel */}
      <div style={{ width: 300, borderLeft: `1px solid ${c.line}`, padding: '10px 14px', display: 'grid', alignContent: 'start', gap: 12, fontSize: 13 }}>
        <div style={{ display: 'flex', gap: 16, fontSize: 12.5, borderBottom: `1px solid ${c.line}`, paddingBottom: 8 }}>
          <b style={{ borderBottom: `2px solid ${c.accent}`, paddingBottom: 6, marginBottom: -9 }}>Status</b>
          <span>Files {f >= T.edit ? <span style={{ background: c.chip, borderRadius: 8, padding: '0 6px' }}>1</span> : null}</span>
          <span>{ui(lang, 'agents')}</span>
        </div>
        <div style={{ border: `1px solid ${c.line}`, borderRadius: 8, padding: 12, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: running ? c.ok : c.accent }} />
            <b>{running ? ui(lang, 'statusLive') : ui(lang, 'statusReady')}</b>
            <span style={{ marginLeft: 'auto', color: c.muted, fontSize: 12 }}>{ui(lang, 'roundsValue', { n: 1 })}</span>
          </div>
          <div style={{ color: c.muted, fontSize: 12 }}>Opus 5.5 · medium · default mode</div>
          <div style={{ display: 'flex', fontSize: 12 }}>
            <span>{ui(lang, 'contextChip')} {Math.round(ctx * 10)}k / 1M</span>
            <span style={{ marginLeft: 'auto' }}>{Math.round(ctx)}%</span>
          </div>
          <div style={{ height: 5, borderRadius: 3, background: c.chip }}>
            <div style={{ width: `${ctx}%`, height: '100%', borderRadius: 3, background: c.accent }} />
          </div>
        </div>
        <div style={{ display: 'grid', gap: 6, borderTop: `1px solid ${c.line}`, paddingTop: 10 }}>
          <b>{ui(lang, 'usageGroup')}</b>
          <Row k="tokens" v={`↑ ${Math.round(ctx * 10)}k`} />
          <Row k={ui(lang, 'cacheLabel')} v={ui(lang, 'cacheValue', { read: `${Math.round(ctx * 8.7)}k`, write: '12k' })} />
          <Row k={ui(lang, 'costLabel')} v={`$${(ctx * 0.004).toFixed(2)}`} />
        </div>
        <div style={{ display: 'grid', gap: 6, borderTop: `1px solid ${c.line}`, paddingTop: 10 }}>
          <b>{ui(lang, 'backgroundGroup')}</b>
          <Row k="Agents" v="0 / 0" />
          <Row k="Terminals" v="0 / 0" />
          <Row k={ui(lang, 'pendingLabel')} v={f >= T.ask && f < T.click ? '1' : '0'} />
        </div>
      </div>

      {/* pointer */}
      {f >= T.cursor && f < T.click + 30 && (
        <svg width="22" height="22" viewBox="0 0 22 22" style={{ position: 'absolute', left: cursorX, top: cursorY, scale: pressed ? '0.85' : '1' }}>
          <path d="M3 2 L3 18 L7.5 13.5 L11 20 L13.5 19 L10 12.5 L16 12.5 Z" fill="#1f1e1c" stroke="#fff" strokeWidth="1.5" />
        </svg>
      )}
    </div>
  )
}

const Row: React.FC<{ k: string; v: string }> = ({ k, v }) => (
  <div style={{ display: 'flex', fontSize: 12.5 }}>
    <span style={{ width: 90, color: '#77746d' }}>{k}</span>
    <span>{v}</span>
  </div>
)

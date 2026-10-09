import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { startBuiltinRun, parseArgs, isIdlePrompt, cleanupAcceptanceSide } from './mods-test-lab.mjs'
import { recordedBuiltinTmux } from './builtin-terminal-evidence.mjs'
import { readOwnedNativeFile } from './native-evidence-files.mjs'

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')

export function buttonAcceptanceFailures(result) {
  const failures = []
  const cleanup = result.cleanup, capture = cleanup?.terminalCapture
  if (result.error || result.businessPassed !== true) failures.push('Button interaction did not complete')
  if (result.binarySHA256 !== result.expectedBinarySHA256 ||
      result.binarySHA256After !== result.expectedBinarySHA256 ||
      result.launchedBinarySHA256 !== result.expectedBinarySHA256) failures.push('Binary identity changed')
  if (cleanup?.verdict !== 'passed' || cleanup.paneDead !== true ||
      cleanup.tmuxKill?.status !== 0 || cleanup.socketRemove?.status !== 0 || result.socketExists !== false)
    failures.push('Owned terminal did not close normally')
  const completion = result.childCompletion, child = completion?.broker
  const absentOfficialProducer = result.mode === 'official' && child?.normalCompletion === false &&
    isDeepStrictEqual(child.failure, { type: 'JournalError', message: 'Foreign or absent native producer' })
  if (!child || !isDeepStrictEqual(child, completion.cleanup) ||
      child.captureId !== result.captureId || completion.launch?.captureId !== result.captureId ||
      completion.launch?.binarySha256 !== result.expectedBinarySHA256 ||
      completion.start?.binarySha256 !== result.expectedBinarySHA256 ||
      !Number.isSafeInteger(child.childPid) || child.childPid <= 0 || child.childPid !== completion.start?.childPid ||
      child.childExitCode !== 0 || child.childReaped !== true || child.physicalEof !== true ||
      !isDeepStrictEqual(child.signalsSent, []) || !isDeepStrictEqual(child.cleanupErrors, []) ||
      (!(child.normalCompletion === true && child.failure === null) && !absentOfficialProducer))
    failures.push('Original child completion did not pass')
  if (result.mode === 'local') {
    if (capture?.boundedVerdict !== 'passed' || capture.framePhysicalVerdict !== 'passed' ||
        capture.nativeResizeBracketsCovered !== true || !(capture.frameCount > 0) ||
        capture.eofPassed !== true || capture.nativeContentMatched !== true || capture.nativeIOMatched !== true ||
        capture.binarySha256 !== result.expectedBinarySHA256 || capture.captureId !== result.captureId)
      failures.push('Local native frame/resize evidence did not pass')
  } else if (result.mode !== 'official') failures.push('Unknown acceptance mode')
  return failures
}

function options(args) {
  const result = { mode: 'local' }, seen = new Set()
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--mode': 'mode', '--binary': 'binary', '--binary-sha256': 'expectedBinarySHA256',
      '--evidence-root': 'evidenceRoot' }[args[i]]
    if (!key || seen.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('Invalid or duplicate argument')
    seen.add(key); result[key] = args[i + 1]
  }
  if (!['local', 'official'].includes(result.mode) || !isAbsolute(result.binary ?? '') ||
      !isAbsolute(result.evidenceRoot ?? '') || !/^[a-f0-9]{64}$/.test(result.expectedBinarySHA256 ?? ''))
    throw Error('Usage: bun scripts/validate-mods-button295.mjs --binary /absolute/claude --binary-sha256 SHA256 --evidence-root /new/absolute/directory [--mode local|official]')
  return result
}

export async function validateButton(args) {
  const requested = options(args)
  assert.equal(hash(requested.binary), requested.expectedBinarySHA256, 'Binary differs before launch')
  mkdirSync(requested.evidenceRoot, { mode: 0o700 })
  // tmux sockets need a short path; retain the private run and link it from the report.
  const runtimeRoot = mkdtempSync('/private/tmp/mb-'), cache = join(runtimeRoot, 'cache'), plugin = join(runtimeRoot, 'plugin')
  for (const path of [cache, plugin, join(plugin, '.claude-plugin'), join(plugin, 'hooks')]) mkdirSync(path, { mode: 0o700 })
  const write = (name, value) => writeFileSync(join(requested.evidenceRoot, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  write('start.json', { ...requested, runtimeRoot, startedAt: new Date().toISOString(), driverPid: process.pid })
  writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'button-children-295', version: '0.1.0', description: 'Offline Button acceptance fixture' }))
  writeFileSync(join(plugin, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))
  writeFileSync(join(plugin, 'hooks/register.ts'), `let count=0,dispatches=0,last='none',saved,other;
export function register(on){
 on('session.start',async($,e,next)=>{await $.command.register({name:'button-test',description:'Open controlled Button test',immediate:true});return next(e)});
 on('command.run',{command:'button-test'},async($,e)=>{await $.ui.open({id:'button-children',title:'BUTTON_CHILDREN_NATIVE',focus:true,closeOnEscape:true});return {text:'BUTTON_NATIVE_OPENED'}});
 on('ui.press',async($,e,next)=>{dispatches++;await $.ui.log('BUTTON_PROBE_DISPATCH:'+e.element);await $.ui.invalidate('ui.render');return next(e)});
 on('ui.render',{component:'Pane'},($,e)=>{const {Box,Text,Button}=$.ui.resolve(e);return Box({flexDirection:'column',children:[
  Text({children:'BUTTON_COUNT='+count+'|DISPATCH='+dispatches+'|LAST='+last}),
  saved??=(Button({key:'save',label:'ACCESSIBLE_NAME_ONLY',autoFocus:true,children:['Save ',Text({dimColor:true,children:'2m'})],onPress:async press=>{count++;last=press.element;await $.ui.log('BUTTON_PROBE_CALLBACK:'+press.element);await $.ui.invalidate('ui.render')}})),
  other??=(Button({key:'other',label:'Other control',onPress:async press=>{count++;last=press.element;await $.ui.log('BUTTON_PROBE_CALLBACK:'+press.element);await $.ui.invalidate('ui.render')}}))
 ]})});
}`)
  const marks = [], snapshots = {}, positions = []
  let launch, cleanup, childCompletion, error, businessPassed = false
  const tmux = args => recordedBuiltinTmux(launch, args)
  const capture = () => tmux(['capture-pane', '-p', '-t', launch.target])
  const send = bytes => tmux(['send-keys', '-t', launch.target, '-l', bytes])
  const until = async (predicate, label, deadlineMs = 15000) => {
    const end = Date.now() + deadlineMs
    while (Date.now() < end) {
      const value = predicate()
      if (value) { marks.push(label); return value }
      await delay(20)
    }
    throw Error('Timed out: ' + label)
  }
  const painted = async (label, predicate) => {
    const text = await until(() => { const text = capture(); return predicate(text) && text }, label)
    snapshots[label] = text
    writeFileSync(join(requested.evidenceRoot, label + '.txt'), text, { flag: 'wx', mode: 0o600 })
    return text
  }
  const count = (value, last) => text => text.includes(`BUTTON_COUNT=${value}|DISPATCH=${value}|LAST=${last}`)
  const closed = text => !text.includes('BUTTON_COUNT=') && !text.includes('[ Save 2m ]') &&
    !text.includes('[ Other control ]') && isIdlePrompt(text)
  const position = text => text.split('\n').map((line, row) => ({ col: line.indexOf('[ Save 2m ]'), row })).find(cell => cell.col >= 0)
  try {
    launch = startBuiltinRun(parseArgs(['run-builtin', '--binary', requested.binary, '--cache', cache]), undefined, undefined, (run, env) => {
      env.ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929'; env.CLAUDE_CODE_NO_FLICKER = '1'
      const file = join(run, 'config/.claude.json'), config = JSON.parse(readFileSync(file))
      writeFileSync(file, JSON.stringify({ ...config, projects: { [join(run, 'project')]: { hasTrustDialogAccepted: true } } }))
    }, plugin)
    assert.equal(launch.binarySha256, requested.expectedBinarySHA256, 'Copied binary differs')
    await painted('ready', isIdlePrompt)
    send('/button-test\r')
    const opened = await painted('opened', text => count(0, 'none')(text) && text.includes('[ Save 2m ]') && isIdlePrompt(text))
    assert(!opened.includes('ACCESSIBLE_NAME_ONLY'), 'Explicit label replaced painted children')
    send('\r')
    await painted('cached-redraw-press', count(1, 'save'))
    send('\r')
    await painted('repeat-enter', count(2, 'save'))
    send('\t\r')
    await painted('batched-tab-enter', count(3, 'other'))
    let previous = position(capture())
    assert(previous, 'Button is painted before resize')
    for (const width of [144, 160]) {
      tmux(['resize-window', '-t', launch.target, '-x', String(width), '-y', '40'])
      const text = await painted('resize-' + width, text => {
        const next = position(text)
        return tmux(['display-message', '-p', '-t', launch.target, '#{pane_width}']).trim() === String(width) &&
          count(3, 'other')(text) && next && next.col !== previous.col
      })
      previous = position(text); positions.push({ columns: width, rows: 40, ...previous })
    }
    const hit = capture().split('\n').map((text, row) => ({ text, row })).find(line => line.text.includes('[ Save 2m ]'))
    assert(hit, 'Child text is painted before click')
    const col = hit.text.indexOf('2m') + 1, row = hit.row + 1
    positions.push({ label: 'child-mouse', col, row })
    send(`\x1b[<0;${col};${row}M\x1b[<0;${col};${row}m`)
    await painted('child-mouse', count(4, 'save'))
    send('\x1b')
    await painted('closed', closed)
    send('/button-test\r')
    await painted('reopened', text => count(4, 'save')(text) && text.includes('[ Save 2m ]') && isIdlePrompt(text))
    send('\r')
    await painted('reopened-press', count(5, 'save'))
    send('\x1b')
    await painted('closed-again', closed)
    businessPassed = true
  } catch (caught) { error = String(caught?.stack ?? caught) }
  finally {
    if (launch) {
      try {
        if (error) send('\x1b\x15')
        send('/exit\r')
        await until(() => tmux(['display-message', '-p', '-t', launch.target, '#{pane_dead}']).trim() === '1', 'normal-child-exit')
      } catch (caught) { error ??= String(caught?.stack ?? caught) }
      cleanup = await cleanupAcceptanceSide(launch, { close: async () => {} })
      try {
        childCompletion = {}
        for (const [key, name] of Object.entries({ start: 'start.json', launch: 'launch.json',
          broker: 'broker-cleanup.json', cleanup: 'cleanup.json' })) {
          childCompletion[key] = JSON.parse(readOwnedNativeFile(join(launch.run, name), 0o600))
        }
      } catch (caught) { error ??= String(caught?.stack ?? caught) }
    }
  }
  const result = { ...requested, binarySHA256: requested.expectedBinarySHA256, binarySHA256After: hash(requested.binary),
    launchedBinarySHA256: launch?.binarySha256, runtimeRoot, run: launch?.run, captureId: launch?.capture.captureId,
    target: launch?.target, pane: launch?.pane, marks, positions, snapshots, cleanup, childCompletion, error, businessPassed,
    socketExists: launch ? existsSync(launch.socket) : null,
    provider: 'none: closed loopback; cleanup provider hook is a no-op',
    fullReleasePassed: false, fullNativeGatePassed: false, actualInputOwnerCovered: false, productTimingEquivalent: false,
    physicalScope: requested.mode === 'local' ? 'bounded native frame/resize replay' : 'not covered: official has no local logical-frame producer' }
  result.failures = buttonAcceptanceFailures(result)
  result.verdict = result.failures.length ? 'failed' : 'passed'
  write('result.json', result)
  console.log('BUTTON_ACCEPTANCE_REPORT=' + join(requested.evidenceRoot, 'result.json'))
  if (result.failures.length) throw Error(result.failures.join('; '))
  return result
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await validateButton(process.argv.slice(2))
}

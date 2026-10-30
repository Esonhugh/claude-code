#!/usr/bin/env python3
"""Multi-turn tmux sweep. usage: drive.py <bin> <label> [--mod] [--port N]
Runs one long conversation against fake-mt.ts, then /exit and --continue.
Writes <out>/result.json with per-step pass/fail and timings."""
import json, os, re, subprocess, sys, time, glob, shutil

BIN, LABEL = sys.argv[1], sys.argv[2]
MOD = '--mod' in sys.argv
PORT = int(sys.argv[sys.argv.index('--port') + 1]) if '--port' in sys.argv else 18820
ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = f'{ROOT}/out/{LABEL}'
HOME, WORK = f'{OUT}/home', f'{OUT}/work'
S = f'mt-{LABEL}'
FJ = f'{OUT}/fake.jsonl'

def sh(*a, **k):
    return subprocess.run(a, capture_output=True, text=True, **k).stdout

def pane():
    return sh('tmux', 'capture-pane', '-p', '-t', S)

def cap(name):
    open(f'{OUT}/pane-{name}.txt', 'w').write(pane())

def keys(*k):
    for x in k:
        sh('tmux', 'send-keys', '-t', S, x); time.sleep(0.4)

def lit(t):
    sh('tmux', 'send-keys', '-t', S, '-l', t); time.sleep(0.6)

def fake_entries(since=0):
    try:
        lines = open(FJ).read().splitlines()
    except FileNotFoundError:
        return []
    out = []
    for l in lines:
        try:
            e = json.loads(l)
        except Exception:
            continue
        if e['n'] > since:
            out.append(e)
    return out

def last_n():
    e = fake_entries()
    return e[-1]['n'] if e else 0

def wait(pred, timeout):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = pred()
        if r:
            return r
        time.sleep(0.5)
    return None

def outs(since, role_re=r'^main'):
    return [e for e in fake_entries(since) if re.search(role_re, e['role'])]

def text_out(e):
    return e['out'] if isinstance(e['out'], str) else ''

def setup():
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(f'{HOME}/.claude/skills/mt-hello', exist_ok=True)
    os.makedirs(WORK)
    os.makedirs(OUT + '/req')
    subprocess.run(f'cd {WORK} && git init -q && echo base > base.txt && echo SECRET=1 > .env && git add base.txt && git -c user.email=t@t -c user.name=t commit -qm init', shell=True)
    json.dump({'hasCompletedOnboarding': True, 'theme': 'dark', 'bypassPermissionsModeAccepted': True, 'customApiKeyResponses': {'approved': ['sk-ant-fake']},
               'projects': {WORK: {'hasTrustDialogAccepted': True, 'hasCompletedProjectOnboarding': True}}},
              open(f'{HOME}/.claude.json', 'w'))
    hook = {'type': 'command', 'command': f"cat >> {OUT}/hooks.log; echo >> {OUT}/hooks.log"}
    events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SubagentStart',
              'SubagentStop', 'PreCompact', 'PostCompact', 'SessionEnd', 'TeammateIdle', 'TaskCreated', 'TaskCompleted']
    hooks = {e: [{'matcher': '', 'hooks': [hook]}] if e in ('PreToolUse', 'PostToolUse', 'PostToolUseFailure') else [{'hooks': [hook]}] for e in events}
    json.dump({'skipDangerousModePermissionPrompt': True, 'teammateMode': 'in-process', 'hooks': hooks},
              open(f'{HOME}/.claude/settings.json', 'w'))
    open(f'{HOME}/.claude/skills/mt-hello/SKILL.md', 'w').write('---\nname: mt-hello\ndescription: multi-turn probe skill\n---\n\nSKILLBODY: say hello.\n')

def launch(extra=''):
    sh('tmux', 'kill-session', '-t', S); time.sleep(0.5)
    plugin = f'--plugin-dir {ROOT}/hello-mod' if MOD else ''
    env = (f'env -i HOME={HOME} PATH=/usr/local/bin:/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8 IS_SANDBOX=1 '
           f'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 CLAUDE_CODE_WORKFLOWS=1 ANTHROPIC_BASE_URL=http://127.0.0.1:{PORT} '
           f'ANTHROPIC_API_KEY=sk-ant-fake ENABLE_TOOL_SEARCH={os.environ.get("TS", "false")} CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1')
    cmd = f'{env} {BIN} --dangerously-skip-permissions {plugin} --debug-file {OUT}/debug-{int(time.time())}.log {extra}; echo EXITED $?; sleep 600'
    sh('tmux', 'new-session', '-d', '-s', S, '-x', '140', '-y', '45', '-c', WORK, cmd)
    t0 = time.time()
    ok = wait(lambda: re.search(r'bypass permissions on|for shortcuts', pane()), 40)
    if not ok:
        p = pane()
        if 'Yes, I accept' in p:
            keys('Down', 'Enter'); ok = wait(lambda: 'bypass permissions on' in pane(), 20)
    time.sleep(1.5)
    return bool(ok), time.time() - t0

results = []
def record(step, ok, dt, detail=''):
    results.append({'step': step, 'ok': bool(ok), 'sec': round(dt, 1), 'detail': detail})
    print(f'[{LABEL}] {"PASS" if ok else "FAIL"} {step} {dt:.1f}s {detail}', flush=True)

NONCE = [0]
def turn(cmd, timeout=40):
    """send '@@ <nonce> CMD' and wait for 'DONE <nonce>'"""
    NONCE[0] += 1
    nonce = f'n{NONCE[0]}'
    since = last_n()
    t0 = time.time()
    keys('C-u'); lit(f'@@ {nonce} {cmd}'); keys('Enter')
    e = wait(lambda: next((x for x in outs(since) if text_out(x).startswith(f'DONE {nonce}')), None), timeout)
    return nonce, since, e, time.time() - t0

def notifs(since, pat, timeout):
    def f():
        for x in fake_entries(since):
            if x['role'].endswith(':notif') or x['role'].startswith('main'):
                pass
        blob = json.dumps([x for x in fake_entries(since)])
        return re.search(pat, blob)
    return wait(f, timeout)

def team_members():
    fs = glob.glob(f'{HOME}/.claude/teams/*/config.json')
    out = {}
    for f in fs:
        try:
            out[f.split('/')[-2]] = [m['name'] for m in json.load(open(f))['members']]
        except Exception as ex:
            out[f] = str(ex)
    return out

def hook_counts():
    c = {}
    try:
        for l in open(f'{OUT}/hooks.log'):
            l = l.strip()
            if not l:
                continue
            try:
                ev = json.loads(l).get('hook_event_name', '?')
            except Exception:
                ev = 'unparsed'
            c[ev] = c.get(ev, 0) + 1
    except FileNotFoundError:
        pass
    return c

ERR_RE = re.compile(r'TypeError|ReferenceError|undefined is not|Cannot read prop|Unhandled|ERROR\b|panic')
def pane_errors():
    return [l.strip() for l in pane().splitlines() if ERR_RE.search(l)]

def main():
    setup()
    fake = subprocess.Popen(['bun', f'{ROOT}/fake-mt.ts'], env={**os.environ, 'PORT': str(PORT), 'FAKE_LOG': f'{OUT}/fake.log', 'FAKE_JSONL': FJ, 'WORK': WORK, **({'FAKE_DUMP': OUT + '/req'} if os.environ.get('DUMP') else {})},
                            stdout=open(f'{OUT}/fake.out', 'w'), stderr=subprocess.STDOUT)
    time.sleep(1.5)
    errs = []
    try:
        ok, dt = launch()
        record('startup', ok, dt)
        cap('00-start')

        def simple(cmd, want, timeout=40, name=None):
            nonce, since, e, dt = turn(cmd, timeout)
            got = text_out(e) if e else ''
            record(name or cmd.split()[0], bool(e) and want in got, dt, got[:80] if e else 'timeout')
            errs.extend(pane_errors())
            return nonce, since, e

        simple('HELLO', 'hello')
        simple('ONE_SH', 'sh-ok')
        simple('PAR_SH', 'par 3')
        simple('MULTI_SH', 'multi-ok')
        nonce, _, _ = simple('EDIT_GO', 'edit-ok')
        try:
            content = open(f'{WORK}/edit-{nonce}.txt').read()
        except Exception as ex:
            content = str(ex)
        record('edit-file', content == 'bye\nworld\n', 0, repr(content))
        simple('GREP_GO', 'grep-ok')
        nonce, since, e = simple('FGQ', 'fg-', 60)
        r = wait(lambda: re.search('quick done fg', json.dumps(fake_entries(since))), 30)
        record('fg-result', r, 0, 'sync' if e and 'fg-ok' in text_out(e) else 'async')
        nonce, since, e = simple('BGQ 2', 'bg-spawned')
        t0 = time.time()
        r = wait(lambda: all(re.search(p, json.dumps(fake_entries(since))) for p in ['quick done b1', 'quick done b2']) and
                 any(x['role'].endswith(':notif') for x in fake_entries(since)), 40)
        record('bg-notify', r, time.time() - t0)
        time.sleep(3)
        nonce, since, e = simple('BGSH_FIN', 'bgsh-started')
        t0 = time.time()
        r = wait(lambda: any(x['role'].endswith(':notif') for x in fake_entries(since)) and re.search(r'finite bg.{0,20} completed', json.dumps(fake_entries(since))), 30)
        record('bgsh-notify', r, time.time() - t0)
        time.sleep(2)
        nonce, since, e = simple('NESTQ', 'nest-spawned')
        t0 = time.time()
        r = wait(lambda: re.search('nodeq done', json.dumps(fake_entries(since))) and any(x['role'].endswith(':notif') for x in fake_entries(since)), 45)
        record('nest-notify', r, time.time() - t0)
        time.sleep(2)
        nonce, since, e = simple('SUB_RES', 'resume-ok', 60)
        t0 = time.time()
        r = wait(lambda: any(x['role'] == 'subq' and 'subq reply' in text_out(x) and x['msgs'] > 1 for x in fake_entries(since)), 30)
        record('resume-ran', r, time.time() - t0)
        time.sleep(3)
        nonce, since, e = simple('TEAM_UP 2', 'team-up', 60)
        time.sleep(4)
        m = team_members()
        record('team-members', any(set(['mate1', 'mate2']) <= set(v) for v in m.values() if isinstance(v, list)), 0, json.dumps(m))
        cap('team-up')
        nonce, since, e = simple('TEAM_DOWN', 'shutdown-sent', 60)
        t0 = time.time()
        r = wait(lambda: (lambda m: m and all(isinstance(v, list) and not any(x.startswith('mate') for x in v) for v in m.values()))(team_members()), 40)
        record('team-shutdown', r, time.time() - t0, json.dumps(team_members()))
        time.sleep(2)
        nonce, since, e = simple('WF_GO', 'wf-', 60)
        t0 = time.time()
        r = wait(lambda: re.search('PONG', json.dumps([x for x in fake_entries(since) if x['role'].startswith('main')])), 60)
        record('wf-result', r, time.time() - t0)
        cap('wf')
        time.sleep(2)
        simple('SKILL_GO', 'skill-ok')
        if MOD:
            simple('ENV_READ', 'mod-deny', name='mod-tool-deny')
            since = last_n(); t0 = time.time()
            keys('C-u'); lit('/hello-mod'); time.sleep(0.8); keys('Enter')
            r = wait(lambda: 'Hello from my first mod' in pane(), 15)
            record('mod-command', r, time.time() - t0)
            cap('mod-cmd')
        # compaction mid conversation
        since = last_n(); t0 = time.time()
        keys('C-u'); lit('/compact'); time.sleep(0.8); keys('Enter')
        r = wait(lambda: re.search(r'Compacted|compacted|Conversation compacted', pane()), 60)
        record('compact', r, time.time() - t0)
        cap('compact')
        time.sleep(2)
        simple('MULTI_SH', 'multi-ok', name='post-compact-multi')
        simple('BGQ 1', 'bg-spawned', name='post-compact-bg')
        time.sleep(8)
        # /context and /cost style dialogs should render without error
        for c in ['/context', '/usage', '/tasks']:
            keys('C-u'); lit(c); time.sleep(0.8); keys('Enter'); time.sleep(2.5)
            cap(c.strip('/'))
            p = pane()
            record('slash-' + c.strip('/'), not ERR_RE.search(p) and 'Unknown' not in p, 0)
            keys('Escape'); time.sleep(1)
        # exit + continue
        t0 = time.time()
        keys('C-u'); lit('/exit'); time.sleep(0.8); keys('Enter')
        r = wait(lambda: 'EXITED' in pane() or 'Background work' in pane(), 20)
        if r and 'Background work' in pane():
            cap('exit-dialog'); keys('Enter')
            r = wait(lambda: 'EXITED' in pane(), 20)
        record('exit', r, time.time() - t0, (re.search(r'EXITED \d+', pane()) or [''])[0])
        time.sleep(1)
        record('sessionend-hook', hook_counts().get('SessionEnd', 0) >= 1, 0)
        before = hook_counts()
        ok, dt = launch('--continue')
        record('continue-start', ok, dt)
        nonce, since, e = turn('HELLO')[0:3] if False else turn('HELLO')[:3]
        record('continue-history', bool(e) and e['msgs'] > 10, 0, f"msgs={e['msgs'] if e else None}")
        keys('C-u'); lit('/exit'); time.sleep(0.8); keys('Enter')
        wait(lambda: 'EXITED' in pane(), 20)
    finally:
        cap('zz-final')
        sh('tmux', 'kill-session', '-t', S)
        fake.terminate()
        hc = hook_counts()
        first_main = next((x for x in fake_entries() if x['role'].startswith('main') and x.get('tools')), {})
        json.dump({'label': LABEL, 'bin': BIN, 'results': results, 'hooks': hc, 'pane_errors': sorted(set(errs)),
                   'tools': first_main.get('tools'), 'sysLen': first_main.get('sysLen'), 'model': first_main.get('model'),
                   'requests': len(fake_entries())}, open(f'{OUT}/result.json', 'w'), indent=1)
        print(f'[{LABEL}] pass {sum(r["ok"] for r in results)}/{len(results)} hooks={hc}')

main()

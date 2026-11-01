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
S = f'ld-{LABEL}'
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

def rss():
    try:
        pids = sh('pgrep', '-f', f'{BIN} --dangerously').split()
        return sum(int(open(f'/proc/{p}/status').read().split('VmRSS:')[1].split()[0]) for p in pids) // 1024
    except Exception:
        return -1

ROUNDS = int(os.environ.get('ROUNDS', '3'))
def main():
    setup()
    fake = subprocess.Popen(['bun', f'{ROOT}/fake3.ts'], env={**os.environ, 'PORT': str(PORT), 'FAKE_LOG': f'{OUT}/fake.log', 'FAKE_JSONL': FJ, 'WORK': WORK},
                            stdout=open(f'{OUT}/fake.out', 'w'), stderr=subprocess.STDOUT)
    time.sleep(1.5)
    errs = []; mem = []; lat = {}
    try:
        ok, dt = launch()
        record('startup', ok, dt)
        def simple(cmd, want, timeout=40, name=None):
            nonce, since, e, dt = turn(cmd, timeout)
            got = text_out(e) if e else ''
            key = name or cmd.split()[0]
            lat.setdefault(key, []).append(round(dt, 2))
            record(key, bool(e) and want in got, dt, got[:80] if e else 'timeout')
            errs.extend(pane_errors())
            return nonce, since, e
        for r in range(ROUNDS):
            simple('HELLO', 'hello'); simple('ONE_SH', 'sh-ok'); simple('PAR_SH', 'par 3'); simple('MULTI_SH', 'multi-ok')
            nonce, _, _ = simple('EDIT_GO', 'edit-ok')
            try: content = open(f'{WORK}/edit-{nonce}.txt').read()
            except Exception as ex: content = str(ex)
            record('edit-file', content == 'bye\nworld\n', 0, repr(content))
            simple('GREP_GO', 'grep-ok'); simple('TOOL_ERR', 'err-ok'); simple('BIG_OUT', 'big-ok', 60)
            simple('FGQ', 'fg-', 60)
            nonce, since, e = simple('BGQ 1', 'bg-spawned')
            t0 = time.time()
            rr = wait(lambda: re.search('quick done b1', json.dumps(fake_entries(since))) and any(x['role'].endswith(':notif') for x in fake_entries(since)), 40)
            record('bg-notify', rr, time.time() - t0); time.sleep(2)
            mem.append(rss()); cap(f'round{r}')
        # Esc during a running tool
        NONCE[0] += 1; nonce = f'n{NONCE[0]}'; since = last_n(); t0 = time.time()
        keys('C-u'); lit(f'@@ {nonce} SLOW_SH'); keys('Enter')
        wait(lambda: any(x['role'] == 'main:SLOW_SH' for x in fake_entries(since)), 15); time.sleep(2.5)
        cap('slow-running'); keys('Escape')
        rr = wait(lambda: re.search(r'Interrupted', pane()), 10)
        record('esc-tool-interrupt', rr, time.time() - t0); cap('slow-interrupted')
        time.sleep(1.5)
        n2, s2, e2, _ = turn('INT_SEE')
        record('after-interrupt-turn', bool(e2), 0, text_out(e2)[:300] if e2 else 'timeout')
        # Esc during streaming text, then a new turn
        NONCE[0] += 1; nonce = f'n{NONCE[0]}'; since = last_n()
        keys('C-u'); lit(f'@@ {nonce} SLOW_TXT'); keys('Enter'); time.sleep(3); keys('Escape')
        rr = wait(lambda: re.search(r'Interrupted', pane()), 10); cap('stream-interrupted')
        record('esc-stream-interrupt', rr, 0)
        time.sleep(1); simple('HELLO', 'hello', name='after-stream-int')
        # queued input while busy
        NONCE[0] += 1; n1 = f'n{NONCE[0]}'; NONCE[0] += 1; n2 = f'n{NONCE[0]}'; since = last_n(); t0 = time.time()
        keys('C-u'); lit(f'@@ {n1} SLOW_TXT'); keys('Enter'); time.sleep(2)
        lit(f'@@ {n2} HELLO'); keys('Enter'); time.sleep(0.5); cap('queued')
        rr = wait(lambda: (lambda o: any(text_out(x).startswith(f'DONE {n1}') for x in o) and any(text_out(x).startswith(f'DONE {n2}') for x in o))(outs(since)), 40)
        order = [text_out(x)[:9] for x in outs(since) if text_out(x).startswith('DONE')]
        record('queued-input', rr, time.time() - t0, json.dumps(order))
        # AskUserQuestion
        NONCE[0] += 1; nonce = f'n{NONCE[0]}'; since = last_n(); t0 = time.time()
        keys('C-u'); lit(f'@@ {nonce} ASKQ'); keys('Enter')
        rr = wait(lambda: 'Which flavor' in pane(), 20); cap('askq')
        if rr: keys('Down'); time.sleep(0.5); keys('Enter'); time.sleep(1); cap('askq-2')
        if rr and re.search(r'Submit|Review your answers', pane()): keys('Enter')
        e = wait(lambda: next((x for x in outs(since) if text_out(x).startswith(f'DONE {nonce}')), None), 20)
        record('askq', bool(e) and 'ask-ok' in text_out(e), time.time() - t0, text_out(e)[:80] if e else 'timeout')
        # bash mode (!)
        keys('C-u'); lit('!'); time.sleep(0.5); lit('echo bang-out-77'); keys('Enter'); time.sleep(3); cap('bang')
        simple('BANG_SEE', 'bang-ok')
        keys('C-u', 'Up'); time.sleep(0.8)
        record('history-up', 'BANG_SEE' in pane().split('\n❯')[-1] if '❯' in pane() else 'BANG_SEE' in pane(), 0); cap('hist'); keys('Down'); time.sleep(0.5); keys('C-u')
        # multi-line input via backslash-enter
        NONCE[0] += 1; nonce = f'n{NONCE[0]}'; since = last_n()
        keys('C-u'); lit(f'@@ {nonce} ML_SEE\\'); keys('Enter'); lit('line2-marker'); keys('Enter')
        e = wait(lambda: next((x for x in outs(since) if text_out(x).startswith(f'DONE {nonce}')), None), 20)
        record('multiline', bool(e) and 'ml-ok' in text_out(e), 0, text_out(e)[:60] if e else 'timeout')
        # /model switch
        keys('C-u'); lit('/model haiku'); time.sleep(0.8); keys('Enter'); time.sleep(2); cap('model')
        if 'Switch model?' in pane(): keys('Enter'); time.sleep(1.5)
        record('model-confirm-dialog', True, 0, 'shown' if 'Switch model?' in open(f'{OUT}/pane-model.txt').read() else 'none')
        simple('MODEL_SEE', 'haiku')
        keys('C-u'); lit('/model default'); time.sleep(0.8); keys('Enter'); time.sleep(2)
        if 'Switch model?' in pane(): keys('Enter'); time.sleep(1.5)
        # /clear
        keys('C-u'); lit('/clear'); time.sleep(0.8); keys('Enter'); time.sleep(2)
        nonce, since, e = simple('CLEAR_SEE', 'msgs=')
        record('clear-reset', bool(e) and int(text_out(e).split('msgs=')[1].split()[0]) <= 3, 0, text_out(e)[:40] if e else '')
        simple('ONE_SH', 'sh-ok', name='post-clear-sh')
        mem.append(rss())
        # ctrl+c ctrl+c exit
        before = hook_counts().get('SessionEnd', 0); t0 = time.time()
        keys('C-u', 'C-c'); time.sleep(0.3); keys('C-c')
        rr = wait(lambda: 'EXITED' in pane(), 15)
        record('ctrlc-exit', rr, time.time() - t0, (re.search(r'EXITED \d+', pane()) or [''])[0])
        time.sleep(1)
        record('ctrlc-sessionend', hook_counts().get('SessionEnd', 0) > before, 0)
        # --resume picker
        ok, dt = launch('--resume')
        p = pane(); cap('resume-picker')
        if not ok and re.search(r'Resume Session|Search|\d+ (messages|minutes|seconds)', p):
            keys('Enter'); ok = wait(lambda: re.search(r'bypass permissions on|for shortcuts', pane()), 20)
        record('resume-start', ok, dt)
        nonce, since, e, _ = turn('HELLO')
        record('resume-history', bool(e) and e['msgs'] > 3, 0, f"msgs={e['msgs'] if e else None}")
        keys('C-u'); lit('/exit'); time.sleep(0.8); keys('Enter'); wait(lambda: 'EXITED' in pane(), 20)
    finally:
        cap('zz-final')
        sh('tmux', 'kill-session', '-t', S)
        fake.terminate()
        hc = hook_counts()
        json.dump({'label': LABEL, 'bin': BIN, 'results': results, 'hooks': hc, 'pane_errors': sorted(set(errs)), 'rss_mb': mem, 'lat': lat,
                   'requests': len(fake_entries())}, open(f'{OUT}/result.json', 'w'), indent=1)
        print(f'[{LABEL}] pass {sum(r["ok"] for r in results)}/{len(results)} rss={mem} hooks={hc}')

main()

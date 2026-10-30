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
S = f'cd-{LABEL}'
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


def main():
    setup()
    global fake
    fake = subprocess.Popen(['bun', f'{ROOT}/fake3.ts'], env={**os.environ, 'PORT': str(PORT), 'FAKE_LOG': f'{OUT}/fake.log', 'FAKE_JSONL': FJ, 'WORK': WORK, 'FAKE_DUMP': OUT + '/req'},
                            stdout=open(f'{OUT}/fake.out', 'w'), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
    time.sleep(2)
    try:
        ok, dt = launch(); record('start', ok, dt)
        for i, c in enumerate(os.environ.get('PRE', 'HELLO,HELLO').split(',')):
            n, s, e, dt = turn(c, 90); record(f'pre{i}-{c}', e, dt)
        if not os.environ.get('NOCOMPACT'):
            keys('C-u'); lit('/compact'); keys('Enter')
            r = wait(lambda: re.search(r'Compacted|compacted', pane()), 60); cap('compact'); record('compact', r, 0)
            time.sleep(2)
        n, s, e, dt = turn('HELLO'); record('post-compact', e, dt)
        open(f'{OUT}/mark-before-exit', 'w').write(str(last_n()))
        keys('C-u'); lit('/exit'); time.sleep(0.8); keys('Enter'); wait(lambda: 'EXITED' in pane(), 20)
        ok, dt = launch(os.environ.get('RESUME_ARG', '--continue')); record('continue', ok, dt)
        open(f'{OUT}/mark-after-continue', 'w').write(str(last_n()))
        n, s, e, dt = turn('HELLO'); record('post-continue', e, dt)
        cap('final')
        keys('C-u'); lit('/exit'); time.sleep(0.8); keys('Enter'); wait(lambda: 'EXITED' in pane(), 20)
    finally:
        sh('tmux', 'kill-session', '-t', S)
        os.killpg(fake.pid, 15)

main()

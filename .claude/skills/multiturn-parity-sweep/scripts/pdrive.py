#!/usr/bin/env python3
"""Permission-mode transition sweep. usage: pdrive.py <bin> <label> [--port N]
Starts in default mode (no bypass flag), answers prompts yes/no/always, cycles Shift+Tab,
runs plan mode + ExitPlanMode, /permissions, /exit + --continue. Writes out/<label>/presult.json."""
import json, os, re, subprocess, sys, time, shutil

BIN, LABEL = sys.argv[1], sys.argv[2]
PORT = int(sys.argv[sys.argv.index('--port') + 1]) if '--port' in sys.argv else 18823
ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = f'{ROOT}/out/{LABEL}'
HOME, WORK = f'{OUT}/home', f'{OUT}/work'
S = f'pm-{LABEL}'
FJ = f'{OUT}/fake.jsonl'

def sh(*a):
    return subprocess.run(a, capture_output=True, text=True).stdout
def tm(*a):
    return sh('tmux', '-L', S, *a)
def pane():
    return tm('capture-pane', '-p', '-t', S)
def cap(name):
    open(f'{OUT}/pane-{name}.txt', 'w').write(pane())
def keys(*k):
    for x in k:
        tm('send-keys', '-t', S, x); time.sleep(0.5)
def lit(t):
    tm('send-keys', '-t', S, '-l', t); time.sleep(0.6)
def wait(pred, timeout):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = pred()
        if r:
            return r
        time.sleep(0.4)
    return None
def entries():
    try:
        return [json.loads(l) for l in open(FJ).read().splitlines() if l.strip()]
    except FileNotFoundError:
        return []
def last_n():
    e = entries(); return e[-1]['n'] if e else 0
def hooks():
    out = []
    try:
        for l in open(f'{OUT}/hooks.log'):
            l = l.strip()
            if l:
                try: out.append(json.loads(l))
                except Exception: pass
    except FileNotFoundError:
        pass
    return out

MODE_RE = [('acceptEdits', r'accept edits on'), ('plan', r'plan mode on'), ('bypassPermissions', r'bypass permissions on'),
           ('auto', r'auto mode on'), ('dontAsk', r"don't ask on")]
def footer_mode():
    tail = '\n'.join([l for l in pane().splitlines() if l.strip()][-4:])
    for m, r in MODE_RE:
        if re.search(r, tail, re.I):
            return m
    return 'default'

PROMPT_RE = re.compile(r'Do you want to (proceed|make this edit|create|allow)|Would you like to proceed|Ready to code\?|Exit plan mode\?|Enter plan mode\?')
def setup():
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(f'{HOME}/.claude', exist_ok=True); os.makedirs(WORK)
    subprocess.run(f'cd {WORK} && git init -q && echo base > base.txt && git add . && git -c user.email=t@t -c user.name=t commit -qm init', shell=True)
    json.dump({'hasCompletedOnboarding': True, 'theme': 'dark', 'bypassPermissionsModeAccepted': True, 'customApiKeyResponses': {'approved': ['sk-ant-fake']},
               'projects': {WORK: {'hasTrustDialogAccepted': True, 'hasCompletedProjectOnboarding': True}}}, open(f'{HOME}/.claude.json', 'w'))
    hook = {'type': 'command', 'command': f"cat >> {OUT}/hooks.log; echo >> {OUT}/hooks.log"}
    evs = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop']
    hk = {e: [{'matcher': '', 'hooks': [hook]}] for e in evs}
    json.dump({'planModeAvailable': True, 'hooks': hk}, open(f'{HOME}/.claude/settings.json', 'w'))

def launch(extra='', flags=''):
    tm('kill-server'); time.sleep(0.5)
    env = (f'env -i HOME={HOME} PATH=/usr/local/bin:/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8 IS_SANDBOX=1 '
           f'ANTHROPIC_BASE_URL=http://127.0.0.1:{PORT} ANTHROPIC_API_KEY=sk-ant-fake ENABLE_TOOL_SEARCH=false '
           f'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1')
    cmd = f'{env} {BIN} {flags} --permission-mode default --debug-file {OUT}/debug-{int(time.time())}.log {extra}; echo EXITED $?; sleep 600'
    tm('new-session', '-d', '-s', S, '-x', '140', '-y', '45', '-c', WORK, cmd)
    ok = wait(lambda: re.search(r'for shortcuts|accept edits|plan mode|bypass permissions|auto mode', pane()), 40)
    time.sleep(4)
    return bool(ok)

results = []
def record(step, ok, detail=''):
    results.append({'step': step, 'ok': bool(ok), 'detail': detail})
    print(f'[{LABEL}] {"PASS" if ok else "FAIL"} {step} {detail}', flush=True)

NONCE = [0]
def turn(cmd, answer=None, timeout=30, tag=None):
    """Send a command; answer=None (expect no prompt) | 'yes' | 'no' | 'always' | 'opt:<n>'.
    Returns dict(prompted, prompt_text, done_text, nonce)."""
    NONCE[0] += 1
    nonce = f'n{NONCE[0]}'; since = last_n()
    keys('C-u'); lit(f'@@ {nonce} {cmd}'); keys('Enter')
    def done():
        return next((x for x in entries() if x['n'] > since and isinstance(x.get('out'), str) and x['out'].startswith(f'DONE {nonce}')), None)
    prompted, ptxt = False, ''
    t0 = time.time()
    while time.time() - t0 < timeout:
        e = done()
        if e:
            break
        p = pane()
        if PROMPT_RE.search(p) and not prompted:
            prompted = True; time.sleep(0.6); p = pane(); ptxt = p
            cap(f'{tag or nonce}-prompt')
            a = answer or 'yes'
            if a == 'yes': keys('Enter')
            elif a == 'no': keys('Escape')
            elif a == 'always': keys('Down', 'Enter')
            elif a.startswith('opt:'): keys(*(['Down'] * (int(a[4:]) - 1)), 'Enter')
        # interrupted turns never reach DONE: detect idle prompt with interrupt marker
        if prompted and answer == 'no' and re.search(r'Interrupted|What should Claude do instead', p):
            time.sleep(1.0)
            break
        time.sleep(0.4)
    e = done()
    cap(tag or nonce)
    return {'nonce': nonce, 'prompted': prompted, 'prompt': ptxt, 'done': e['out'] if e else None, 'since': since}

def prompt_options(txt):
    return [re.sub(r'\s+', ' ', l.strip(' │❯>')).strip() for l in txt.splitlines() if re.match(r'^\s*[│ ]*[❯>]?\s*\d\.\s', l)]

def shift_tab():
    keys('BTab'); time.sleep(0.8)
    return footer_mode()

def last_hook(ev, since_idx):
    hs = hooks()[since_idx:]
    return [h for h in hs if h.get('hook_event_name') == ev]

def main():
    setup()
    fake = subprocess.Popen(['bun', f'{ROOT}/pfake.ts'], env={**os.environ, 'PORT': str(PORT), 'FAKE_LOG': f'{OUT}/fake.log', 'FAKE_JSONL': FJ, 'WORK': WORK},
                            stdout=open(f'{OUT}/fake.out', 'w'), stderr=subprocess.STDOUT)
    time.sleep(1.5)
    try:
        record('startup', launch(), footer_mode())
        cap('00-start')
        record('start-mode-default', footer_mode() == 'default', footer_mode())

        h0 = len(hooks()); r = turn('PREAD')
        record('read-no-prompt', not r['prompted'] and r['done'] and 'ok' in r['done'], str(r['done']))
        pm = [h.get('permission_mode') for h in last_hook('PreToolUse', h0)]
        record('hook-mode-default', pm and pm[-1] == 'default', str(pm))

        h0 = len(hooks()); r = turn('PSH', 'yes', tag='psh-yes')
        record('bash-prompt-yes', r['prompted'] and os.path.exists(f"{WORK}/p-{r['nonce']}.txt"), str(r['done']))
        record('bash-prompt-options', bool(prompt_options(r['prompt'])), ' | '.join(prompt_options(r['prompt'])))
        pr = last_hook('PermissionRequest', h0)
        record('hook-permission-request', len(pr) == 1, json.dumps([x.get('type') + ':' + str(x.get('mode') or '') for x in pr[-1].get('permission_suggestions', [])]) if pr else '0')

        h0 = len(hooks()); r = turn('PSH', 'no', tag='psh-no')
        record('bash-prompt-no', r['prompted'] and not os.path.exists(f"{WORK}/p-{r['nonce']}.txt"), str(r['done']))
        pd = last_hook('PermissionDenied', h0); pf = last_hook('PostToolUseFailure', h0)
        record('deny-hooks', True, f'PermissionDenied={len(pd)} PostToolUseFailure={len(pf)}')
        time.sleep(1)
        r = turn('HELLO')
        record('after-deny-next-turn', r['done'] and 'hello' in r['done'], str(r['done']))

        r = turn('PSH', 'always', tag='psh-always')
        record('bash-prompt-always', r['prompted'] and os.path.exists(f"{WORK}/p-{r['nonce']}.txt"), str(r['done']))
        record('always-keeps-mode', footer_mode() == 'default', footer_mode())
        for i in range(6):
            if footer_mode() == 'default':
                break
            shift_tab()
        r = turn('PSH', None, tag='psh-after-always')
        record('bash-after-always', True, f"prompted={r['prompted']}")

        r = turn('PWRITE', 'yes', tag='write-default')
        record('write-prompt-default', r['prompted'] and os.path.exists(f"{WORK}/w-{r['nonce']}.txt"), ' | '.join(prompt_options(r['prompt'])))
        r = turn('PWRITE', 'always', tag='write-always')
        record('write-always', r['prompted'] and os.path.exists(f"{WORK}/w-{r['nonce']}.txt"), footer_mode())
        record('write-always-mode', footer_mode() == 'acceptEdits', footer_mode())
        for i in range(6):
            if footer_mode() == 'default':
                break
            shift_tab()

        m1 = shift_tab(); cap('mode-1')
        record('shift-tab-1', m1 == 'acceptEdits', m1)
        h0 = len(hooks()); r = turn('PWRITE', None, tag='write-accept')
        record('write-acceptEdits-no-prompt', not r['prompted'] and os.path.exists(f"{WORK}/w-{r['nonce']}.txt"), f"prompted={r['prompted']}")
        pm = [h.get('permission_mode') for h in last_hook('PreToolUse', h0)]
        record('hook-mode-acceptEdits', pm and pm[-1] == 'acceptEdits', str(pm))

        m2 = shift_tab(); cap('mode-2')
        record('shift-tab-2', m2 == 'plan', m2)
        h0 = len(hooks()); r = turn('PLAN_EXIT', 'no', timeout=40, tag='plan-exit')
        record('plan-write-prompted', r['prompted'], ' | '.join(prompt_options(r['prompt'])))
        record('plan-write-not-written', not os.path.exists(f"{WORK}/plan-{r['nonce']}.txt"), str(r['done']))
        time.sleep(1)
        r = turn('PLAN_EXIT', 'yes', timeout=40, tag='plan-exit2')
        # first prompt: the Write; answer yes; then the exit dialog
        ok2 = wait(lambda: PROMPT_RE.search(pane()) and re.search(r'plan mode\?|Ready to code', pane()), 10)
        if ok2:
            cap('plan-exit-dialog'); record('plan-exit-dialog', True, ' | '.join(prompt_options(pane())))
            keys('Enter'); time.sleep(2)
        else:
            record('plan-exit-dialog', 'exit:' in str(r['done']), str(r['done']))
        after_exit = footer_mode(); cap('after-plan-exit')
        record('mode-after-plan-exit', after_exit != 'plan', after_exit)
        pm = [h.get('permission_mode') for h in last_hook('PreToolUse', h0)]
        record('hook-mode-plan', pm and pm[0] == 'plan', str(pm))

        seq = [footer_mode()]
        for i in range(5):
            seq.append(shift_tab())
        record('cycle-no-bypass', 'bypassPermissions' not in seq, '>'.join(seq))
        for i in range(6):
            if footer_mode() == 'default':
                break
            shift_tab()
        h0 = len(hooks()); r = turn('ENTER_PLAN', 'yes', tag='enter-plan')
        time.sleep(1)
        record('enter-plan-tool', footer_mode() == 'plan', f"prompted={r['prompted']} mode={footer_mode()} {r['done']}")
        cap('after-enter-plan')
        for i in range(6):
            if footer_mode() == 'default':
                break
            shift_tab()
        record('plan-to-default', footer_mode() == 'default', footer_mode())

        keys('C-u'); lit('/permissions'); time.sleep(0.8); keys('Enter'); time.sleep(2.5)
        cap('permissions')
        keys('Escape'); time.sleep(1)
        shift_tab()
        keys('C-u'); lit('/exit'); time.sleep(0.8); keys('Enter')
        record('exit', wait(lambda: 'EXITED' in pane(), 20), '')
        launch('--continue')
        record('continue-mode', footer_mode() == 'default', footer_mode())
        r = turn('PSH mk', 'yes', tag='continue-mk')
        record('continue-prompts', r['prompted'], f"prompted={r['prompted']}")
        keys('C-u'); lit('/exit'); time.sleep(0.8); keys('Enter'); wait(lambda: 'EXITED' in pane(), 20)

        # phase B: bypass available
        launch('', '--allow-dangerously-skip-permissions')
        seq = [footer_mode()]
        for i in range(6):
            seq.append(shift_tab())
            if seq[-1] == 'bypassPermissions':
                break
        cap('cycle-to-bypass')
        record('cycle-reaches-bypass', seq[-1] == 'bypassPermissions', '>'.join(seq))
        h0 = len(hooks()); r = turn('PSH mk', None, tag='bypass-mk')
        record('bypass-no-prompt', not r['prompted'] and r['done'] and 'ok' in r['done'], f"prompted={r['prompted']} {r['done']}")
        pm = [h.get('permission_mode') for h in last_hook('PreToolUse', h0)]
        record('hook-mode-bypass', pm and pm[-1] == 'bypassPermissions', str(pm))
        seq2 = ['bypassPermissions']
        for i in range(6):
            seq2.append(shift_tab())
            if seq2[-1] == 'default':
                break
        cap('cycle-back')
        record('cycle-back-default', seq2[-1] == 'default', '>'.join(seq2))
        r = turn('PSH mk', 'no', tag='default-mk-no')
        record('default-prompts-again', r['prompted'], f"prompted={r['prompted']}")
        keys('C-u'); lit('/exit'); time.sleep(0.8); keys('Enter'); wait(lambda: 'EXITED' in pane(), 20)
    finally:
        cap('zz-final')
        tm('kill-server')
        fake.terminate()
        hs = hooks()
        modes = [(h.get('hook_event_name'), h.get('tool_name'), h.get('permission_mode')) for h in hs if h.get('hook_event_name') in ('PreToolUse', 'PermissionRequest', 'PermissionDenied')]
        json.dump({'label': LABEL, 'bin': BIN, 'results': results, 'hook_modes': modes}, open(f'{OUT}/presult.json', 'w'), indent=1)
        print(f'[{LABEL}] pass {sum(r["ok"] for r in results)}/{len(results)}')

main()

#!/usr/bin/env python3
"""Real-model multi-turn tmux sweep. usage: rdrive.py <bin> <label> [--model M]
Natural-language turns; measures whether the model reaches for the intended tool (hit) and whether
the outcome is right (pass). Uses the container OAuth credential (binary finds it itself)."""
import json, os, re, subprocess, sys, time, glob, shutil

BIN, LABEL = sys.argv[1], sys.argv[2]
MODEL = sys.argv[sys.argv.index('--model') + 1] if '--model' in sys.argv else 'claude-sonnet-5-5'
ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = f'{ROOT}/rout/{LABEL}'
HOME, WORK = f'{OUT}/home', f'{OUT}/work'
S = f'rt-{LABEL}'

def sh(*a):
    return subprocess.run(a, capture_output=True, text=True).stdout
def pane():
    return sh('tmux', 'capture-pane', '-p', '-t', S)
def cap(name):
    open(f'{OUT}/pane-{name}.txt', 'w').write(pane())
def keys(*k):
    for x in k:
        sh('tmux', 'send-keys', '-t', S, x); time.sleep(0.4)
def lit(t):
    sh('tmux', 'send-keys', '-t', S, '-l', t); time.sleep(0.6)
def wait(pred, timeout):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = pred()
        if r: return r
        time.sleep(1)
    return None

def setup():
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(f'{HOME}/.claude/skills/mt-hello', exist_ok=True)
    os.makedirs(WORK)
    subprocess.run(f'cd {WORK} && git init -q && echo "hello base" > base.txt && git add base.txt && git -c user.email=t@t -c user.name=t commit -qm init', shell=True)
    json.dump({'hasCompletedOnboarding': True, 'theme': 'dark', 'bypassPermissionsModeAccepted': True,
               'projects': {WORK: {'hasTrustDialogAccepted': True, 'hasCompletedProjectOnboarding': True}}},
              open(f'{HOME}/.claude.json', 'w'))
    hook = {'type': 'command', 'command': f"cat >> {OUT}/hooks.log; echo >> {OUT}/hooks.log"}
    events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop',
              'PreCompact', 'PostCompact', 'SessionEnd', 'TeammateIdle']
    hooks = {e: [{'matcher': '', 'hooks': [hook]}] if 'ToolUse' in e else [{'hooks': [hook]}] for e in events}
    json.dump({'skipDangerousModePermissionPrompt': True, 'teammateMode': 'in-process', 'hooks': hooks, 'model': MODEL},
              open(f'{HOME}/.claude/settings.json', 'w'))
    open(f'{HOME}/.claude/skills/mt-hello/SKILL.md', 'w').write('---\nname: mt-hello\ndescription: Greets the user with the project codeword. Use when the user asks for the mt-hello skill.\n---\n\nReply with the codeword ZEBRA-42 and nothing else.\n')

def launch(extra=''):
    sh('tmux', 'kill-session', '-t', S); time.sleep(0.5)
    env = (f'env -i HOME={HOME} PATH=/usr/local/bin:/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8 IS_SANDBOX=1 '
           f'HTTPS_PROXY={os.environ.get("HTTPS_PROXY", "")} NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt '
           f'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 CLAUDE_CODE_WORKFLOWS=1 DISABLE_AUTOUPDATER=1')
    cmd = f'{env} {BIN} --dangerously-skip-permissions --model {MODEL} {extra}; echo EXITED $?; sleep 600'
    sh('tmux', 'new-session', '-d', '-s', S, '-x', '150', '-y', '50', '-c', WORK, cmd)
    ok = wait(lambda: re.search(r'bypass permissions on|for shortcuts', pane()), 60)
    time.sleep(2)
    return bool(ok)

def transcript():
    fs = [f for f in glob.glob(f'{HOME}/.claude/projects/*/*.jsonl')]
    return max(fs, key=os.path.getmtime) if fs else None

def entries(path):
    out = []
    if not path: return out
    for l in open(path):
        try: out.append(json.loads(l))
        except Exception: pass
    return out

BUSY = re.compile(r'esc to interrupt|Running…|running\b.*agent|· thinking|\(\d+s ·')
def idle_for(sec):
    """pane not busy and transcript unchanged for `sec` seconds"""
    t = transcript(); m0 = os.path.getmtime(t) if t else 0
    t0 = time.time()
    while time.time() - t0 < sec:
        if BUSY.search(pane()): return False
        time.sleep(1)
    t = transcript(); m1 = os.path.getmtime(t) if t else 0
    return m0 == m1

def settle(timeout=240, quiet=8):
    t0 = time.time()
    time.sleep(3)
    while time.time() - t0 < timeout:
        if idle_for(quiet): return time.time() - t0
    return None

results = []
def record(step, hit, ok, dt, detail=''):
    results.append({'step': step, 'hit': bool(hit), 'ok': bool(ok), 'sec': round(dt or -1, 1), 'detail': detail})
    print(f'[{LABEL}] {step}: hit={bool(hit)} ok={bool(ok)} {dt and round(dt)}s {detail}', flush=True)

def tool_uses_since(n0):
    """tool_use blocks in the main transcript after entry index n0 -> list of (name, input)"""
    es = entries(transcript())[n0:]
    out = []
    for e in es:
        if e.get('type') == 'assistant':
            for b in e.get('message', {}).get('content', []) or []:
                if isinstance(b, dict) and b.get('type') == 'tool_use':
                    out.append((b['name'], b.get('input', {})))
    return out

def last_assistant_text(n0):
    es = entries(transcript())[n0:]
    t = ''
    for e in es:
        if e.get('type') == 'assistant':
            for b in e.get('message', {}).get('content', []) or []:
                if isinstance(b, dict) and b.get('type') == 'text': t = b['text']
    return t

def say(text, timeout=240, quiet=8):
    n0 = len(entries(transcript()))
    keys('C-u'); lit(text); keys('Enter')
    dt = settle(timeout, quiet)
    return n0, dt

def members():
    out = {}
    for f in glob.glob(f'{HOME}/.claude/teams/*/config.json'):
        try: out[f.split('/')[-2]] = [m['name'] for m in json.load(open(f))['members']]
        except Exception as ex: out[f] = str(ex)
    return out

def main():
    setup()
    try:
        record('startup', launch(), launch_ok := True, 0)
        n0, dt = say('How many files (excluding .git) are in the current directory? Answer with just the number.')
        tu = tool_uses_since(n0); txt = last_assistant_text(n0)
        record('R1-list', len(tu) > 0, re.search(r'\b1\b', txt), dt, f'{[t[0] for t in tu]} -> {txt[:60]!r}')
        n0, dt = say('Use a subagent (the Agent tool) to read base.txt and report back its exact contents.')
        tu = tool_uses_since(n0); txt = last_assistant_text(n0)
        record('R2-subagent', any(t[0] in ('Agent', 'Task') for t in tu), 'hello base' in txt, dt, f'{[t[0] for t in tu]}')
        n0, dt = say('Launch two background agents in parallel (run_in_background): one creates a.txt containing A, the other creates b.txt containing B. Do not wait for them; when their completion notifications arrive, tell me "both done".', timeout=300, quiet=15)
        settle(120, 15)
        tu = tool_uses_since(n0); txt = last_assistant_text(n0)
        bg = [t for t in tu if t[0] in ('Agent', 'Task') and t[1].get('run_in_background')]
        ok = os.path.exists(f'{WORK}/a.txt') and os.path.exists(f'{WORK}/b.txt')
        record('R3-bg-agents', len(bg) >= 2, ok and 'both done' in txt.lower(), dt, f'{[t[0] for t in tu]} files={ok} last={txt[:50]!r}')
        cap('r3')
        n0, dt = say('Run the shell command `sleep 6; echo BG-FINISHED` in the background (run_in_background), then once you get its completion notification, tell me its output.', timeout=180, quiet=12)
        settle(60, 12)
        tu = tool_uses_since(n0); txt = last_assistant_text(n0)
        record('R4-bg-bash', any(t[0] == 'Bash' and t[1].get('run_in_background') for t in tu), 'BG-FINISHED' in txt, dt, f'{[t[0] for t in tu]}')
        n0, dt = say('Spawn two teammates named alice and bob (Agent tool with the name parameter). alice creates alice.txt containing "alice", bob creates bob.txt containing "bob". After both report back, shut both of them down with a shutdown_request.', timeout=400, quiet=20)
        settle(180, 20)
        tu = tool_uses_since(n0)
        named = {t[1].get('name') for t in tu if t[0] == 'Agent' and t[1].get('name')}
        shut = [t for t in tu if t[0] == 'SendMessage' and 'shutdown' in json.dumps(t[1])]
        files = os.path.exists(f'{WORK}/alice.txt') and os.path.exists(f'{WORK}/bob.txt')
        mem = members()
        clean = mem and all(isinstance(v, list) and not ({'alice', 'bob'} & set(v)) for v in mem.values())
        record('R5-teammates', {'alice', 'bob'} <= named, files, dt, f'named={sorted(named)} files={files}')
        record('R5-shutdown', len(shut) >= 2, clean, 0, f'shut={len(shut)} members={mem}')
        cap('r5')
        n0, dt = say('Use the Workflow tool to run a tiny workflow: two agents in parallel, each returns one fruit name. Report both fruits.', timeout=400, quiet=20)
        settle(180, 20)
        tu = tool_uses_since(n0); txt = last_assistant_text(n0)
        record('R6-workflow', any(t[0] == 'Workflow' for t in tu), len(txt) > 0 and bool(re.search(r'apple|banana|mango|orange|grape|cherry|kiwi|pear|peach|lemon|lime|berry|melon|plum|fig|papaya|pineapple|apricot', txt, re.I)), dt, f'{[t[0] for t in tu]} {txt[:60]!r}')
        cap('r6')
        n0, dt = say('Use the mt-hello skill.')
        tu = tool_uses_since(n0); txt = last_assistant_text(n0)
        record('R7-skill', any(t[0] == 'Skill' for t in tu), 'ZEBRA-42' in txt, dt, f'{[t[0] for t in tu]} {txt[:40]!r}')
        keys('C-u'); lit('/compact'); keys('Enter')
        t0 = time.time(); r = wait(lambda: re.search(r'Compacted|compacted', pane()), 240)
        record('R8-compact', True, r, time.time() - t0)
        settle(60, 5)
        n0, dt = say('Without using any tools, list the .txt files that were created during this conversation (not base.txt).')
        txt = last_assistant_text(n0)
        got = [f for f in ['a.txt', 'b.txt', 'alice.txt', 'bob.txt'] if f in txt]
        record('R9-recall', True, len(got) == 4, dt, f'{got}')
        keys('C-u'); lit('/exit'); keys('Enter')
        r = wait(lambda: 'EXITED' in pane() or 'Background work' in pane(), 30)
        if r and 'Background work' in pane():
            keys('Enter'); r = wait(lambda: 'EXITED' in pane(), 30)
        record('exit', True, r, 0)
        ok = launch('--continue')
        n0, dt = say('What was the content of base.txt that the subagent reported earlier? Answer without tools.')
        record('R10-continue', ok, 'hello base' in last_assistant_text(n0), dt)
        keys('C-u'); lit('/exit'); keys('Enter'); wait(lambda: 'EXITED' in pane(), 30)
    finally:
        cap('zz-final')
        sh('tmux', 'kill-session', '-t', S)
        hc = {}
        try:
            for l in open(f'{OUT}/hooks.log'):
                l = l.strip()
                if l:
                    try: ev = json.loads(l).get('hook_event_name')
                    except Exception: ev = '?'
                    hc[ev] = hc.get(ev, 0) + 1
        except FileNotFoundError: pass
        json.dump({'label': LABEL, 'bin': BIN, 'model': MODEL, 'results': results, 'hooks': hc}, open(f'{OUT}/result.json', 'w'), indent=1)
        print(f'[{LABEL}] hit {sum(r["hit"] for r in results)}/{len(results)} ok {sum(r["ok"] for r in results)}/{len(results)} hooks={hc}', flush=True)

main()

#!/usr/bin/env python3
"""Drive a Claude Code binary through a Code Mode scenario against mock-api.ts.

usage: drive.py <binary> <scenario.json> [--label L] [--port N] [--keep]

The scenario's "drive" list is run in order. Each run gets its own
OUT=/tmp/cmx/conformance/run/<label> with an isolated HOME (CLAUDE_CONFIG_DIR
under it), a git work dir, a fake API key and no proxy variables. Results go to
OUT/result.json; mock requests to OUT/mock.jsonl, redacted bodies to OUT/req/.

Actions (one key each):
  {"launch": {"args": "...", "env": {...}, "mode": "default"}}   start in tmux; {{session}} in args = newest transcript id ({{label}} in files = the run label); env null unsets;
      "may_exit": true accepts a binary that exits at startup (check the pane next)
  {"turn": "CMD", "timeout": 60}       type "@@ <nonce> CMD", wait for "DONE <nonce>"
  {"send": "CMD"}                      type it, don't wait
  {"wait_req": {"cmd": C, "step": k, "timeout": s}}  wait until the mock served it
  {"wait_pane": "regex", "timeout": s} {"keys": ["Escape", ...]} {"type": "text"}
  {"sleep": s} {"capture": "name"} {"exit": true}
  {"headless": {"prompt": "...", "args": "...", "env": {...}, "as": "name"}}
  {"expect": {"name": N, "cmd": C, "step": k, "field": F, "match": RE, "absent": bool}}
      F: lastResult | lastUser | tools | lastResultBlocks | lastResultIsError | system | messages | out
         | tool:NAME (that tool's description and input schema)
      "role": RE instead of "cmd" matches subagent/side/notif requests (wait_req too); "nth": i picks one (default -1)
  {"expect_same": {"name": N, "a": CMD, "b": CMD, "step": k, "fields": [...]}}  two requests agree
  {"expect_gap": {"name": N, "cmd": C, "from": 0, "to": 1, "min": s, "max": s}}  seconds between two steps
  {"expect_pane": {"name": N, "match": RE, "absent": bool}}
  {"expect_file": {"name": N, "path": P, "match": RE}}       P relative to WORK
  {"expect_transcript": {"name": N, "match": RE, "absent": bool}}
  {"expect_headless": {"name": N, "as": name, "match": RE, "absent": bool}}
"""
import glob, json, os, re, shutil, subprocess, sys, time

ROOT = os.path.dirname(os.path.abspath(__file__))
FAKE_KEY = 'mock-key-not-a-secret-0123456789abcdef'
ERR_RE = re.compile(r'TypeError|ReferenceError|undefined is not|Cannot read prop|Unhandled|panic')


def sh(*a, **k):
    return subprocess.run(a, capture_output=True, text=True, **k).stdout


class Run:
    def __init__(self, binary, scenario_path, label, port, keep):
        self.bin = os.path.abspath(binary)
        self.scenario_path = os.path.abspath(scenario_path)
        self.sc = json.load(open(scenario_path))
        self.label = label or self.sc['name']
        self.port = port
        self.keep = keep
        # realpath: on macOS /tmp is /private/tmp, and project trust is keyed by the real cwd.
        self.out = os.path.realpath('/tmp/cmx/conformance/run') + f'/{self.label}'
        self.home, self.work = f'{self.out}/home', f'{self.out}/work'
        self.jsonl = f'{self.out}/mock.jsonl'
        self.session = f'cm-{self.label}'
        self.results, self.nonces, self.headless_out = [], {}, {}
        self.counter = 0
        self.mock = None

    # ---- setup
    def setup(self):
        shutil.rmtree(self.out, ignore_errors=True)
        cfg_dir = f'{self.home}/.claude'
        os.makedirs(cfg_dir)
        os.makedirs(self.work)
        os.makedirs(f'{self.out}/req')
        # {{label}} in a file's path or content is this run's label, for fixtures that name their own cwd.
        for rel, content in self.sc.get('files', {}).items():
            rel, content = rel.replace('{{label}}', self.label), content.replace('{{label}}', self.label)
            p = f'{self.work}/{rel}'
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, 'w').write(content)
        subprocess.run(f'cd {self.work} && git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init --allow-empty',
                       shell=True, check=True)
        state = {'hasCompletedOnboarding': True, 'theme': 'dark', 'bypassPermissionsModeAccepted': True,
                 'customApiKeyResponses': {'approved': [FAKE_KEY[-20:]], 'rejected': []},
                 'projects': {self.work: {'hasTrustDialogAccepted': True, 'hasCompletedProjectOnboarding': True}}}
        state.update(self.sc.get('globalConfig', {}))
        for p in (f'{self.home}/.claude.json', f'{cfg_dir}/.claude.json'):
            json.dump(state, open(p, 'w'))
        settings = self.sc.get('settings', {})
        settings.setdefault('skipDangerousModePermissionPrompt', True)
        json.dump(settings, open(f'{cfg_dir}/settings.json', 'w'))

    def start_mock(self):
        env = {**os.environ, 'PORT': str(self.port), 'MOCK_SCENARIO': self.scenario_path, 'MOCK_JSONL': self.jsonl,
               'MOCK_DUMP': f'{self.out}/req', 'WORK': self.work}
        self.mock = subprocess.Popen(['bun', f'{ROOT}/mock-api.ts'], env=env, stdout=open(f'{self.out}/mock.out', 'w'),
                                     stderr=subprocess.STDOUT)
        for _ in range(40):
            if 'up on' in open(f'{self.out}/mock.out').read():
                return
            time.sleep(0.25)
        raise RuntimeError('mock-api did not start')

    def base_env(self, extra):
        env = {'HOME': self.home, 'CLAUDE_CONFIG_DIR': f'{self.home}/.claude', 'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
               'TERM': 'xterm-256color', 'LANG': 'C.UTF-8', 'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{self.port}',
               'ANTHROPIC_API_KEY': FAKE_KEY, 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_AUTOUPDATER': '1',
               'DISABLE_TELEMETRY': '1', 'NO_PROXY': '127.0.0.1,localhost'}
        env.update(self.sc.get('env', {}))
        env.update(extra or {})
        return {k: v for k, v in env.items() if v is not None}
    # ---- tmux
    def pane(self):
        return sh('tmux', 'capture-pane', '-p', '-J', '-t', self.session, '-S', '-200')

    def keys(self, *ks):
        for k in ks:
            sh('tmux', 'send-keys', '-t', self.session, k)
            time.sleep(0.4)

    def type(self, t):
        sh('tmux', 'send-keys', '-t', self.session, '-l', t)
        time.sleep(0.6)

    def wait(self, pred, timeout):
        t0 = time.time()
        while time.time() - t0 < timeout:
            r = pred()
            if r:
                return r
            time.sleep(0.5)
        return None

    def latest_session(self):
        files = [p for p in glob.glob(f'{self.home}/.claude/projects/*/*.jsonl')]
        return os.path.basename(max(files, key=os.path.getmtime))[:-6] if files else ''

    def launch(self, spec):
        sh('tmux', 'kill-session', '-t', self.session)
        spec = {**spec, 'args': spec.get('args', '').replace('{{session}}', self.latest_session())}
        env = self.base_env(spec.get('env'))
        mode = spec.get('mode', 'default')
        envs = ' '.join(f"{k}='{v}'" for k, v in env.items())
        cmd = (f"env -i {envs} {self.bin} --permission-mode {mode} --debug-file {self.out}/debug-{int(time.time())}.log "
               f"{spec.get('args', '')}; echo EXITED $?; sleep 900")
        sh('tmux', 'new-session', '-d', '-s', self.session, '-x', '160', '-y', '50', '-c', self.work, cmd)
        ready = re.compile(r'for shortcuts|bypass permissions on|accept edits on|auto mode on|\? for')
        ok = self.wait(lambda: ready.search(self.pane()) or re.search(r'Yes, I accept|Do you trust', self.pane())
                       or (spec.get('may_exit') and 'EXITED' in self.pane()), 45)
        if ok and re.search(r'Yes, I accept', self.pane()):
            self.keys('Down', 'Enter')
            ok = self.wait(lambda: ready.search(self.pane()), 20)
        time.sleep(1.5)
        self.record('launch', bool(ok), self.pane()[-300:] if not ok else '')

    # ---- mock log
    def reqs(self):
        try:
            lines = open(self.jsonl).read().splitlines()
        except FileNotFoundError:
            return []
        out = []
        for l in lines:
            try:
                out.append(json.loads(l))
            except json.JSONDecodeError:
                pass
        return out

    def find_req(self, cmd, step=None, latest_nonce=True, role=None, nth=-1):
        if role is not None:  # subagent / side / notif requests, matched by role regex; nth picks one (default last)
            hits = [r for r in self.reqs() if re.search(role, r.get('role', '')) and (step is None or r.get('step') == step)]
            return hits[nth] if -len(hits) <= nth < len(hits) else None
        nonce = self.nonces.get(cmd) if latest_nonce else None
        hits = [r for r in self.reqs() if r.get('cmd') == cmd and (step is None or r.get('step') == step)
                and (nonce is None or r.get('nonce') == nonce) and not r.get('role', '').endswith(':notif')]
        return hits[-1] if hits else None

    def body_of(self, r):
        return json.load(open(f"{self.out}/req/req-{r['n']:04d}.json"))

    def system_of(self, r):
        s = self.body_of(r).get('system')
        return s if isinstance(s, str) else '\n'.join(b.get('text', '') for b in (s or []))

    def send(self, cmd):
        self.counter += 1
        nonce = f'n{self.counter}'
        self.nonces[cmd] = nonce
        self.keys('C-u')
        self.type(f'@@ {nonce} {cmd}')
        self.keys('Enter')
        return nonce

    def turn(self, cmd, timeout):
        nonce = self.send(cmd)
        t0 = time.time()
        r = self.wait(lambda: next((x for x in self.reqs() if isinstance(x.get('out'), str)
                                    and x['out'].startswith(f'DONE {nonce}')), None), timeout)
        self.record(f'turn {cmd}', bool(r), (r or {}).get('out', 'timeout')[:200], time.time() - t0)

    def headless(self, spec):
        env = self.base_env(spec.get('env'))
        args = ['env', '-i', *[f'{k}={v}' for k, v in env.items()], self.bin, '-p', spec['prompt'], '--output-format',
                'stream-json', '--verbose', *spec.get('args', '').split()]
        p = subprocess.run(args, capture_output=True, text=True, cwd=self.work, timeout=spec.get('timeout', 120))
        name = spec.get('as', 'headless')
        self.headless_out[name] = p.stdout + p.stderr
        open(f'{self.out}/headless-{name}.txt', 'w').write(self.headless_out[name])
        self.record(f'headless {name}', True, f'exit={p.returncode}')

    # ---- results
    def record(self, name, ok, detail='', sec=0.0):
        self.results.append({'step': name, 'ok': bool(ok), 'sec': round(sec, 1), 'detail': detail})
        print(f'[{self.label}] {"PASS" if ok else "FAIL"} {name} {detail[:160]!r}', flush=True)

    def check(self, name, value, spec):
        # Without a pattern the check is only that the value exists.
        found = value is not None and ('match' not in spec or re.search(spec['match'], value, re.S) is not None)
        ok = (not found) if spec.get('absent') else found
        self.record(name, ok, '' if ok else (value or '<none>')[:400])
    def transcripts(self):
        return '\n'.join(open(p, errors='replace').read() for p in glob.glob(f'{self.home}/.claude/projects/**/*.jsonl', recursive=True))

    def act(self, a):
        k, v = next(iter(a.items()))
        if k == 'launch':
            self.launch(v)
        elif k == 'turn':
            self.turn(v, a.get('timeout', 60))
        elif k == 'send':
            self.send(v)
        elif k == 'wait_req':
            r = self.wait(lambda: self.find_req(v.get('cmd'), v.get('step'), role=v.get('role')), v.get('timeout', 60))
            self.record(f"wait_req {v.get('cmd') or v.get('role')}#{v.get('step')}", bool(r))
        elif k == 'wait_pane':
            r = self.wait(lambda: re.search(v, self.pane()), a.get('timeout', 30))
            self.record(f'wait_pane {v[:40]}', bool(r), '' if r else self.pane()[-400:])
        elif k == 'keys':
            self.keys(*v)
        elif k == 'type':
            self.type(v)
        elif k == 'sleep':
            time.sleep(v)
        elif k == 'capture':
            open(f'{self.out}/pane-{v}.txt', 'w').write(self.pane())
        elif k == 'exit':
            self.keys('C-u')
            self.type('/exit')
            self.keys('Enter')
            self.wait(lambda: 'EXITED' in self.pane(), 20)
        elif k == 'headless':
            self.headless(v)
        elif k == 'expect':
            r = self.find_req(v.get('cmd'), v.get('step'), role=v.get('role'), nth=v.get('nth', -1))
            field = v.get('field', 'lastResult')
            if r is None:
                value = None
            elif field == 'system':
                value = self.system_of(r)
            elif field == 'messages':
                value = json.dumps(self.body_of(r).get('messages'), ensure_ascii=False)
            elif field.startswith('tool:'):
                t = next((t for t in self.body_of(r).get('tools') or [] if t.get('name') == field[5:]), None)
                value = None if t is None else t.get('description', '') + '\n' + json.dumps(t.get('input_schema'))
            else:
                value = r.get(field)
                value = str(value) if isinstance(value, bool) else value
                value = ','.join(map(str, value)) if isinstance(value, list) else value
            self.check(v['name'], value, v)
        elif k == 'expect_same':
            ra, rb = self.find_req(v['a'], v.get('step', 0)), self.find_req(v['b'], v.get('step', 0))
            diff = [f for f in v.get('fields', ['tools', 'sysSha']) if not ra or not rb or ra.get(f) != rb.get(f)]
            self.record(v['name'], not diff, f'differs: {diff}' if diff else '')
        elif k == 'expect_gap':
            r0, r1 = self.find_req(v['cmd'], v.get('from', 0)), self.find_req(v['cmd'], v.get('to', 1))
            gap = (r1['t'] - r0['t']) / 1000 if r0 and r1 else None
            ok = gap is not None and v.get('min', 0) <= gap <= v.get('max', 1e9)
            self.record(v['name'], ok, f'gap={gap}s')
        elif k == 'expect_pane':
            self.check(v['name'], self.pane(), v)
        elif k == 'expect_file':
            p = f"{self.work}/{v['path']}"
            self.check(v['name'], open(p).read() if os.path.exists(p) else None, v)
        elif k == 'expect_transcript':
            self.check(v['name'], self.transcripts(), v)
        elif k == 'expect_headless':
            self.check(v['name'], self.headless_out.get(v['as']), v)
        else:
            raise ValueError(f'unknown action {k}')

    def scan_secrets(self):
        # `Bearer $(...)` is a shell example in the auto mode classifier's prompt, not a token.
        out = sh('rg', '-l', '-i', '-a', r'sk-ant-|authorization: bearer [^$]|"x-api-key": *"[^\[]', self.out)
        return [l for l in out.splitlines() if l]

    def run(self):
        self.setup()
        self.start_mock()
        try:
            for a in self.sc['drive']:
                self.act(a)
            errs = [l.strip() for l in self.pane().splitlines() if ERR_RE.search(l)]
            if errs:
                self.record('pane errors', False, ' | '.join(errs)[:400])
        finally:
            open(f'{self.out}/pane-final.txt', 'w').write(self.pane())
            if not self.keep:
                sh('tmux', 'kill-session', '-t', self.session)
            if self.mock:
                self.mock.terminate()
        # The fake key is the only credential the run ever sees; drop it from logs too.
        for p in glob.glob(f'{self.out}/**/*', recursive=True):
            if os.path.isfile(p) and p.endswith(('.log', '.txt', '.jsonl', '.json')):
                s = open(p, errors='replace').read()
                if FAKE_KEY in s:
                    open(p, 'w').write(s.replace(FAKE_KEY, '[REDACTED]'))
        leaks = self.scan_secrets()
        self.record('secret scan', not leaks, ', '.join(leaks)[:300])
        passed = sum(r['ok'] for r in self.results)
        summary = {'scenario': self.sc['name'], 'label': self.label, 'binary': self.bin, 'passed': passed,
                   'failed': len(self.results) - passed, 'results': self.results}
        json.dump(summary, open(f'{self.out}/result.json', 'w'), indent=1)
        print(f'[{self.label}] {passed}/{len(self.results)} passed -> {self.out}/result.json')
        return summary['failed'] == 0


def main():
    argv = sys.argv[1:]
    opt = lambda name, default=None: argv[argv.index(name) + 1] if name in argv else default
    pos = [a for i, a in enumerate(argv) if not a.startswith('--') and (i == 0 or argv[i - 1] not in ('--label', '--port'))]
    if len(pos) < 2:
        print(__doc__)
        sys.exit(2)
    ok = Run(pos[0], pos[1], opt('--label'), int(opt('--port', '18830')), '--keep' in argv).run()
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()

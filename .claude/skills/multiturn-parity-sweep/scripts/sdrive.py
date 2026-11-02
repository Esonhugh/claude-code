#!/usr/bin/env python3
# sdrive.py <bin> <label> <port>: open each slash command once in a live session, capture pane, Escape out.
import sys, os, subprocess, time, json, re
sys.argv = [sys.argv[0], sys.argv[1], sys.argv[2], '--port', sys.argv[3]]
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ldrive.py')).read().split('def rss():')[0]
exec(src)
CMDS = ['/help', '/status', '/config', '/context', '/usage', '/cost', '/hooks', '/agents', '/mcp', '/permissions',
        '/model', '/effort', '/theme', '/output-style', '/tasks', '/workflows', '/skills', '/plugin', '/doctor', '/export',
        '/statusline', '/ide', '/add-dir', '/resume', '/rewind', '/compact', '/todos', '/release-notes', '/terminal-setup',
        '/review', '/security-review', '/pr-comments', '/privacy-settings', '/login', '/fast', '/copy', '/btw hi', '/rename probe', '/sandbox', '/upgrade', '/feedback', '/stats', '/diff', '/plan', '/clear']
if os.environ.get('CMDS'): CMDS = os.environ['CMDS'].split(',')
setup(); os.environ['EDITOR']='true'
fake = subprocess.Popen(['bun', f'{ROOT}/fake3.ts'], env={**os.environ, 'PORT': str(PORT), 'FAKE_LOG': f'{OUT}/fake.log', 'FAKE_JSONL': FJ, 'WORK': WORK}, stdout=open(f'{OUT}/fake.out', 'w'), stderr=subprocess.STDOUT)
time.sleep(1.5)
res = {}
try:
    launch()
    turn('HELLO')
    for c in CMDS:
        keys('C-u'); lit(c); time.sleep(0.8); keys('Enter'); time.sleep(2.5)
        p = pane(); name = re.sub(r'\W+', '_', c.strip('/'))
        open(f'{OUT}/s-{name}.txt', 'w').write(p)
        tail = '\n'.join(p.splitlines()[-30:])
        res[c] = {'unknown': bool(re.search(r'Unknown|not a known command|isn.t available', tail, re.I)), 'err': [l.strip() for l in p.splitlines() if ERR_RE.search(l)][:3]}
        for _ in range(3):
            keys('Escape'); time.sleep(0.6)
        if 'EXITED' in pane():
            res[c]['exited'] = True; launch('--continue')
        keys('C-u')
finally:
    sh('tmux', 'kill-session', '-t', S); fake.terminate()
    json.dump(res, open(f'{OUT}/slash.json', 'w'), indent=1)
    print(json.dumps({k: v for k, v in res.items() if v['unknown'] or v['err'] or v.get('exited')}, indent=1))

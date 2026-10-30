import sys,os,time,subprocess,json,re
sys.argv=[sys.argv[0],sys.argv[1],sys.argv[2],'--port',sys.argv[3]]
d=os.path.dirname(os.path.abspath(__file__))
src=open(os.path.join(d,'ldrive.py')).read().split('def rss():')[0]
exec(src)
setup()
fake=subprocess.Popen(['bun',f'{d}/fake3.ts'],env={**os.environ,'PORT':str(PORT),'FAKE_LOG':f'{OUT}/fake.log','FAKE_JSONL':FJ,'WORK':WORK,'FAKE_DUMP':OUT+'/req'},stdout=open(f'{OUT}/fake.out','w'),stderr=subprocess.STDOUT)
time.sleep(1.5)
def run(c, wait_s=3, name=None):
    keys('C-u'); lit(c); time.sleep(1.2)
    pre=pane()
    keys('Enter'); time.sleep(wait_s)
    p=pane(); n=name or re.sub(r'\W+','_',c.strip('/!'))
    open(f'{OUT}/t-{n}-pre.txt','w').write(pre); open(f'{OUT}/t-{n}.txt','w').write(p)
    for _ in range(2): keys('Escape'); time.sleep(0.5)
    return p
try:
    launch()
    turn('HELLO')
    for c in (os.environ.get('T4CMDS') or '/plan,/hepl,/upgrade,/nosuchcmd,/copy,/security-review,/mcp,/terminal-setup').split(','):
        run(c)
    run('!echo bang-ok', 6, 'bang')
    turn('HELLO')
    cap('final')
finally:
    sh('tmux','kill-session','-t',S); fake.terminate()

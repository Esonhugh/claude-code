import sys,os,time,subprocess
sys.argv=[sys.argv[0],sys.argv[1],sys.argv[2],'--port',sys.argv[3]]
d=os.path.dirname(os.path.abspath(__file__))
src=open(os.path.join(d,'ldrive.py')).read().split('def rss():')[0]
exec(src)
setup()
fake=subprocess.Popen(['bun',f'{ROOT}/fake3.ts'],env={**os.environ,'PORT':str(PORT),'FAKE_LOG':f'{OUT}/fake.log','FAKE_JSONL':FJ,'WORK':WORK},stdout=open(f'{OUT}/fake.out','w'),stderr=subprocess.STDOUT)
time.sleep(1.5)
try:
    launch()
    for c in ['/upgrade','/hepl','/plan']:
        keys('C-u'); lit(c); time.sleep(1.2)
        open(f'{OUT}/ta-{c[1:]}.txt','w').write(pane())
        keys('C-u'); time.sleep(0.5)
finally:
    sh('tmux','kill-session','-t',S); fake.terminate()

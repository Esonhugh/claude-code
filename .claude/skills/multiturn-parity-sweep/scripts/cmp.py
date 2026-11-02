import json,sys,os
OUT=sys.argv[1]
fj=[json.loads(l) for l in open(OUT+'/fake.jsonl')]
a=int(open(OUT+'/mark-before-exit').read()); b=int(open(OUT+'/mark-after-continue').read())
pre=[e['n'] for e in fj if e['n']<=a and e['role'].startswith('main')][-1]
post=[e['n'] for e in fj if e['n']>b and e['role'].startswith('main')][0]
print('compare req',pre,post, [ (e['n'],e['role']) for e in fj if e['n']>=pre-3])
A=json.load(open(f'{OUT}/req/req-{pre}.json')); B=json.load(open(f'{OUT}/req/req-{post}.json'))
def strip(x):
    if isinstance(x,dict): return {k:strip(v) for k,v in x.items() if k!='cache_control'}
    if isinstance(x,list): return [strip(v) for v in x]
    return x
for k in ('model','thinking','output_config','context_management'):
    if A.get(k)!=B.get(k): print('DIFF',k,A.get(k),B.get(k))
print('tools same:', strip(A['tools'])==strip(B['tools']), len(A['tools']),len(B['tools']))
print('system same:', strip(A['system'])==strip(B['system']))
if strip(A['system'])!=strip(B['system']):
    for i,(x,y) in enumerate(zip(A['system'],B['system'])):
        if strip(x)!=strip(y): print(' sys block',i,'\n  A:',json.dumps(x)[:600],'\n  B:',json.dumps(y)[:600])
ma,mb=A['messages'],B['messages']
print('msgs',len(ma),len(mb))
for i in range(max(len(ma),len(mb))):
    x=ma[i] if i<len(ma) else None; y=mb[i] if i<len(mb) else None
    same=strip(x)==strip(y)
    def s(m):
        if m is None: return None
        c=m['content']; 
        if isinstance(c,str): return m['role']+': '+c[:300]
        return m['role']+': '+' | '.join((b.get('type')+':'+(b.get('text') or json.dumps(b.get('content') or b.get('input') or ''))[:250]) for b in c)
    print(i,'SAME' if same else 'DIFF'); 
    if not same: print('  A',s(x)); print('  B',s(y))

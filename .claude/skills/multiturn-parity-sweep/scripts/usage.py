import json,glob,sys,os,collections
for run in sys.argv[1:]:
    seen={}; models=collections.Counter(); mainseq=[]
    for f in glob.glob(run+'/home/.claude/projects/**/*.jsonl',recursive=True):
        if f.endswith('journal.jsonl'): continue
        ismain='subagents' not in f
        for l in open(f):
            try:o=json.loads(l)
            except:continue
            m=o.get('message') or {}
            if o.get('type')!='assistant' or not isinstance(m,dict) or 'usage' not in m: continue
            mid=m.get('id'); u=m['usage']
            if mid in seen: continue
            seen[mid]=(u,ismain,o.get('timestamp',''),m.get('model'))
    tot=collections.Counter(); main=[]
    for mid,(u,ism,ts,mod) in seen.items():
        models[mod]+=1
        for k in ('input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens'): tot[k]+=u.get(k,0) or 0
        if ism: main.append((ts,u))
    main.sort(key=lambda x:x[0])
    breaks=0;prev=0
    for ts,u in main:
        cr=u.get('cache_read_input_tokens',0) or 0
        if prev and cr < prev*0.5: breaks+=1
        prev=cr+(u.get('cache_creation_input_tokens',0) or 0)
    inp=tot['input_tokens']+tot['cache_creation_input_tokens']+tot['cache_read_input_tokens']
    hit=tot['cache_read_input_tokens']/inp if inp else 0
    w=tot['input_tokens']+tot['cache_creation_input_tokens']*2+tot['cache_read_input_tokens']*0.1+tot['output_tokens']*5
    print(f"{os.path.basename(run):10} req={len(seen):3} main={len(main):3} in={tot['input_tokens']:6} cw={tot['cache_creation_input_tokens']:7} cr={tot['cache_read_input_tokens']:8} out={tot['output_tokens']:6} total={inp+tot['output_tokens']:8} hit={hit:.1%} weighted={w:8.0f} mainBreaks={breaks} models={dict(models)}")

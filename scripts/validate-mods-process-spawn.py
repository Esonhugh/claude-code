#!/usr/bin/env python3
import argparse
import importlib.util
from pathlib import Path
import datetime,hashlib,json,os,shlex,signal,subprocess,sys,time,shutil,tempfile,pwd

def recheck_process_spawn_report(root, expected_report_sha256, expected_binary_sha256):
    path=root/'evidence/result.json'
    payload=path.read_bytes()
    if hashlib.sha256(payload).hexdigest()!=expected_report_sha256:
        raise ValueError('process.spawn closed report changed')
    report=json.loads(payload)
    if report.get('binarySHA256')!=expected_binary_sha256 or report.get('originalBinarySHA256')!=expected_binary_sha256:
        raise ValueError('process.spawn binary identity differs')
    if hashlib.sha256(Path(report['originalBinary']).read_bytes()).hexdigest()!=expected_binary_sha256:
        raise ValueError('process.spawn original binary changed')
    required={'evidence/debug.log','evidence/pty.raw','evidence/driver-used.py','evidence/inputs.jsonl','cwd/children.jsonl','bin/claude'}
    artifacts=report.get('artifactsSHA256',{})
    if not required<=set(artifacts):raise ValueError('missing process.spawn originals')
    for relative,digest in artifacts.items():
        source=root/relative
        if source.is_symlink() or not source.is_file() or source.resolve().is_relative_to(root.resolve()) is not True:
            raise ValueError('process.spawn original is outside its owner')
        if hashlib.sha256(source.read_bytes()).hexdigest()!=digest:
            raise ValueError('process.spawn original changed: '+relative)
    debug=(root/'evidence/debug.log').read_text()
    observed=[json.loads(line.split('SPAWN-ORACLE:',1)[1]) for line in debug.splitlines() if 'SPAWN-ORACLE:' in line]
    children=[json.loads(line) for line in (root/'cwd/children.jsonl').read_text().splitlines()]
    inputs=[json.loads(line) for line in (root/'evidence/inputs.jsonl').read_text().splitlines()]
    if observed!=report.get('caseResults') or children!=report.get('children') or inputs!=report.get('inputs'):
        raise ValueError('process.spawn receipts differ from their originals')
    origins=[json.loads(line.split('SPAWN-NEXT:',1)[1]) for line in debug.splitlines() if 'SPAWN-NEXT:' in line]
    checks=process_spawn_checks(report)
    checks['middleware_origin_and_wrapped_receipt']=len(origins)==3 and {row.get('case') for row in origins}=={'normal','twice','afterdeny'} and all(row.get('origin')=={'plugin':'spawn-oracle-author','tier':'user'} and row.get('receipt')=={'value':{'code':7,'signal':None}} for row in origins)
    checks['script_identity']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()==report.get('driverSHA256')
    return checks

def process_spawn_checks(record):
    rows=record.get('caseResults',[])
    cases=['normal','twice','deny','afterdeny','before','pending','break','badreceipt']
    by={row.get('case'):row for row in rows if isinstance(row,dict)}
    checks={
        'eight_unique_actual_receipts':len(rows)==len(by)==8 and set(by)==set(cases),
        'synchronous_stream':len(rows)==8 and all(row.get('immediate') is True for row in rows),
        'normal_exit':record.get('normalExitPassed') is True,
        'owned_children_reaped':record.get('childrenGone') is True,
        'binary_unchanged':record.get('binaryUnchanged') is True,
        'owned_socket_released':record.get('socketReleased') is True,
        'cleanup':not record.get('cleanupError') and not record.get('socketCleanupError'),
        'real_entry_observed':record.get('status')=='observed',
    }
    if not checks['eight_unique_actual_receipts']:return checks
    checks['chunk_contract']=all(isinstance(row.get('chunks'),list) and all(
        isinstance(chunk,dict) and chunk.get('stream') in ('stdout','stderr') and
        isinstance(chunk.get('text'),str) and bool(chunk['text']) and chunk['text'].startswith('obs:')
        for chunk in row['chunks']) for row in rows)
    children=record.get('children',[])
    counts={case:sum(child.get('case')==case for child in children) for case in cases}
    checks['real_child_ledger']=counts==dict(normal=1,twice=2,deny=0,afterdeny=1,before=0,pending=1,**{'break':1,'badreceipt':0}) and len(children)==6 and len({c.get('pid') for c in children})==6 and all(isinstance(c.get('pid'),int) and c['pid']>1 for c in children)
    for case,count in [('normal',1),('twice',2),('afterdeny',1)]:
        row=by[case]
        try:
            text=''.join(c['text'][4:] for c in row['chunks'] if c['stream']=='stdout')
            outputs=[]
            decoder=json.JSONDecoder()
            while text:
                value,end=decoder.raw_decode(text);outputs.append(value);text=text[end:]
            checks[case+'_actual_pipes']=len(outputs)==count and all(
                value.get('input')=='stdin-é' and value.get('marker')=='observer' for value in outputs) and {v.get('pid') for v in outputs}=={c.get('pid') for c in children if c.get('case')==case} and ''.join(c['text'][4:] for c in row['chunks'] if c['stream']=='stderr')=='stderr-é-漢字'*count
        except (KeyError,TypeError,ValueError):checks[case+'_actual_pipes']=False
    checks['raw_receipts']=all(by[case].get('receipt')=={'code':7,'signal':None} for case in ['normal','twice'])
    for case,message in [('deny','spawn-oracle-author: $.process.spawn: held spawn'),('afterdeny','spawn-oracle-author: $.process.spawn ran, and a plugin withheld its result: held after child')]:
        expected={'name':'HooksError','message':message}
        checks[case+'_failure']=by[case].get('error')==by[case].get('receiptError')==expected
    checks['deny_without_child']=by['deny']['chunks']==[]
    checks['unpulled_return']=by['before']['chunks']==[] and by['before'].get('returned')=={'done':True} and by['before'].get('resultState')=='pending'
    checks['pending_return']=bool(by['pending']['chunks']) and by['pending'].get('returned')=={'done':True} and by['pending'].get('pending')=={'value':{'done':True}} and by['pending'].get('receiptState')=='fulfilled' and 'receipt' not in by['pending'] and 'receiptError' not in by['pending']
    checks['break_return']=bool(by['break']['chunks']) and by['break'].get('returned')=={'done':True} and by['break'].get('receiptError')=={'name':'HooksError','message':'the stream was closed before its result'}
    checks['receipt_projection']=by['badreceipt']['chunks']==[] and by['badreceipt'].get('receipt')=={'code':'bad-code','signal':12} and 'error' not in by['badreceipt']
    return checks

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--binary',type=Path,required=True)
    parser.add_argument('--binary-sha256',required=True)
    parser.add_argument('--evidence-root',type=Path,required=True)
    parser.add_argument('--side',choices=['candidate','official'],default='candidate')
    args=parser.parse_args()
    binary=args.binary.resolve();side=args.side
    if not binary.is_file() or binary.is_symlink():raise ValueError('binary must be a regular file')
    if hashlib.sha256(binary.read_bytes()).hexdigest()!=args.binary_sha256:raise ValueError('binary SHA-256 mismatch')
    if args.evidence_root.is_symlink():raise ValueError('evidence root must not be a symlink')
    root=args.evidence_root.resolve();root.mkdir(mode=0o700)
    for name in ('home','config','tmp','cache','runtime','cwd','evidence'):(root/name).mkdir(mode=0o700)
    bun_path=shutil.which('bun');tmux_path=shutil.which('tmux')
    if not bun_path or not tmux_path or not shutil.which('sandbox-exec'):raise ValueError('macOS sandbox-exec, Bun and tmux are required')
    originalBinary=binary
    (root/'bin').mkdir(mode=0o700)
    shutil.copyfile(binary,root/'bin/claude')
    binary=root/'bin/claude';binary.chmod(0o700)
    ev=root/'evidence';dummy='owned-panes-native-dummy-key'
    env={'PATH':'/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin','SHELL':'/bin/sh','TERM':'xterm-256color','LANG':'en_US.UTF-8','HOME':str(root/'home'),'CLAUDE_CONFIG_DIR':str(root/'config'),'XDG_CONFIG_HOME':str(root/'config'),'XDG_CACHE_HOME':str(root/'cache'),'XDG_RUNTIME_DIR':str(root/'runtime'),'TMPDIR':str(root/'tmp'),'CLAUDE_CODE_TMPDIR':str(root/'tmp'),'ANTHROPIC_API_KEY':dummy,'ANTHROPIC_BASE_URL':'http://127.0.0.1:9','DISABLE_TELEMETRY':'1','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL':'1','SSH_CONNECTION':'127.0.0.1 1 127.0.0.1 2','PRIVACY_MODE':'1','CLAUDE_CODE_NO_FLICKER':'1','CLAUDE_CODE_MAX_RETRIES':'0','GIT_CONFIG_GLOBAL':'/dev/null','GIT_CONFIG_NOSYSTEM':'1','CLAUDE_CODE_FRAME_EVIDENCE_PATH':str(ev/'frames.jsonl')}
    (root/'config/.claude.json').write_text(json.dumps({'numStartups':1,'installMethod':'local','hasCompletedOnboarding':True,'customApiKeyResponses':{'approved':[dummy[-20:]],'rejected':[]},'cachedGrowthBookFeatures':{'tengu_quiet_dolphin':True},'projects':{str(root/'cwd'):{'hasTrustDialogAccepted':True,'hasCompletedProjectOnboarding':True}}}))
    (root/'config/settings.json').write_text(json.dumps({'skipDangerousModePermissionPrompt':True,'model':'claude-sonnet-4-6','tui':'fullscreen','theme':'dark','env':{'CLAUDE_CODE_MAX_RETRIES':'0'}}))
    helper=Path(__file__).resolve().parents[1]/'.claude/skills/release-validation/scripts/run-binary-gate.py'
    spec=importlib.util.spec_from_file_location('process_spawn_socket_owner',helper)
    socket_owner=importlib.util.module_from_spec(spec);spec.loader.exec_module(socket_owner)
    (ev/'socket-cleanup-helper.py').write_bytes(helper.read_bytes())
    socketRoot=Path(tempfile.mkdtemp(prefix='mps-',dir='/private/tmp'));socketRoot.chmod(0o700)
    socketCapture={'socketRoot':str(socketRoot),'socket':str(socketRoot/'s')}

    profile=root/'sandbox.sb';profile.write_text('(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath '+json.dumps(str(root))+'))\n(allow file-write* (subpath '+json.dumps(str(socketRoot))+'))\n(allow file-write* (literal "/dev/null") (literal "/dev/ptmx") (regex #"^/dev/ttys"))\n(deny network*)\n(allow network* (local unix-socket) (remote unix-socket))\n(deny process-exec (literal "/usr/bin/security"))\n(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc"))\n(deny file-read* (regex #"/Library/Keychains(/|$)"))\n(deny file-read* (subpath '+json.dumps(str(Path(pwd.getpwuid(os.getuid()).pw_dir)/'.claude'))+'))\n')
    child=root/'cwd/child.mjs'
    child.write_text("""import {appendFileSync} from 'node:fs';
    appendFileSync('children.jsonl', JSON.stringify({pid:process.pid,case:process.env.CASE})+'\\n');
    let input='';for await(const chunk of process.stdin) input+=chunk;
    process.stdout.write(JSON.stringify({pid:process.pid,input,marker:process.env.MARKER}));
    process.stderr.write('stderr-é-漢字');
    if(['pending','break'].includes(process.env.CASE)) {setInterval(()=>{},1000);setTimeout(()=>process.exit(99),20000)} else process.exitCode=7;
    """)
    plugin=root/'plugin';(plugin/'.claude-plugin').mkdir(parents=True);(plugin/'hooks').mkdir()
    (plugin/'.claude-plugin/plugin.json').write_text(json.dumps({'name':'spawn-oracle-author','version':'1.0.0','description':'Owned process spawn oracle'}))
    (plugin/'hooks/hooks.json').write_text(json.dumps({'modules':['./register.js']}))
    module="""export function register(on) {
     on('session.start',async($,e,next)=>{await $.command.register({name:'pspawn',description:'Owned process spawn oracle',immediate:true});return next(e)});
     on('command.run',{command:'pspawn'},async($,e)=>{
      const name=e.args.trim();const flow=$.process.spawn({argv:__ARGV__,input:'stdin-é',env:{CASE:name,MARKER:'before'},plugin:'forged',timeoutMs:1});
      const report={case:name,immediate:typeof flow.next==='function'&&!('then'in flow),chunks:[]};
      let state='pending';flow.result.then(value=>{state='fulfilled'},error=>{state='rejected'});
      try {
       if(name==='before') {report.returned=await flow.return();await Promise.resolve();report.resultState=state;}
       else if(name==='break') {report.chunks.push((await flow.next()).value);report.returned=await flow.return();try{report.receipt=await flow.result;report.receiptState='fulfilled'}catch(error){report.receiptError={name:error.name,message:error.message}}}
       else if(name==='pending') {report.chunks.push((await flow.next()).value);const pending=flow.next().then(value=>({value}),error=>({error:{name:error.name,message:error.message}}));report.returned=await flow.return();report.pending=await pending;try{report.receipt=await flow.result;report.receiptState='fulfilled'}catch(error){report.receiptError={name:error.name,message:error.message}}}
       else {for await(const chunk of flow) report.chunks.push(chunk);report.receipt=await flow.result;}
      }catch(error){report.error={name:error.name,message:error.message};try{await flow.result}catch(failure){report.receiptError={name:failure.name,message:failure.message}}}
      $.ui.log('SPAWN-ORACLE:'+JSON.stringify(report),{to:'debug'});return{text:'SPAWN-ORACLE-DONE:'+name};
     });
    }
    """.replace('__ARGV__',json.dumps([bun_path,str(child)]))
    (plugin/'hooks/register.js').write_text(module)
    decorator=root/'decorator';(decorator/'.claude-plugin').mkdir(parents=True);(decorator/'hooks').mkdir()
    (decorator/'.claude-plugin/plugin.json').write_text(json.dumps({'name':'spawn-oracle-observer','version':'1.0.0','description':'Owned process stream middleware'}))
    (decorator/'hooks/hooks.json').write_text(json.dumps({'modules':['./register.js']}))
    (decorator/'hooks/register.js').write_text("""export function register(on) {
     on('process.spawn',async function*($,e,next){
      const name=e.env.CASE;if(name==='badreceipt')return{value:{code:'bad-code',signal:12}};if(name==='deny')return{deny:'held spawn'};
      let receipt;const count=name==='twice'?2:1;
      for(let index=0;index<count;index++) {const child=next({...e,env:{...e.env,MARKER:'observer'}});for await(const chunk of child)yield {...chunk,text:'obs:'+chunk.text};receipt=await child.result;}
      $.ui.log('SPAWN-NEXT:'+JSON.stringify({case:name,origin:next.origin,receipt}),{to:'debug'});
      if(name==='afterdeny') return{deny:'held after child'};
      return receipt;
     });
    }
    """)
    argv=[str(binary),'--dangerously-skip-permissions','--plugin-dir',str(decorator),'--plugin-dir',str(plugin),'--debug','--debug-file',str(ev/'debug.log')]

    launcher=root/'launch.sh';launcher.write_text('#!/bin/sh\ncd '+shlex.quote(str(root/'cwd'))+'\nwhile [ ! -f '+shlex.quote(str(root/'capture-ready'))+' ]; do /bin/sleep 0.02; done\nexec /usr/bin/env -i '+' '.join(shlex.quote(k+'='+v)for k,v in env.items())+' '+shlex.join(argv)+'\n');launcher.chmod(0o700)
    socket=str(socketRoot/'s');target='status:0.0';tm=tmux_path;server=None;identity=None;raw=ev/'pty.raw'
    def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
    record={'originalBinary':str(originalBinary),'originalBinarySHA256':sha(originalBinary),'side':side,'root':str(root),'binary':str(binary),'binarySHA256':sha(binary),'binaryBytes':binary.stat().st_size,'binaryMtimeNs':binary.stat().st_mtime_ns,'argv':argv,'environment':env,'terminal':{'columns':160,'rows':40},'inputs':[],'observations':[],'cleanup':[],'status':'running','normalExitPassed':False,'noCredentialsCopied':True,'globalDeadlineSeconds':90,'completeParity':False,'diagnosticOnly':False,'scope':'eight process.spawn author CLI contracts; no complete Mods/release claim'}
    start=time.monotonic();driver=Path(__file__).read_bytes();(ev/'driver-used.py').write_bytes(driver);record['driverSHA256']=hashlib.sha256(driver).hexdigest()
    def save():(ev/'result.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n')
    def tmux(*args,check=True):
     p=subprocess.run([tm,'-S',socket,*args],cwd=root/'cwd',env=env,capture_output=True,text=True,timeout=8)
     if check and p.returncode:raise RuntimeError(p.stderr)
     return p

    def capture(label):
     p=tmux('capture-pane','-p','-t',target,check=False);(ev/(label+'.txt')).write_text(p.stdout)
     a=tmux('capture-pane','-p','-e','-N','-t',target,check=False);(ev/(label+'.ansi')).write_text(a.stdout)
     state=tmux('display-message','-p','-t',target,'#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{alternate_on} #{pane_dead} #{pane_dead_status}',check=False).stdout.strip()
     (ev/(label+'.capture.json')).write_text(json.dumps({'state':state,'rawOffset':raw.stat().st_size if raw.exists()else 0,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}))
     return p.stdout

    def wait(label,predicate,seconds=15):
     deadline=min(time.monotonic()+seconds,start+90)
     while time.monotonic()<deadline:
      pane=capture(label)
      if predicate(pane):record['observations'].append({'label':label,'observed':True});save();return pane
      if server.poll()is not None or tmux('display-message','-p','-t',target,'#{pane_dead}',check=False).stdout.strip()=='1':break
      time.sleep(.1)
     record['observations'].append({'label':label,'observed':False});save();raise RuntimeError('process.spawn barrier '+label)

    def send(data,label):
      entry={'label':label,'hex':data.hex(),'transport':'tmux send-keys -H'}
      record['inputs'].append(entry)
      with (ev/'inputs.jsonl').open('a') as journal:journal.write(json.dumps(entry)+'\n')
      save();tmux('send-keys','-t',target,'-H',*[f'{v:02x}'for v in data])
    def command(text,label):
     send(text.encode(),label+'-literal')
     def live_input(p):
      row=tmux('display-message','-p','-t',target,'#{cursor_y}',check=False).stdout.strip()
      lines=p.splitlines()
      return row.isdigit() and int(row)<len(lines) and lines[int(row)].strip().replace('\u00a0',' ').startswith('❯ '+text)
     wait(label+'-input',live_input)
     send(b'\r',label+'-enter')
    def pane_identity():
     v=tmux('display-message','-p','-t',target,'#{pane_pid}',check=False).stdout.strip()
     if not v.isdigit():return None
     p=subprocess.run(['/bin/ps','-p',v,'-o','pgid=,lstart=,comm='],capture_output=True,text=True,timeout=3);f=p.stdout.split()
     return {'pid':int(v),'pgid':int(f[0]),'started':' '.join(f[1:6])}if p.returncode==0 and len(f)>=7 else None
    log=(ev/'tmux-server.log').open('x');save()
    try:
     server=subprocess.Popen(['/usr/bin/sandbox-exec','-f',str(profile),tm,'-D','-S',socket,'-f','/dev/null'],cwd=root/'cwd',env=env,stdout=log,stderr=log,start_new_session=True);record['serverPID']=server.pid;save()
     deadline=time.monotonic()+8
     while not(socketRoot/'s').exists()and server.poll()is None and time.monotonic()<deadline:time.sleep(.05)
     socketCapture.update(serverPid=server.pid,socketIdentity=socket_owner.terminal_socket_identity(socketCapture))
     record['socketCapture']=socketCapture;save()
     tmux('set-option','-g','remain-on-exit','on');tmux('set-option','-g','set-clipboard','on');tmux('new-session','-d','-s','status','-x','160','-y','40',str(launcher));identity=pane_identity();record['paneProcess']=identity;save()
     tmux('pipe-pane','-o','-t',target,'/bin/cat > '+shlex.quote(str(raw)));(root/'capture-ready').touch()
     wait('01-ready',lambda p:'❯'in p and 'bypass permissions'in p,30)
     def debug_events(marker):
      path=ev/'debug.log'
      return [json.loads(line.split(marker,1)[1])for line in path.read_text(errors='replace').splitlines()if marker in line]if path.exists()else[]
     record['caseResults']=[]
     for case in ['normal','twice','deny','afterdeny','before','pending','break','badreceipt']:
      command('/pspawn '+case,'spawn-'+case)
      wait('spawn-'+case+'-result',lambda p:any(item.get('case')==case for item in debug_events('SPAWN-ORACLE:')))
      result=[item for item in debug_events('SPAWN-ORACLE:')if item.get('case')==case]
      if len(result)!=1:raise RuntimeError('duplicate oracle receipt '+case)
      record['caseResults'].append(result[0]);save()
     record['status']='observed'
    except BaseException as e:
     record['status']='failed';record['error']={'type':type(e).__name__,'message':str(e)}
    finally:
     try:
      if identity:
       capture('90-before-normal-exit');send(b'\x1b[27u','90-escape-for-normal-exit');command('/exit','91-exit')
       deadline=time.monotonic()+5;state=''
       while time.monotonic()<deadline:
        state=tmux('display-message','-p','-t',target,'#{pane_dead} #{pane_dead_status}',check=False).stdout.strip()
        if state.startswith('1 '):break
        time.sleep(.1)
       record['normalExitState']=state;record['normalExitPassed']=state=='1 0';capture('92-final')
     except BaseException as e:record['normalExitError']=str(e)
     debug=(ev/'debug.log').read_text(errors='replace')if(ev/'debug.log').exists()else''
     record['debugProjection']=[line for line in debug.splitlines()if any(token in line for token in ('SPAWN-ORACLE:','SPAWN-NEXT:','[ModsBuiltin]','[Mods:'))]
     try:
      if identity and pane_identity()==identity:
       os.killpg(identity['pgid'],signal.SIGTERM);record['cleanup'].append({'ownedPanePGID':identity['pgid'],'signal':'SIGTERM','identity':identity});time.sleep(.1)
       if pane_identity()==identity:os.killpg(identity['pgid'],signal.SIGKILL);record['cleanup'].append({'ownedPanePGID':identity['pgid'],'signal':'SIGKILL'})
      if server:
       tmux('kill-session','-t','status',check=False)
       if server.poll()is None:os.killpg(server.pid,signal.SIGTERM);record['cleanup'].append({'ownedServerPGID':server.pid,'signal':'SIGTERM'})
       try:server.wait(timeout=3)
       except subprocess.TimeoutExpired:os.killpg(server.pid,signal.SIGKILL);server.wait(timeout=3);record['cleanup'].append({'ownedServerPGID':server.pid,'signal':'SIGKILL'})
       record['serverExitCode']=server.returncode
     except BaseException as e:record['cleanupError']=str(e)
     record['pressExactlyOnce']=len(record.get('caseResults',[]))==8
     record['packageRegistered']=any('[ModsBuiltin]' in line and '\"version\":\"2.1.292\"' in line and 'package-registered' in line for line in record['debugProjection'])
     record['children']=[json.loads(line) for line in (root/'cwd/children.jsonl').read_text().splitlines()] if (root/'cwd/children.jsonl').exists() else []
     record['childrenGone']=True
     for child in record['children']:
      try:os.kill(child['pid'],0);record['childrenGone']=False
      except ProcessLookupError:pass
     for owned_child in record['children']:
      try:os.kill(owned_child['pid'],0)
      except ProcessLookupError:continue
      identity_command=['/bin/ps','-p',str(owned_child['pid']),'-o','lstart=,args=']
      observed=subprocess.run(identity_command,capture_output=True,text=True,timeout=3,env={**env,'LC_ALL':'C','TZ':'UTC'}).stdout.split()
      if len(observed)<6 or str(root/'cwd/child.mjs') not in ' '.join(observed[5:]):
       record['cleanupError']='live child identity could not be confirmed';continue
      started_identity=' '.join(observed[:5])
      try:
       os.kill(owned_child['pid'],signal.SIGTERM)
       record['cleanup'].append({'ownedChildPID':owned_child['pid'],'started':started_identity,'signal':'SIGTERM'})
       deadline=time.monotonic()+.5
       while time.monotonic()<deadline:
        try:os.kill(owned_child['pid'],0)
        except ProcessLookupError:break
        time.sleep(.01)
       current=subprocess.run(identity_command,capture_output=True,text=True,timeout=3,env={**env,'LC_ALL':'C','TZ':'UTC'}).stdout.split()
       if ' '.join(current[:5])==started_identity and str(root/'cwd/child.mjs') in ' '.join(current[5:]):
        os.kill(owned_child['pid'],signal.SIGKILL)
        record['cleanup'].append({'ownedChildPID':owned_child['pid'],'started':started_identity,'signal':'SIGKILL'})
      except ProcessLookupError:pass
     record['binaryUnchanged']=sha(binary)==record['binarySHA256'];record['elapsedSeconds']=round(time.monotonic()-start,3);save();log.close()
    record['socketClose']=socket_owner.release_owned_terminal_socket(socketCapture)
    record['socketReleased']=record['socketClose']['socket_released']
    try:socketRoot.rmdir()
    except OSError as error:record['socketCleanupError']=str(error)
    record['artifactsSHA256']={str(path.relative_to(root)):sha(path) for path in sorted(root.rglob('*')) if path.is_file() and path!=ev/'result.json' and not path.is_symlink()}
    record['checks']=process_spawn_checks(record)
    record['validation_verdict']='passed' if all(record['checks'].values()) else 'failed'
    save()
    print(json.dumps({'root':str(root),'status':record['status'],'normalExitPassed':record['normalExitPassed'],'error':record.get('error'),'checks':record.get('checks'),'reportSHA256':sha(ev/'result.json')}),flush=True)
    return 0 if record['validation_verdict']=='passed' else 1

if __name__=='__main__':
    sys.exit(main())

import {expect,test} from 'bun:test';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {URL} from 'node:url';
import {spawnSync} from 'node:child_process';

for(const mode of ['registered','failed'])test('actual private debug log reports package '+mode+' provenance and errors',async()=>{
 const root=await mkdtemp(join(tmpdir(),'diff-package-debug-289-'));
 const archive=join(root,'bad.zip');
 if(mode==='failed')await writeFile(archive,'invalid');
 const modules={startup:new URL('../src/plugins/bundled/index.ts',import.meta.url).pathname,debug:new URL('../src/utils/debug.ts',import.meta.url).pathname,state:new URL('../src/bootstrap/state.ts',import.meta.url).pathname,config:new URL('../src/utils/config.ts',import.meta.url).pathname};
 const source=`import {initBuiltinPlugins} from ${JSON.stringify(modules.startup)};import {enableDebugLogging,flushDebugLogs,getDebugLogPath} from ${JSON.stringify(modules.debug)};import {setIsInteractive} from ${JSON.stringify(modules.state)};import {enableConfigs} from ${JSON.stringify(modules.config)};enableConfigs();enableDebugLogging();setIsInteractive(true);await initBuiltinPlugins();await flushDebugLogs();console.log(JSON.stringify({path:getDebugLogPath()}));`;
 const env={...process.env,HOME:root,CLAUDE_CONFIG_DIR:join(root,'config'),CLAUDE_CODE_DEBUG_LOGS_DIR:join(root,'debug'),NODE_ENV:'development'};
 if(mode==='failed')env.CLAUDE_CODE_BUILTIN_DIFF_ARCHIVE=archive;else delete env.CLAUDE_CODE_BUILTIN_DIFF_ARCHIVE;
 const child=spawnSync(process.execPath,['-e',source],{env,encoding:'utf8'});
 const {status:code,stdout,stderr}=child;
 expect(code).toBe(0);expect(stderr).toBe('');const {path}=JSON.parse(stdout);console.log(JSON.stringify({retainedDebugLog:path,mode}));
 const log=await readFile(path,'utf8');const line=log.split('\n').find(line=>line.includes('[ModsBuiltin]'));
 const event=JSON.parse(line.slice(line.indexOf('[ModsBuiltin]')+'[ModsBuiltin] '.length));
 expect(event.plugin).toBe('cc-plugin-diff');expect(event.version).toBe('2.1.291');
 if(mode==='registered'){
  expect(event.event).toBe('package-registered');expect(event.storageId).toBe('cc-plugin-diff@builtin');expect(event.archiveSha256).toBe('a055c383e182c50f5cd804a25e6587871cad065804d35082292fe9acb2d6d424');expect(event.moduleSha256).toBe('05350cb490432c50c1e4227a6097112c4063d710385c937e29a73cf79adddba8');
 }else{expect(event.event).toBe('package-load-failed');expect(event.phase).toBe('package');expect(event.error).toContain('SHA-256 mismatch');expect(event.archive).toBe(archive)}
});

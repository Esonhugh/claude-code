import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('the plugin test engine and its host callbacks expose synchronous process streams with distinct public receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-spawn-testing-'))
  try {
    await mkdir(join(root, '.claude-plugin'))
    await mkdir(join(root, 'hooks'))
    await mkdir(join(root, 'home'))
    await writeFile(join(root, '.claude-plugin/plugin.json'), JSON.stringify({name:'spawn-testing',version:'1.0.0'}))
    await writeFile(join(root, 'hooks/hooks.json'), JSON.stringify({modules:['../register.ts']}))
    await writeFile(join(root, 'register.ts'), `export function register(on) {
      on('command.run',async $=>{const child=$.process.spawn({argv:['owned-stub']});let text='';for await(const c of child)text+=c.text;return {text,exit:await child.result}});
    }`)
    const file = join(root, 'spawn.test.ts')
    await writeFile(file, `import {test,expect} from 'claude-code/testing';
      test('engine stream',async($,on)=>{
        on('process.spawn',async function*(){yield {stream:'stdout',text:'owned'};return {value:{code:7,signal:null}}});
        const flow=$.process.spawn({argv:['owned-stub']});expect(typeof flow.next).toBe('function');expect('then' in flow).toBe(false);
        const chunks=[];for await(const c of flow)chunks.push(c);
        expect(chunks).toEqual([{stream:'stdout',text:'owned'}]);expect(await flow.result).toEqual({value:{code:7,signal:null}});
      });
      test('callback and author streams',async($,on)=>{
        on('process.spawn',async function*(){yield {stream:'stdout',text:'callback-owned'};return {value:{code:8,signal:null}}});
        on('clock.now',async $=>{const flow=$.process.spawn({argv:['owned-stub']});expect(typeof flow.next).toBe('function');let text='';for await(const c of flow)text+=c.text;expect(text).toBe('callback-owned');expect(await flow.result).toEqual({code:8,signal:null});return {value:42}});
        expect(await $.clock.now()).toEqual({value:42});
        expect(await $.command.run({command:'probe',args:''})).toEqual({text:'callback-owned',exit:{code:8,signal:null}});
      });
      test('callback denial',async($,on)=>{
        on('process.spawn',async function*(){return {deny:'controlled refusal'}});
        on('clock.now',async $=>{
          const flow=$.process.spawn({argv:['must-not-start']});
          const failed = await flow.next().then(()=>{throw new Error('denied spawn was accepted')}, error=>error);
          expect(failed.name).toBe('HooksError');
          expect(failed.message).toBe('claude-code/testing: $.process.spawn: controlled refusal');
          await expect(flow.result).rejects.toThrow('claude-code/testing: $.process.spawn: controlled refusal');
          return {value:43};
        });
        expect(await $.clock.now()).toEqual({value:43});
      });
      test('unhandled process stream',async $=>{
        const flow=$.process.spawn({argv:['must-not-start']});expect(typeof flow.next).toBe('function');
        await expect(flow.next()).rejects.toThrow('Unhandled plugin test event: process.spawn');
        await expect(flow.result).rejects.toThrow('Unhandled plugin test event: process.spawn');
      });`)
    const child = Bun.spawn([process.execPath, join(import.meta.dir,'testing/runner.ts'), '--child', root, file], {
      cwd: join(import.meta.dir, '../../..'), stdin:'ignore', stdout:'pipe', stderr:'pipe',
      env:{PATH:'/usr/bin:/bin',HOME:join(root,'home'),CLAUDE_CONFIG_DIR:join(root,'home/config'),TMPDIR:root,DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},
    })
    const watchdog = setTimeout(() => child.kill(), 15000)
    try {
      const [stdout,stderr,status] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
      const line = stdout.split('\n').find(line => line.startsWith('__CLAUDE_PLUGIN_TEST_RESULT__'))
      expect(line, stderr || stdout).toBeDefined()
      const result = JSON.parse(line!.slice('__CLAUDE_PLUGIN_TEST_RESULT__'.length)) as {tests:{failure?:string}[];loadFailure?:string}
      expect(result.loadFailure).toBeUndefined()
      expect(result.tests.map(item => item.failure)).toEqual([undefined,undefined,undefined,undefined])
      expect(status).toBe(0)
      expect(stderr).toBe('')
    } finally {clearTimeout(watchdog)}
  } finally {await rm(root,{recursive:true,force:true})}
},20000)

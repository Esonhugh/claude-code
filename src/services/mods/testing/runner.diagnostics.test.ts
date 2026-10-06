import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPluginTestFile } from './runner.js'

test('actual author test failure retains the error message when its stack has no message', async () => {
  const root=await mkdtemp(join(tmpdir(),'mods-test-diagnostics-'))
  try {
    await mkdir(join(root,'.claude-plugin'))
    await mkdir(join(root,'hooks'))
    await writeFile(join(root,'.claude-plugin/plugin.json'),JSON.stringify({name:'diagnostic-probe',version:'1.0.0'}))
    await writeFile(join(root,'hooks/hooks.json'),JSON.stringify({modules:['../register.ts']}))
    await writeFile(join(root,'register.ts'),'export function register() {}')
    const file=join(root,'probe.test.ts')
    await writeFile(file,`import {test} from 'claude-code/testing';test('missing stack headline',()=>{
      const error=new TypeError('the precise author failure');
      error.stack='TypeError\\n    at retained-author-frame:1:2';
      throw error;
    })`)
    const result=await runPluginTestFile(root,file)
    expect(result.loadFailure).toBeUndefined()
    expect(result.tests).toHaveLength(1)
    expect(result.tests[0]!.failure).toContain('TypeError: the precise author failure')
    expect(result.tests[0]!.failure).toContain('at retained-author-frame:1:2')
  } finally {await rm(root,{recursive:true,force:true})}
})

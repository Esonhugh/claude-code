import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const childFlag = 'CLAUDE_CODE_MAILBOX_ACK_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('C17 mailbox publication acknowledgement (isolated)', async () => {
    const child = Bun.spawn([process.execPath,'test',import.meta.path],{env:{...process.env,[childFlag]:'1'},stdout:'pipe',stderr:'pipe'})
    const [code,stdout,stderr] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
    if (code !== 0) throw Error(`${stdout}\n${stderr}`)
  })
} else {
  const config = await mkdtemp(join(tmpdir(),'mailbox-ack-'))
  process.env.CLAUDE_CONFIG_DIR = config
  afterAll(async()=>{await rm(config,{recursive:true,force:true})})
  mock.module('./lockfile.js',()=>({lock:async()=>async()=>{throw Object.assign(Error('release fixture'),{code:'ERELEASED'})}}))
  const { writeToMailbox,readMailbox,getInboxPath } = await import('./teammateMailbox.js')
  test('C17 committed real mailbox remains acknowledged when releasing the lock reports a failure', async () => {
    const row = {from:'fixture-lead',text:'private fixture',timestamp:'2026-10-05T00:00:00.000Z'}
    expect(await writeToMailbox('recipient',row,'ack-team')).toBe(true)
    expect(await readMailbox('recipient','ack-team')).toEqual([{...row,read:false}])
  })
  test('C17 failed real mailbox publication does not acknowledge a queue', async () => {
    const inbox = getInboxPath('blocked','ack-team')
    await mkdir(inbox,{recursive:true});await writeFile(join(inbox,'block'),'private fixture')
    expect(await writeToMailbox('blocked',{from:'fixture-lead',text:'private fixture',timestamp:'2026-10-05T00:00:00.000Z'},'ack-team')).toBe(false)
  })
}

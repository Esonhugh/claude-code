import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { ensureModDeclarations } from './declarations.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true}))) })
test('C17 strict author AgentStatus AgentSpec and real spawn input contracts', async () => {
  const root=await mkdtemp(join(tmpdir(),'mods-author-agent-')); roots.push(root)
  const generated=await ensureModDeclarations(root,'2.1.289',[])
  await mkdir(join(root,'tests'))
  await writeFile(join(root,'tests/agent.ts'), `
    import type { EngineInterface, AgentInfo, AgentStatus, AgentSpec, AgentSpawnInput, AgentSpawnResult, ToolCheckInput, ToolCheckResult, AgentOfferInput, AgentOfferResult, Register } from 'claude-code'
    declare const $:EngineInterface
    const status:AgentStatus[]=['pending','running','waiting','idle','completed','failed','killed']
    const agents:Promise<AgentInfo[]>=$.agent.list()
    async function inspect(){const rows=await agents; for(const row of rows){const state:AgentStatus=row.status; const identity:string|undefined=row.teammateId; void [state,identity,row.parentId,row.spawnedBy,row.name]} rows.push({id:'child',description:'Review',type:'Explore',status:'waiting'})}
    const spec:AgentSpec={name:'review',description:'Reviews',prompt:'Review',tools:['Read'],disallowedTools:['Bash'],effort:100,permissionMode:'plan',mcpServers:['fixture',{fixture:{command:'true'}}],hooks:{},maxTurns:5,skills:['review'],initialPrompt:'Begin',memory:'project',background:true,omitClaudeMd:true,isolation:'remote'}
    $.agent.register(spec)
    // @ts-expect-error Required prompt is not Fields.
    $.agent.register({name:'bad',description:'Bad'})
    // @ts-expect-error Memory is the official three literals.
    $.agent.register({name:'bad',description:'Bad',prompt:'Bad',memory:'global'})
    // @ts-expect-error Public agent status has no paused branch.
    const invalid:AgentStatus='paused'
    const register:Register=on=>{
      on('agent.spawn',async($,e,next)=>{
        const input:AgentSpawnInput=e
        const teammate:true|undefined=e.isTeammate
        const provider:string=e.provider.plugin
        const result:AgentSpawnResult=await next(e)
        // @ts-expect-error Hook input is immutable.
        e.parentAgentId='forged'
        void [input,teammate,provider]
        return result
      })
      on('tool.check',async($,e,next)=>{
        const input:Readonly<ToolCheckInput>=e
        const id:string|undefined=e.tool_use_id
        const result:ToolCheckResult=await next(e)
        const hook:string|undefined=result.hook
        // @ts-expect-error tool check verdict is the native three literals.
        const bad:ToolCheckResult={decision:'approved'}
        // @ts-expect-error immutable host input.
        e.tool='forged'
        void [input,id,hook,bad];return result
      })
      on('agent.offer',async($,e,next)=>{
        const input:Readonly<AgentOfferInput>=e
        const result:AgentOfferResult=await next(e)
        const offered:boolean=result.isOffered
        // @ts-expect-error provider identity is immutable.
        e.provider.plugin='forged'
        void [input,offered];return result
      })
      on('agent.register',async($,e,next)=>{
        const spec:Readonly<AgentSpec>=e
        const result:{value:{agent:string};deny?:undefined}|{deny:string;value?:undefined}=await next(e)
        // @ts-expect-error Register value is closed.
        const bad:typeof result={value:{agent:'reader'},deny:'No'}
        void [spec,bad];return result
      })
      on('agent.list',async($,e,next)=>{
        const result:{value:AgentInfo[];deny?:undefined}|{deny:string;value?:undefined}=await next(e)
        return result
      })
      // @ts-expect-error A spawn denial cannot also carry a model.
      on('agent.spawn',()=>({deny:'No',model:'haiku'}))
    }
    void [status,agents,inspect,spec,invalid,register]
  `)
  const configPath=join(generated.root,'tsconfig.json');const config=ts.readConfigFile(configPath,ts.sys.readFile)
  const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,generated.root,{skipLibCheck:false},configPath)
  const diagnostics=[...parsed.errors,...ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames,parsed.options))].map(x=>ts.flattenDiagnosticMessageText(x.messageText,'\n')).join('\n')
  expect(diagnostics).toBe('')
})

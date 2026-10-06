import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Fresh processes isolate skill discovery and configuration caches.
const childSource = [
  "import assert from 'node:assert/strict'",
  "import {mkdir,writeFile} from 'node:fs/promises'",
  "import {join} from 'node:path'",
  "await mkdir(join(process.cwd(),'home'),{recursive:true})",
  'const state=await import(' + JSON.stringify(new URL('../bootstrap/state.ts', import.meta.url).href) + ')',
  'state.setOriginalCwd(process.cwd());state.setProjectRoot(process.cwd());state.setCwdState(process.cwd())',
  'const {enableConfigs}=await import(' + JSON.stringify(new URL('../utils/config.ts', import.meta.url).href) + ');enableConfigs()',
  'const loader=await import(' + JSON.stringify(new URL('./loadSkillsDir.ts', import.meta.url).href) + ')',
  'const {prepareForkedCommandContext}=await import(' + JSON.stringify(new URL('../utils/forkedAgent.ts', import.meta.url).href) + ')',
  "const scenario=process.env.FORK_AGENT_SOURCE",
  "const variants=[['number','agent: 42','42'],['zero','agent: 0','0'],['false','agent: false','false'],['true','agent: true','true'],['null','agent: null',undefined],['absent','',undefined],['quoted','agent: \"42\"','42'],['inline','agent: 42','42']]",
  "let commands=[]",
  "if(scenario==='mcp-builder'){const {getMCPSkillBuilders}=await import(" + JSON.stringify(new URL('./mcpSkillBuilders.ts', import.meta.url).href) + ");const {parseFrontmatter}=await import(" + JSON.stringify(new URL('../utils/frontmatterParser.ts', import.meta.url).href) + ");const builders=getMCPSkillBuilders();for(const [name,field] of variants){const md='---\\ndescription: Fork agent type probe\\ncontext: '+(name==='inline'?'inline':'fork')+'\\n'+field+'\\nbackground: false\\ndisallowed-tools: Bash, Edit\\n---\\nFORK-AGENT-BODY $ARGUMENTS';const {frontmatter,content}=parseFrontmatter(md);commands.push(builders.createSkillCommand({...builders.parseSkillFrontmatterFields(frontmatter,content,name),skillName:name,markdownContent:content,source:'mcp',loadedFrom:'mcp',baseDir:undefined,paths:undefined}))}}else{const base=scenario==='user'?join(process.env.CLAUDE_CONFIG_DIR,'skills'):join(process.cwd(),'.claude',scenario==='legacy'?'commands':'skills');for(const [name,field] of variants){const dir=scenario==='legacy'?base:join(base,name);await mkdir(dir,{recursive:true});await writeFile(join(dir,scenario==='legacy'?name+'.md':'SKILL.md'),'---\\ndescription: Fork agent type probe\\ncontext: '+(name==='inline'?'inline':'fork')+'\\n'+field+'\\nbackground: false\\ndisallowed-tools: Bash, Edit\\n---\\nFORK-AGENT-BODY $ARGUMENTS')}commands=await loader.getSkillDirCommands(process.cwd())}",
  "for(const [name,,expected] of variants){const command=commands.find(c=>c.name===name);assert.ok(command,'Skill was not discovered: '+name);assert.equal(command.type,'prompt');assert.equal(command.agent,expected,scenario+': '+name+' must be a string or absent');assert.equal(command.background,false);assert.deepEqual(command.disallowedTools,['Bash','Edit']);assert.equal(command.context,name==='inline'?undefined:'fork');assert.equal(command.source,scenario==='user'?'userSettings':scenario==='mcp-builder'?'mcp':'projectSettings');if(name==='inline')continue;const target=expected??'general-purpose';const agents=[{agentType:'general-purpose',getSystemPrompt:()=>'',whenToUse:'fallback'},{agentType:target,getSystemPrompt:()=>'',whenToUse:'selected'}];const context={abortController:new AbortController(),getAppState:()=>({toolPermissionContext:{alwaysAllowRules:{command:[]}}}),options:{agentDefinitions:{activeAgents:agents}}};const prepared=await prepareForkedCommandContext(command,'argument-marker',context,async()=>({behavior:'allow'}));assert.equal(prepared.baseAgent.agentType,target);assert.ok(prepared.skillContent.includes('FORK-AGENT-BODY argument-marker'));assert.equal(prepared.promptMessages.length,1)}",
].join('\n')

for (const source of ['project', 'legacy', 'user', 'mcp-builder']) {
  test('fork agent selection preserves YAML values from ' + source, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'skill-fork-agent-')))
    const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', childSource], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: join(directory, 'home'),
        CLAUDE_CONFIG_DIR: join(directory, 'config'),
        XDG_CONFIG_HOME: join(directory, 'xdg'),
        XDG_CACHE_HOME: join(directory, 'cache'),
        TMPDIR: directory,
        DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
        FORK_AGENT_SOURCE: source,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(exitCode, stdout + stderr).toBe(0)
    } finally {
      if (child.exitCode === null) { child.kill(); await child.exited }
      await rm(directory, { recursive: true, force: true })
    }
  })
}

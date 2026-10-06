import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Exercise discovery from actual plugin files without sharing loader/config caches.
const childSource = [
  "import assert from 'node:assert/strict'",
  "import {mkdir,writeFile} from 'node:fs/promises'",
  "import {join} from 'node:path'",
  'const state=await import(' + JSON.stringify(new URL('../../bootstrap/state.ts', import.meta.url).href) + ')',
  'state.setOriginalCwd(process.cwd());state.setProjectRoot(process.cwd());state.setCwdState(process.cwd())',
  'const {enableConfigs}=await import(' + JSON.stringify(new URL('../config.ts', import.meta.url).href) + ');enableConfigs()',
  "const scenario=process.env.PLUGIN_FORK_CASE;const plugin=join(process.cwd(),'plugin with space');const manifest={name:'fork-probe',version:'1.0.0'}",
  "const isLegacy=scenario==='legacy';const isCustom=scenario==='custom';const dir=join(plugin,isLegacy?'commands':isCustom?'custom-skills':'skills',...(isLegacy?[]:['probe']))",
  "await mkdir(join(plugin,'.claude-plugin'),{recursive:true});await mkdir(dir,{recursive:true})",
  "if(isCustom)manifest.skills='./custom-skills'",
  "await writeFile(join(plugin,'.claude-plugin/plugin.json'),JSON.stringify(manifest))",
  "const variants=scenario==='inline'?[['probe','context: inline\\nagent: general-purpose',undefined,'general-purpose'],['invalid','context: FORK\\nagent: null',undefined,undefined]]:[['probe','context: fork\\nagent: general-purpose','fork','general-purpose'],['numeric','context: fork\\nagent: 42','fork','42']]",
  "for(const [name,fields] of variants){const base=isLegacy?dir:join(plugin,isCustom?'custom-skills':'skills',name);await mkdir(base,{recursive:true});await writeFile(join(base,isLegacy?name+'.md':'SKILL.md'),'---\\ndescription: Fork plugin probe\\n'+fields+'\\nbackground: false\\n---\\nPLUGIN-FORK-BODY $ARGUMENTS ${CLAUDE_PLUGIN_ROOT}\\n')}",
  'state.setInlinePlugins([plugin])',
  'const {getPluginCommands,getPluginSkills}=await import(' + JSON.stringify(new URL('./loadPluginCommands.ts', import.meta.url).href) + ')',
  'const commands=await (isLegacy?getPluginCommands():getPluginSkills())',
  "for(const [name,,context,agent] of variants){const command=commands.find(c=>c.name==='fork-probe:'+name);assert.ok(command,'Plugin file was not discovered: '+name);assert.equal(command.type,'prompt');assert.equal(command.context,context);assert.equal(command.agent,agent);assert.equal(command.source,'plugin');assert.equal(command.pluginInfo.pluginManifest.name,'fork-probe');const blocks=await command.getPromptForCommand('argument-marker',{getAppState:()=>({toolPermissionContext:{alwaysAllowRules:{}}})});assert.ok(blocks.some(b=>b.type==='text'&&b.text.includes('PLUGIN-FORK-BODY argument-marker '+plugin)))}",
].join('\n')

for (const scenario of ['skill', 'legacy', 'custom', 'inline']) {
  test('plugin discovery preserves fork context and agent: ' + scenario, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'plugin-fork-')))
    const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', childSource], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        CLAUDE_CONFIG_DIR: join(directory, 'config'),
        XDG_CONFIG_HOME: join(directory, 'xdg'),
        XDG_CACHE_HOME: join(directory, 'cache'),
        TMPDIR: directory,
        DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
        PLUGIN_FORK_CASE: scenario,
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

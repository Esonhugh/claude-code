import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getInPlacePluginSource } from './managedPlugins.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, {recursive:true,force:true}))) })

test('managed Mods require an absolute policy directory, relative catalog source, and in-place containment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'managed-mod-source-'))
  roots.push(root)
  const market = join(root,'market'); const plugin = join(market,'plugins','guard')
  await mkdir(join(market,'.claude-plugin'),{recursive:true}); await mkdir(plugin,{recursive:true})
  const catalog = (source: unknown) => writeFile(join(market,'.claude-plugin','marketplace.json'), JSON.stringify({name:'corp',owner:{name:'corp'},plugins:[{name:'guard',source}]}))
  const policy = {enabledPlugins:{'guard@corp':true},extraKnownMarketplaces:{corp:{source:{source:'directory' as const,path:market}}}}
  await catalog('./plugins/guard')
  expect((await getInPlacePluginSource('guard@corp',policy))?.path).toBe(plugin)
  expect((await getInPlacePluginSource('guard@corp', {...policy, enabledPlugins:{'guard@corp':false}}))?.managedSource).toBe(false)
  expect(await getInPlacePluginSource('guard@inline',policy)).toBeUndefined()
  expect(await getInPlacePluginSource('guard@corp', {...policy,extraKnownMarketplaces:{corp:{source:{source:'directory',path:'relative'}}}})).toBeUndefined()
  expect(await getInPlacePluginSource('guard@corp', {...policy,extraKnownMarketplaces:{corp:{source:{source:'github',repo:'corp/mods'}}}})).toBeUndefined()
  await catalog(plugin)
  await expect(getInPlacePluginSource('guard@corp',policy)).rejects.toThrow()
  for (const source of ['./../outside', {source:'github',repo:'corp/guard'}]) {
    await catalog(source)
    expect(await getInPlacePluginSource('guard@corp',policy)).toBeUndefined()
  }
  const outside = join(root,'outside'); await mkdir(outside); await symlink(outside,join(market,'linked'))
  await catalog('./linked')
  expect(await getInPlacePluginSource('guard@corp',policy)).toBeUndefined()
  await writeFile(join(market,'.claude-plugin','marketplace.json'),'{broken')
  await expect(getInPlacePluginSource('guard@corp',policy)).rejects.toThrow()
})

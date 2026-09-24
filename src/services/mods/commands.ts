import type {
  Command,
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'

export type ModCommandSpec = {
  name: string
  description: string
  argumentHint?: string
  immediate?: true
}

export type ModCommandDescription = { description: string; argumentHint?: string; isHidden: boolean }
export type ModCommandRunResult = { text?: string }
export type ModCommandOwner = object

export type ModCommands = {
  register(owner: ModCommandOwner, spec: ModCommandSpec): { command: string }
  validateCommit(owner: ModCommandOwner, replacedOwner?: ModCommandOwner, preparedOwners?: readonly ModCommandOwner[]): void
  commit(owner: ModCommandOwner, replacedOwner?: ModCommandOwner): void
  release(owner: ModCommandOwner): void
  list(): Command[]
  ownerOf(command: Command): ModCommandOwner | undefined
  getSnapshot(): Command[]
  subscribe(listener: () => void): () => void
  projection(existing: Command[]): Command[]
  describe(existing: Command[]): Promise<Command[]>
  invalidateDescriptions(notify?: boolean): void
}

const modCommand = Symbol('mod command')
type MarkedCommand = Command & { [modCommand]: true }

export function isModCommand(command: Command): command is MarkedCommand {
  return (command as Partial<MarkedCommand>)[modCommand] === true
}

export function createModCommands({
  getBuiltinCommands,
  run,
  describe,
  canReplaceBuiltin,
}: {
  getBuiltinCommands: () => readonly Command[]
  describe?: (command: Command, owner?: ModCommandOwner) => Promise<ModCommandDescription>
  canReplaceBuiltin?: (
    owner: ModCommandOwner,
    spec: Readonly<ModCommandSpec>,
    command: Command,
  ) => boolean
  run: (
    command: string,
    args: string,
    context: LocalJSXCommandContext,
  ) => Promise<ModCommandRunResult>
}): ModCommands {
  const candidates = new Map<ModCommandOwner, Map<string, Command>>()
  // An activation may publish before it registers its first command.
  const publishedOwners = new WeakSet<ModCommandOwner>()
  const active = new Map<string, { command: Command; owner: ModCommandOwner }>()
  const listeners = new Set<() => void>()
  let snapshot: Command[] = Object.freeze([]) as Command[]
  let descriptions = new WeakMap<Command, { pending: Promise<void>; command?: Command }>()
  const originals = new WeakMap<Command, Command>()

  function merge(existing: Command[]): Command[] {
    const base = existing.map(command => originals.get(command) ?? command).filter(command => !isModCommand(command))
    if (snapshot.length === 0) return base
    const activeNames = new Set(snapshot.map(command => command.name))
    return [
      ...base.filter(command =>
        !activeNames.has(command.name) &&
        !command.aliases?.some(alias => activeNames.has(alias)),
      ),
      ...snapshot,
    ]
  }

  function projection(existing: Command[]): Command[] {
    if (!describe && snapshot.length === 0 && !existing.some(isModCommand)) return existing
    return merge(existing).map(command => descriptions.get(command)?.command ?? command)
  }

  function validateOwner(owner: ModCommandOwner): void {
    if ((typeof owner !== 'object' && typeof owner !== 'function') || owner === null)
      throw new TypeError('Mod command owner must be an activation object')
  }

  function copySpec(spec: ModCommandSpec): Readonly<ModCommandSpec> {
    if (!spec || typeof spec !== 'object')
      throw new TypeError('Mod command spec must be an object')
    if (typeof spec.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(spec.name))
      throw new TypeError('Mod command name must use 1-64 letters, digits, underscores, or dashes')
    if (typeof spec.description !== 'string' || spec.description.trim() === '')
      throw new TypeError('Mod command description must contain non-whitespace text')
    if (spec.argumentHint !== undefined && typeof spec.argumentHint !== 'string')
      throw new TypeError('Mod command argumentHint must be a string')
    if (spec.immediate !== undefined && spec.immediate !== true)
      throw new TypeError('Mod command immediate may only be true')
    return Object.freeze({
      name: spec.name,
      description: spec.description,
      ...(spec.argumentHint === undefined ? {} : { argumentHint: spec.argumentHint }),
      ...(spec.immediate === true ? { immediate: true as const } : {}),
    })
  }

  function projectCommand(spec: Readonly<ModCommandSpec>): Command {
    const command: MarkedCommand = {
      type: 'local-jsx',
      name: spec.name,
      description: spec.description,
      loadedFrom: 'plugin',
      ...(spec.argumentHint === undefined ? {} : { argumentHint: spec.argumentHint }),
      ...(spec.immediate === true ? { immediate: true } : {}),
      load: async () => ({
        call: async (
          onDone: LocalJSXCommandOnDone,
          context: LocalJSXCommandContext,
          args: string,
        ) => {
          const result = await run(spec.name, args, context)
          if (!result || typeof result !== 'object' || Array.isArray(result))
            throw new TypeError('Mod command run must return an object')
          if (result.text !== undefined && typeof result.text !== 'string')
            throw new TypeError('Mod command run text must be a string')
          if (result.text === undefined) onDone(undefined, { display: 'skip' })
          else onDone(result.text)
          return null
        },
      }),
      [modCommand]: true,
    }
    return command
  }

  function publish(): void {
    snapshot = Object.freeze([...active.values()].map(value => value.command)) as Command[]
    for (const listener of [...listeners]) listener()
  }

  function validateCommit(
    owner: ModCommandOwner,
    replacedOwner?: ModCommandOwner,
    preparedOwners: readonly ModCommandOwner[] = [],
  ): void {
    validateOwner(owner)
    if (replacedOwner !== undefined) validateOwner(replacedOwner)
    for (const name of candidates.get(owner)?.keys() ?? []) {
      const current = active.get(name)
      if (
        (current && current.owner !== owner && current.owner !== replacedOwner) ||
        preparedOwners.some(other => other !== owner && candidates.get(other)?.has(name))
      ) {
        throw new Error(`Mod command /${name} is already owned by another activation`)
      }
    }
  }

  return {
    validateCommit,
    register(owner, input) {
      validateOwner(owner)
      const spec = copySpec(input)
      for (const builtin of getBuiltinCommands()) {
        if (builtin.name !== spec.name && builtin.aliases?.includes(spec.name) !== true)
          continue
        if (
          builtin.name === spec.name &&
          canReplaceBuiltin?.(owner, spec, builtin)
        ) continue
        throw new Error(`Command /${spec.name} refused: it is the built-in /${builtin.name}`)
      }
      if (publishedOwners.has(owner)) {
        const current = active.get(spec.name)
        if (current && current.owner !== owner)
          throw new Error(`Mod command /${spec.name} is already owned by another activation`)
        active.set(spec.name, { command: projectCommand(spec), owner })
        publish()
        return { command: spec.name }
      }
      let owned = candidates.get(owner)
      if (!owned) {
        owned = new Map()
        candidates.set(owner, owned)
      }
      owned.set(spec.name, projectCommand(spec))
      return { command: spec.name }
    },

    commit(owner, replacedOwner) {
      validateCommit(owner, replacedOwner)
      const next = candidates.get(owner) ?? new Map<string, Command>()

      let changed = false
      for (const [name, current] of [...active]) {
        if (current.owner === owner || current.owner === replacedOwner) {
          active.delete(name)
          changed = true
        }
      }
      for (const [name, command] of next) {
        active.set(name, { command, owner })
        changed = true
      }
      candidates.delete(owner)
      if (replacedOwner !== undefined) publishedOwners.delete(replacedOwner)
      publishedOwners.add(owner)
      if (changed) publish()
    },

    release(owner) {
      validateOwner(owner)
      publishedOwners.delete(owner)
      candidates.delete(owner)
      let changed = false
      for (const [name, current] of [...active]) {
        if (current.owner !== owner) continue
        active.delete(name)
        changed = true
      }
      if (changed) publish()
    },

    list: () => snapshot,
    ownerOf(command) {
      const registered = active.get(command.name)
      return registered?.command === (originals.get(command) ?? command) ? registered.owner : undefined
    },
    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    projection,
    async describe(existing) {
      if (!describe) return projection(existing)
      const cache = descriptions
      let changed = false
      await Promise.all(merge(existing).map(command => {
        let entry = cache.get(command)
        if (!entry) {
          const next: { pending: Promise<void>; command?: Command } = { pending: Promise.resolve() }
          cache.set(command, next)
          next.pending = describe(command, active.get(command.name)?.owner).then(result => {
            next.command = { ...command, description: result.description, argumentHint: result.argumentHint, isHidden: result.isHidden }
            originals.set(next.command, command)
            changed = true
          }).catch(error => {
            cache.delete(command)
            throw error
          })
          entry = next
        }
        return entry.pending
      }))
      if (cache === descriptions && changed) publish()
      return projection(existing)
    },
    invalidateDescriptions(notify = true) {
      descriptions = new WeakMap()
      if (notify) publish()
    },
  }
}

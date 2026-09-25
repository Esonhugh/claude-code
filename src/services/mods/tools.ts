import { Ajv, type ValidateFunction } from 'ajv'
import { z } from 'zod/v4'
import {
  buildTool,
  type Tool,
  type ToolInputJSONSchema,
  type Tools,
} from '../../Tool.js'

export type ModToolSpec = {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
}

export type ModToolOwner = object

export type ModTools = {
  register(owner: ModToolOwner, spec: ModToolSpec): { tool: string }
  validateCommit(
    owner: ModToolOwner,
    replacedOwner?: ModToolOwner,
    preparedOwners?: readonly ModToolOwner[],
  ): void
  commit(owner: ModToolOwner, replacedOwner?: ModToolOwner): void
  release(owner: ModToolOwner): void
  projection(baseTools: Tools): Tools
  ownerOf(tool: Tool): ModToolOwner | undefined
  list(): Tools
  getSnapshot(): Tools
  subscribe(listener: () => void): () => void
}

type PreparedSpec = Readonly<{
  name: string
  description: string
  inputSchema: ToolInputJSONSchema
  validateInput: ValidateFunction
}>

export function createModTools({
  notify = listener => listener(),
  pluginOf,
  getBuiltinTools = () => [],
  getTools,
}: {
  notify?: (listener: () => void) => void
  pluginOf: (owner: ModToolOwner) => string
  getBuiltinTools?: () => Tools
  getTools?: () => Tools
}): ModTools {
  const candidates = new Map<ModToolOwner, Map<string, Tool>>()
  const publishedOwners = new WeakSet<ModToolOwner>()
  const projectedTools = new WeakSet<Tool>()
  const active = new Map<string, { tool: Tool; owner: ModToolOwner }>()
  const listeners = new Set<() => void>()
  let snapshot: Tool[] = Object.freeze([]) as Tool[]

  function validateOwner(owner: ModToolOwner): void {
    if (
      (typeof owner !== 'object' && typeof owner !== 'function') ||
      owner === null
    )
      throw new TypeError('Mod tool owner must be an activation object')
  }

  function prepareSpec(spec: ModToolSpec): PreparedSpec {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec))
      throw new TypeError('Mod tool spec must be an object')
    if (
      typeof spec.name !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(spec.name)
    )
      throw new TypeError(
        'Mod tool name must use 1-64 letters, digits, underscores, or dashes',
      )
    if (
      typeof spec.description !== 'string' ||
      spec.description.trim() === ''
    )
      throw new TypeError(
        'Mod tool description must contain non-whitespace text',
      )
    const inputSchema =
      spec.inputSchema === undefined ? { type: 'object' } : spec.inputSchema
    if (
      !inputSchema ||
      typeof inputSchema !== 'object' ||
      Array.isArray(inputSchema)
    )
      throw new TypeError('Mod tool inputSchema must be a JSON schema object')
    if (inputSchema.type !== 'object')
      throw new TypeError('Mod tool inputSchema must describe an object')
    try {
      const copiedSchema = structuredClone(inputSchema) as ToolInputJSONSchema
      const ajv = new Ajv({ allErrors: true })
      if (!ajv.validateSchema(copiedSchema))
        throw new TypeError(
          `Mod tool inputSchema is invalid: ${ajv.errorsText(ajv.errors)}`,
        )
      return Object.freeze({
        name: spec.name,
        description: spec.description.replace(
          /[\uD800-\uDFFF]/gu,
          '\uFFFD',
        ),
        inputSchema: copiedSchema,
        validateInput: ajv.compile(copiedSchema),
      })
    } catch (error) {
      if (error instanceof TypeError) throw error
      throw new TypeError(
        `Mod tool inputSchema is invalid: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  function fullName(owner: ModToolOwner, name: string): string {
    const plugin = pluginOf(owner)
    if (typeof plugin !== 'string' || plugin === '')
      throw new TypeError('Mod tool plugin name must be a non-empty string')
    return `mcp__${plugin.replace(/[^A-Za-z0-9_-]/g, '_')}__${name}`
  }

  function projectTool(
    owner: ModToolOwner,
    spec: PreparedSpec,
    name: string,
  ): Tool {
    const inputSchema = z
      .object({})
      .passthrough()
      .superRefine((input, context) => {
        if (spec.validateInput(input)) return
        for (const error of spec.validateInput.errors ?? []) {
          context.addIssue({
            code: 'custom',
            message: `${error.instancePath || 'root'} ${error.message ?? 'is invalid'}`,
          })
        }
      })
    return buildTool({
      name,
      isMcp: true,
      maxResultSizeChars: 100_000,
      async description() {
        return spec.description
      },
      async prompt() {
        return spec.description
      },
      inputSchema,
      inputJSONSchema: spec.inputSchema,
      isOpenWorld() {
        return false
      },
      async call() {
        throw new Error(
          `Dynamic Mod tool ${name} must be answered by a Mods tool.call hook`,
        )
      },
      mapToolResultToToolResultBlockParam(result, toolUseID) {
        return {
          type: 'tool_result',
          tool_use_id: toolUseID,
          content:
            typeof result === 'string'
              ? result
              : (JSON.stringify(result) ?? String(result)),
        }
      },
      renderToolUseMessage() {
        return null
      },
    })
  }

  function builtinConflict(name: string): Tool | undefined {
    const tools = getTools?.() ?? getBuiltinTools()
    return tools.find(tool =>
      !projectedTools.has(tool) &&
      (tool.name === name || tool.aliases?.includes(name) === true),
    )
  }

  function publish(): void {
    snapshot = Object.freeze([...active.values()].map(value => value.tool)) as Tool[]
    for (const listener of [...listeners]) notify(listener)
  }

  function validateCommit(
    owner: ModToolOwner,
    replacedOwner?: ModToolOwner,
    preparedOwners: readonly ModToolOwner[] = [],
  ): void {
    validateOwner(owner)
    if (replacedOwner !== undefined) validateOwner(replacedOwner)
    for (const name of candidates.get(owner)?.keys() ?? []) {
      const current = active.get(name)
      if (
        (current &&
          current.owner !== owner &&
          current.owner !== replacedOwner) ||
        preparedOwners.some(
          other => other !== owner && candidates.get(other)?.has(name),
        )
      )
        throw new Error(
          `Mod tool ${name} is already owned by another activation`,
        )
    }
  }

  return {
    validateCommit,
    register(owner, input) {
      validateOwner(owner)
      const spec = prepareSpec(input)
      const name = fullName(owner, spec.name)
      const builtin = builtinConflict(name)
      if (builtin)
        throw new Error(
          `Tool ${name} refused: it conflicts with the built-in ${builtin.name}`,
        )
      const tool = projectTool(owner, spec, name)
      projectedTools.add(tool)
      if (publishedOwners.has(owner)) {
        const current = active.get(name)
        if (current && current.owner !== owner)
          throw new Error(
            `Mod tool ${name} is already owned by another activation`,
          )
        active.set(name, { tool, owner })
        publish()
        return { tool: name }
      }
      let owned = candidates.get(owner)
      if (!owned) {
        owned = new Map()
        candidates.set(owner, owned)
      }
      owned.set(name, tool)
      return { tool: name }
    },

    commit(owner, replacedOwner) {
      validateCommit(owner, replacedOwner)
      const next = candidates.get(owner) ?? new Map<string, Tool>()
      let changed = false
      for (const [name, current] of [...active]) {
        if (current.owner === owner || current.owner === replacedOwner) {
          active.delete(name)
          changed = true
        }
      }
      for (const [name, tool] of next) {
        active.set(name, { tool, owner })
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

    projection(baseTools) {
      if (snapshot.length === 0 && !baseTools.some(tool => projectedTools.has(tool)))
        return baseTools
      const activeNames = new Set(snapshot.map(tool => tool.name))
      return [
        ...baseTools.filter(
          tool =>
            !projectedTools.has(tool) &&
            !activeNames.has(tool.name) &&
            !tool.aliases?.some(alias => activeNames.has(alias)),
        ),
        ...snapshot,
      ]
    },
    ownerOf(tool) {
      const registered = active.get(tool.name)
      return registered?.tool === tool ? registered.owner : undefined
    },
    list: () => snapshot,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

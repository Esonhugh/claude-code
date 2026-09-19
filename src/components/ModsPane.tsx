import { parsePatch } from 'diff'
import figures from 'figures'
import React, { useMemo, useState } from 'react'
import type { ModUiCallback, ModUiInteraction, ModUiKeyRow, ModUiPane } from '../services/mods/ui.js'
import { BaseText, Box, Button, type DOMElement, Link, Text, useStdin, useTheme } from '../ink.js'
import ScrollBox, { type ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import type { FocusEvent } from '../ink/events/focus-event.js'
import type { KeyboardEvent } from '../ink/events/keyboard-event.js'
import { getFocusManager, getRootNode } from '../ink/focus.js'
import { hitTest } from '../ink/hit-test.js'
import { nodeCache } from '../ink/node-cache.js'
import type { InputEvent } from '../ink/events/input-event.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import type { Color } from '../ink/styles.js'
import { getTheme, type Theme } from '../utils/theme.js'
import { HighlightedCodeFallback } from './HighlightedCode/Fallback.js'
import { StructuredDiff } from './StructuredDiff.js'

const MAX_TREE_DEPTH = 100
const MAX_TREE_NODES = 2_000
const MAX_TEXT_LENGTH = 10_000
const MAX_TOTAL_TEXT = 1_000_000
const MAX_OPTIONS = 1_000

const boxProps = new Set([
  'key', 'flexDirection', 'flexGrow', 'flexShrink', 'flexWrap', 'alignItems',
  'alignSelf', 'justifyContent', 'gap', 'columnGap', 'rowGap', 'width', 'height',
  'minWidth', 'minHeight', 'margin', 'marginX', 'marginY', 'marginTop',
  'marginBottom', 'marginLeft', 'marginRight', 'padding', 'paddingX', 'paddingY',
  'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'borderStyle',
  'borderColor', 'borderDimColor', 'backgroundColor', 'overflow', 'display',
])
const textProps = new Set([
  'color', 'backgroundColor', 'dimColor', 'bold', 'italic', 'underline',
  'strikethrough', 'inverse', 'wrap',
])
const buttonProps = new Set([
  'key', 'label', 'hotkey', 'action', 'plain', 'dimColor', 'autoFocus',
])
const selectProps = new Set(['key', 'label', 'options', 'value', 'autoFocus'])
const inputProps = new Set([
  'key', 'label', 'placeholder', 'value', 'submitLabel', 'autoFocus',
])
const linkProps = new Set(['href', 'label'])
const codeProps = new Set([
  'source', 'language', 'path', 'startLine', 'format', 'wrap',
])
const boxHoverProps = new Set([
  'scope', 'borderStyle', 'borderColor', 'borderDimColor', 'backgroundColor',
  'display',
])
const textHoverProps = new Set([
  'scope', 'color', 'backgroundColor', 'dimColor', 'bold', 'italic',
  'underline', 'strikethrough', 'inverse',
])
const wrapValues = new Set([
  'wrap', 'end', 'middle', 'truncate', 'truncate-start', 'truncate-middle',
  'truncate-end',
])
const borderStyles = new Set([
  'single', 'double', 'round', 'bold', 'singleDouble', 'doubleSingle',
  'classic', 'arrow', 'dashed',
])
const flexDirections = new Set(['row', 'column', 'row-reverse', 'column-reverse'])
const flexWraps = new Set(['nowrap', 'wrap', 'wrap-reverse'])
const alignItems = new Set(['flex-start', 'center', 'flex-end', 'stretch'])
const alignSelf = new Set(['flex-start', 'center', 'flex-end', 'auto'])
const justifyContent = new Set([
  'flex-start', 'center', 'flex-end', 'space-between', 'space-around',
  'space-evenly',
])
const overflows = new Set(['visible', 'hidden'])
const displays = new Set(['flex', 'none'])
const spacingProps = new Set([
  'gap', 'columnGap', 'rowGap', 'margin', 'marginX', 'marginY', 'marginTop',
  'marginBottom', 'marginLeft', 'marginRight', 'padding', 'paddingX', 'paddingY',
  'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
])
const sizeProps = new Set(['width', 'height', 'minWidth', 'minHeight'])
const booleanTextProps = new Set([
  'dimColor', 'bold', 'italic', 'underline', 'strikethrough', 'inverse',
])
const ansiColors: Readonly<Record<string, string>> = {
  black: '#000000',
  red: '#e5484d',
  green: '#46a758',
  yellow: '#f5d90a',
  blue: '#3e63dd',
  magenta: '#d6409f',
  cyan: '#05a2c2',
  white: '#ffffff',
  gray: '#8b8d98',
  grey: '#8b8d98',
  blackBright: '#6e6e6e',
  redBright: '#ff6369',
  greenBright: '#5bd07f',
  yellowBright: '#ffe629',
  blueBright: '#5b8def',
  magentaBright: '#ee6ac2',
  cyanBright: '#3ec2e0',
  whiteBright: '#ffffff',
}

type RenderNode = string | RenderElement
type RenderElement = {
  type: 'Box' | 'Text' | 'Button' | 'Input' | 'Select' | 'Link' | 'Code'
  props?: Record<string, unknown>
  children?: RenderNode[]
  hover?: Record<string, unknown>
  group?: { plugin: string }
  press?: ModUiCallback
}

type ValidatedTree = {
  tree: RenderElement
  focusKeys: ReadonlySet<string>
  hasAutoFocus: boolean
  hoverBoxes: ReadonlyMap<RenderElement, boolean>
}

type FocusElements = React.RefObject<Map<string, Set<DOMElement>>>
type KeyElements = React.RefObject<Map<string, {
  plugin: string
  key: string
  elements: Set<DOMElement>
}>>
type HoverGroup = { plugin: string; scope: string }
type HoverHandlers = Pick<React.ComponentProps<typeof Box>, 'onMouseEnter' | 'onMouseLeave'>

type HoverGroupEntry = {
  count: number
  listeners: Set<() => void>
}

const LocalHoverContext = React.createContext(false)
const PersonInputContext = React.createContext(false)
const PaneLayoutContext = React.createContext<(() => void) | undefined>(undefined)
const hoverGroups = new Map<string, HoverGroupEntry>()

function hoverGroupKey(group: HoverGroup): string {
  return `${group.plugin}\0scope\0${group.scope}`
}

function updateHoverGroup(key: string, by: 1 | -1): void {
  let entry = hoverGroups.get(key)
  if (!entry && by === 1) {
    entry = { count: 0, listeners: new Set() }
    hoverGroups.set(key, entry)
  }
  if (!entry) return
  entry.count += by
  for (const listener of entry.listeners) listener()
  if (entry.count <= 0 && entry.listeners.size === 0) hoverGroups.delete(key)
}

function subscribeHoverGroup(key: string | undefined, listener: () => void): () => void {
  if (key === undefined) return () => {}
  let entry = hoverGroups.get(key)
  if (!entry) {
    entry = { count: 0, listeners: new Set() }
    hoverGroups.set(key, entry)
  }
  entry.listeners.add(listener)
  return () => {
    entry!.listeners.delete(listener)
    if (entry!.count <= 0 && entry!.listeners.size === 0) hoverGroups.delete(key)
  }
}

function useHoverGroup(group: HoverGroup | undefined): { active: boolean; handlers: HoverHandlers } {
  const key = group === undefined ? undefined : hoverGroupKey(group)
  const active = React.useSyncExternalStore(
    listener => subscribeHoverGroup(key, listener),
    () => key !== undefined && (hoverGroups.get(key)?.count ?? 0) > 0,
    () => false,
  )
  const entered = React.useRef<string | undefined>(undefined)
  React.useLayoutEffect(() => {
    const previous = entered.current
    if (previous === undefined || previous === key) return
    updateHoverGroup(previous, -1)
    if (key !== undefined) updateHoverGroup(key, 1)
    entered.current = key
  }, [key])
  React.useEffect(() => () => {
    if (entered.current !== undefined) updateHoverGroup(entered.current, -1)
  }, [])
  if (key === undefined) return { active: false, handlers: {} }
  return {
    active,
    handlers: {
      onMouseEnter: () => {
        if (entered.current === key) return
        if (entered.current !== undefined) updateHoverGroup(entered.current, -1)
        entered.current = key
        updateHoverGroup(key, 1)
      },
      onMouseLeave: () => {
        if (entered.current !== key) return
        entered.current = undefined
        updateHoverGroup(key, -1)
      },
    },
  }
}

function keyElementId(plugin: string, key: string): string {
  return `${plugin}\0${key}`
}

function useElementRegistration(
  keyElements: KeyElements,
  plugin: string | undefined,
  key: unknown,
  focusElements?: FocusElements,
): (element: DOMElement | null) => void {
  return useMemo(() => {
    let registered: DOMElement | null = null
    return (element: DOMElement | null) => {
      if (typeof key !== 'string' || !key) return
      const id = plugin === undefined ? undefined : keyElementId(plugin, key)
      if (registered) {
        const focused = focusElements?.current.get(key)
        focused?.delete(registered)
        if (focused?.size === 0) focusElements!.current.delete(key)
        const keyed = id === undefined ? undefined : keyElements.current.get(id)
        keyed?.elements.delete(registered)
        if (keyed?.elements.size === 0) keyElements.current.delete(id!)
      }
      registered = element
      if (!element) return
      if (focusElements) {
        let entries = focusElements.current.get(key)
        if (!entries) {
          entries = new Set()
          focusElements.current.set(key, entries)
        }
        entries.add(element)
      }
      if (id !== undefined) {
        let entry = keyElements.current.get(id)
        if (!entry) {
          entry = { plugin: plugin!, key, elements: new Set() }
          keyElements.current.set(id, entry)
        }
        entry.elements.add(element)
      }
    }
  }, [keyElements, plugin, key, focusElements])
}

function documentOrder(root: DOMElement): Map<DOMElement, number> {
  const result = new Map<DOMElement, number>()
  let index = 0
  const visit = (element: DOMElement) => {
    result.set(element, index++)
    for (const child of element.childNodes) {
      if (child.nodeName !== '#text') visit(child)
    }
  }
  visit(root)
  return result
}

function firstInDocumentOrder(
  elements: Iterable<DOMElement>,
  order: ReadonlyMap<DOMElement, number>,
): DOMElement | undefined {
  let first: DOMElement | undefined
  let firstIndex = Number.POSITIVE_INFINITY
  for (const element of elements) {
    const index = order.get(element)
    if (index !== undefined && index < firstIndex) {
      first = element
      firstIndex = index
    }
  }
  return first
}

function rowOf(element: DOMElement, viewport: DOMElement): number {
  let row = 0
  for (let current: DOMElement | undefined = element;
    current && current !== viewport;
    current = current.parentNode) {
    row += current.yogaNode?.getComputedTop() ?? 0
  }
  return row
}

function keyRowsOf(
  elements: KeyElements,
  viewport: DOMElement | undefined,
): readonly ModUiKeyRow[] {
  if (!viewport) return []
  const order = documentOrder(viewport)
  const result: ModUiKeyRow[] = []
  for (const { plugin, key, elements: entries } of elements.current.values()) {
    const element = firstInDocumentOrder(entries, order)
    if (!element) continue
    const top = Math.max(0, Math.floor(rowOf(element, viewport)))
    const height = Math.max(0, Math.ceil(element.yogaNode?.getComputedHeight() ?? 0))
    result.push({ plugin, key, top, bottom: top + height })
  }
  return result
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${label} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError(`${label} must be plain data`)
  return value as Record<string, unknown>
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor))
      throw new TypeError(`${label} accessors are unsupported`)
    if (!allowed.has(key)) throw new TypeError(`Unsupported ${label} prop ${key}`)
  }
}

function hasControl(value: string, singleLine: boolean): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code === 0x7f || (code < 0x20 && (singleLine || (code !== 0x09 && code !== 0x0a))))
      return true
  }
  return false
}

function stringProp(
  props: Record<string, unknown>,
  key: string,
  options: { required?: boolean; singleLine?: boolean; max?: number } = {},
): string | undefined {
  const value = props[key]
  if (value === undefined && !options.required) return undefined
  if (typeof value !== 'string') throw new TypeError(`${key} must be a string`)
  const max = options.max ?? MAX_TEXT_LENGTH
  if (value.length > max) throw new RangeError(`${key} exceeds ${max} characters`)
  if (hasControl(value, options.singleLine === true))
    throw new TypeError(`${key} contains a control character`)
  return value
}

function booleanProp(props: Record<string, unknown>, key: string): void {
  if (props[key] !== undefined && typeof props[key] !== 'boolean')
    throw new TypeError(`${key} must be boolean`)
}

function trueProp(props: Record<string, unknown>, key: string): void {
  if (props[key] !== undefined && props[key] !== true)
    throw new TypeError(`${key} may only be true`)
}

function validatePress(value: unknown, type: string): ModUiCallback {
  const press = record(value, `${type} press`)
  assertKeys(press, new Set(['plugin', 'handle']), `${type} press`)
  if (typeof press.plugin !== 'string' || !press.plugin)
    throw new TypeError(`${type} press plugin must be a string`)
  if (!Number.isInteger(press.handle) || (press.handle as number) < 1)
    throw new TypeError(`${type} press handle must be a positive integer`)
  return press as ModUiCallback
}

function validateHover(
  value: unknown,
  type: 'Box' | 'Text' | 'Button',
): void {
  const hover = record(value, `${type} hover`)
  assertKeys(hover, type === 'Box' ? boxHoverProps : textHoverProps, `${type} hover`)
  const scope = stringProp(hover, 'scope', { singleLine: true, max: 64 })
  if (scope !== undefined && scope.length === 0)
    throw new TypeError('hover scope must not be empty')
  for (const key of booleanTextProps) booleanProp(hover, key)
  booleanProp(hover, 'borderDimColor')
  if (hover.display !== undefined && hover.display !== 'flex')
    throw new TypeError('hover display may only be flex')
  if (hover.borderStyle !== undefined &&
      (typeof hover.borderStyle !== 'string' || !borderStyles.has(hover.borderStyle)))
    throw new TypeError('Unsupported hover borderStyle')
  for (const key of ['color', 'backgroundColor', 'borderColor'])
    if (hover[key] !== undefined) stringProp(hover, key, { singleLine: true })
}

function validBoxKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= MAX_TEXT_LENGTH && !hasControl(value, true)
}

function validateBoxProps(props: Record<string, unknown>): void {
  assertKeys(props, boxProps, 'Box')
  for (const key of spacingProps) {
    if (props[key] !== undefined && (!Number.isInteger(props[key]) || (props[key] as number) < 0))
      throw new TypeError(`Box ${key} must be a non-negative integer`)
  }
  for (const key of ['flexGrow', 'flexShrink']) {
    if (props[key] !== undefined && (typeof props[key] !== 'number' || !Number.isFinite(props[key]) || (props[key] as number) < 0))
      throw new TypeError(`Box ${key} must be a non-negative number`)
  }
  for (const key of sizeProps) {
    const value = props[key]
    if (value !== undefined &&
        !((typeof value === 'number' && Number.isFinite(value) && value >= 0) ||
          (typeof value === 'string' && /^\d+(?:\.\d+)?%$/.test(value))))
      throw new TypeError(`Box ${key} must be a non-negative size`)
  }
  if (props.flexDirection !== undefined && !flexDirections.has(props.flexDirection as string))
    throw new TypeError('Unsupported Box flexDirection')
  if (props.flexWrap !== undefined && !flexWraps.has(props.flexWrap as string))
    throw new TypeError('Unsupported Box flexWrap')
  if (props.alignItems !== undefined && !alignItems.has(props.alignItems as string))
    throw new TypeError('Unsupported Box alignItems')
  if (props.alignSelf !== undefined && !alignSelf.has(props.alignSelf as string))
    throw new TypeError('Unsupported Box alignSelf')
  if (props.justifyContent !== undefined && !justifyContent.has(props.justifyContent as string))
    throw new TypeError('Unsupported Box justifyContent')
  if (props.overflow !== undefined && !overflows.has(props.overflow as string))
    throw new TypeError('Unsupported Box overflow')
  if (props.display !== undefined && !displays.has(props.display as string))
    throw new TypeError('Unsupported Box display')
  if (props.borderStyle !== undefined &&
      (typeof props.borderStyle !== 'string' || !borderStyles.has(props.borderStyle)))
    throw new TypeError('Unsupported Box borderStyle')
  booleanProp(props, 'borderDimColor')
  for (const key of ['borderColor', 'backgroundColor'])
    if (props[key] !== undefined) stringProp(props, key, { singleLine: true })
}

function validateTextProps(props: Record<string, unknown>): void {
  assertKeys(props, textProps, 'Text')
  for (const key of booleanTextProps) booleanProp(props, key)
  for (const key of ['color', 'backgroundColor'])
    if (props[key] !== undefined) stringProp(props, key, { singleLine: true })
  if (props.wrap !== undefined && !wrapValues.has(props.wrap as string))
    throw new TypeError('Unsupported Text wrap')
}

function validateHref(href: string): void {
  if (href.length > 2_048 || !/^[\x20-\x7e]+$/.test(href) || href.includes('@') || href.includes(' '))
    throw new TypeError('Link href must be at most 2048 printable ASCII characters')
  let url: URL
  try {
    url = new URL(href)
  } catch {
    throw new TypeError('Link href must be an absolute URL')
  }
  if (url.username || url.password ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost')) ||
      url.href !== href)
    throw new TypeError('Link href must be canonical https or http://localhost without userinfo')
}

export function validateModRenderTree(value: unknown): ValidatedTree {
  let nodes = 0
  let totalText = 0
  const path = new Set<object>()
  const focusKeys = new Set<string>()
  const hoverBoxes = new Map<RenderElement, boolean>()
  let hasAutoFocus = false

  function countText(value: string): void {
    if (value.length > MAX_TEXT_LENGTH)
      throw new RangeError(`UI string exceeds ${MAX_TEXT_LENGTH} characters`)
    if (hasControl(value, false))
      throw new TypeError('UI string contains a control character')
    totalText += value.length
    if (totalText > MAX_TOTAL_TEXT) throw new RangeError('UI text budget exceeded')
  }

  function visit(
    value: unknown,
    depth: number,
    inInline = false,
    localScope: 'none' | 'valid' | 'hidden' | 'inert' = 'none',
    concealed = false,
    siblingBoxKeys = new Set<string>(),
  ): RenderNode {
    if (++nodes > MAX_TREE_NODES) throw new RangeError('UI tree node budget exceeded')
    if (depth > MAX_TREE_DEPTH) throw new RangeError('UI tree depth exceeded')
    if (typeof value === 'string') {
      countText(value)
      return value
    }
    const node = record(value, 'UI element')
    if (path.has(node)) throw new TypeError('Cyclic UI tree')
    path.add(node)
    assertKeys(node, new Set(['type', 'props', 'children', 'hover', 'group', 'press']), 'element')
    if (!['Box', 'Text', 'Button', 'Input', 'Select', 'Link', 'Code'].includes(String(node.type)))
      throw new TypeError(`Unsupported UI element ${String(node.type)}`)
    const type = node.type as RenderElement['type']
    if (inInline && ['Box', 'Button', 'Input', 'Select', 'Code'].includes(type))
      throw new TypeError(`${type} cannot be nested in an inline element`)
    const props = node.props === undefined ? {} : record(node.props, `${type} props`)

    if (type === 'Box') validateBoxProps(props)
    else if (type === 'Text') validateTextProps(props)
    else if (type === 'Button') {
      assertKeys(props, buttonProps, 'Button')
      const key = stringProp(props, 'key', { required: true, singleLine: true })!
      stringProp(props, 'label', { required: true, singleLine: true })
      stringProp(props, 'hotkey', { singleLine: true, max: 1 })
      stringProp(props, 'action', { singleLine: true, max: 128 })
      trueProp(props, 'plain')
      trueProp(props, 'autoFocus')
      hasAutoFocus ||= props.autoFocus === true
      booleanProp(props, 'dimColor')
      validatePress(node.press, type)
      focusKeys.add(key)
    } else if (type === 'Select') {
      assertKeys(props, selectProps, 'Select')
      const key = stringProp(props, 'key', { required: true, singleLine: true })!
      stringProp(props, 'label', { singleLine: true })
      stringProp(props, 'value', { singleLine: true })
      trueProp(props, 'autoFocus')
      hasAutoFocus ||= props.autoFocus === true
      if (!Array.isArray(props.options) || props.options.length < 1 || props.options.length > MAX_OPTIONS)
        throw new TypeError(`Select options must contain 1-${MAX_OPTIONS} entries`)
      const values = new Set<string>()
      for (const optionValue of props.options) {
        const option = record(optionValue, 'Select option')
        assertKeys(option, new Set(['value', 'label']), 'Select option')
        const optionKey = stringProp(option, 'value', { required: true, singleLine: true })!
        stringProp(option, 'label', { singleLine: true })
        if (values.has(optionKey)) throw new TypeError('Select option values must be unique')
        values.add(optionKey)
      }
      if (props.value !== undefined && !values.has(props.value as string))
        throw new TypeError('Select value must name an option')
      validatePress(node.press, type)
      focusKeys.add(key)
    } else if (type === 'Input') {
      assertKeys(props, inputProps, 'Input')
      const key = stringProp(props, 'key', { required: true, singleLine: true })!
      for (const name of ['label', 'placeholder', 'value', 'submitLabel'])
        stringProp(props, name, { singleLine: true })
      trueProp(props, 'autoFocus')
      hasAutoFocus ||= props.autoFocus === true
      validatePress(node.press, type)
      focusKeys.add(key)
    } else if (type === 'Link') {
      assertKeys(props, linkProps, 'Link')
      const href = stringProp(props, 'href', { required: true, singleLine: true, max: 2_048 })!
      stringProp(props, 'label', { singleLine: true })
      validateHref(href)
    } else {
      assertKeys(props, codeProps, 'Code')
      const source = stringProp(props, 'source', { required: true, max: MAX_TEXT_LENGTH })!
      for (const name of ['language', 'path']) stringProp(props, name, { singleLine: true })
      if (props.startLine !== undefined && (!Number.isInteger(props.startLine) || (props.startLine as number) < 1))
        throw new TypeError('Code startLine must be a positive integer')
      if (props.format !== undefined && !['source', 'diff'].includes(props.format as string))
        throw new TypeError('Unsupported Code format')
      if (props.wrap !== undefined && !['wrap', 'truncate-end'].includes(props.wrap as string))
        throw new TypeError('Unsupported Code wrap')
      if (props.format === 'diff') {
        let hunks = 0
        try {
          hunks = parsePatch(source).reduce((total, file) => total + file.hunks.length, 0)
        } catch {
          // Report the same public validation error for every parser failure.
        }
        if (hunks === 0) throw new TypeError('Code diff source must contain a unified diff hunk')
      }
    }

    for (const [key, value] of Object.entries(props)) {
      if (type === 'Box' && key === 'key') continue
      if (typeof value === 'string') countText(value)
      else if (Array.isArray(value)) {
        for (const entry of value) {
          if (!entry || typeof entry !== 'object') continue
          for (const nested of Object.values(entry as Record<string, unknown>))
            if (typeof nested === 'string') countText(nested)
        }
      }
    }

    let childLocalScope = localScope
    let localScopeIsLive: boolean | undefined
    if (type === 'Box' && props.key !== undefined) {
      const key = props.key
      if (validBoxKey(key)) {
        const uniqueKey = !siblingBoxKeys.has(key)
        siblingBoxKeys.add(key)
        localScopeIsLive = uniqueKey
        childLocalScope = uniqueKey
          ? props.display === 'none' || concealed ? 'hidden' : 'valid'
          : 'inert'
      } else {
        delete props.key
        localScopeIsLive = false
        childLocalScope = 'inert'
      }
    }
    if (node.group !== undefined) {
      const group = record(node.group, `${type} group`)
      assertKeys(group, new Set(['plugin']), `${type} group`)
      const plugin = stringProp(group, 'plugin', { required: true, singleLine: true, max: 64 })!
      if (!plugin) throw new TypeError(`${type} group plugin must not be empty`)
    }
    if (node.hover !== undefined) {
      if (!['Box', 'Text', 'Button'].includes(type))
        throw new TypeError(`${type} does not support hover`)
      validateHover(node.hover, type as 'Box' | 'Text' | 'Button')
      const hover = node.hover as Record<string, unknown>
      if (hover.scope === undefined && childLocalScope === 'none')
        throw new TypeError(`${type} hover requires a visible unique keyed Box or scope`)
      if (hover.scope === undefined && childLocalScope === 'hidden')
        throw new TypeError(`${type} hover requires a visible unique keyed Box`)
      if (hover.scope !== undefined) {
        const owner = type === 'Button' ? node.press : node.group
        if (!owner) throw new TypeError(`${type} hover scope requires a plugin group`)
      }
      if (hover.scope !== undefined && hover.display !== undefined)
        throw new TypeError('hover scope cannot be combined with display')
      if (hover.display !== undefined && props.display !== 'none')
        throw new TypeError('hover display flex requires Box display none')
      if (hover.borderStyle !== undefined && props.borderStyle === undefined)
        throw new TypeError('hover borderStyle requires an existing Box borderStyle')
    }
    if (['Button', 'Input', 'Select', 'Code'].includes(type) && node.children !== undefined)
      throw new TypeError(`${type} is a leaf element`)
    let children: RenderNode[] | undefined
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) throw new TypeError(`${type} children must be an array`)
      const childBoxKeys = new Set<string>()
      children = node.children.map(child =>
        visit(
          child,
          depth + 1,
          inInline || type === 'Text' || type === 'Link',
          childLocalScope,
          concealed || props.display === 'none',
          childBoxKeys,
        ),
      )
    }
    path.delete(node)
    const element: RenderElement = {
      type,
      ...(Object.keys(props).length === 0 ? {} : { props }),
      ...(children === undefined ? {} : { children }),
      ...(node.hover === undefined ? {} : { hover: node.hover as Record<string, unknown> }),
      ...(node.group === undefined ? {} : { group: node.group as { plugin: string } }),
      ...(node.press === undefined ? {} : { press: node.press as ModUiCallback }),
    }
    if (localScopeIsLive !== undefined) hoverBoxes.set(element, localScopeIsLive)
    return element
  }

  const tree = visit(value, 1)
  if (typeof tree === 'string') throw new TypeError('Mod UI render must return an element')
  return { tree, focusKeys, hasAutoFocus, hoverBoxes }
}

type Props = {
  pane: ModUiPane
  onInteract(
    pane: ModUiPane,
    drawing: number,
    callback: ModUiCallback,
    kind: ModUiInteraction,
    element: string,
    value?: string,
  ): Promise<unknown>
  onClose(pane: ModUiPane): Promise<unknown>
  /** Returns the host's final landing and its published snapshot revision. */
  onFocus(pane: ModUiPane, element?: string): Promise<unknown>
  onScroll(pane: ModUiPane, by: number, pointer?: { column: number; row: number }): Promise<unknown>
  /** Person input is allowed by the current composer/dialog presentation. */
  canFocus?: boolean
  onReportMetrics?: (
    pane: ModUiPane,
    metrics: {
      bodyRows: number
      contentRows: number
      keyRows?: readonly ModUiKeyRow[]
    },
  ) => void | Promise<void>
  onError?: (error: unknown) => void
}

export function ModsPane({
  pane,
  onInteract,
  onClose,
  onFocus,
  onScroll,
  onReportMetrics,
  onError,
  canFocus = false,
}: Props): React.ReactNode {
  const rootRef = React.useRef<DOMElement>(null)
  const scrollRef = React.useRef<ScrollBoxHandle>(null)
  const focusElements = React.useRef(new Map<string, Set<DOMElement>>())
  const keyElements = React.useRef(new Map<string, {
    plugin: string
    key: string
    elements: Set<DOMElement>
  }>())
  const validated = useMemo(() => validateModRenderTree(pane.tree), [pane.tree])

  const reportMetrics = React.useCallback(() => {
    const scroll = scrollRef.current
    const bodyRows = scroll?.getElement()?.yogaNode?.getComputedHeight()
    if (!scroll || !onReportMetrics || bodyRows === undefined || bodyRows < 1) return
    void Promise.resolve(onReportMetrics(pane, {
      bodyRows: Math.floor(bodyRows),
      contentRows: Math.max(0, Math.ceil(scroll.getFreshScrollHeight())),
      keyRows: keyRowsOf(keyElements, scroll.getElement()),
    })).catch(error => onError?.(error))
  }, [onReportMetrics, onError, pane])
  React.useLayoutEffect(() => {
    scrollRef.current?.scrollTo(pane.scrollOffset)
    reportMetrics()
  }, [reportMetrics, pane.scrollOffset, validated.tree])

  const latest = React.useRef({ pane, onFocus, onScroll, onError, canFocus })
  latest.current = { pane, onFocus, onScroll, onError, canFocus }
  const applyingFocus = React.useRef(false)
  const focusQueue = React.useRef(Promise.resolve())
  const pendingFocus = React.useRef(0)
  const focusGeneration = React.useRef(0)
  const committedRevision = React.useRef(pane.revision)
  const focusCommit = React.useRef<{
    owner: object; generation: number; revision: number; resolve(): void
  } | undefined>(undefined)
  const focusHandoff = React.useRef<{
    owner: object; generation: number; tree: unknown
    requested: string; landing: string; element: DOMElement
  } | undefined>(undefined)
  const { internal_eventEmitter } = useStdin()

  const navigable = () => {
    const root = rootRef.current
    if (!root) return []
    const order = documentOrder(root)
    return [...focusElements.current].flatMap(([key, entries]) => {
      const visible = [...entries].filter(element => {
        for (let node: DOMElement | undefined = element; node && node !== root; node = node.parentNode) {
          if (node.style.display === 'none') return false
        }
        return order.has(element)
      })
      const element = firstInDocumentOrder(visible, order)
      return element ? [{ key, element }] : []
    }).sort((a, b) => order.get(a.element)! - order.get(b.element)!)
  }
  const applyFocus = (key: string | undefined, focused = true) => {
    const root = rootRef.current
    if (!root) return
    const manager = getFocusManager(root)
    applyingFocus.current = true
    try {
      if (!focused) {
        focusHandoff.current = undefined
        manager.blur()
      } else {
        const entries = navigable()
        if (focusHandoff.current?.landing !== key) focusHandoff.current = undefined
        const handoff = focusHandoff.current
        // Some drawings return the old key of a row's destination slot.
        const reused = handoff && handoff.owner === latest.current.pane.owner &&
          handoff.generation === focusGeneration.current && handoff.landing === key &&
          handoff.tree !== latest.current.pane.tree && entries.find(entry =>
            entry.key === handoff.requested && entry.element === handoff.element &&
            entry.element.attributes.autoFocus === true)
        manager.focus(reused?.element ?? entries.find(entry => entry.key === key)?.element ?? root)
      }
    } finally { applyingFocus.current = false }
  }
  const requestFocus = (target: string | undefined | (() => string | undefined)) => {
    const owner = pane.owner
    const generation = focusGeneration.current
    pendingFocus.current++
    focusQueue.current = focusQueue.current.then(async () => {
      const current = latest.current
      if (!rootRef.current || current.pane.owner !== owner || !current.pane.visible ||
          generation !== focusGeneration.current || !(current.pane.focused || current.canFocus)) return
      const key = typeof target === 'function' ? target() : target
      if (typeof target === 'function' && navigable().some(entry =>
        entry.key === key && entry.element === getFocusManager(rootRef.current!).activeElement)) return
      const before = navigable()
      const result = await current.onFocus(current.pane, key) as {
        deny?: string; element?: string; focused?: boolean; revision?: number
      } | undefined
      if (!rootRef.current || latest.current.pane.owner !== owner || generation !== focusGeneration.current) return
      if (!result?.deny && result?.focused !== false && key !== undefined && result?.element !== undefined) {
        const element = before.find(entry => entry.key === result.element)?.element
        focusHandoff.current = element && result.element !== key ? {
          owner, generation, tree: current.pane.tree, requested: key, landing: result.element, element,
        } : undefined
      }
      if (result?.focused !== false && result?.revision !== undefined &&
          committedRevision.current < result.revision) {
        await new Promise<void>(resolve => {
          focusCommit.current = { owner, generation, revision: result.revision!, resolve }
        })
        if (!rootRef.current || latest.current.pane.owner !== owner || generation !== focusGeneration.current) return
      }
      if (result && 'focused' in result) applyFocus(result.element, result.focused)
      else if (result?.deny) applyFocus(latest.current.pane.focusedElement, latest.current.pane.focused)
      else applyFocus(result?.element ?? key, key !== undefined)
    }).catch(error => {
      if (rootRef.current && generation === focusGeneration.current)
        applyFocus(latest.current.pane.focusedElement, latest.current.pane.focused)
      latest.current.onError?.(error)
    }).finally(() => { pendingFocus.current-- })
    return focusQueue.current
  }
  const handleFocus: Props['onFocus'] = (_pane, key) =>
    !rootRef.current || applyingFocus.current || pendingFocus.current > 0 ? Promise.resolve() : requestFocus(key)

  React.useLayoutEffect(() => {
    if (!pane.visible || !(pane.focused || canFocus)) focusGeneration.current++
  }, [pane.visible, pane.focused, canFocus])

  React.useLayoutEffect(() => {
    committedRevision.current = pane.revision
    const waiting = focusCommit.current
    if (waiting && (waiting.owner !== pane.owner || waiting.generation !== focusGeneration.current ||
        pane.revision >= waiting.revision)) {
      focusCommit.current = undefined
      waiting.resolve()
    }
  })
  React.useLayoutEffect(() => () => {
    focusGeneration.current++
    focusCommit.current?.resolve()
    focusCommit.current = undefined
  }, [pane.owner])

  // Capture coordinates before transcript useInput subscribers consume the wheel.
  React.useEffect(() => {
    const capture = (event: InputEvent) => {
      const current = latest.current
      if (event.key.tab && !event.key.ctrl && !event.key.meta && !event.key.super &&
          current.canFocus && current.pane.visible && !current.pane.focused) {
        const controls = navigable()
        const key = (event.key.shift ? controls.at(-1) : controls[0])?.key
        if (key !== undefined) {
          event.stopImmediatePropagation()
          void requestFocus(key)
        }
        return
      }
      const pointer = event.keypress.pointer
      const viewport = scrollRef.current?.getElement()
      if (!current.pane.visible || !pointer || !viewport ||
          !(event.key.wheelUp || event.key.wheelDown)) return
      let hit: DOMElement | undefined = hitTest(getRootNode(viewport), pointer.column, pointer.row) ?? undefined
      while (hit && hit !== viewport) hit = hit.parentNode
      const rect = nodeCache.get(viewport)
      if (!hit || !rect) return
      event.stopImmediatePropagation()
      void current.onScroll(current.pane, event.key.wheelUp ? -1 : 1, {
        column: pointer.column - rect.x, row: pointer.row - rect.y,
      }).catch(error => current.onError?.(error))
    }
    internal_eventEmitter?.prependListener('input', capture)
    return () => { internal_eventEmitter?.removeListener('input', capture) }
  }, [internal_eventEmitter, pane.owner])

  const actions: Record<string, () => void | false> = Object.create(null)
  const visitActions = (node: RenderElement) => {
    const action = node.props?.action
    if (node.type === 'Button' && typeof action === 'string' && !(action in actions)) {
      actions[action] = () => {
        const current = latest.current.pane
        if (!current.visible || !(current.focused || latest.current.canFocus) ||
            current.owner !== pane.owner || current.drawing !== pane.drawing) return false
        const key = node.props!.key as string
        if (!navigable().some(entry => entry.key === key)) return false
        if (current.drawing === undefined) return false
        void onInteract(current, current.drawing, node.press!, 'press', key).catch(error => onError?.(error))
      }
    }
    if (node.props?.display !== 'none') {
      for (const child of node.children ?? []) if (typeof child !== 'string') visitActions(child)
    }
  }
  visitActions(validated.tree)
  useKeybindings(actions, { context: 'Global', isActive: pane.visible && (pane.focused || canFocus) })

  React.useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const manager = getFocusManager(root)
    if (!pane.focused) {
      let current = manager.activeElement
      while (current) {
        if (current === root) {
          applyFocus(undefined, false)
          break
        }
        current = current.parentNode
      }
      return
    }
    if (pane.focusedElement === undefined || pendingFocus.current > 0) return
    applyFocus(pane.focusedElement)
  }, [pane.focused, pane.focusedElement, validated.tree])

  const run = (operation: Promise<unknown>) => {
    void operation.catch(error => onError?.(error))
  }
  const handleKeyDown = (event: KeyboardEvent) => {
    if (!pane.focused) return
    if (event.ctrl || event.meta || event.superKey || (event.shift && event.key !== 'tab')) return
    if (event.key === 'tab' || event.key === 'up' || event.key === 'down') {
      const controls = navigable()
      const active = rootRef.current && getFocusManager(rootRef.current).activeElement
      const bodyFocused = pane.focusedElement !== undefined &&
        !controls.some(entry => entry.key === pane.focusedElement) && active === rootRef.current
      if (event.key === 'tab' ? controls.length > 0 : controls.length > 1 && !bodyFocused) {
        event.preventDefault()
        const direction = event.key === 'up' || event.key === 'tab' && event.shift ? -1 : 1
        run(requestFocus(() => {
          const entries = navigable()
          const active = rootRef.current && getFocusManager(rootRef.current).activeElement
          const index = entries.findIndex(entry => entry.element === active)
          const next = index < 0 ? (direction === 1 ? 0 : entries.length - 1) : index + direction
          return entries[next]?.key ?? entries[index]?.key
        }))
        return
      }
    }
    let by: number | undefined
    if (event.key === 'up') by = -1
    else if (event.key === 'down') by = 1
    else if (event.key === 'pageup') by = -pane.bodyRows
    else if (event.key === 'pagedown') by = pane.bodyRows
    else if (event.key === 'home') by = -pane.contentRows
    else if (event.key === 'end') by = pane.contentRows
    if (by !== undefined) {
      event.preventDefault()
      run(onScroll(pane, by))
    } else if (event.key === 'escape') {
      event.preventDefault()
      focusGeneration.current++
      focusCommit.current?.resolve()
      focusCommit.current = undefined
      run(pane.closeOnEscape ? onClose(pane) : onFocus(pane))
    }
  }
  return (
    <Box
      ref={rootRef}
      flexDirection="column"
      width="100%"
      height={pane.bodyRows + (pane.title ? 1 : 0)}
      flexGrow={pane.placement === 'dock' ? 1 : 0}
      overflow="hidden"
      tabIndex={pane.focused ? 0 : undefined}
      autoFocus={pane.focused && !validated.hasAutoFocus}
      onFocusCapture={event => {
        if (pane.focused || canFocus || !rootRef.current || applyingFocus.current) return
        const manager = getFocusManager(rootRef.current)
        applyingFocus.current = true
        try {
          if (event.relatedTarget) manager.focus(event.relatedTarget as DOMElement)
          else manager.blur()
        } finally { applyingFocus.current = false }
        event.stopPropagation()
      }}
      onKeyDown={handleKeyDown}
    >
      {pane.title && <Box flexShrink={0}><Text bold>{pane.title}</Text></Box>}
      <ScrollBox
        ref={scrollRef}
        flexGrow={1}
        flexDirection="column"
        width="100%"
      >
        <PersonInputContext.Provider value={pane.visible && (pane.focused || canFocus)}>
          <PaneLayoutContext.Provider value={reportMetrics}>
            <RenderElementNode
              node={validated.tree}
              pane={pane}
              focusElements={focusElements}
              keyElements={keyElements}
              onInteract={onInteract}
              onFocus={handleFocus}
              onError={onError}
              hoverBoxes={validated.hoverBoxes}
              parentInline={false}
            />
          </PaneLayoutContext.Provider>
        </PersonInputContext.Provider>
      </ScrollBox>
    </Box>
  )
}

function groupOf(node: RenderElement): HoverGroup | undefined {
  const scope = node.hover?.scope
  if (typeof scope !== 'string') return undefined
  const plugin = node.type === 'Button' ? node.press?.plugin : node.group?.plugin
  return plugin === undefined ? undefined : { plugin, scope }
}

function terminalStyles(value: Record<string, unknown>): Record<string, unknown> {
  const style = { ...value }
  for (const key of ['color', 'backgroundColor', 'borderColor']) {
    const color = style[key]
    if (typeof color === 'string' && ansiColors[color] !== undefined)
      style[key] = ansiColors[color]
  }
  return style
}

function rawTextStyles(value: Record<string, unknown>, theme: Theme): Record<string, unknown> {
  const style = terminalStyles(value)
  for (const key of ['color', 'backgroundColor']) {
    const color = style[key]
    if (typeof color !== 'string') continue
    if (color.startsWith('#') || color.startsWith('rgb(') ||
        color.startsWith('ansi256(') || color.startsWith('ansi:')) continue
    style[key] = theme[color as keyof Theme] as Color | undefined
  }
  return style
}

function hoverStyles(node: RenderElement, active: boolean): Record<string, unknown> {
  if (!active || !node.hover) return {}
  const { scope: _scope, ...style } = node.hover
  return terminalStyles(style)
}

function RenderElementNode({
  node,
  pane,
  focusElements,
  keyElements,
  onInteract,
  onFocus,
  onError,
  hoverBoxes,
  parentInline = false,
}: {
  node: RenderElement
  pane: ModUiPane
  focusElements: FocusElements
  keyElements: KeyElements
  onInteract: Props['onInteract']
  onFocus: Props['onFocus']
  onError?: Props['onError']
  hoverBoxes: ReadonlyMap<RenderElement, boolean>
  parentInline?: boolean
}): React.ReactNode {
  const inline = parentInline || node.type === 'Text' || node.type === 'Link'
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const props = terminalStyles(node.props ?? {})
  const elementRef = useElementRegistration(keyElements, node.group?.plugin, props.key)
  const group = groupOf(node)
  const groupHover = useHoverGroup(group)
  const localActive = React.useContext(LocalHoverContext)
  const active = group === undefined ? localActive : groupHover.active
  const style = node.type === 'Text' || node.type === 'Button'
    ? rawTextStyles(hoverStyles(node, active), theme)
    : hoverStyles(node, active)
  const canHeatGroup = group !== undefined && !parentInline
  const children = node.children?.map((child, index) =>
    typeof child === 'string'
      ? inline ? child : <Text key={index}>{child}</Text>
      : <RenderElementNode
          key={child.type === 'Box' && hoverBoxes.get(child) === true
            ? String(child.props?.key)
            : index}
          node={child}
          pane={pane}
          focusElements={focusElements}
          keyElements={keyElements}
          onInteract={onInteract}
          onFocus={onFocus}
          onError={onError}
          hoverBoxes={hoverBoxes}
          parentInline={inline}
        />,
  )
  if (node.type === 'Box') {
    const localScopeIsLive = hoverBoxes.get(node)
    if (localScopeIsLive !== undefined) {
      return <ScopedHoverBox
        props={props}
        hover={node.hover}
        group={group}
        isLive={localScopeIsLive}
        elementRef={elementRef}
      >
        {children}
      </ScopedHoverBox>
    }
    return <Box
      {...props as React.ComponentProps<typeof Box>}
      {...style as React.ComponentProps<typeof Box>}
      {...(canHeatGroup ? groupHover.handlers : {})}
      ref={elementRef}
    >
      {children}
    </Box>
  }
  if (node.type === 'Text') {
    const textProps = rawTextStyles({ ...props, ...style }, theme)
    const { dimColor, ...rest } = textProps
    if (dimColor === true) rest.color = theme.inactive as Color
    const text = <BaseText
      {...rest as React.ComponentProps<typeof BaseText>}
    >
      {children}
    </BaseText>
    return canHeatGroup ? <Box {...groupHover.handlers}>{text}</Box> : text
  }
  if (node.type === 'Link') {
    const label = props.label as string | undefined
    return <Link url={props.href as string} fallback={children ?? label ?? props.href as string}>{children ?? label}</Link>
  }
  if (node.type === 'Code') {
    const source = props.source as string
    const language = props.language as string | undefined
    const path = props.path as string | undefined
    if (props.format === 'diff') {
      return <ModDiff source={source} path={path} bodyColumns={pane.bodyColumns} />
    }
    return <HighlightedCodeFallback code={source} filePath={path ?? (language ? `code.${language}` : 'code.md')} />
  }
  if (node.type === 'Button') {
    return <ModButton node={node} pane={pane} focusElements={focusElements} keyElements={keyElements} onInteract={onInteract} onFocus={onFocus} onError={onError} active={active} handlers={canHeatGroup ? groupHover.handlers : {}} />
  }
  if (node.type === 'Select') {
    return <ModSelect node={node} pane={pane} focusElements={focusElements} keyElements={keyElements} onInteract={onInteract} onFocus={onFocus} onError={onError} />
  }
  return <ModInput node={node} pane={pane} focusElements={focusElements} keyElements={keyElements} onInteract={onInteract} onFocus={onFocus} onError={onError} />
}

function ModDiff({ source, path, bodyColumns }: {
  source: string
  path?: string
  bodyColumns: number
}): React.ReactNode {
  const ref = React.useRef<DOMElement>(null)
  const [columns, setColumns] = useState(bodyColumns)
  const reportMetrics = React.useContext(PaneLayoutContext)
  const patches = useMemo(() => parsePatch(source).flatMap(file => file.hunks), [source])
  React.useLayoutEffect(() => {
    const width = ref.current?.yogaNode?.getComputedWidth()
    if (width !== undefined && width > 0) {
      const next = Math.max(1, Math.floor(width))
      if (next !== columns) setColumns(next)
    }
  })
  // Child layout effects run before ScrollBox reattaches its viewport ref.
  React.useEffect(() => { reportMetrics?.() }, [columns, reportMetrics])
  return <Box ref={ref} flexDirection="column" width="100%" maxWidth={bodyColumns}>
    {patches.map((patch, index) => <StructuredDiff
      key={index}
      patch={patch}
      dim={false}
      filePath={path ?? 'change.diff'}
      firstLine={null}
      width={Math.min(columns, bodyColumns)}
    />)}
  </Box>
}

function ScopedHoverBox({
  props,
  hover,
  group,
  isLive,
  elementRef,
  children,
}: {
  props: Record<string, unknown>
  hover?: Record<string, unknown>
  group?: HoverGroup
  isLive: boolean
  elementRef: (element: DOMElement | null) => void
  children: React.ReactNode
}): React.ReactNode {
  const [hovered, setHovered] = useState(false)
  const groupHover = useHoverGroup(group)
  const active = group === undefined ? isLive && hovered : groupHover.active
  const style = !active || !hover ? {} : hoverStyles({ type: 'Box', hover }, true)
  return (
    <LocalHoverContext.Provider value={isLive && hovered}>
      <Box
        {...props as React.ComponentProps<typeof Box>}
        {...style as React.ComponentProps<typeof Box>}
        ref={elementRef}
        onMouseEnter={() => {
          setHovered(true)
          groupHover.handlers.onMouseEnter?.()
        }}
        onMouseLeave={() => {
          setHovered(false)
          groupHover.handlers.onMouseLeave?.()
        }}
      >
        {children}
      </Box>
    </LocalHoverContext.Provider>
  )
}

function reportElementFocus(
  event: FocusEvent,
  pane: ModUiPane,
  key: string,
  onFocus: Props['onFocus'],
  onError?: Props['onError'],
): void {
  if (event.target !== event.currentTarget) return
  void onFocus(pane, key).catch(error => onError?.(error))
}

function ModButton({
  node, pane, focusElements, keyElements, onInteract, onFocus, onError, active, handlers,
}: {
  node: RenderElement
  pane: ModUiPane
  focusElements: FocusElements
  keyElements: KeyElements
  onInteract: Props['onInteract']
  onFocus: Props['onFocus']
  onError?: Props['onError']
  active: boolean
  handlers: HoverHandlers
}): React.ReactNode {
  const inputAllowed = React.useContext(PersonInputContext)
  const props = node.props!
  const key = props.key as string
  const press = node.press!
  const elementRef = useElementRegistration(keyElements, node.group?.plugin ?? press.plugin, key, focusElements)
  const plain = props.plain === true
  const style = hoverStyles(node, active)
  const run = () => {
    if (!inputAllowed || pane.drawing === undefined) return
    void onInteract(pane, pane.drawing, press, 'press', key).catch(error => onError?.(error))
  }
  return (
    <Box {...handlers}>
      <Button
        ref={elementRef}
        onAction={run}
        tabIndex={pane.focused ? 0 : -1}
        autoFocus={pane.focused && props.autoFocus === true}
        onFocus={event => { if (inputAllowed) reportElementFocus(event, pane, key, onFocus, onError) }}
      >
        {({ focused, hovered }) => {
          const chrome = focused || hovered
          return (
            <Text
              inverse={chrome}
              bold={!plain}
              dimColor={props.dimColor === true && !chrome}
              {...style as React.ComponentProps<typeof Text>}
            >
              {plain && props.hotkey
                ? <Text color="suggestion">{props.hotkey as string}</Text>
                : plain ? '' : '[ '}
              {plain && props.hotkey ? ': ' : ''}
              {props.label as string}
              {plain ? '' : ' ]'}
            </Text>
          )
        }}
      </Button>
    </Box>
  )
}

function ModSelect({
  node, pane, focusElements, keyElements, onInteract, onFocus, onError,
}: {
  node: RenderElement
  pane: ModUiPane
  focusElements: FocusElements
  keyElements: KeyElements
  onInteract: Props['onInteract']
  onFocus: Props['onFocus']
  onError?: Props['onError']
}): React.ReactNode {
  const inputAllowed = React.useContext(PersonInputContext)
  const props = node.props!
  const options = props.options as { value: string; label?: string }[]
  const initial = Math.max(0, options.findIndex(option => option.value === props.value))
  const [index, setIndex] = useState(initial)
  const [focused, setFocused] = useState(false)
  const key = props.key as string
  const press = node.press!
  const elementRef = useElementRegistration(keyElements, node.group?.plugin ?? press.plugin, key, focusElements)
  const select = () => {
    if (!inputAllowed || pane.drawing === undefined) return
    const value = options[index]!.value
    void onInteract(pane, pane.drawing, press, 'select', key, value).catch(error => onError?.(error))
  }
  const handle = (event: KeyboardEvent) => {
    if (!pane.focused || event.ctrl || event.meta || event.superKey || event.shift) return
    if (event.key === 'up') {
      event.preventDefault()
      event.stopPropagation()
      setIndex(current => (current + options.length - 1) % options.length)
    } else if (event.key === 'down') {
      event.preventDefault()
      event.stopPropagation()
      setIndex(current => (current + 1) % options.length)
    } else if (event.key === 'return' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      select()
    }
  }
  const option = options[index]!
  return (
    <Box
      ref={elementRef}
      tabIndex={pane.focused ? 0 : -1}
      autoFocus={pane.focused && props.autoFocus === true}
      onFocus={event => {
        setFocused(true)
        if (inputAllowed) reportElementFocus(event, pane, key, onFocus, onError)
      }}
      onBlur={() => setFocused(false)}
      onKeyDown={handle}
      onClick={select}
    >
      {props.label ? <Text>{String(props.label)}: </Text> : null}
      <Text inverse={focused}>{option.label ?? option.value} {figures.arrowUp}{figures.arrowDown}</Text>
    </Box>
  )
}

function ModInput({
  node, pane, focusElements, keyElements, onInteract, onFocus, onError,
}: {
  node: RenderElement
  pane: ModUiPane
  focusElements: FocusElements
  keyElements: KeyElements
  onInteract: Props['onInteract']
  onFocus: Props['onFocus']
  onError?: Props['onError']
}): React.ReactNode {
  const inputAllowed = React.useContext(PersonInputContext)
  const props = node.props!
  const [value, setValue] = useState((props.value as string | undefined) ?? '')
  const [focused, setFocused] = useState(false)
  const key = props.key as string
  const press = node.press!
  const elementRef = useElementRegistration(keyElements, node.group?.plugin ?? press.plugin, key, focusElements)
  const send = (kind: 'change' | 'submit', next: string) => {
    if (!inputAllowed || pane.drawing === undefined) return
    void onInteract(
      pane,
      pane.drawing,
      press,
      kind === 'change' ? 'input.change' : 'input.submit',
      key,
      next,
    ).catch(error => onError?.(error))
  }
  const handle = (event: KeyboardEvent) => {
    if (!pane.focused) return
    if (event.key === 'return') {
      event.preventDefault()
      event.stopPropagation()
      send('submit', value)
      return
    }
    if (['up', 'down', 'left', 'right', 'home', 'end'].includes(event.key) &&
        !event.ctrl && !event.meta && !event.superKey) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    let next = value
    if (event.key === 'backspace' || event.key === 'delete') next = value.slice(0, -1)
    else if (event.key.length === 1 && !event.ctrl && !event.meta) next = value + event.key
    else return
    event.preventDefault()
    event.stopPropagation()
    setValue(next)
    send('change', next)
  }
  return (
    <Box
      ref={elementRef}
      tabIndex={pane.focused ? 0 : -1}
      autoFocus={pane.focused && props.autoFocus === true}
      onFocus={event => {
        setFocused(true)
        if (inputAllowed) reportElementFocus(event, pane, key, onFocus, onError)
      }}
      onBlur={() => setFocused(false)}
      onKeyDown={handle}
    >
      {props.label ? <Text>{String(props.label)}: </Text> : null}
      <Text inverse={focused}>{value || String(props.placeholder ?? '')}</Text>
      <Text dimColor> {String(props.submitLabel ?? 'submit')}</Text>
    </Box>
  )
}

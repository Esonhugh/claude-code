import { parsePatch } from 'diff'
import figures from 'figures'
import { getGraphemeSegmenter } from '../utils/intl.js'
import React, { useMemo, useState } from 'react'
import type { ModRenderSurface, ModUiCallback, ModUiInteraction, ModUiKeyRow, ModUiPane } from '../services/mods/ui.js'
import type { ModClientHandle } from '../services/mods/client.js'
import { copyModClientData } from '../services/mods/client.js'
import { BaseText, Box, Button, type DOMElement, Link, Text, useInput, useStdin, useTheme } from '../ink.js'
import ScrollBox, { type ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import type { FocusEvent } from '../ink/events/focus-event.js'
import type { ClickEvent } from '../ink/events/click-event.js'
import type { PointerEvent } from '../ink/events/pointer-event.js'
import type { KeyboardEvent } from '../ink/events/keyboard-event.js'
import { getFocusManager, getRootNode } from '../ink/focus.js'
import { hitTest } from '../ink/hit-test.js'
import { markDirty, scheduleRenderFrom, type TerminalImagePlacement } from '../ink/dom.js'
import { nodeCache } from '../ink/node-cache.js'
import type { InputEvent } from '../ink/events/input-event.js'
import { useOptionalKeybindingContext } from '../keybindings/KeybindingContext.js'
import { KEYBINDING_ACTIONS } from '../keybindings/schema.js'
import type { Color } from '../ink/styles.js'
import { getTheme, type Theme } from '../utils/theme.js'
import { basename, extname, isAbsolute } from 'node:path'
import { Ansi } from '../ink/Ansi.js'
import { getCliHighlightPromise, type CliHighlight } from '../utils/cliHighlight.js'
import { convertLeadingTabsToSpaces } from '../utils/file.js'
import { wrapAnsi } from '../ink/wrapAnsi.js'
import { StructuredDiff } from './StructuredDiff.js'
import { expectColorDiff } from './StructuredDiff/colorDiff.js'
import { stringWidth } from '../ink/stringWidth.js'
import { useSettings } from '../hooks/useSettings.js'
import { Markdown } from './Markdown.js'
import { TerminalWriteContext } from '../ink/useTerminalNotification.js'
import { wrapForMultiplexer } from '../ink/termio/osc.js'

const MAX_TREE_DEPTH = 100
const MAX_TREE_NODES = 2_000
const MAX_TEXT_LENGTH = 10_000
const MAX_TOTAL_TEXT = 1_000_000
const MAX_OPTIONS = 1_000
const markdownLinkProtocols = ['https:', 'http:', 'file:']

const boxProps = new Set([
  'key', 'flexDirection', 'flexGrow', 'flexShrink', 'flexWrap', 'alignItems',
  'alignSelf', 'justifyContent', 'gap', 'columnGap', 'rowGap', 'width', 'height',
  'minWidth', 'minHeight', 'margin', 'marginX', 'marginY', 'marginTop',
  'marginBottom', 'marginLeft', 'marginRight', 'padding', 'paddingX', 'paddingY',
  'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'borderStyle',
  'borderColor', 'borderDimColor', 'backgroundColor', 'overflow', 'display',
  'position', 'top', 'left', 'right', 'bottom',
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
const clientProps = new Set(['key', 'module', 'props', 'width', 'height', 'flexGrow'])
const rasterProps = new Set(['key', 'columns', 'rows', 'cells'])
const imageProps = new Set(['key', 'source', 'columns', 'rows', 'alt'])
const svgProps = new Set(['source', 'alt', 'width', 'height', 'isInteractive'])
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_PATH_BYTES = 3_072
const boxHoverProps = new Set([
  'scope', 'borderStyle', 'borderColor', 'borderDimColor', 'backgroundColor',
  'display', 'top', 'left', 'right', 'bottom',
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
  type: 'Box' | 'Text' | 'Button' | 'Input' | 'Select' | 'Link' | 'Code' | 'Markdown' | 'Client' | 'Raster' | 'Image' | 'Svg' | 'engine'
  ref?: number
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

type PaneTabEntry = {
  pane: ModUiPane
  onFocus: (pane: ModUiPane, element?: string) => Promise<unknown>
  onError?: (error: unknown) => void
}
type PaneTabGroup = {
  entries: PaneTabEntry[]
  listeners: Set<() => void>
}
const paneTabGroups = new WeakMap<object, Map<ModUiPane['placement'], PaneTabGroup>>()

function paneShown(pane: ModUiPane): boolean | undefined {
  return (pane as ModUiPane & { shown?: boolean }).shown
}

function paneTabGroup(root: object, placement: ModUiPane['placement']): PaneTabGroup {
  let placements = paneTabGroups.get(root)
  if (!placements) {
    placements = new Map()
    paneTabGroups.set(root, placements)
  }
  let group = placements.get(placement)
  if (!group) {
    group = { entries: [], listeners: new Set() }
    placements.set(placement, group)
  }
  return group
}

function notifyPaneTabs(group: PaneTabGroup): void {
  for (const listener of group.listeners) listener()
}

function openPaneTabs(group: PaneTabGroup | undefined): PaneTabEntry[] {
  return group?.entries.filter(entry => entry.pane.visible) ?? []
}

function selectedPaneTab(entries: readonly PaneTabEntry[]): PaneTabEntry | undefined {
  return entries.find(entry => paneShown(entry.pane) === true) ??
    entries.find(entry => paneShown(entry.pane) !== false && entry.pane.focused) ??
    entries.find(entry => paneShown(entry.pane) !== false) ?? entries[0]
}

const hoverGroups = new Map<string, HoverGroupEntry>()
const clientPointerCapture = new WeakMap<object, DOMElement>()
const clientRegions = new WeakSet<DOMElement>()

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
  if (type === 'Box') {
    for (const key of ['top', 'left', 'right', 'bottom']) {
      if (hover[key] !== undefined && !Number.isInteger(hover[key]))
        throw new TypeError(`Box hover ${key} must be an integer`)
    }
  }
  for (const key of ['color', 'backgroundColor', 'borderColor'])
    if (hover[key] !== undefined) stringProp(hover, key, { singleLine: true })
}

function validBoxKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= MAX_TEXT_LENGTH && !hasControl(value, true)
}

function validateBoxProps(props: Record<string, unknown>): void {
  assertKeys(props, boxProps, 'Box')
  if (props.position !== undefined && !['relative', 'absolute'].includes(props.position as string))
    throw new TypeError('Unsupported Box position')
  for (const key of ['top', 'left', 'right', 'bottom']) {
    if (props[key] !== undefined && !Number.isInteger(props[key]))
      throw new TypeError(`Box ${key} must be an integer`)
  }
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

function validateClientProps(props: Record<string, unknown>): void {
  assertKeys(props, clientProps, 'Client')
  const key = stringProp(props, 'key', { required: true, singleLine: true })!
  const module = stringProp(props, 'module', { required: true, singleLine: true })!
  if (!key) throw new TypeError('Client key must not be empty')
  if (!module) throw new TypeError('Client module must not be empty')
  for (const name of ['width', 'height']) {
    const value = props[name]
    if (value !== undefined &&
        !((typeof value === 'number' && Number.isFinite(value) && value >= 0) ||
          (typeof value === 'string' && /^\d+(?:\.\d+)?%$/.test(value))))
      throw new TypeError(`Client ${name} must be a non-negative size`)
  }
  if (props.flexGrow !== undefined &&
      (typeof props.flexGrow !== 'number' || !Number.isFinite(props.flexGrow) || props.flexGrow < 0))
    throw new TypeError('Client flexGrow must be a non-negative number')
  if (props.props !== undefined) copyModClientData(props.props)
}

function boundedIntegerProp(
  props: Record<string, unknown>,
  key: string,
  maximum: number,
  type: string,
): number {
  const value = props[key]
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum)
    throw new TypeError(`${type} ${key} must be an integer from 1 to ${maximum}`)
  return value as number
}

function decodeBase64(value: unknown, label: string, maximum?: number): Buffer {
  if (typeof value !== 'string' || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new TypeError(`${label} must be padded standard base64`)
  const decoded = Buffer.from(value, 'base64')
  if (maximum !== undefined && decoded.length > maximum)
    throw new RangeError(`${label} exceeds ${maximum} decoded bytes`)
  return decoded
}

function validateRasterProps(props: Record<string, unknown>): void {
  assertKeys(props, rasterProps, 'Raster')
  const key = stringProp(props, 'key', { required: true, singleLine: true })!
  if (!key) throw new TypeError('Raster key must not be empty')
  const columns = boundedIntegerProp(props, 'columns', 512, 'Raster')
  const rows = boundedIntegerProp(props, 'rows', 256, 'Raster')
  const cells = decodeBase64(props.cells, 'Raster cells')
  if (cells.length !== columns * rows * 12)
    throw new TypeError('Raster cells decoded length must match columns * rows * 3 little-endian u32 values')
  for (let offset = 0; offset < cells.length; offset += 12) {
    const codePoint = cells.readUInt32LE(offset)
    if (codePoint < 0x20 || codePoint > 0xffff || codePoint === 0x7f ||
        codePoint >= 0xd800 && codePoint <= 0xdfff || stringWidth(String.fromCodePoint(codePoint)) !== 1)
      throw new TypeError('Raster codePoint must be a printable width-1 BMP character')
    for (const colorOffset of [4, 8]) {
      const color = cells.readUInt32LE(offset + colorOffset)
      if (color !== 0x01000000 && color > 0x00ffffff)
        throw new TypeError('Raster colors must be RGB or terminal default')
    }
  }
}

function validateImageSource(value: unknown): void {
  const source = record(value, 'Image source')
  if (Object.hasOwn(source, 'png')) {
    assertKeys(source, new Set(['png']), 'Image png source')
    const bytes = decodeBase64(source.png, 'Image png', MAX_INLINE_IMAGE_BYTES)
    if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      throw new TypeError('Image png must contain a PNG file')
    return
  }
  if (Object.hasOwn(source, 'rgba')) {
    assertKeys(source, new Set(['rgba', 'width', 'height']), 'Image rgba source')
    const width = boundedIntegerProp(source, 'width', 2_048, 'Image source')
    const height = boundedIntegerProp(source, 'height', 2_048, 'Image source')
    const bytes = decodeBase64(source.rgba, 'Image rgba', MAX_INLINE_IMAGE_BYTES)
    if (bytes.length !== width * height * 4)
      throw new TypeError('Image rgba decoded length must match width * height * 4')
    return
  }
  const shared = Object.hasOwn(source, 'shm')
  assertKeys(source, new Set([shared ? 'shm' : 'file', 'format', 'width', 'height', 'generation']), `Image ${shared ? 'shm' : 'file'} source`)
  const path = stringProp(source, shared ? 'shm' : 'file', { required: true, singleLine: true, max: MAX_IMAGE_PATH_BYTES })!
  if (!path || Buffer.byteLength(path) > MAX_IMAGE_PATH_BYTES)
    throw new TypeError('Image source path must be 1-3072 bytes')
  if (shared) {
    if (!/^\/[A-Za-z0-9._-]{1,254}$/.test(path))
      throw new TypeError('Image shm must be a POSIX shared-memory name')
  } else if (!isAbsolute(path)) {
    throw new TypeError('Image file must be an absolute path')
  }
  const format = source.format
  if (shared) {
    if (format !== 'rgba' && format !== 'rgb') throw new TypeError('Image shm format must be rgba or rgb')
  } else if (format !== 'png' && format !== 'rgba' && format !== 'rgb') {
    throw new TypeError('Image file format must be png, rgba, or rgb')
  }
  if (format !== 'png') {
    boundedIntegerProp(source, 'width', 4_096, 'Image source')
    boundedIntegerProp(source, 'height', 4_096, 'Image source')
  } else if (source.width !== undefined || source.height !== undefined) {
    throw new TypeError('Image png file source does not take width or height')
  }
  if (source.generation !== undefined && (!Number.isSafeInteger(source.generation) || (source.generation as number) < 0))
    throw new TypeError('Image generation must be a non-negative safe integer')
}

function validateImageProps(props: Record<string, unknown>): void {
  assertKeys(props, imageProps, 'Image')
  const key = stringProp(props, 'key', { singleLine: true })
  if (key !== undefined && !key) throw new TypeError('Image key must not be empty')
  boundedIntegerProp(props, 'columns', 255, 'Image')
  boundedIntegerProp(props, 'rows', 255, 'Image')
  stringProp(props, 'alt', { required: true })
  validateImageSource(props.source)
}

function validateSvgProps(props: Record<string, unknown>): void {
  assertKeys(props, svgProps, 'Svg')
  const source = stringProp(props, 'source', { required: true, max: 131_072 })!
  const document = source.trim()
  if (!/^<svg(?:\s[^<>]*?)?>[\s\S]*<\/svg>$/.test(document))
    throw new TypeError('Svg source must be a complete SVG document')
  if (/<\s*(?:script|foreignObject|iframe|object|embed)(?:\s|>)/i.test(document) ||
      /\son[a-z][a-z0-9:_-]*\s*=/i.test(document) ||
      /(?:href|src)\s*=\s*(['"])\s*(?:javascript:|data\s*:\s*text\/html)/i.test(document) ||
      /<\s*style(?:\s|>)[\s\S]*(?:@import|url\s*\()/i.test(document))
    throw new TypeError('Svg source contains active content')
  stringProp(props, 'alt', { required: true })
  for (const key of ['width', 'height']) {
    const value = props[key]
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0))
      throw new TypeError(`Svg ${key} must be positive finite CSS pixels`)
  }
  booleanProp(props, 'isInteractive')
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

export function validateModRenderTree(value: unknown, surface: ModRenderSurface = 'terminal', engineRefs?: ReadonlySet<number>): ValidatedTree {
  let nodes = 0
  let totalText = 0
  const path = new Set<object>()
  const focusKeys = new Set<string>()
  const clientKeys = new Set<string>()
  const mediaKeys = new Set<string>()
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
    if (node.type === 'engine') {
      assertKeys(node, new Set(['type', 'ref']), 'engine')
      if (!Number.isInteger(node.ref) || !engineRefs?.has(node.ref as number))
        throw new TypeError('Unknown Mod UI engine ref')
      if (inInline) throw new TypeError('engine cannot be nested in an inline element')
      path.delete(node)
      return { type: 'engine', ref: node.ref as number }
    }
    assertKeys(node, new Set(['type', 'props', 'children', 'hover', 'group', 'press']), 'element')
    if (!['Box', 'Text', 'Button', 'Input', 'Select', 'Link', 'Code', 'Markdown', 'Client', 'Raster', 'Image', 'Svg'].includes(String(node.type)))
      throw new TypeError(`Unsupported UI element ${String(node.type)}`)
    const type = node.type as RenderElement['type']
    if (surface === 'mobile' && ['Input', 'Select'].includes(type))
      throw new TypeError(`${type} is not supported on ${surface}`)
    if (surface === 'terminal' && type === 'Svg')
      throw new TypeError('Svg has no consumer on terminal')
    if (surface !== 'terminal' && ['Client', 'Raster', 'Image'].includes(type))
      throw new TypeError(`${type} has no consumer on ${surface}`)
    if (inInline && ['Box', 'Button', 'Input', 'Select', 'Code', 'Markdown', 'Client', 'Raster', 'Image', 'Svg'].includes(type))
      throw new TypeError(`${type} cannot be nested in an inline element`)
    const props = node.props === undefined ? {} : record(node.props, `${type} props`)

    if (type === 'Box') validateBoxProps(props)
    else if (type === 'Text') validateTextProps(props)
    else if (type === 'Client') validateClientProps(props)
    else if (type === 'Raster') validateRasterProps(props)
    else if (type === 'Image') validateImageProps(props)
    else if (type === 'Svg') validateSvgProps(props)
    else if (type === 'Button') {
      assertKeys(props, buttonProps, 'Button')
      const key = stringProp(props, 'key', { required: true, singleLine: true })!
      stringProp(props, 'label', { required: true, singleLine: true })
      const hotkey = stringProp(props, 'hotkey', { singleLine: true, max: 1 })
      if (hotkey !== undefined && !/^[a-z0-9]$/.test(hotkey))
        throw new TypeError('Button hotkey must be one digit or lowercase letter')
      const action = stringProp(props, 'action', { singleLine: true, max: 128 })
      if (action !== undefined && !(KEYBINDING_ACTIONS as readonly string[]).includes(action))
        throw new TypeError('Unsupported Button action')
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
    } else if (type === 'Markdown') {
      assertKeys(props, new Set(['key', 'text', 'dimColor', 'pressableLinks']), 'Markdown')
      const key = stringProp(props, 'key', { singleLine: true })
      stringProp(props, 'text', { required: true })
      booleanProp(props, 'dimColor')
      if (node.press !== undefined) {
        if (!key) throw new TypeError('Markdown key is required with a press callback')
        validatePress(node.press, type)
        focusKeys.add(key)
      }
      if (props.pressableLinks !== undefined) {
        if (node.press === undefined) throw new TypeError('Markdown pressableLinks requires a press callback')
        if (!Array.isArray(props.pressableLinks) || props.pressableLinks.length > 256)
          throw new TypeError('Markdown pressableLinks must contain at most 256 links')
        for (const href of props.pressableLinks) {
          if (typeof href !== 'string' || href.length > 2_048 || hasControl(href, true))
            throw new TypeError('Markdown pressableLinks entries must be strings of at most 2048 characters')
        }
      }
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
    } else if (type === 'Client' || type === 'Raster' || type === 'Image' && props.key !== undefined) {
      throw new TypeError(`${type} requires a plugin group`)
    }
    if (type === 'Client') {
      const id = keyElementId((node.group as { plugin: string }).plugin, props.key as string)
      if (clientKeys.has(id)) throw new TypeError('Client keys must be unique within a plugin tree')
      clientKeys.add(id)
    }
    if ((type === 'Raster' || type === 'Image') && props.key !== undefined) {
      const id = `${type}\0${keyElementId((node.group as { plugin: string }).plugin, props.key as string)}`
      if (mediaKeys.has(id)) throw new TypeError(`${type} keys must be unique within a plugin tree`)
      mediaKeys.add(id)
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
      if (hover.display !== undefined && props.display !== 'none')
        throw new TypeError('hover display flex requires Box display none')
      if (hover.borderStyle !== undefined && props.borderStyle === undefined)
        throw new TypeError('hover borderStyle requires an existing Box borderStyle')
    }
    if (['Button', 'Input', 'Select', 'Code', 'Markdown', 'Client', 'Raster', 'Image', 'Svg'].includes(type) && node.children !== undefined)
      throw new TypeError(`${type} is a leaf element`)
    if (['Client', 'Raster', 'Image', 'Svg'].includes(type) && (node.hover !== undefined || node.press !== undefined))
      throw new TypeError(`${type} does not support hover or press`)
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

  const latest = React.useRef({ pane, onFocus, onScroll, onInteract, onError, canFocus })
  latest.current = { pane, onFocus, onScroll, onInteract, onError, canFocus }
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
  const [tabsRevision, setTabsRevision] = useState(0)
  const tabGroupRef = React.useRef<PaneTabGroup | undefined>(undefined)
  const tabEntryRef = React.useRef<PaneTabEntry | undefined>(undefined)
  if (tabEntryRef.current) {
    tabEntryRef.current.pane = pane
    tabEntryRef.current.onFocus = onFocus
    tabEntryRef.current.onError = onError
  }
  React.useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const group = paneTabGroup(getRootNode(root), pane.placement)
    const entry = { pane, onFocus, onError }
    tabGroupRef.current = group
    tabEntryRef.current = entry
    group.entries.push(entry)
    setTabsRevision(value => value + 1)
    notifyPaneTabs(group)
    return () => {
      const index = group.entries.indexOf(entry)
      if (index >= 0) group.entries.splice(index, 1)
      tabGroupRef.current = undefined
      tabEntryRef.current = undefined
      notifyPaneTabs(group)
    }
  }, [pane.owner, pane.placement])
  React.useLayoutEffect(() => {
    const group = tabGroupRef.current
    if (group) notifyPaneTabs(group)
  }, [pane.visible, pane.focused, pane.title, paneShown(pane)])
  React.useEffect(() => {
    const group = tabGroupRef.current
    if (!group) return
    const listener = () => setTabsRevision(value => value + 1)
    group.listeners.add(listener)
    return () => { group.listeners.delete(listener) }
  }, [pane.owner, pane.placement])
  void tabsRevision
  const tabs = openPaneTabs(tabGroupRef.current)
  const selectedTab = selectedPaneTab(tabs)
  const showTabs = tabs.length > 1
  const shown = !showTabs || selectedTab?.pane.owner === pane.owner && selectedTab.pane.id === pane.id
  const selectTab = (entry: PaneTabEntry | undefined) => {
    if (!entry || entry.pane.owner === selectedTab?.pane.owner && entry.pane.id === selectedTab.pane.id) return
    void entry.onFocus(entry.pane).catch(error => entry.onError?.(error))
  }
  useInput((_input, key, event) => {
    if (!shown || !showTabs || !pane.visible || !pane.focused || key.ctrl || key.meta || key.super) return
    const offset = key.leftArrow || key.shift && key.tab ? -1 : key.rightArrow ? 1 : 0
    if (!offset) return
    const index = tabs.findIndex(entry => entry.pane.owner === pane.owner && entry.pane.id === pane.id)
    if (index < 0) return
    event.stopImmediatePropagation()
    selectTab(tabs[(index + tabs.length + offset) % tabs.length])
  }, { isActive: shown && showTabs && pane.visible && pane.focused })

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
        const target = reused?.element ?? entries.find(entry => entry.key === key)?.element ?? root
        let active = manager.activeElement
        if (clientRegions.has(target)) {
          while (active && active !== target) active = active.parentNode ?? null
        }
        if (!clientRegions.has(target) || active !== target) manager.focus(target)
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
      let region = before.find(entry => entry.key === key)?.element
      while (region && !clientRegions.has(region)) region = region.parentNode
      const hostKey = region ? before.find(entry => entry.element === region)?.key ?? key : key
      const result = await current.onFocus(current.pane, hostKey) as {
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
      const landing = hostKey !== key && !result?.deny && result?.focused !== false &&
        (result?.element === undefined || result.element === hostKey) ? key : result?.element
      if (result && 'focused' in result) applyFocus(landing, result.focused)
      else if (result?.deny) applyFocus(latest.current.pane.focusedElement, latest.current.pane.focused)
      else applyFocus(landing ?? key, key !== undefined)
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

  const keybindings = useOptionalKeybindingContext()
  const actions: Record<string, () => void | false> = Object.create(null)
  const visitActions = (node: RenderElement) => {
    const action = node.props?.action
    if (node.type === 'Button' && typeof action === 'string') {
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
  const actionsActive = pane.visible && (pane.focused || canFocus)
  React.useEffect(() => {
    if (!keybindings || !actionsActive) return
    const unregister = Object.entries(actions).map(([action, handler]) =>
      keybindings.registerHandler({ action, context: 'Global', handler }))
    return () => { for (const remove of unregister) remove() }
  }, [keybindings, actionsActive, actions])
  useInput((input, key, event) => {
    if (!keybindings) return
    // Chords are dispatched by the existing interceptor. Bare editor keys
    // must reach Input's DOM handler rather than activating an action Button.
    const root = rootRef.current
    const active = root && getFocusManager(root).activeElement
    const inputFocused = (node: RenderElement): boolean =>
      node.type === 'Input' && focusElements.current.get(node.props?.key as string)?.has(active!) === true ||
      (node.children ?? []).some(child => typeof child !== 'string' && inputFocused(child))
    if (!key.ctrl && !key.meta && !key.super && (!pane.focused || inputFocused(validated.tree))) return
    const result = keybindings.resolve(input, key, [...new Set([...keybindings.activeContexts, 'Global' as const])])
    if (result.type === 'match' && result.action in actions && actions[result.action]!() !== false) {
      event.stopImmediatePropagation()
    }
  }, { isActive: actionsActive })

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
    if (!pane.focused || !pane.visible) return
    if (!event.ctrl && !event.meta && !event.superKey && !event.isPasted && /^[a-z0-9]$/i.test(event.key)) {
      let target: RenderElement | undefined
      const visit = (node: RenderElement) => {
        if (node.props?.display === 'none') return
        if (node.type === 'Button' && node.props?.hotkey === event.key.toLowerCase()) target = node
        for (const child of node.children ?? []) if (typeof child !== 'string') visit(child)
      }
      visit(validated.tree)
      if (target && pane.drawing !== undefined) {
        event.preventDefault()
        event.stopPropagation()
        run(onInteract(pane, pane.drawing, target.press!, 'press', target.props!.key as string))
        return
      }
    }
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
      height={shown ? pane.bodyRows + (showTabs ? 1 : 0) : 0}
      flexGrow={shown && pane.placement === 'dock' ? 1 : 0}
      overflow="hidden"
      display={shown ? 'flex' : 'none'}
      tabIndex={shown && pane.focused ? 0 : undefined}
      autoFocus={shown && pane.focused && !validated.hasAutoFocus}
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
      {showTabs && <Box flexShrink={0} gap={1}>
        {tabs.map((entry, index) => {
          const selected = entry.pane.owner === selectedTab?.pane.owner && entry.pane.id === selectedTab.pane.id
          return <Box key={`${entry.pane.plugin}:${entry.pane.id}:${index}`} onClick={() => selectTab(entry)}>
            <Text bold={selected} inverse={selected}> {entry.pane.title} </Text>
          </Box>
        })}
      </Box>}
      <ScrollBox
        ref={scrollRef}
        flexGrow={1}
        flexDirection="column"
        width="100%"
      >
        <PersonInputContext.Provider value={shown && pane.visible && (pane.focused || canFocus)}>
          <PaneLayoutContext.Provider value={reportMetrics}>
            <RenderElementNode
              node={validated.tree}
              pane={pane}
              focusElements={focusElements}
              keyElements={keyElements}
              onInteract={onInteract}
              currentPane={() => latest.current.pane}
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

function ModRaster({ props }: { props: Record<string, unknown> }): React.ReactNode {
  const columns = props.columns as number
  const rows = props.rows as number
  const cells = Buffer.from(props.cells as string, 'base64')
  const lines = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => {
      const offset = (row * columns + column) * 12
      const foreground = cells.readUInt32LE(offset + 4)
      const background = cells.readUInt32LE(offset + 8)
      const color = foreground === 0x01000000
        ? undefined
        : `#${foreground.toString(16).padStart(6, '0')}`
      const backgroundColor = background === 0x01000000
        ? undefined
        : `#${background.toString(16).padStart(6, '0')}`
      return <BaseText key={column} color={color as Color | undefined} backgroundColor={backgroundColor as Color | undefined}>
        {String.fromCodePoint(cells.readUInt32LE(offset))}
      </BaseText>
    }),
  )
  return <Box flexDirection="column" width={columns} height={rows}>
    {lines.map((line, row) => <BaseText key={row}>{line}</BaseText>)}
  </Box>
}

type ImageSource =
  | { png: string }
  | { rgba: string; width: number; height: number }
  | { file: string; format: 'png' | 'rgb' | 'rgba'; width?: number; height?: number; generation?: number }
  | { shm: string; format: 'rgb' | 'rgba'; width: number; height: number; generation?: number }

function supportsTerminalImages(isTTY: boolean): boolean {
  if (!isTTY) return false
  const terminal = `${process.env.TERM_PROGRAM ?? ''} ${process.env.LC_TERMINAL ?? ''} ${process.env.TERM ?? ''}`.toLowerCase()
  return terminal.includes('kitty') || terminal.includes('ghostty')
}

function imageSourceIdentity(source: ImageSource): string {
  if ('png' in source) return `png\0${source.png}`
  if ('rgba' in source) return `rgba\0${source.width}\0${source.height}\0${source.rgba}`
  const name = 'file' in source ? source.file : source.shm
  return `${'file' in source ? 'file' : 'shm'}\0${name}\0${source.format}\0${source.width ?? ''}\0${source.height ?? ''}\0${source.generation ?? ''}`
}

function imagePixelSize(source: ImageSource): { width: number; height: number } | undefined {
  if ('rgba' in source)
    return { width: source.width, height: source.height }
  if ('file' in source) {
    if (source.format !== 'png')
      return { width: source.width!, height: source.height! }
    return source.width !== undefined && source.height !== undefined
      ? { width: source.width, height: source.height }
      : undefined
  }
  if ('shm' in source)
    return { width: source.width, height: source.height }
  const header = Buffer.from(source.png.slice(0, 32), 'base64')
  if (
    header.length < 24 ||
    header.toString('hex', 0, 8) !== '89504e470d0a1a0a' ||
    header.toString('ascii', 12, 16) !== 'IHDR'
  ) return undefined
  return {
    width: header.readUInt32BE(16),
    height: header.readUInt32BE(20),
  }
}

function kittyImageSequences(source: ImageSource, placement: TerminalImagePlacement, id: number): string[] {
  let payload: string
  let medium: 'd' | 'f' | 's'
  let format: 24 | 32 | 100
  let dimensions = ''
  if ('png' in source) {
    payload = source.png
    medium = 'd'
    format = 100
  } else if ('rgba' in source) {
    payload = source.rgba
    medium = 'd'
    format = 32
    dimensions = `,s=${source.width},v=${source.height}`
  } else {
    const name = 'file' in source ? source.file : source.shm
    payload = Buffer.from(name).toString('base64')
    medium = 'file' in source ? 'f' : 's'
    format = source.format === 'png' ? 100 : source.format === 'rgb' ? 24 : 32
    if (source.format !== 'png') dimensions = `,s=${source.width},v=${source.height}`
  }
  const chunks: string[] = []
  for (let offset = 0; offset < payload.length || offset === 0; offset += 4_096)
    chunks.push(payload.slice(offset, offset + 4_096))
  const { columns, rows, sourceLeft, sourceTop, sourceColumns, sourceRows } = placement
  const clipped = sourceLeft !== 0 || sourceTop !== 0 || columns !== sourceColumns || rows !== sourceRows
  const pixels = imagePixelSize(source)
  if (clipped && !pixels) return []
  const crop = clipped
    ? (() => {
        const x = Math.floor(sourceLeft * pixels!.width / sourceColumns)
        const y = Math.floor(sourceTop * pixels!.height / sourceRows)
        const right = Math.ceil((sourceLeft + columns) * pixels!.width / sourceColumns)
        const bottom = Math.ceil((sourceTop + rows) * pixels!.height / sourceRows)
        return `,x=${x},y=${y},w=${right - x},h=${bottom - y}`
      })()
    : ''
  return chunks.map((chunk, index) => {
    const more = index < chunks.length - 1 ? 1 : 0
    const control = index === 0
      ? `a=T,f=${format}${dimensions},t=${medium}${crop},c=${columns},r=${rows},C=1,i=${id},m=${more}`
      : `m=${more}`
    return wrapForMultiplexer(`\u001b_G${control};${chunk}\u001b\\`)
  })
}

let nextTerminalImageId = 1

function ModImage({ props }: { props: Record<string, unknown> }): React.ReactNode {
  const terminal = React.useContext(TerminalWriteContext)
  const source = props.source as ImageSource
  const identity = imageSourceIdentity(source)
  const sharedFrame = 'shm' in source ? source : undefined
  const sharedSequence = React.useRef(0)
  const stable = React.useMemo(() => ({
    identity: sharedFrame ? `${identity}\0${++sharedSequence.current}` : identity,
    source,
  }), [identity, sharedFrame])
  const id = React.useState(() => nextTerminalImageId++)[0]
  const supported = terminal !== null && supportsTerminalImages(terminal.isTTY)
  const renderedNode = React.useRef<DOMElement | null>(null)
  const image = React.useMemo(() => supported
    ? {
        id,
        identity: stable.identity,
        sequences: (placement: TerminalImagePlacement) => kittyImageSequences(stable.source, placement, id),
      }
    : undefined, [id, stable, supported])
  const imageRef = React.useRef(image)
  imageRef.current = image
  React.useLayoutEffect(() => {
    const node = renderedNode.current
    if (!node) return
    if (image) node.terminalImage = image
    else delete node.terminalImage
    markDirty(node)
    scheduleRenderFrom(node)
  }, [image])
  React.useLayoutEffect(() => () => {
    const node = renderedNode.current
    if (!node || node.terminalImage !== imageRef.current) return
    delete node.terminalImage
    markDirty(node)
    scheduleRenderFrom(node)
  }, [])
  const element = React.useCallback((node: DOMElement | null) => {
    renderedNode.current = node
  }, [])
  if (supported) return <Box ref={element} width={props.columns as number} height={props.rows as number} />
  return <Box width={props.columns as number} height={props.rows as number} overflow="hidden">
    <Text wrap="truncate-end">{props.alt as string}</Text>
  </Box>
}

function RenderElementNode({
  node,
  pane,
  focusElements,
  keyElements,
  onInteract,
  currentPane,
  onFocus,
  onError,
  hoverBoxes,
  clientHandle,
  parentInline = false,
}: {
  node: RenderElement
  pane: ModUiPane
  focusElements: FocusElements
  keyElements: KeyElements
  onInteract: Props['onInteract']
  currentPane: () => ModUiPane
  onFocus: Props['onFocus']
  onError?: Props['onError']
  hoverBoxes: ReadonlyMap<RenderElement, boolean>
  clientHandle?: ModClientHandle
  parentInline?: boolean
}): React.ReactNode {
  const inline = parentInline || node.type === 'Text' || node.type === 'Link'
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const props = terminalStyles(node.props ?? {})
  const elementRef = useElementRegistration(keyElements, node.group?.plugin, props.key)
  const markdownLinks = React.useRef(new Set<DOMElement>())
  const registerMarkdownLink = React.useCallback((element: DOMElement, active: boolean) => {
    if (active) markdownLinks.current.add(element)
    else markdownLinks.current.delete(element)
    const key = props.key
    const plugin = node.press?.plugin
    if (typeof key !== 'string' || !plugin) return
    const id = keyElementId(plugin, key)
    const focused = focusElements.current.get(key)
    const keyed = keyElements.current.get(id)
    if (active) {
      if (focused) focused.add(element)
      else focusElements.current.set(key, new Set([element]))
      if (keyed) keyed.elements.add(element)
      else keyElements.current.set(id, { plugin, key, elements: new Set([element]) })
    } else {
      focused?.delete(element)
      if (focused?.size === 0) focusElements.current.delete(key)
      keyed?.elements.delete(element)
      if (keyed?.elements.size === 0) keyElements.current.delete(id)
    }
  }, [focusElements, keyElements, node.press?.plugin, props.key])
  React.useLayoutEffect(() => () => {
    for (const element of markdownLinks.current) registerMarkdownLink(element, false)
    markdownLinks.current.clear()
  }, [registerMarkdownLink])
  const group = groupOf(node)
  const groupHover = useHoverGroup(group)
  const localActive = React.useContext(LocalHoverContext)
  const active = group === undefined ? localActive : groupHover.active
  const style = node.type === 'Text' || node.type === 'Button'
    ? rawTextStyles(hoverStyles(node, active), theme)
    : hoverStyles(node, active)
  const canHeatGroup = group !== undefined && !parentInline
  const children = node.children?.map((child, index) => {
    if (typeof child === 'string') return inline ? child : <Text key={index}>{child}</Text>
    const childKey = child.type === 'Client'
      ? `${child.group!.plugin}\0${String(child.props!.key)}\0${String(child.props!.module)}`
      : child.type === 'Image' && child.props?.key !== undefined
        ? `${child.group!.plugin}\0${String(child.props.key)}`
        : child.type === 'Box' && hoverBoxes.get(child) === true
          ? String(child.props?.key)
          : index
    return <RenderElementNode
      key={childKey}
      node={child}
      pane={pane}
      focusElements={focusElements}
      keyElements={keyElements}
      onInteract={onInteract}
      currentPane={currentPane}
      onFocus={onFocus}
      onError={onError}
      hoverBoxes={hoverBoxes}
      clientHandle={clientHandle}
      parentInline={inline}
    />
  })
  if (node.type === 'Client') {
    return <ModClient node={node} pane={pane} focusElements={focusElements} keyElements={keyElements}
      onFocus={onFocus} onError={onError} hoverBoxes={hoverBoxes} />
  }
  if (node.type === 'Raster') return <ModRaster props={props} />
  if (node.type === 'Image') return <ModImage props={props} />
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
    const content = node.children?.some(child => child !== '') ? children : label ?? props.href as string
    return <Link url={props.href as string} fallback={content}>{content}</Link>
  }
  if (node.type === 'Markdown') {
    const drawing = pane.drawing
    const owner = pane.owner
    const key = props.key as string | undefined
    const press = node.press
    const onLinkPress = drawing === undefined || key === undefined || press === undefined ? undefined : (href: string) => {
      const current = currentPane()
      if (current.owner !== owner || current.drawing !== drawing) return
      void onInteract(current, drawing, press, 'link.press', key, href).catch(error => onError?.(error))
    }
    return <Box ref={elementRef} flexDirection="column" width="100%">
      <Markdown
        dimColor={props.dimColor as boolean | undefined}
        allowedLinkProtocols={markdownLinkProtocols}
        onLinkPress={onLinkPress}
        pressableLinks={props.pressableLinks as readonly string[] | undefined}
        registerPressableLink={key === undefined ? undefined : registerMarkdownLink}
      >{props.text as string}</Markdown>
    </Box>
  }
  if (node.type === 'Code') {
    const source = props.source as string
    const language = props.language as string | undefined
    const path = props.path as string | undefined
    if (props.format === 'diff') {
      return <ModDiff source={source} path={path}
        wrap={props.wrap as 'wrap' | 'truncate-end' | undefined} bodyColumns={pane.bodyColumns} />
    }
    return <ModCode source={source} language={language} path={path}
      startLine={props.startLine as number | undefined}
      wrap={props.wrap as 'wrap' | 'truncate-end' | undefined} />
  }
  const interact = clientHandle === undefined
    ? onInteract
    : async (
      _pane: ModUiPane,
      _drawing: number,
      callback: ModUiCallback,
      kind: ModUiInteraction,
      element: string,
      value?: string,
    ) => clientHandle.press(callback, kind, element, value)
  if (node.type === 'Button') {
    return <ModButton node={node} pane={pane} focusElements={focusElements} keyElements={keyElements} onInteract={interact} onFocus={onFocus} onError={onError} active={active} handlers={canHeatGroup ? groupHover.handlers : {}} />
  }
  if (node.type === 'Select') {
    return <ModSelect node={node} pane={pane} focusElements={focusElements} keyElements={keyElements} onInteract={interact} onFocus={onFocus} onError={onError} />
  }
  return <ModInput node={node} pane={pane} focusElements={focusElements} keyElements={keyElements} onInteract={interact} currentPane={currentPane} onFocus={onFocus} onError={onError} />
}

function ModClient({
  node, pane, focusElements, keyElements, onFocus, onError,
}: {
  node: RenderElement
  pane: ModUiPane
  focusElements: FocusElements
  keyElements: KeyElements
  onFocus: Props['onFocus']
  onError?: Props['onError']
  hoverBoxes: ReadonlyMap<RenderElement, boolean>
}): React.ReactNode {
  const inputAllowed = React.useContext(PersonInputContext)
  const reportMetrics = React.useContext(PaneLayoutContext)
  const props = node.props!
  const key = props.key as string
  const plugin = node.group!.plugin
  const module = props.module as string
  const element = React.useRef<DOMElement>(null)
  const handle = React.useRef<ModClientHandle | undefined>(undefined)
  const releasePointer = React.useRef<(() => void) | undefined>(undefined)
  const mounted = React.useRef<{ pane: ModUiPane; node: RenderElement } | undefined>(undefined)
  const lastSize = React.useRef<[number, number] | undefined>(undefined)
  const latestError = React.useRef(onError)
  latestError.current = onError
  const [frame, setFrame] = useState<ValidatedTree>()
  const register = useElementRegistration(keyElements, plugin, key, focusElements)
  const elementRef = React.useCallback((value: DOMElement | null) => {
    if (element.current) clientRegions.delete(element.current)
    element.current = value
    if (value) clientRegions.add(value)
    register(value)
  }, [register])

  React.useLayoutEffect(() => {
    setFrame(undefined)
    if (!pane.clients) {
      latestError.current?.(new Error('Client cannot mount without a terminal clients host'))
      return
    }
    let active = true
    let next: ModClientHandle
    try {
      next = pane.clients.mount(pane, node, tree => {
        if (!active) return
        try {
          const validated = validateModRenderTree(tree)
          const visit = (current: RenderElement): void => {
            if (current.type === 'Client') throw new TypeError('A Client module cannot render another Client')
            for (const child of current.children ?? []) if (typeof child !== 'string') visit(child)
          }
          visit(validated.tree)
          setFrame(validated)
        } catch (error) {
          active = false
          setFrame(undefined)
          releasePointer.current?.()
          const failed = handle.current
          handle.current = undefined
          void failed?.dispose().catch(failure => latestError.current?.(failure))
          latestError.current?.(error)
        }
      }, error => {
        active = false
        setFrame(undefined)
        handle.current = undefined
        releasePointer.current?.()
        latestError.current?.(error)
      })
    } catch (error) {
      latestError.current?.(error)
      return
    }
    if (!active) {
      void next.dispose().catch(error => latestError.current?.(error))
      return
    }
    handle.current = next
    mounted.current = { pane, node }
    lastSize.current = undefined
    // The host owns failure reporting through the onError passed to mount.
    void next.ready.catch(() => {})
    return () => {
      active = false
      if (handle.current === next) {
        handle.current = undefined
        mounted.current = undefined
        lastSize.current = undefined
      }
      void next.dispose().catch(error => latestError.current?.(error))
    }
  }, [pane.clients, pane.owner, plugin, key, module])

  React.useLayoutEffect(() => {
    const current = handle.current
    const previous = mounted.current
    if (!current || !previous || previous.pane === pane && previous.node === node) return
    mounted.current = { pane, node }
    void current.update(pane, node).catch(error => latestError.current?.(error))
  }, [pane, node])

  React.useLayoutEffect(() => {
    const current = handle.current
    const layout = element.current?.yogaNode
    if (!current || !layout) return
    const columns = Math.max(0, Math.floor(layout.getComputedWidth()))
    const rows = Math.max(0, Math.floor(layout.getComputedHeight()))
    if (lastSize.current?.[0] === columns && lastSize.current[1] === rows) return
    lastSize.current = [columns, rows]
    void current.resize(columns, rows).catch(error => latestError.current?.(error))
  })
  React.useEffect(() => { reportMetrics?.() }, [frame, reportMetrics])

  const run = (operation: Promise<unknown>) => {
    void operation.catch(error => latestError.current?.(error))
  }
  const { internal_eventEmitter } = useStdin()
  React.useEffect(() => {
    if (!internal_eventEmitter || !inputAllowed || !pane.visible) return
    let captured = false
    let hovered = false
    let lastMove = { x: 0, y: 0 }
    const wheel = (event: InputEvent) => {
      if (captured && (event.key.wheelUp || event.key.wheelDown)) event.stopImmediatePropagation()
    }
    const release = () => {
      if (captured) clientPointerCapture.delete(internal_eventEmitter)
      captured = false
      internal_eventEmitter.removeListener('input', wheel)
    }
    releasePointer.current = release
    const pointer = (event: PointerEvent) => {
      const current = handle.current
      const region = element.current
      const rect = region && nodeCache.get(region)
      if (!current || !region || !rect) { release(); return }
      const owner = clientPointerCapture.get(internal_eventEmitter)
      if (owner && owner !== region) return
      let hit: DOMElement | undefined = hitTest(getRootNode(region), event.col, event.row) ?? undefined
      let localControl = false
      while (hit && hit !== region) {
        if (typeof hit.attributes.tabIndex === 'number' || hit._eventHandlers?.onClick) localControl = true
        hit = hit.parentNode
      }
      if (event.type === 'move') {
        if (hit && !hovered) {
          lastMove = { x: event.col - rect.x, y: event.row - rect.y }
          void current.pointer({ type: 'enter', ...lastMove }).catch(error => latestError.current?.(error))
        } else if (!hit && hovered) {
          void current.pointer({ type: 'leave', ...lastMove }).catch(error => latestError.current?.(error))
        }
        hovered = !!hit
      }
      // Hover belongs to the whole region; local controls keep their clicks.
      if (!captured && (!hit || localControl && event.type !== 'move')) return
      if (event.type === 'move') lastMove = { x: event.col - rect.x, y: event.row - rect.y }
      if (captured || event.type !== 'move' || event.button !== 3) event.stopImmediatePropagation()
      if (event.type === 'down') {
        hovered = true
        lastMove = { x: event.col - rect.x, y: event.row - rect.y }
        captured = true
        clientPointerCapture.set(internal_eventEmitter, region)
        internal_eventEmitter.removeListener('input', wheel)
        internal_eventEmitter.prependListener('input', wheel)
        getFocusManager(region).handleClickFocus(region)
      }
      if (event.type === 'up') release()
      void current.pointer({
        type: event.type, x: event.col - rect.x, y: event.row - rect.y,
        ...(event.button < 3 ? { button: ['left', 'middle', 'right'][event.button] } : {}),
        ...(event.shift ? { shift: true } : {}),
        ...(event.alt ? { alt: true } : {}),
        ...(event.ctrl ? { ctrl: true } : {}),
      }).catch(error => latestError.current?.(error))
    }
    internal_eventEmitter.prependListener('pointer', pointer)
    internal_eventEmitter.on('terminalblur', release)
    return () => {
      release()
      if (releasePointer.current === release) releasePointer.current = undefined
      internal_eventEmitter.removeListener('pointer', pointer)
      internal_eventEmitter.removeListener('terminalblur', release)
    }
  }, [internal_eventEmitter, inputAllowed, pane.visible, pane.owner, module, key, plugin])
  const keyDown = (event: KeyboardEvent) => {
    const current = handle.current
    if (!current || !inputAllowed || !pane.visible || event.currentTarget !== event.target || event.key === 'escape') return
    event.preventDefault()
    event.stopPropagation()
    run(current.key({
      key: event.key,
      ...(event.ctrl ? { ctrl: true as const } : {}),
      ...(event.shift ? { shift: true as const } : {}),
      ...(event.meta ? { meta: true as const } : {}),
    }))
  }
  const style = {
    width: props.width,
    height: props.height,
    flexGrow: props.flexGrow,
  } as React.ComponentProps<typeof Box>
  return <Box
    {...style}
    ref={elementRef}
    flexDirection="column"
    overflow="hidden"
    tabIndex={pane.focused ? 0 : -1}
    onFocus={event => {
      if (inputAllowed) reportElementFocus(event, pane, key, onFocus, onError)
    }}
    onKeyDown={keyDown}
  >
    {frame && <RenderElementNode
      node={frame.tree}
      pane={pane}
      focusElements={focusElements}
      keyElements={keyElements}
      onInteract={async () => {}}
      currentPane={() => pane}
      onFocus={async () => onFocus(pane, key)}
      onError={onError}
      hoverBoxes={frame.hoverBoxes}
      clientHandle={handle.current}
    />}
  </Box>
}

function ModCode({ source, language, path, startLine, wrap }: {
  source: string; language?: string; path?: string; startLine?: number; wrap?: 'wrap' | 'truncate-end'
}): React.ReactNode {
  const [highlighter, setHighlighter] = useState<CliHighlight | null>(null)
  React.useEffect(() => {
    let mounted = true
    void getCliHighlightPromise().then(value => { if (mounted) setHighlighter(value) })
    return () => { mounted = false }
  }, [])
  const reportMetrics = React.useContext(PaneLayoutContext)
  React.useEffect(() => { reportMetrics?.() }, [reportMetrics])
  const lines = useMemo(() => {
    const code = convertLeadingTabsToSpaces(source)
    const firstLine = code.split('\n')[0]
    const filenames: Record<string, string> = {
      Dockerfile: 'dockerfile', Makefile: 'makefile', Rakefile: 'ruby', Gemfile: 'ruby', 'CMakeLists.txt': 'cmake',
    }
    let resolved = language ?? filenames[basename(path ?? '')] ?? extname(path ?? '').slice(1)
    if (language === undefined && !highlighter?.supportsLanguage(resolved) && firstLine?.startsWith('#!')) {
      const interpreter = firstLine.match(/\b(bash|sh|python[\d.]*|node|ruby|perl)\b/)?.[1]
      resolved = interpreter?.startsWith('python') ? 'python'
        : interpreter === 'node' ? 'javascript'
        : interpreter === 'sh' ? 'bash' : interpreter ?? ''
    }
    const highlighted = resolved && highlighter?.supportsLanguage(resolved)
      ? highlighter.highlight(code, { language: resolved, ignoreIllegals: true })
      : code
    // Reopen multiline token styles at newlines without adding any soft wraps.
    return wrapAnsi(highlighted, MAX_TOTAL_TEXT, { hard: true, trim: false, wordWrap: false }).split('\n')
  }, [source, language, path, highlighter])
  const digits = String((startLine ?? 1) + lines.length - 1).length
  return <Box flexDirection="column" width="100%">
    {lines.map((line, index) => <Box key={index} minHeight={1}>
      {startLine !== undefined && <Box width={digits} marginRight={1} flexShrink={0} justifyContent="flex-end">
        <Text dimColor>{startLine + index}</Text>
      </Box>}
      <Text wrap={wrap}><Ansi>{line}</Ansi></Text>
    </Box>)}
  </Box>
}

function ModDiff({ source, path, wrap, bodyColumns }: {
  source: string
  path?: string
  wrap?: 'wrap' | 'truncate-end'
  bodyColumns: number
}): React.ReactNode {
  const [theme] = useTheme()
  const settings = useSettings()
  const ref = React.useRef<DOMElement>(null)
  const [columns, setColumns] = useState(bodyColumns)
  const reportMetrics = React.useContext(PaneLayoutContext)
  const patches = useMemo(() => parsePatch(source).flatMap(file => file.hunks), [source])
  const truncated = useMemo(() => {
    if (wrap !== 'truncate-end') return undefined
    const ColorDiff = settings.syntaxHighlightingDisabled ? null : expectColorDiff()
    return patches.flatMap(patch => {
      const digits = String(Math.max(patch.oldStart + patch.oldLines, patch.newStart + patch.newLines)).length
      // Ask the existing highlighter for unwrapped lines; Ink owns truncation.
      const width = Math.max(1, ...patch.lines.map(line => stringWidth(line) + digits + 3))
      const colored = ColorDiff && new ColorDiff(patch, null, path ?? 'change.diff', null).render(theme, width, false)
      if (colored) return colored.map((line, index) => <Text key={`${patch.oldStart}:${patch.newStart}:${index}`} wrap="truncate-end"><Ansi>{line}</Ansi></Text>)
      let oldLine = patch.oldStart
      let newLine = patch.newStart
      return patch.lines.filter(line => /^[ +\-]/.test(line)).map((line, index) => {
        const marker = line[0]!
        const number = marker === '-' ? oldLine : newLine
        if (marker !== '+') oldLine++
        if (marker !== '-') newLine++
        return <Box key={`${patch.oldStart}:${patch.newStart}:${index}`}>
          <Box width={digits + 1} flexShrink={0} justifyContent="flex-end"><Text dimColor>{number}</Text></Box>
          <Text wrap="truncate-end" color={marker === '+' ? 'diffAdded' : marker === '-' ? 'diffRemoved' : undefined}> {marker}{line.slice(1)}</Text>
        </Box>
      })
    })
  }, [wrap, patches, path, theme, settings.syntaxHighlightingDisabled])
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
    {truncated ?? patches.map((patch, index) => <StructuredDiff
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
  const [selectedIndex, setIndex] = useState(initial)
  const [drawing, setDrawing] = useState(pane.drawing)
  const index = drawing !== pane.drawing && props.value !== undefined
    ? initial
    : Math.min(selectedIndex, options.length - 1)
  if (drawing !== pane.drawing) setDrawing(pane.drawing)
  if (index !== selectedIndex) setIndex(index)
  const indexRef = React.useRef(index)
  indexRef.current = index
  const [focused, setFocused] = useState(false)
  const key = props.key as string
  const press = node.press!
  const elementRef = useElementRegistration(keyElements, node.group?.plugin ?? press.plugin, key, focusElements)
  const select = () => {
    if (!inputAllowed || pane.drawing === undefined) return
    const value = options[indexRef.current]!.value
    void onInteract(pane, pane.drawing, press, 'select', key, value).catch(error => onError?.(error))
  }
  const handle = (event: KeyboardEvent) => {
    if (!pane.focused || event.ctrl || event.meta || event.superKey || event.shift) return
    if (event.key === 'up') {
      event.preventDefault()
      event.stopPropagation()
      indexRef.current = (indexRef.current + options.length - 1) % options.length
      setIndex(indexRef.current)
    } else if (event.key === 'down') {
      event.preventDefault()
      event.stopPropagation()
      indexRef.current = (indexRef.current + 1) % options.length
      setIndex(indexRef.current)
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
  node, pane, focusElements, keyElements, onInteract, currentPane, onFocus, onError,
}: {
  node: RenderElement
  pane: ModUiPane
  focusElements: FocusElements
  keyElements: KeyElements
  onInteract: Props['onInteract']
  currentPane: () => ModUiPane
  onFocus: Props['onFocus']
  onError?: Props['onError']
}): React.ReactNode {
  const inputAllowed = React.useContext(PersonInputContext)
  const props = node.props!
  const controlledValue = props.value as string | undefined
  const [value, setValue] = useState(controlledValue ?? '')
  const valueRef = React.useRef(value)
  const cursorRef = React.useRef(value.length)
  const drawnValueRef = React.useRef(controlledValue)
  if (controlledValue !== drawnValueRef.current) {
    drawnValueRef.current = controlledValue
    const next = controlledValue ?? ''
    valueRef.current = next
    cursorRef.current = next.length
    setValue(next)
  }
  const [focused, setFocused] = useState(false)
  const key = props.key as string
  const press = node.press!
  const owner = pane.owner
  const drawing = pane.drawing
  const elementRef = useElementRegistration(keyElements, node.group?.plugin ?? press.plugin, key, focusElements)
  const send = (kind: 'change' | 'submit', next: string) => {
    const current = currentPane()
    if (!inputAllowed || drawing === undefined || current.owner !== owner || current.drawing !== drawing) return
    void onInteract(
      current,
      drawing,
      press,
      kind === 'change' ? 'input.change' : 'input.submit',
      key,
      next,
    ).catch(error => onError?.(error))
  }
  const replace = (next: string, cursor: number) => {
    valueRef.current = next
    cursorRef.current = cursor
    setValue(next)
    send('change', next)
  }
  const boundaries = () => [
    ...getGraphemeSegmenter().segment(valueRef.current),
  ].map(segment => segment.index).concat(valueRef.current.length)
  const previousBoundary = (cursor: number) => {
    const points = boundaries()
    return points.findLast(point => point < cursor) ?? 0
  }
  const nextBoundary = (cursor: number) =>
    boundaries().find(point => point > cursor) ?? valueRef.current.length
  const handle = (event: KeyboardEvent) => {
    if (!pane.focused) return
    if (event.text !== undefined) {
      event.preventDefault()
      event.stopPropagation()
      const cursor = cursorRef.current
      const next = valueRef.current.slice(0, cursor) + event.text + valueRef.current.slice(cursor)
      replace(next, cursor + event.text.length)
      return
    }
    if (event.key === 'return') {
      event.preventDefault()
      event.stopPropagation()
      send('submit', valueRef.current)
      return
    }
    if (!event.ctrl && !event.meta && !event.superKey &&
        ['up', 'down', 'left', 'right', 'home', 'end'].includes(event.key)) {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'left') cursorRef.current = previousBoundary(cursorRef.current)
      else if (event.key === 'right') cursorRef.current = nextBoundary(cursorRef.current)
      else if (event.key === 'home') cursorRef.current = 0
      else if (event.key === 'end') cursorRef.current = valueRef.current.length
      return
    }
    if (event.key !== 'backspace' && event.key !== 'delete') return
    event.preventDefault()
    event.stopPropagation()
    const cursor = cursorRef.current
    if (event.key === 'backspace') {
      if (cursor === 0) return
      const previous = previousBoundary(cursor)
      replace(valueRef.current.slice(0, previous) + valueRef.current.slice(cursor), previous)
    } else {
      if (cursor === valueRef.current.length) return
      replace(valueRef.current.slice(0, cursor) + valueRef.current.slice(nextBoundary(cursor)), cursor)
    }
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
      <Text inverse={focused} dimColor={!value}>{value || String(props.placeholder ?? '')}</Text>
      {focused && <Text dimColor> {String(props.submitLabel ?? 'submit')}</Text>}
    </Box>
  )
}

import {isDeepStrictEqual} from 'node:util'
import {createHash} from 'node:crypto'
import {modClientDataProblem} from './remoteUiClient.js'
import type {ModInput} from './types.js'

function record(value: unknown): value is ModInput {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const inRange = (v:unknown, min:number, max:number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const color = (v:unknown) => typeof v === 'string' && (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(v) || /^(?:surface|fill|text|bg|border|on)-[a-z0-9-]+$/.test(v))

function checkStyle(style:unknown) {
  if (!record(style) || modClientDataProblem(style) || JSON.stringify(style).length > 65536) throw new TypeError('style must be bounded JSON')
  for (const [part,input] of Object.entries(style)) {
    const message = part === 'UserMessage' || part === 'AssistantMessage'
    if (!message && !['Text','Heading','ToolUse'].includes(part)) throw new TypeError(`unsupported style part ${part}`)
    const rules = Array.isArray(input) ? input : [input]
    if (Array.isArray(input) && (!message || !rules.length || rules.length > 4)) throw new TypeError(`invalid style.${part} rules`)
    for (const rule of rules) {
      if (!record(rule)) throw new TypeError(`style.${part} must be a rule`)
      for (const [k,v] of Object.entries(rule)) {
        const box = message || part === 'ToolUse'
        if (k === 'color' && color(v) || box && ['backgroundColor','borderColor'].includes(k) && color(v) ||
          box && k === 'borderWidth' && inRange(v,0,8) || message && k === 'rotate' && inRange(v,-3,3) ||
          k === 'fontFamily' && Array.isArray(v) && v.length === 1 && ['sans','serif','mono','code','cursive'].includes(v[0]) ||
          part !== 'ToolUse' && (k === 'fontSize' && inRange(v,11,28) || k === 'letterSpacing' && inRange(v,-1,4) ||
          k === 'lineHeight' && inRange(v,Math.max(12,Number(rule.fontSize ?? 0)),48) || k === 'italic' && typeof v === 'boolean' ||
          k === 'fontWeight' && ['regular','medium','semibold','bold'].includes(String(v)))) continue
        throw new TypeError(`invalid or unsupported style.${part}.${k}`)
      }
    }
  }
}

function checkSound(sound:unknown) {
  // This host currently serves short pitched cues; it does not synthesize audio.
  if (!record(sound) || modClientDataProblem(sound) || Object.keys(sound).some(k => k !== 'cues') || !record(sound.cues))
    throw new TypeError('sound supports cues only in this build')
  for (const [name,cue] of Object.entries(sound.cues)) {
    if (!['send','tool','compact','done','ask','error','click'].includes(name) || !record(cue) || Object.keys(cue).some(k => k !== 'layers') ||
      !Array.isArray(cue.layers) || cue.layers.length !== 1) throw new TypeError('sound supports one pitched layer per cue in this build')
    const l = cue.layers[0]
    if (!record(l) || Object.keys(l).some(k => !['wave','notes','gain','step'].includes(k)) ||
      !['sine','triangle','square','saw','bell'].includes(String(l.wave)) || !Array.isArray(l.notes) || !l.notes.length || l.notes.length > 8 ||
      l.notes.some(note => !inRange(note,20,10000) && !(typeof note === 'string' && /^[A-G]#?[2-7]$/.test(note))) ||
      l.gain !== undefined && !inRange(l.gain,0,1) || l.step !== undefined && (name === 'click' || !inRange(l.step,0,0.5))) throw new TypeError(`invalid or unsupported sound.cues.${name} layer`)
  }
}

export function validateTheme(input: unknown): asserts input is ModInput {
  if (!record(input) || !Object.keys(input).length) throw new TypeError('theme.set needs a theme attribute; $.theme.clear() clears the theme')
  // Decline unsupported attributes rather than reporting that a partial theme landed.
  for (const key of Object.keys(input)) if (!['backdrop','colors','overrideColorScheme','style','sound'].includes(key))
    throw new TypeError(`theme.set does not support the attribute "${key}" in this build`)
  if (input.overrideColorScheme !== undefined && !['light','dark'].includes(String(input.overrideColorScheme)))
    throw new TypeError('overrideColorScheme is light or dark')
  if ('backdrop' in input) {
    const b = input.backdrop
    if (!record(b)) throw new TypeError('backdrop must be an object')
    if ('color' in b) {
      if (Object.keys(b).length !== 1 || !color(b.color)) throw new TypeError('invalid solid backdrop color')
    } else if ('gradient' in b) {
      const g = b.gradient
      if (Object.keys(b).length !== 1 || !record(g) || Object.keys(g).some(k => !['stops','angle','shape'].includes(k)) ||
          !Array.isArray(g.stops) || g.stops.length < 2 || g.stops.length > 16 || !g.stops.every(color) ||
          g.angle !== undefined && !inRange(g.angle,-360,360) || g.shape !== undefined && !['linear','radial'].includes(String(g.shape))) throw new TypeError('invalid or unsupported backdrop gradient')
    } else if (typeof b.scene !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(b.scene) || Object.keys(b).some(key => key !== 'scene' && key !== 'glass')) throw new TypeError('unsupported backdrop in this build')
    if (b.glass !== undefined && b.glass !== false && (!record(b.glass) ||
        Object.keys(b.glass).some(key => !['blur','opacity'].includes(key)) ||
        Object.entries(b.glass).some(([key,v]) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > (key === 'blur' ? 64 : 1))))
      throw new TypeError('theme.set glass supports blur: 0..64 and opacity: 0..1 in this build')
  }
  if ('colors' in input) {
    const c = input.colors
    const problem = modClientDataProblem(c)
    if (problem) throw new TypeError(`theme.set colors must be bounded JSON: ${problem}`)
    if (!record(c) || JSON.stringify(c).match(/"(?:__proto__|constructor|prototype)":/)) throw new TypeError('theme.set colors must be a palette object without reserved keys')
  }
  if ('style' in input) checkStyle(input.style)
  if ('sound' in input) checkSound(input.sound)
  if (Object.values(input).every(v => v === undefined))
    throw new TypeError('theme.set needs a theme attribute')
}

export function createModTheme<Owner>() {
  const listeners = new Set<() => void>()
  const changed = () => {for (const listener of listeners) listener()}
  let state: {owner:Owner; plugin:string; args:ModInput} | undefined
  const blobs = new Map<string,unknown>()
  const clear = () => {
    blobs.clear()
    if (state) { state = undefined; changed() }
    return {isDrawn:false,reason:'the theme is cleared'}
  }
  return {
    subscribe(listener:() => void) { listeners.add(listener); return () => {listeners.delete(listener)} },
    set(owner:Owner, plugin:string, args:ModInput, drawn:boolean) {
      validateTheme(args)
      if (state?.owner !== owner || !isDeepStrictEqual(state.args,args)) {
        state = {owner,plugin,args:structuredClone(args)}; changed()
      }
      const requestId = record(args.backdrop) && typeof args.backdrop.scene === 'string' ? 'backdrop' : 'theme'
      return drawn ? {isDrawn:true,requestId} : {isDrawn:false,requestId,reason:'no attached desktop or mobile client draws themes yet; the theme stands and draws when one attaches'}
    }, clear,
    release(owner:Owner) { if (state?.owner === owner) clear() },
    props(id:string, surface?:string): ModInput {
      if (surface === 'desktop' && blobs.has(id)) return {[id.split(':')[0]!]:structuredClone(blobs.get(id))}
      if (!state) return {}
      const {plugin,args:{backdrop,colors,overrideColorScheme,sound,style}} = state
      const scene = record(backdrop) && typeof backdrop.scene === 'string'
      if (id === 'backdrop' && scene) return {plugin,scene:backdrop.scene,
        glass:backdrop.glass === false ? false : {blur:16,opacity:0.6,...(record(backdrop.glass) ? backdrop.glass : {})},
        ...(overrideColorScheme === undefined ? {} : {overrideColorScheme})}
      if (id !== 'theme') return {}
      const props:ModInput = scene && colors === undefined ? {} : {plugin,...(!scene && backdrop !== undefined && {backdrop:structuredClone(backdrop)}),
        ...(colors === undefined ? {} : {colors:structuredClone(colors)}), ...(overrideColorScheme === undefined ? {} : {overrideColorScheme})}
      if (surface === 'desktop') for (const [name,data] of Object.entries({sound,style})) {
        if (data === undefined) continue
        const hash = createHash('sha256').update(JSON.stringify(name === 'style' ? [data,[]] : data)).digest('hex')
        const key = `${name}:${hash}`
        blobs.delete(key); blobs.set(key,data)
        if (blobs.size > 16) blobs.delete(blobs.keys().next().value!)
        Object.assign(props,{plugin,[`${name}Hash`]:hash})
      }
      return props
    },
  }
}

/** Until full shader/vector validation is available, backdrop nodes may only paint passive primitives. */
export function validateBackdropTree(value: unknown): void {
  if (typeof value === 'string') return
  if (!record(value) || !['Box','Text','engine'].includes(String(value.type)) || value.press !== undefined || value.hover !== undefined)
    throw new TypeError('Backdrop supports passive Box and Text in this build')
  if (Array.isArray(value.children)) for (const child of value.children) validateBackdropTree(child)
}

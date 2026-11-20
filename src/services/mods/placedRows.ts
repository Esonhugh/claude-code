import {randomUUID} from 'node:crypto'
import type {UUID} from 'node:crypto'
import type {Message} from '../../types/message.js'

export type ModPlacedRow = {plugin:string;id:string;request_id:UUID;after_uuid?:UUID}
export function createModPlacedRows() {
  let rows: readonly ModPlacedRow[] = []
  const listeners = new Set<() => void>()
  const publish = (next:readonly ModPlacedRow[]) => {rows = next; for (const listen of listeners) listen()}
  return {
    rows:() => rows,
    subscribe(listener:() => void) { listeners.add(listener); return () => {listeners.delete(listener)} },
    reset() { if (rows.length) publish([]) },
    place(plugin:string,id:unknown,conversation:readonly Message[] | undefined,undrawn?:string) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new TypeError('ui.place needs an id of 1-64 letters, digits, _ or -')
      if (!conversation) return {isPlaced:false,reason:'no conversation to place a row in'}
      const own = rows.filter(row => row.plugin === plugin)
      let row = own.find(row => row.id === id)
      if (!row) {
        if (own.length >= 500) return {isPlaced:false,reason:'a plugin holds at most 500 placed rows'}
        const anchor = conversation.findLast(m => (m.type === 'user' || m.type === 'assistant') && !('isMeta' in m && m.isMeta))
        row = {plugin,id,request_id:randomUUID(),...(anchor && {after_uuid:anchor.uuid})}
        publish([...rows,row])
      }
      return undrawn === undefined ? {isPlaced:true,requestId:row.request_id} : {isPlaced:false,requestId:row.request_id,reason:undrawn}
    },
  }
}

/** Presentation-only projection. The conversation, transcript and model inputs never own these rows. */
export function withModPlacedRows(messages:Message[], rows:readonly ModPlacedRow[] | undefined): Message[] {
  if (!rows?.length) return messages
  const anchors = new Map<string | undefined,Message[]>()
  for (const row of rows) {
    const display:Message = {type:'system',subtype:'placed',uuid:row.request_id,timestamp:'',plugin:row.plugin,id:row.id}
    const group = anchors.get(row.after_uuid)
    if (group) group.push(display); else anchors.set(row.after_uuid,[display])
  }
  const result = [...(anchors.get(undefined) ?? [])]
  for (const message of messages) {result.push(message); const group = anchors.get(message.uuid); if (group) result.push(...group)}
  return result
}

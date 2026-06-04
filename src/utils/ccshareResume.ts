import type { LogOption } from '../types/logs.js'

export function parseCcshareId(value: string): string {
  return value
}

export async function loadCcshare(_id: string): Promise<string | LogOption> {
  return _id
}

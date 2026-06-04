export type ServerLock = {
  pid: number
  port?: number
  host?: string
  httpUrl: string
  startedAt?: number
}

export async function writeServerLock(_lock: ServerLock): Promise<void> {}
export async function removeServerLock(): Promise<void> {}
export async function probeRunningServer(): Promise<ServerLock | undefined> {
  return undefined
}

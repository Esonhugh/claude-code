export type SSHSession = any

export class SSHSessionError extends Error {}

export async function createSSHSession(..._args: unknown[]): Promise<SSHSession> {
  return undefined
}

export async function createLocalSSHSession(..._args: unknown[]): Promise<SSHSession> {
  return undefined
}

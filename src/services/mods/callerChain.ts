/** Internal dispatch history. This is never part of author arguments or receipts. */
export type ModCallerChain = readonly (string | Readonly<{ plugin: string; registration: number }>)[]

export function copyModCallerChain(chain: ModCallerChain | undefined): ModCallerChain {
  return Object.freeze((chain ?? []).map(member => typeof member === 'string'
    ? member
    : Object.freeze({ plugin: member.plugin, registration: member.registration })))
}

export function appendModCallerChain(
  chain: ModCallerChain | undefined,
  member: ModCallerChain[number],
): ModCallerChain {
  const prior = chain ?? []
  const plugin = typeof member === 'string' ? member : member.plugin
  const registration = typeof member === 'string' ? undefined : member.registration
  const present = prior.some(existing => typeof existing === 'string'
    ? existing === plugin
    : existing.plugin === plugin && existing.registration === registration)
  return copyModCallerChain(present ? prior : [...prior, member])
}

export function excludesModCaller(chain: ModCallerChain, plugin: string, registration: number): boolean {
  return chain.some(member => typeof member === 'string'
    ? member === plugin
    : member.plugin === plugin && member.registration === registration)
}

// Native model expectations should not inherit the provider of the CLI running bun test.
export async function withFirstPartyModel(check: () => Promise<void>): Promise<void> {
  const keys = ['CLAUDE_CODE_USE_OPENAI','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY']
  const previous = keys.map(key => process.env[key])
  for (const key of keys) delete process.env[key]
  try { await check() } finally {
    keys.forEach((key,i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i] })
  }
}

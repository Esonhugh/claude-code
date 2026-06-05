export default workflow({
  name: 'official-compatible-convergence',
  description: 'Fixture covering retry and convergence-style repair loops.',
  defaults: {
    maxConcurrency: 2,
    maxAgents: 10,
    maxRetries: 2,
    permissionMode: 'acceptEdits',
  },
  phases: [
    agent({
      id: 'attempt',
      description: 'Attempt implementation',
      prompt: ({ args }) => `Attempt the requested change: ${JSON.stringify(args)}`,
    }),
    agent({
      id: 'verify',
      description: 'Verify attempt',
      dependsOn: ['attempt'],
      prompt: 'Run the requested verification mentally from the provided output and identify failures.',
      review: 'adversarial',
    }),
    agent({
      id: 'repair',
      description: 'Repair verified failure',
      dependsOn: ['verify'],
      prompt: 'Repair only the verified failure and explain the next verification step.',
    }),
  ],
})

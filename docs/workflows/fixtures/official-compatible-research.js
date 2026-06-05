export default async function main() {
  const findings = await parallel([
    agent({
      label: 'research-a',
      prompt: 'Research primary evidence for ' + JSON.stringify(args),
    }),
    agent({
      label: 'research-b',
      prompt: 'Research counter-evidence for ' + JSON.stringify(args),
    }),
  ])
  await review({
    label: 'review',
    prompt: 'Cross-check findings: ' + findings.map(item => item.output).join('\n'),
    dependsOn: findings.map(item => item.label),
  })
  await refute({
    label: 'refute',
    prompt: 'Try to falsify verified claims from review.',
    dependsOn: ['review'],
  })
  await vote({
    label: 'synthesis',
    prompt: 'Synthesize only claims that survived review and refutation.',
    dependsOn: ['review', 'refute'],
  })
}

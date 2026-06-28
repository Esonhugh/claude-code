const defaultRecoverFeatures = ['AGENT_TRIGGERS'];

const enabled = new Set([
  ...defaultRecoverFeatures,
  ...(process.env.CLAUDE_CODE_RECOVER_FEATURES ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
]);

export function feature(name) {
  return enabled.has(name);
}

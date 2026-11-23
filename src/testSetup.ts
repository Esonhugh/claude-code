// Preloaded by bunfig.toml into every `bun test` process. bun test sets
// NODE_ENV=test, where a missing Claude credential is an error
// (getAnthropicApiKeyWithSource); tests that need no credential or OAuth
// set up their own.
process.env.ANTHROPIC_API_KEY ||= 'sk-ant-test-placeholder'

import type { ModelName } from './model.js'
import type { APIProvider } from './providers.js'

export type ModelConfigProvider = Exclude<APIProvider, 'openai'>
export type ModelConfig = Record<ModelConfigProvider, ModelName>

// @[MODEL LAUNCH]: Add a new CLAUDE_*_CONFIG constant here. Double check the correct model strings
// here since the pattern may change.

export const CLAUDE_3_7_SONNET_CONFIG = {
  firstParty: 'claude-3-7-sonnet-20250219',
  bedrock: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
  vertex: 'claude-3-7-sonnet@20250219',
  foundry: 'claude-3-7-sonnet',
} as const satisfies ModelConfig

export const CLAUDE_3_5_V2_SONNET_CONFIG = {
  firstParty: 'claude-3-5-sonnet-20241022',
  bedrock: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  vertex: 'claude-3-5-sonnet-v2@20241022',
  foundry: 'claude-3-5-sonnet',
} as const satisfies ModelConfig

export const CLAUDE_3_5_HAIKU_CONFIG = {
  firstParty: 'claude-3-5-haiku-20241022',
  bedrock: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
  vertex: 'claude-3-5-haiku@20241022',
  foundry: 'claude-3-5-haiku',
} as const satisfies ModelConfig

export const CLAUDE_HAIKU_4_5_CONFIG = {
  firstParty: 'claude-haiku-4-5-20251001',
  bedrock: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  vertex: 'claude-haiku-4-5@20251001',
  foundry: 'claude-haiku-4-5',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_CONFIG = {
  firstParty: 'claude-sonnet-4-20250514',
  bedrock: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  vertex: 'claude-sonnet-4@20250514',
  foundry: 'claude-sonnet-4',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_5_CONFIG = {
  firstParty: 'claude-sonnet-4-5-20250929',
  bedrock: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  vertex: 'claude-sonnet-4-5@20250929',
  foundry: 'claude-sonnet-4-5',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_CONFIG = {
  firstParty: 'claude-opus-4-20250514',
  bedrock: 'us.anthropic.claude-opus-4-20250514-v1:0',
  vertex: 'claude-opus-4@20250514',
  foundry: 'claude-opus-4',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_1_CONFIG = {
  firstParty: 'claude-opus-4-1-20250805',
  bedrock: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
  vertex: 'claude-opus-4-1@20250805',
  foundry: 'claude-opus-4-1',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_5_CONFIG = {
  firstParty: 'claude-opus-4-5-20251101',
  bedrock: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
  vertex: 'claude-opus-4-5@20251101',
  foundry: 'claude-opus-4-5',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_6_CONFIG = {
  firstParty: 'claude-opus-4-6',
  bedrock: 'us.anthropic.claude-opus-4-6-v1',
  vertex: 'claude-opus-4-6',
  foundry: 'claude-opus-4-6',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_6_CONFIG = {
  firstParty: 'claude-sonnet-4-6',
  bedrock: 'us.anthropic.claude-sonnet-4-6',
  vertex: 'claude-sonnet-4-6',
  foundry: 'claude-sonnet-4-6',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_7_CONFIG = {
  firstParty: 'claude-opus-4-7',
  bedrock: 'anthropic.claude-opus-4-7',
  vertex: 'claude-opus-4-7',
  foundry: 'claude-opus-4-7',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_8_CONFIG = {
  firstParty: 'claude-opus-4-8',
  bedrock: 'anthropic.claude-opus-4-8',
  vertex: 'claude-opus-4-8',
  foundry: 'claude-opus-4-8',
} as const satisfies ModelConfig

export const CLAUDE_FABLE_5_CONFIG = {
  firstParty: 'claude-fable-5',
  bedrock: 'anthropic.claude-fable-5',
  vertex: 'claude-fable-5',
  foundry: 'claude-fable-5',
} as const satisfies ModelConfig

export const CLAUDE_FABLE_5_1_CONFIG = {
  firstParty: 'claude-fable-5-1',
  bedrock: 'anthropic.claude-fable-5-1',
  vertex: 'claude-fable-5-1',
  foundry: 'claude-fable-5-1',
} as const satisfies ModelConfig

export const CLAUDE_MYTHOS_5_CONFIG = {
  firstParty: 'claude-mythos-5',
  bedrock: 'anthropic.claude-mythos-5',
  vertex: 'claude-mythos-5',
  foundry: 'claude-mythos-5',
} as const satisfies ModelConfig

export const CLAUDE_MYTHOS_5_1_CONFIG = {
  firstParty: 'claude-mythos-5-1',
  bedrock: 'anthropic.claude-mythos-5-1',
  vertex: 'claude-mythos-5-1',
  foundry: 'claude-mythos-5-1',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_5_CONFIG = {
  firstParty: 'claude-opus-5',
  bedrock: 'anthropic.claude-opus-5',
  vertex: 'claude-opus-5',
  foundry: 'claude-opus-5',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_5_5_CONFIG = {
  firstParty: 'claude-opus-5-5',
  bedrock: 'anthropic.claude-opus-5-5',
  vertex: 'claude-opus-5-5',
  foundry: 'claude-opus-5-5',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_5_CONFIG = {
  firstParty: 'claude-sonnet-5',
  bedrock: 'anthropic.claude-sonnet-5',
  vertex: 'claude-sonnet-5',
  foundry: 'claude-sonnet-5',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_5_5_CONFIG = {
  firstParty: 'claude-sonnet-5-5',
  bedrock: 'anthropic.claude-sonnet-5-5',
  vertex: 'claude-sonnet-5-5',
  foundry: 'claude-sonnet-5-5',
} as const satisfies ModelConfig

export const OPENAI_MODEL_CONFIG = {
  default: 'gpt-5.6-sol',
  opus: 'gpt-5.6-sol',
  sonnet: 'gpt-5.6-terra',
  haiku: 'gpt-5.6-luna',
} as const

// @[MODEL LAUNCH]: Register the new config here.
export const ALL_MODEL_CONFIGS = {
  haiku35: CLAUDE_3_5_HAIKU_CONFIG,
  haiku45: CLAUDE_HAIKU_4_5_CONFIG,
  sonnet35: CLAUDE_3_5_V2_SONNET_CONFIG,
  sonnet37: CLAUDE_3_7_SONNET_CONFIG,
  sonnet40: CLAUDE_SONNET_4_CONFIG,
  sonnet45: CLAUDE_SONNET_4_5_CONFIG,
  sonnet46: CLAUDE_SONNET_4_6_CONFIG,
  sonnet50: CLAUDE_SONNET_5_CONFIG,
  sonnet55: CLAUDE_SONNET_5_5_CONFIG,
  opus40: CLAUDE_OPUS_4_CONFIG,
  opus41: CLAUDE_OPUS_4_1_CONFIG,
  opus45: CLAUDE_OPUS_4_5_CONFIG,
  opus46: CLAUDE_OPUS_4_6_CONFIG,
  opus47: CLAUDE_OPUS_4_7_CONFIG,
  opus48: CLAUDE_OPUS_4_8_CONFIG,
  opus50: CLAUDE_OPUS_5_CONFIG,
  opus55: CLAUDE_OPUS_5_5_CONFIG,
  fable50: CLAUDE_FABLE_5_CONFIG,
  fable51: CLAUDE_FABLE_5_1_CONFIG,
  mythos50: CLAUDE_MYTHOS_5_CONFIG,
  mythos51: CLAUDE_MYTHOS_5_1_CONFIG,
} as const satisfies Record<string, ModelConfig>

export type ModelKey = keyof typeof ALL_MODEL_CONFIGS

/** Union of all canonical first-party model IDs, e.g. 'claude-opus-4-6' | 'claude-sonnet-4-5-20250929' | … */
export type CanonicalModelId =
  (typeof ALL_MODEL_CONFIGS)[ModelKey]['firstParty']

/** Runtime list of canonical model IDs — used by comprehensiveness tests. */
export const CANONICAL_MODEL_IDS = Object.values(ALL_MODEL_CONFIGS).map(
  c => c.firstParty,
) as [CanonicalModelId, ...CanonicalModelId[]]

/** Map canonical ID → internal short key. Used to apply settings-based modelOverrides. */
export const CANONICAL_ID_TO_KEY: Record<CanonicalModelId, ModelKey> =
  Object.fromEntries(
    (Object.entries(ALL_MODEL_CONFIGS) as [ModelKey, ModelConfig][]).map(
      ([key, cfg]) => [cfg.firstParty, key],
    ),
  ) as Record<CanonicalModelId, ModelKey>

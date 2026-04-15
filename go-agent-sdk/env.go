package claudesdk

// Environment variable constants used by the Claude Code Agent SDK.
// These can be set in the environment or via ClaudeAgentOptions.Env.

const (
	// CLAUDE_CODE_CONFIG_DIR overrides the default Claude config directory (~/.claude).
	CLAUDE_CODE_CONFIG_DIR = "CLAUDE_CONFIG_DIR"

	// CLAUDE_CODE_STREAM_CLOSE_TIMEOUT sets the initialize handshake timeout in milliseconds.
	// Default: "60000" (60 seconds).
	CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = "CLAUDE_CODE_STREAM_CLOSE_TIMEOUT"

	// CLAUDE_CODE_SKIP_VERSION_CHECK skips the CLI version validation when set.
	CLAUDE_CODE_SKIP_VERSION_CHECK = "CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK"

	// CLAUDE_CODE_ENABLE_FILE_CHECKPOINTING enables file state checkpointing when set to "true".
	CLAUDE_CODE_ENABLE_FILE_CHECKPOINTING = "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING"

	// CLAUDE_CODE_ENTRYPOINT identifies the SDK entry point. The Go SDK sets this to "sdk-go".
	CLAUDE_CODE_ENTRYPOINT = "CLAUDE_CODE_ENTRYPOINT"

	// CLAUDE_CODE_SDK_VERSION is set by the SDK to its version string.
	CLAUDE_CODE_SDK_VERSION = "CLAUDE_AGENT_SDK_VERSION"

	// CLAUDE_CODE_NESTING_FILTER is filtered out to prevent recursive CLI nesting.
	CLAUDE_CODE_NESTING_FILTER = "CLAUDECODE"

	// --- CLI Environment Variables (from Claude Code source) ---

	// CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS enables the agent teams/swarm feature.
	// Set to "1" or "true" to enable.
	CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"

	// CLAUDE_CODE_IS_SANDBOX indicates the process is running inside a sandbox container.
	// Set to "1" when running in Docker/sandbox with no internet access.
	CLAUDE_CODE_IS_SANDBOX = "IS_SANDBOX"

	// CLAUDE_CODE_USE_BEDROCK enables Amazon Bedrock as the API provider.
	CLAUDE_CODE_USE_BEDROCK = "CLAUDE_CODE_USE_BEDROCK"

	// CLAUDE_CODE_USE_VERTEX enables Google Vertex AI as the API provider.
	CLAUDE_CODE_USE_VERTEX = "CLAUDE_CODE_USE_VERTEX"

	// CLAUDE_CODE_USE_FOUNDRY enables Foundry as the API provider.
	CLAUDE_CODE_USE_FOUNDRY = "CLAUDE_CODE_USE_FOUNDRY"

	// CLAUDE_CODE_SUBAGENT_MODEL overrides the model used for sub-agents.
	CLAUDE_CODE_SUBAGENT_MODEL = "CLAUDE_CODE_SUBAGENT_MODEL"

	// CLAUDE_CODE_MAX_OUTPUT_TOKENS overrides the max output tokens for model responses.
	CLAUDE_CODE_MAX_OUTPUT_TOKENS = "CLAUDE_CODE_MAX_OUTPUT_TOKENS"

	// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC disables non-essential network traffic
	// (telemetry, update checks, etc.) when set.
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"

	// CLAUDE_CODE_API_KEY_HELPER_TTL_MS sets the TTL for cached API key helper results.
	CLAUDE_CODE_API_KEY_HELPER_TTL_MS = "CLAUDE_CODE_API_KEY_HELPER_TTL_MS"

	// CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS disables experimental beta features.
	CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"

	// CLAUDE_CODE_ENABLE_TELEMETRY enables telemetry data collection.
	CLAUDE_CODE_ENABLE_TELEMETRY = "CLAUDE_CODE_ENABLE_TELEMETRY"

	// CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST indicates that the API provider
	// configuration is managed by the host environment.
	CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"

	// CLAUDE_CODE_OAUTH_TOKEN provides an OAuth token for authentication.
	CLAUDE_CODE_OAUTH_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN"

	// CLAUDE_CODE_SKIP_BEDROCK_AUTH skips Bedrock authentication.
	CLAUDE_CODE_SKIP_BEDROCK_AUTH = "CLAUDE_CODE_SKIP_BEDROCK_AUTH"

	// CLAUDE_CODE_SKIP_VERTEX_AUTH skips Vertex AI authentication.
	CLAUDE_CODE_SKIP_VERTEX_AUTH = "CLAUDE_CODE_SKIP_VERTEX_AUTH"

	// CLAUDE_CODE_SKIP_FOUNDRY_AUTH skips Foundry authentication.
	CLAUDE_CODE_SKIP_FOUNDRY_AUTH = "CLAUDE_CODE_SKIP_FOUNDRY_AUTH"
)

// SDKVersion is the current version of the Go Agent SDK.
const SDKVersion = "0.1.0"

// MinimumClaudeCodeVersion is the minimum required Claude Code CLI version.
const MinimumClaudeCodeVersion = "2.0.0"

// SDKEntrypoint identifies this SDK in the CLAUDE_CODE_ENTRYPOINT variable.
const SDKEntrypoint = "sdk-go"

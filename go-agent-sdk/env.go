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
)

// SDKVersion is the current version of the Go Agent SDK.
const SDKVersion = "0.1.0"

// MinimumClaudeCodeVersion is the minimum required Claude Code CLI version.
const MinimumClaudeCodeVersion = "2.0.0"

// SDKEntrypoint identifies this SDK in the CLAUDE_CODE_ENTRYPOINT variable.
const SDKEntrypoint = "sdk-go"

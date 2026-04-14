package claudesdk

import "encoding/json"

// PermissionMode controls how tool executions are handled.
type PermissionMode string

const (
	PermissionModeDefault           PermissionMode = "default"
	PermissionModeAcceptEdits       PermissionMode = "acceptEdits"
	PermissionModeBypassPermissions PermissionMode = "bypassPermissions"
	PermissionModePlan              PermissionMode = "plan"
	PermissionModeDontAsk           PermissionMode = "dontAsk"
	PermissionModeAuto              PermissionMode = "auto"
)

// PermissionBehavior is the behavior for a permission result.
type PermissionBehavior string

const (
	PermissionBehaviorAllow PermissionBehavior = "allow"
	PermissionBehaviorDeny  PermissionBehavior = "deny"
	PermissionBehaviorAsk   PermissionBehavior = "ask"
)

// HookPermissionDecision is the decision from a hook.
type HookPermissionDecision string

const (
	HookPermissionAllow HookPermissionDecision = "allow"
	HookPermissionDeny  HookPermissionDecision = "deny"
	HookPermissionAsk   HookPermissionDecision = "ask"
	HookPermissionDefer HookPermissionDecision = "defer"
)

// EffortLevel controls how much effort Claude puts into its response.
type EffortLevel string

const (
	EffortLow    EffortLevel = "low"
	EffortMedium EffortLevel = "medium"
	EffortHigh   EffortLevel = "high"
	EffortMax    EffortLevel = "max"
)

// OutputFormatType specifies the output format type.
type OutputFormatType string

const (
	OutputFormatJSONSchema OutputFormatType = "json_schema"
)

// SettingSource specifies a config scope.
type SettingSource string

const (
	SettingSourceLocal   SettingSource = "local"
	SettingSourceUser    SettingSource = "user"
	SettingSourceProject SettingSource = "project"
)

// FastModeState represents fast mode state.
type FastModeState string

const (
	FastModeOff      FastModeState = "off"
	FastModeCooldown FastModeState = "cooldown"
	FastModeOn       FastModeState = "on"
)

// ExitReason represents the reason for exiting.
type ExitReason string

const (
	ExitReasonClear                    ExitReason = "clear"
	ExitReasonResume                   ExitReason = "resume"
	ExitReasonLogout                   ExitReason = "logout"
	ExitReasonPromptInputExit          ExitReason = "prompt_input_exit"
	ExitReasonOther                    ExitReason = "other"
	ExitReasonBypassPermissionsDisabled ExitReason = "bypass_permissions_disabled"
)

// SDKAssistantMessageError represents error types from the API.
type SDKAssistantMessageError string

const (
	AssistantErrorAuthFailed      SDKAssistantMessageError = "authentication_failed"
	AssistantErrorBilling         SDKAssistantMessageError = "billing_error"
	AssistantErrorRateLimit       SDKAssistantMessageError = "rate_limit"
	AssistantErrorInvalidRequest  SDKAssistantMessageError = "invalid_request"
	AssistantErrorServer          SDKAssistantMessageError = "server_error"
	AssistantErrorUnknown         SDKAssistantMessageError = "unknown"
	AssistantErrorMaxOutputTokens SDKAssistantMessageError = "max_output_tokens"
)

// TerminalReason is the reason a session ended.
type TerminalReason string

const (
	TerminalReasonEndTurn       TerminalReason = "end_turn"
	TerminalReasonMaxTurns      TerminalReason = "max_turns"
	TerminalReasonInterrupt     TerminalReason = "interrupt"
	TerminalReasonMaxBudget     TerminalReason = "error_max_budget_usd"
	TerminalReasonAPIError      TerminalReason = "error_api"
	TerminalReasonToolError     TerminalReason = "error_tool"
)

// HookEvent represents hook event types.
type HookEvent string

const (
	HookEventPreToolUse          HookEvent = "PreToolUse"
	HookEventPostToolUse         HookEvent = "PostToolUse"
	HookEventPostToolUseFailure  HookEvent = "PostToolUseFailure"
	HookEventNotification        HookEvent = "Notification"
	HookEventUserPromptSubmit    HookEvent = "UserPromptSubmit"
	HookEventSessionStart        HookEvent = "SessionStart"
	HookEventSessionEnd          HookEvent = "SessionEnd"
	HookEventStop                HookEvent = "Stop"
	HookEventStopFailure         HookEvent = "StopFailure"
	HookEventSubagentStart       HookEvent = "SubagentStart"
	HookEventSubagentStop        HookEvent = "SubagentStop"
	HookEventPreCompact          HookEvent = "PreCompact"
	HookEventPostCompact         HookEvent = "PostCompact"
	HookEventPermissionRequest   HookEvent = "PermissionRequest"
	HookEventPermissionDenied    HookEvent = "PermissionDenied"
	HookEventSetup               HookEvent = "Setup"
	HookEventElicitation         HookEvent = "Elicitation"
	HookEventElicitationResult   HookEvent = "ElicitationResult"
	HookEventConfigChange        HookEvent = "ConfigChange"
	HookEventInstructionsLoaded  HookEvent = "InstructionsLoaded"
	HookEventCwdChanged          HookEvent = "CwdChanged"
	HookEventFileChanged         HookEvent = "FileChanged"
)

// --- MCP Server Configs ---

// McpStdioServerConfig is a stdio-based MCP server.
type McpStdioServerConfig struct {
	Type    string            `json:"type,omitempty"` // "stdio" or empty
	Command string            `json:"command"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

// McpSSEServerConfig is an SSE-based MCP server.
type McpSSEServerConfig struct {
	Type    string            `json:"type"` // "sse"
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
}

// McpHttpServerConfig is an HTTP-based MCP server.
type McpHttpServerConfig struct {
	Type    string            `json:"type"` // "http"
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
}

// McpServerConfig represents any MCP server configuration.
// Use json.RawMessage for flexible deserialization.
type McpServerConfig = json.RawMessage

// --- Agent Definition ---

// AgentDefinition defines a custom subagent.
type AgentDefinition struct {
	Description                       string              `json:"description"`
	Tools                             []string            `json:"tools,omitempty"`
	DisallowedTools                   []string            `json:"disallowedTools,omitempty"`
	Prompt                            string              `json:"prompt"`
	Model                             string              `json:"model,omitempty"`
	McpServers                        []json.RawMessage   `json:"mcpServers,omitempty"`
	CriticalSystemReminder            string              `json:"criticalSystemReminder_EXPERIMENTAL,omitempty"`
	Skills                            []string            `json:"skills,omitempty"`
	InitialPrompt                     string              `json:"initialPrompt,omitempty"`
	MaxTurns                          *int                `json:"maxTurns,omitempty"`
	Background                        *bool               `json:"background,omitempty"`
	Memory                            string              `json:"memory,omitempty"` // "user", "project", "local"
	Effort                            *EffortLevel        `json:"effort,omitempty"`
	PermissionMode                    *PermissionMode     `json:"permissionMode,omitempty"`
}

// AgentInfo describes an available subagent.
type AgentInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Model       string `json:"model,omitempty"`
}

// --- Model Info ---

// ModelInfo describes an available model.
type ModelInfo struct {
	Value                    string        `json:"value"`
	DisplayName              string        `json:"displayName"`
	Description              string        `json:"description"`
	SupportsEffort           *bool         `json:"supportsEffort,omitempty"`
	SupportedEffortLevels    []EffortLevel `json:"supportedEffortLevels,omitempty"`
	SupportsAdaptiveThinking *bool         `json:"supportsAdaptiveThinking,omitempty"`
	SupportsFastMode         *bool         `json:"supportsFastMode,omitempty"`
	SupportsAutoMode         *bool         `json:"supportsAutoMode,omitempty"`
}

// ModelUsage tracks token usage and cost.
type ModelUsage struct {
	InputTokens              int     `json:"inputTokens"`
	OutputTokens             int     `json:"outputTokens"`
	CacheReadInputTokens     int     `json:"cacheReadInputTokens"`
	CacheCreationInputTokens int     `json:"cacheCreationInputTokens"`
	WebSearchRequests        int     `json:"webSearchRequests"`
	CostUSD                  float64 `json:"costUSD"`
	ContextWindow            int     `json:"contextWindow"`
	MaxOutputTokens          int     `json:"maxOutputTokens"`
}

// --- Account Info ---

// AccountInfo holds authenticated user account information.
type AccountInfo struct {
	Email            string `json:"email,omitempty"`
	Organization     string `json:"organization,omitempty"`
	SubscriptionType string `json:"subscriptionType,omitempty"`
	TokenSource      string `json:"tokenSource,omitempty"`
	APIKeySource     string `json:"apiKeySource,omitempty"`
	APIProvider      string `json:"apiProvider,omitempty"` // "firstParty", "bedrock", "vertex", "foundry", "anthropicAws"
}

// --- Slash Command ---

// SlashCommand describes an available slash command.
type SlashCommand struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// --- Permission Types ---

// PermissionRuleValue is a rule for a permission.
type PermissionRuleValue struct {
	ToolName    string `json:"toolName"`
	RuleContent string `json:"ruleContent,omitempty"`
}

// PermissionUpdate describes a permission change.
type PermissionUpdate struct {
	Type        string               `json:"type"` // "addRules", "replaceRules", "removeRules", "setMode", "addDirectories", "removeDirectories"
	Rules       []PermissionRuleValue `json:"rules,omitempty"`
	Behavior    PermissionBehavior    `json:"behavior,omitempty"`
	Destination string                `json:"destination,omitempty"` // "userSettings", "projectSettings", "localSettings", "session", "cliArg"
	Mode        PermissionMode        `json:"mode,omitempty"`
	Directories []string              `json:"directories,omitempty"`
}

// PermissionResultAllow indicates a tool use is allowed.
type PermissionResultAllow struct {
	Behavior              string              `json:"behavior"` // "allow"
	UpdatedInput          map[string]any      `json:"updatedInput,omitempty"`
	UpdatedPermissions    []PermissionUpdate  `json:"updatedPermissions,omitempty"`
	ToolUseID             string              `json:"toolUseID,omitempty"`
	DecisionClassification string             `json:"decisionClassification,omitempty"`
}

// PermissionResultDeny indicates a tool use is denied.
type PermissionResultDeny struct {
	Behavior              string `json:"behavior"` // "deny"
	Message               string `json:"message"`
	Interrupt             *bool  `json:"interrupt,omitempty"`
	ToolUseID             string `json:"toolUseID,omitempty"`
	DecisionClassification string `json:"decisionClassification,omitempty"`
}

// PermissionResult is either Allow or Deny.
type PermissionResult struct {
	Allow *PermissionResultAllow
	Deny  *PermissionResultDeny
}

func (p PermissionResult) MarshalJSON() ([]byte, error) {
	if p.Allow != nil {
		return json.Marshal(p.Allow)
	}
	if p.Deny != nil {
		return json.Marshal(p.Deny)
	}
	return []byte("null"), nil
}

// --- Thinking Config ---

// ThinkingConfig controls Claude's thinking behavior.
type ThinkingConfig struct {
	Type         string `json:"type"` // "adaptive", "enabled", "disabled"
	BudgetTokens int    `json:"budgetTokens,omitempty"`
}

// --- Output Format ---

// OutputFormat configures structured output.
type OutputFormat struct {
	Type   OutputFormatType       `json:"type"`
	Schema map[string]any         `json:"schema,omitempty"`
}

// --- Sandbox Settings ---

// SandboxSettings configures command execution isolation.
type SandboxSettings struct {
	Enabled                   *bool                      `json:"enabled,omitempty"`
	FailIfUnavailable         *bool                      `json:"failIfUnavailable,omitempty"`
	AutoAllowBashIfSandboxed  *bool                      `json:"autoAllowBashIfSandboxed,omitempty"`
	AllowUnsandboxedCommands  *bool                      `json:"allowUnsandboxedCommands,omitempty"`
	Network                   *SandboxNetworkConfig      `json:"network,omitempty"`
	Filesystem                *SandboxFilesystemConfig   `json:"filesystem,omitempty"`
	IgnoreViolations          map[string][]string        `json:"ignoreViolations,omitempty"`
}

// SandboxNetworkConfig configures sandbox network access.
type SandboxNetworkConfig struct {
	AllowedDomains         []string `json:"allowedDomains,omitempty"`
	AllowManagedDomainsOnly *bool   `json:"allowManagedDomainsOnly,omitempty"`
	AllowUnixSockets       []string `json:"allowUnixSockets,omitempty"`
	AllowAllUnixSockets    *bool    `json:"allowAllUnixSockets,omitempty"`
	AllowLocalBinding      *bool    `json:"allowLocalBinding,omitempty"`
	HTTPProxyPort          *int     `json:"httpProxyPort,omitempty"`
	SOCKSProxyPort         *int     `json:"socksProxyPort,omitempty"`
}

// SandboxFilesystemConfig configures sandbox filesystem access.
type SandboxFilesystemConfig struct {
	AllowWrite               []string `json:"allowWrite,omitempty"`
	DenyWrite                []string `json:"denyWrite,omitempty"`
	DenyRead                 []string `json:"denyRead,omitempty"`
	AllowRead                []string `json:"allowRead,omitempty"`
	AllowManagedReadPathsOnly *bool   `json:"allowManagedReadPathsOnly,omitempty"`
}

// --- Plugin Config ---

// SdkPluginConfig defines a plugin to load.
type SdkPluginConfig struct {
	Type string `json:"type"` // "local"
	Path string `json:"path"`
}

// --- Content Blocks ---

// ContentBlock is the interface for message content blocks.
type ContentBlock interface {
	contentBlock()
}

// TextBlock represents a text content block.
type TextBlock struct {
	Type string `json:"type"` // "text"
	Text string `json:"text"`
}

func (TextBlock) contentBlock() {}

// ThinkingBlock represents a thinking/reasoning content block.
type ThinkingBlock struct {
	Type     string `json:"type"` // "thinking"
	Thinking string `json:"thinking"`
}

func (ThinkingBlock) contentBlock() {}

// ToolUseBlock represents a tool use request.
type ToolUseBlock struct {
	Type  string         `json:"type"` // "tool_use"
	ID    string         `json:"id"`
	Name  string         `json:"name"`
	Input map[string]any `json:"input"`
}

func (ToolUseBlock) contentBlock() {}

// ToolResultBlock represents a tool execution result.
type ToolResultBlock struct {
	Type      string `json:"type"` // "tool_result"
	ToolUseID string `json:"tool_use_id"`
	Content   string `json:"content,omitempty"`
	IsError   bool   `json:"is_error,omitempty"`
}

func (ToolResultBlock) contentBlock() {}

// --- Messages ---

// Message is the interface for all SDK messages.
type Message interface {
	MessageType() string
}

// UserMessage is a user input message.
type UserMessage struct {
	Type      string          `json:"type"` // "user"
	Content   json.RawMessage `json:"content,omitempty"`
	UUID      string          `json:"uuid,omitempty"`
	SessionID string          `json:"session_id,omitempty"`
}

func (UserMessage) MessageType() string { return "user" }

// AssistantMessage is a response from Claude.
type AssistantMessage struct {
	Type            string                    `json:"type"` // "assistant"
	Message         json.RawMessage           `json:"message"`
	ParentToolUseID *string                   `json:"parent_tool_use_id"`
	Error           *SDKAssistantMessageError `json:"error,omitempty"`
	UUID            string                    `json:"uuid,omitempty"`
	SessionID       string                    `json:"session_id,omitempty"`
}

func (AssistantMessage) MessageType() string { return "assistant" }

// GetContentBlocks extracts typed content blocks from the assistant message.
func (m *AssistantMessage) GetContentBlocks() []ContentBlock {
	var raw struct {
		Content []json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(m.Message, &raw); err != nil {
		return nil
	}
	var blocks []ContentBlock
	for _, c := range raw.Content {
		var t struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(c, &t); err != nil {
			continue
		}
		switch t.Type {
		case "text":
			var b TextBlock
			if json.Unmarshal(c, &b) == nil {
				blocks = append(blocks, b)
			}
		case "thinking":
			var b ThinkingBlock
			if json.Unmarshal(c, &b) == nil {
				blocks = append(blocks, b)
			}
		case "tool_use":
			var b ToolUseBlock
			if json.Unmarshal(c, &b) == nil {
				blocks = append(blocks, b)
			}
		case "tool_result":
			var b ToolResultBlock
			if json.Unmarshal(c, &b) == nil {
				blocks = append(blocks, b)
			}
		}
	}
	return blocks
}

// SystemMessage is a system-level message.
type SystemMessage struct {
	Type      string `json:"type"`    // "system"
	Subtype   string `json:"subtype"` // "task_started", "task_progress", "task_notification", etc.
	UUID      string `json:"uuid,omitempty"`
	SessionID string `json:"session_id,omitempty"`

	// Fields for various subtypes (use as needed)
	TaskID    string `json:"task_id,omitempty"`
	Status    string `json:"status,omitempty"`
	Summary   string `json:"summary,omitempty"`
	Message_  string `json:"message,omitempty"`
	Title     string `json:"title,omitempty"`
	AgentID   string `json:"agent_id,omitempty"`
	AgentType string `json:"agent_type,omitempty"`

	// Raw preserves the full JSON for subtype-specific fields
	Raw json.RawMessage `json:"-"`
}

func (SystemMessage) MessageType() string { return "system" }

// ResultMessage is the final result of a query.
type ResultMessage struct {
	Type       string          `json:"type"` // "result"
	Subtype    string          `json:"subtype,omitempty"` // "success" or "error_*"
	CostUSD    float64         `json:"cost_usd,omitempty"`
	Duration   float64         `json:"duration_ms,omitempty"`
	IsError    bool            `json:"is_error,omitempty"`
	Reason     TerminalReason  `json:"reason,omitempty"`
	SessionID  string          `json:"session_id,omitempty"`
	UUID       string          `json:"uuid,omitempty"`
	Usage      *ModelUsage     `json:"usage,omitempty"`
	Raw        json.RawMessage `json:"-"`
}

func (ResultMessage) MessageType() string { return "result" }

// RateLimitEvent indicates rate limiting.
type RateLimitEvent struct {
	Type      string           `json:"type"` // "rate_limit_event"
	RetryInfo *SDKRateLimitInfo `json:"retry_info,omitempty"`
	UUID      string            `json:"uuid,omitempty"`
	SessionID string            `json:"session_id,omitempty"`
}

func (RateLimitEvent) MessageType() string { return "rate_limit_event" }

// SDKRateLimitInfo contains rate limit retry information.
type SDKRateLimitInfo struct {
	RetryAfterMs int    `json:"retry_after_ms,omitempty"`
	Message      string `json:"message,omitempty"`
}

// PartialAssistantMessage represents a streaming partial message.
type PartialAssistantMessage struct {
	Type      string          `json:"type"` // "assistant"
	Subtype   string          `json:"subtype,omitempty"` // "partial"
	Message   json.RawMessage `json:"message,omitempty"`
	UUID      string          `json:"uuid,omitempty"`
	SessionID string          `json:"session_id,omitempty"`
}

func (PartialAssistantMessage) MessageType() string { return "assistant" }

// --- MCP Server Status ---

// McpServerStatus reports the status of an MCP server connection.
type McpServerStatus struct {
	Name       string          `json:"name"`
	Status     string          `json:"status"` // "connected", "failed", "needs-auth", "pending", "disabled"
	ServerInfo *McpServerInfo  `json:"serverInfo,omitempty"`
	Error      string          `json:"error,omitempty"`
	Config     json.RawMessage `json:"config,omitempty"`
	Scope      string          `json:"scope,omitempty"`
	Tools      []McpToolInfo   `json:"tools,omitempty"`
}

// McpServerInfo describes a connected MCP server.
type McpServerInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// McpToolInfo describes a tool from an MCP server.
type McpToolInfo struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Annotations *McpAnnotations `json:"annotations,omitempty"`
}

// McpAnnotations describes tool capabilities.
type McpAnnotations struct {
	ReadOnly    *bool `json:"readOnly,omitempty"`
	Destructive *bool `json:"destructive,omitempty"`
	OpenWorld   *bool `json:"openWorld,omitempty"`
}

// McpSetServersResult is the result of setting MCP servers.
type McpSetServersResult struct {
	Added   []string          `json:"added"`
	Removed []string          `json:"removed"`
	Errors  map[string]string `json:"errors"`
}

// --- Options ---

// ClaudeAgentOptions configures a Claude Agent SDK session.
type ClaudeAgentOptions struct {
	// Core options
	Model                          string                       `json:"model,omitempty"`
	FallbackModel                  string                       `json:"fallbackModel,omitempty"`
	PermissionMode                 PermissionMode               `json:"permissionMode,omitempty"`
	AllowDangerouslySkipPermissions bool                        `json:"allowDangerouslySkipPermissions,omitempty"`
	SystemPrompt                   any                          `json:"systemPrompt,omitempty"` // string or {type, preset, append}
	MaxTurns                       *int                         `json:"maxTurns,omitempty"`
	MaxThinkingTokens              *int                         `json:"maxThinkingTokens,omitempty"`
	MaxBudgetUsd                   *float64                     `json:"maxBudgetUsd,omitempty"`
	Thinking                       *ThinkingConfig              `json:"thinking,omitempty"`
	Effort                         *EffortLevel                 `json:"effort,omitempty"`
	OutputFormat                   *OutputFormat                `json:"outputFormat,omitempty"`
	Betas                          []string                     `json:"betas,omitempty"`

	// Session
	CWD                    string            `json:"cwd,omitempty"`
	Continue               bool              `json:"continue,omitempty"`
	Resume                 string            `json:"resume,omitempty"`
	SessionID              string            `json:"sessionId,omitempty"`
	ResumeSessionAt        string            `json:"resumeSessionAt,omitempty"`
	ForkSession            bool              `json:"forkSession,omitempty"`
	PersistSession         *bool             `json:"persistSession,omitempty"`

	// Tools & Permissions
	Tools                  any               `json:"tools,omitempty"` // []string or {type, preset}
	AllowedTools           []string          `json:"allowedTools,omitempty"`
	DisallowedTools        []string          `json:"disallowedTools,omitempty"`
	AdditionalDirectories  []string          `json:"additionalDirectories,omitempty"`

	// Agents
	Agent                  string                       `json:"agent,omitempty"`
	Agents                 map[string]AgentDefinition   `json:"agents,omitempty"`

	// MCP
	McpServers             map[string]json.RawMessage   `json:"mcpServers,omitempty"`
	StrictMcpConfig        bool                         `json:"strictMcpConfig,omitempty"`
	PermissionPromptToolName string                     `json:"permissionPromptToolName,omitempty"`

	// Plugins
	Plugins                []SdkPluginConfig            `json:"plugins,omitempty"`

	// Environment
	Env                    map[string]string            `json:"env,omitempty"`
	Executable             string                       `json:"executable,omitempty"` // "bun", "deno", "node"
	ExecutableArgs         []string                     `json:"executableArgs,omitempty"`
	ExtraArgs              map[string]string            `json:"extraArgs,omitempty"`
	PathToClaudeCode       string                       `json:"pathToClaudeCodeExecutable,omitempty"`

	// Features
	IncludePartialMessages bool                         `json:"includePartialMessages,omitempty"`
	IncludeHookEvents      bool                         `json:"includeHookEvents,omitempty"`
	EnableFileCheckpointing bool                        `json:"enableFileCheckpointing,omitempty"`
	PromptSuggestions      bool                         `json:"promptSuggestions,omitempty"`
	AgentProgressSummaries bool                         `json:"agentProgressSummaries,omitempty"`
	Debug                  bool                         `json:"debug,omitempty"`
	DebugFile              string                       `json:"debugFile,omitempty"`

	// Sandbox
	Sandbox                *SandboxSettings             `json:"sandbox,omitempty"`

	// Settings
	Settings               any                          `json:"settings,omitempty"` // string path or Settings object
	SettingSources         []SettingSource              `json:"settingSources,omitempty"`

	// Callbacks (not serialized - Go-side only)
	CanUseTool             CanUseToolFunc               `json:"-"`
	OnElicitation          OnElicitationFunc            `json:"-"`
	Stderr                 func(data string)            `json:"-"`
	HookCallbacks          map[HookEvent][]HookCallbackMatcher `json:"-"`
}

// CanUseToolFunc is the Go callback type for permission decisions.
type CanUseToolFunc func(toolName string, input map[string]any, ctx ToolPermissionContext) (PermissionResult, error)

// ToolPermissionContext provides context for permission decisions.
type ToolPermissionContext struct {
	ToolUseID       string             `json:"toolUseID"`
	AgentID         string             `json:"agentID,omitempty"`
	Suggestions     []PermissionUpdate `json:"suggestions,omitempty"`
	BlockedPath     string             `json:"blockedPath,omitempty"`
	DecisionReason  string             `json:"decisionReason,omitempty"`
	Title           string             `json:"title,omitempty"`
	DisplayName     string             `json:"displayName,omitempty"`
	Description     string             `json:"description,omitempty"`
}

// OnElicitationFunc is the Go callback for MCP elicitation.
type OnElicitationFunc func(request ElicitationRequest) (ElicitationResult, error)

// ElicitationRequest is an MCP elicitation request.
type ElicitationRequest struct {
	ServerName      string         `json:"serverName"`
	Message         string         `json:"message"`
	Mode            string         `json:"mode,omitempty"`
	URL             string         `json:"url,omitempty"`
	ElicitationID   string         `json:"elicitationId,omitempty"`
	RequestedSchema map[string]any `json:"requestedSchema,omitempty"`
}

// ElicitationResult is the response to an elicitation.
type ElicitationResult struct {
	Action  string         `json:"action"` // "accept", "decline", "cancel"
	Content map[string]any `json:"content,omitempty"`
}

// HookCallbackMatcher matches hooks for execution.
type HookCallbackMatcher struct {
	Matcher string         `json:"matcher,omitempty"`
	Timeout *int           `json:"timeout,omitempty"`
	Hooks   []HookCallback `json:"-"`
}

// HookCallback is a function that handles a hook event.
type HookCallback func(input json.RawMessage, toolUseID string) (HookJSONOutput, error)

// HookJSONOutput is the output from a hook callback.
type HookJSONOutput struct {
	// Sync output fields
	Continue             *bool                  `json:"continue,omitempty"`
	PermissionDecision   *HookPermissionDecision `json:"permissionDecision,omitempty"`
	AdditionalContext    string                  `json:"additionalContext,omitempty"`
	UpdatedInput         map[string]any          `json:"updatedInput,omitempty"`
	// Async mode
	Async                bool                    `json:"async,omitempty"`
	AsyncTimeout         *int                    `json:"asyncTimeout,omitempty"`
}

// --- Control Protocol ---

// ControlRequest is a request from the SDK to the CLI.
type ControlRequest struct {
	Type      string         `json:"type"` // "control_request"
	RequestID string         `json:"request_id"`
	Request   map[string]any `json:"request"`
}

// ControlResponse is a response from the CLI to the SDK.
type ControlResponse struct {
	Type     string          `json:"type"` // "control_response"
	Response json.RawMessage `json:"response"`
}

// --- Initialize Response ---

// InitializeResponse is returned after the initialize handshake.
type InitializeResponse struct {
	Commands                []SlashCommand  `json:"commands"`
	Agents                  []AgentInfo     `json:"agents"`
	OutputStyle             string          `json:"output_style"`
	AvailableOutputStyles   []string        `json:"available_output_styles"`
	Models                  []ModelInfo     `json:"models"`
	Account                 AccountInfo     `json:"account"`
	FastModeState           *FastModeState  `json:"fast_mode_state,omitempty"`
}

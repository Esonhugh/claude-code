package claudesdk

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// ── Helpers ──────────────────────────────────────────────────────────────────

// contains reports whether args contains the given flag.
func contains(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}

// argValue returns the value that immediately follows flag in args.
// It returns "" if the flag is absent or has no following value.
func argValue(args []string, flag string) string {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

// argValues returns all values that immediately follow flag in args.
func argValues(args []string, flag string) []string {
	var vals []string
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			vals = append(vals, args[i+1])
		}
	}
	return vals
}

// intPtr is a helper to create an *int.
func intPtr(v int) *int { return &v }

// float64Ptr is a helper to create a *float64.
func float64Ptr(v float64) *float64 { return &v }

// boolPtr is a helper to create a *bool.
func boolPtr(v bool) *bool { return &v }

// effortPtr is a helper to create an *EffortLevel.
func effortPtr(e EffortLevel) *EffortLevel { return &e }

// ── buildArgs tests ──────────────────────────────────────────────────────────

func TestBuildArgs_Minimal(t *testing.T) {
	args := buildArgs(&ClaudeAgentOptions{})

	if len(args) != 3 {
		t.Fatalf("expected exactly 3 args for empty options, got %d: %v", len(args), args)
	}
	if args[0] != "--output-format" || args[1] != "stream-json" || args[2] != "--verbose" {
		t.Fatalf("unexpected base args: %v", args)
	}
}

func TestBuildArgs_AllBoolFlags(t *testing.T) {
	tests := []struct {
		name string
		opts ClaudeAgentOptions
		flag string
	}{
		{"AllowDangerouslySkipPermissions", ClaudeAgentOptions{AllowDangerouslySkipPermissions: true}, "--dangerously-skip-permissions"},
		{"Continue", ClaudeAgentOptions{Continue: true}, "--continue"},
		{"Debug", ClaudeAgentOptions{Debug: true}, "--debug"},
		{"ForkSession", ClaudeAgentOptions{ForkSession: true}, "--fork-session"},
		{"IncludePartialMessages", ClaudeAgentOptions{IncludePartialMessages: true}, "--include-partial-messages"},
		{"IncludeHookEvents", ClaudeAgentOptions{IncludeHookEvents: true}, "--include-hook-events"},
		{"EnableFileCheckpointing", ClaudeAgentOptions{EnableFileCheckpointing: true}, "--enable-file-checkpointing"},
		{"PromptSuggestions", ClaudeAgentOptions{PromptSuggestions: true}, "--prompt-suggestions"},
		{"AgentProgressSummaries", ClaudeAgentOptions{AgentProgressSummaries: true}, "--agent-progress-summaries"},
		{"StrictMcpConfig", ClaudeAgentOptions{StrictMcpConfig: true}, "--strict-mcp-config"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			args := buildArgs(&tt.opts)
			if !contains(args, tt.flag) {
				t.Errorf("expected flag %q in args: %v", tt.flag, args)
			}
		})
	}
}

func TestBuildArgs_BoolFlagsFalseNotPresent(t *testing.T) {
	// When bool flags are false they should NOT appear.
	args := buildArgs(&ClaudeAgentOptions{})
	absent := []string{
		"--dangerously-skip-permissions",
		"--continue",
		"--debug",
		"--fork-session",
		"--include-partial-messages",
		"--include-hook-events",
		"--enable-file-checkpointing",
		"--prompt-suggestions",
		"--agent-progress-summaries",
		"--strict-mcp-config",
	}
	for _, flag := range absent {
		if contains(args, flag) {
			t.Errorf("flag %q should not be in args for empty options", flag)
		}
	}
}

func TestBuildArgs_ModelFlags(t *testing.T) {
	args := buildArgs(&ClaudeAgentOptions{
		Model:         "claude-sonnet-4-20250514",
		FallbackModel: "claude-3-haiku-20240307",
	})

	if v := argValue(args, "--model"); v != "claude-sonnet-4-20250514" {
		t.Errorf("--model = %q, want %q", v, "claude-sonnet-4-20250514")
	}
	if v := argValue(args, "--fallback-model"); v != "claude-3-haiku-20240307" {
		t.Errorf("--fallback-model = %q, want %q", v, "claude-3-haiku-20240307")
	}
}

func TestBuildArgs_MaxTurnsPointer(t *testing.T) {
	t.Run("nil", func(t *testing.T) {
		args := buildArgs(&ClaudeAgentOptions{})
		if contains(args, "--max-turns") {
			t.Error("--max-turns should not appear when nil")
		}
	})
	t.Run("set", func(t *testing.T) {
		args := buildArgs(&ClaudeAgentOptions{MaxTurns: intPtr(10)})
		if v := argValue(args, "--max-turns"); v != "10" {
			t.Errorf("--max-turns = %q, want %q", v, "10")
		}
	})
}

func TestBuildArgs_MaxThinkingTokens(t *testing.T) {
	args := buildArgs(&ClaudeAgentOptions{MaxThinkingTokens: intPtr(4096)})
	if v := argValue(args, "--max-thinking-tokens"); v != "4096" {
		t.Errorf("--max-thinking-tokens = %q, want %q", v, "4096")
	}
}

func TestBuildArgs_ThinkingConfig(t *testing.T) {
	tests := []struct {
		name   string
		cfg    ThinkingConfig
		expect string
	}{
		{"disabled", ThinkingConfig{Type: "disabled"}, "disabled"},
		{"adaptive", ThinkingConfig{Type: "adaptive"}, "adaptive"},
		{"enabled", ThinkingConfig{Type: "enabled", BudgetTokens: 8000}, "enabled:8000"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			args := buildArgs(&ClaudeAgentOptions{Thinking: &tt.cfg})
			if v := argValue(args, "--thinking"); v != tt.expect {
				t.Errorf("--thinking = %q, want %q", v, tt.expect)
			}
		})
	}
}

func TestBuildArgs_EffortLevel(t *testing.T) {
	for _, level := range []EffortLevel{EffortLow, EffortMedium, EffortHigh, EffortMax} {
		t.Run(string(level), func(t *testing.T) {
			args := buildArgs(&ClaudeAgentOptions{Effort: effortPtr(level)})
			if v := argValue(args, "--effort"); v != string(level) {
				t.Errorf("--effort = %q, want %q", v, string(level))
			}
		})
	}

	t.Run("nil", func(t *testing.T) {
		args := buildArgs(&ClaudeAgentOptions{})
		if contains(args, "--effort") {
			t.Error("--effort should not appear when nil")
		}
	})
}

func TestBuildArgs_AllowedDisallowedTools(t *testing.T) {
	args := buildArgs(&ClaudeAgentOptions{
		AllowedTools:    []string{"Bash", "Read"},
		DisallowedTools: []string{"Write"},
	})

	allowed := argValues(args, "--allowedTools")
	if len(allowed) != 2 || allowed[0] != "Bash" || allowed[1] != "Read" {
		t.Errorf("--allowedTools = %v, want [Bash Read]", allowed)
	}

	disallowed := argValues(args, "--disallowedTools")
	if len(disallowed) != 1 || disallowed[0] != "Write" {
		t.Errorf("--disallowedTools = %v, want [Write]", disallowed)
	}
}

func TestBuildArgs_AdditionalDirs(t *testing.T) {
	dirs := []string{"/home/user/project1", "/home/user/project2", "/home/user/shared"}
	args := buildArgs(&ClaudeAgentOptions{AdditionalDirectories: dirs})

	got := argValues(args, "--add-dir")
	if len(got) != len(dirs) {
		t.Fatalf("expected %d --add-dir flags, got %d", len(dirs), len(got))
	}
	for i, d := range dirs {
		if got[i] != d {
			t.Errorf("--add-dir[%d] = %q, want %q", i, got[i], d)
		}
	}
}

func TestBuildArgs_Betas(t *testing.T) {
	betas := []string{"context-1m-2025-08-07", "another-beta"}
	args := buildArgs(&ClaudeAgentOptions{Betas: betas})

	got := argValues(args, "--beta")
	if len(got) != 2 {
		t.Fatalf("expected 2 --beta flags, got %d", len(got))
	}
	if got[0] != betas[0] || got[1] != betas[1] {
		t.Errorf("--beta values = %v, want %v", got, betas)
	}
}

func TestBuildArgs_SettingSources(t *testing.T) {
	sources := []SettingSource{SettingSourceLocal, SettingSourceUser, SettingSourceProject}
	args := buildArgs(&ClaudeAgentOptions{SettingSources: sources})

	got := argValues(args, "--setting-source")
	if len(got) != 3 {
		t.Fatalf("expected 3 --setting-source flags, got %d", len(got))
	}
	for i, s := range sources {
		if got[i] != string(s) {
			t.Errorf("--setting-source[%d] = %q, want %q", i, got[i], string(s))
		}
	}
}

func TestBuildArgs_SystemPrompt(t *testing.T) {
	t.Run("string", func(t *testing.T) {
		args := buildArgs(&ClaudeAgentOptions{
			SystemPrompt: "You are a helpful assistant.",
		})
		if v := argValue(args, "--system-prompt"); v != "You are a helpful assistant." {
			t.Errorf("--system-prompt = %q, want %q", v, "You are a helpful assistant.")
		}
	})

	t.Run("preset with append", func(t *testing.T) {
		args := buildArgs(&ClaudeAgentOptions{
			SystemPrompt: SystemPromptPreset{
				Type:   "preset",
				Preset: "claude_code",
				Append: "Always be concise.",
			},
		})
		if v := argValue(args, "--append-system-prompt"); v != "Always be concise." {
			t.Errorf("--append-system-prompt = %q, want %q", v, "Always be concise.")
		}
		if contains(args, "--system-prompt") {
			t.Error("--system-prompt should not be present for preset")
		}
	})

	t.Run("file", func(t *testing.T) {
		args := buildArgs(&ClaudeAgentOptions{
			SystemPrompt: SystemPromptFile{
				Type: "file",
				Path: "/path/to/prompt.txt",
			},
		})
		if v := argValue(args, "--system-prompt-file"); v != "/path/to/prompt.txt" {
			t.Errorf("--system-prompt-file = %q, want %q", v, "/path/to/prompt.txt")
		}
	})

	t.Run("nil", func(t *testing.T) {
		args := buildArgs(&ClaudeAgentOptions{})
		if contains(args, "--system-prompt") || contains(args, "--append-system-prompt") || contains(args, "--system-prompt-file") {
			t.Error("no system prompt flags should appear for nil")
		}
	})
}

func TestBuildArgs_Plugins(t *testing.T) {
	plugins := []SdkPluginConfig{
		{Type: "local", Path: "/plugins/a"},
		{Type: "local", Path: "/plugins/b"},
	}
	args := buildArgs(&ClaudeAgentOptions{Plugins: plugins})

	got := argValues(args, "--plugin-dir")
	if len(got) != 2 {
		t.Fatalf("expected 2 --plugin-dir flags, got %d", len(got))
	}
	if got[0] != "/plugins/a" || got[1] != "/plugins/b" {
		t.Errorf("--plugin-dir = %v, want [/plugins/a /plugins/b]", got)
	}
}

func TestBuildArgs_PluginEmptyPath(t *testing.T) {
	args := buildArgs(&ClaudeAgentOptions{
		Plugins: []SdkPluginConfig{{Type: "local", Path: ""}},
	})
	if contains(args, "--plugin-dir") {
		t.Error("--plugin-dir should not appear for empty path")
	}
}

func TestBuildArgs_TaskBudget(t *testing.T) {
	args := buildArgs(&ClaudeAgentOptions{
		TaskBudget: &TaskBudget{TotalTokens: 50000},
	})
	if v := argValue(args, "--task-budget"); v != "50000" {
		t.Errorf("--task-budget = %q, want %q", v, "50000")
	}
}

func TestBuildArgs_MaxBudgetUsd(t *testing.T) {
	tests := []struct {
		val    float64
		expect string
	}{
		{1.5, "1.50"},
		{0.01, "0.01"},
		{100.0, "100.00"},
		{9.999, "10.00"},
	}
	for _, tt := range tests {
		t.Run(tt.expect, func(t *testing.T) {
			args := buildArgs(&ClaudeAgentOptions{MaxBudgetUsd: float64Ptr(tt.val)})
			if v := argValue(args, "--max-budget-usd"); v != tt.expect {
				t.Errorf("--max-budget-usd = %q, want %q", v, tt.expect)
			}
		})
	}

	t.Run("nil", func(t *testing.T) {
		args := buildArgs(&ClaudeAgentOptions{})
		if contains(args, "--max-budget-usd") {
			t.Error("--max-budget-usd should not appear when nil")
		}
	})
}

func TestBuildArgs_PersistSession(t *testing.T) {
	t.Run("false", func(t *testing.T) {
		args := buildArgs(&ClaudeAgentOptions{PersistSession: boolPtr(false)})
		if !contains(args, "--no-persist-session") {
			t.Error("expected --no-persist-session when PersistSession=false")
		}
	})

	t.Run("true", func(t *testing.T) {
		args := buildArgs(&ClaudeAgentOptions{PersistSession: boolPtr(true)})
		if contains(args, "--no-persist-session") {
			t.Error("--no-persist-session should not appear when PersistSession=true")
		}
	})

	t.Run("nil", func(t *testing.T) {
		args := buildArgs(&ClaudeAgentOptions{})
		if contains(args, "--no-persist-session") {
			t.Error("--no-persist-session should not appear when PersistSession=nil")
		}
	})
}

func TestBuildArgs_ExtraArgs(t *testing.T) {
	args := buildArgs(&ClaudeAgentOptions{
		ExtraArgs: map[string]string{
			"custom-flag":  "value1",
			"boolean-flag": "",
		},
	})

	if !contains(args, "--custom-flag") {
		t.Error("expected --custom-flag in args")
	}
	if !contains(args, "--boolean-flag") {
		t.Error("expected --boolean-flag in args")
	}

	// The boolean flag should NOT have a following value that is ""
	for i, a := range args {
		if a == "--boolean-flag" {
			// Next item should not be "" (it should either be end of list or another flag)
			if i+1 < len(args) && args[i+1] == "" {
				t.Error("boolean flag should not have empty string value")
			}
			break
		}
	}

	if v := argValue(args, "--custom-flag"); v != "value1" {
		t.Errorf("--custom-flag = %q, want %q", v, "value1")
	}
}

func TestBuildArgs_Sandbox(t *testing.T) {
	enabled := true
	args := buildArgs(&ClaudeAgentOptions{
		Sandbox: &SandboxSettings{
			Enabled: &enabled,
		},
	})

	settingsJSON := argValue(args, "--settings")
	if settingsJSON == "" {
		t.Fatal("expected --settings flag for sandbox config")
	}

	var parsed map[string]any
	if err := json.Unmarshal([]byte(settingsJSON), &parsed); err != nil {
		t.Fatalf("failed to parse settings JSON: %v", err)
	}

	sandbox, ok := parsed["sandbox"]
	if !ok {
		t.Fatal("expected 'sandbox' key in settings")
	}

	sandboxMap, ok := sandbox.(map[string]any)
	if !ok {
		t.Fatal("sandbox value is not a map")
	}

	if v, ok := sandboxMap["enabled"]; !ok || v != true {
		t.Errorf("sandbox.enabled = %v, want true", v)
	}
}

func TestBuildArgs_SandboxMergedWithSettings(t *testing.T) {
	enabled := true
	args := buildArgs(&ClaudeAgentOptions{
		Settings: map[string]any{"theme": "dark"},
		Sandbox:  &SandboxSettings{Enabled: &enabled},
	})

	settingsJSON := argValue(args, "--settings")
	if settingsJSON == "" {
		t.Fatal("expected --settings flag")
	}

	var parsed map[string]any
	if err := json.Unmarshal([]byte(settingsJSON), &parsed); err != nil {
		t.Fatalf("failed to parse settings JSON: %v", err)
	}

	if parsed["theme"] != "dark" {
		t.Errorf("expected theme=dark, got %v", parsed["theme"])
	}
	if _, ok := parsed["sandbox"]; !ok {
		t.Error("expected sandbox key in merged settings")
	}
}

func TestBuildArgs_SettingsStringJSON(t *testing.T) {
	args := buildArgs(&ClaudeAgentOptions{
		Settings: `{"editor":"vim"}`,
	})

	settingsJSON := argValue(args, "--settings")
	if settingsJSON == "" {
		t.Fatal("expected --settings flag")
	}

	var parsed map[string]any
	if err := json.Unmarshal([]byte(settingsJSON), &parsed); err != nil {
		t.Fatalf("failed to parse settings JSON: %v", err)
	}

	if parsed["editor"] != "vim" {
		t.Errorf("expected editor=vim, got %v", parsed["editor"])
	}
}

func TestBuildArgs_OutputFormatJSON(t *testing.T) {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"name": map[string]any{"type": "string"},
		},
	}
	args := buildArgs(&ClaudeAgentOptions{
		OutputFormat: &OutputFormat{
			Type:   OutputFormatJSONSchema,
			Schema: schema,
		},
	})

	raw := argValue(args, "--output-format-json")
	if raw == "" {
		t.Fatal("expected --output-format-json flag")
	}

	var parsed OutputFormat
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		t.Fatalf("failed to parse output-format-json: %v", err)
	}
	if parsed.Type != OutputFormatJSONSchema {
		t.Errorf("output format type = %q, want %q", parsed.Type, OutputFormatJSONSchema)
	}
}

func TestBuildArgs_PermissionModeVariants(t *testing.T) {
	for _, pm := range []PermissionMode{
		PermissionModeDefault,
		PermissionModeAcceptEdits,
		PermissionModeBypassPermissions,
		PermissionModePlan,
	} {
		t.Run(string(pm), func(t *testing.T) {
			args := buildArgs(&ClaudeAgentOptions{PermissionMode: pm})
			if v := argValue(args, "--permission-mode"); v != string(pm) {
				t.Errorf("--permission-mode = %q, want %q", v, string(pm))
			}
		})
	}
}

func TestBuildArgs_StringFields(t *testing.T) {
	tests := []struct {
		name string
		opts ClaudeAgentOptions
		flag string
		want string
	}{
		{"CWD", ClaudeAgentOptions{CWD: "/work"}, "--cwd", "/work"},
		{"Resume", ClaudeAgentOptions{Resume: "session-abc"}, "--resume", "session-abc"},
		{"SessionID", ClaudeAgentOptions{SessionID: "sid-123"}, "--session-id", "sid-123"},
		{"DebugFile", ClaudeAgentOptions{DebugFile: "/var/log/debug.log"}, "--debug-file", "/var/log/debug.log"},
		{"ResumeSessionAt", ClaudeAgentOptions{ResumeSessionAt: "2024-01-01"}, "--resume-session-at", "2024-01-01"},
		{"Agent", ClaudeAgentOptions{Agent: "custom-agent"}, "--agent", "custom-agent"},
		{"PermissionPromptToolName", ClaudeAgentOptions{PermissionPromptToolName: "my-tool"}, "--permission-prompt-tool-name", "my-tool"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			args := buildArgs(&tt.opts)
			if v := argValue(args, tt.flag); v != tt.want {
				t.Errorf("%s = %q, want %q", tt.flag, v, tt.want)
			}
		})
	}
}

func TestBuildArgs_McpServers(t *testing.T) {
	mcpServers := map[string]json.RawMessage{
		"server1": json.RawMessage(`{"command":"node","args":["server.js"]}`),
	}
	args := buildArgs(&ClaudeAgentOptions{McpServers: mcpServers})

	raw := argValue(args, "--mcp-config")
	if raw == "" {
		t.Fatal("expected --mcp-config flag")
	}

	var parsed map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		t.Fatalf("failed to parse mcp-config: %v", err)
	}
	if _, ok := parsed["server1"]; !ok {
		t.Error("expected server1 key in mcp-config")
	}
}

func TestBuildArgs_CombinedComplex(t *testing.T) {
	// Verify a realistic combination of options produces well-formed args.
	opts := &ClaudeAgentOptions{
		Model:                           "claude-sonnet-4-20250514",
		PermissionMode:                  PermissionModeBypassPermissions,
		AllowDangerouslySkipPermissions: true,
		MaxTurns:                        intPtr(5),
		Thinking:                        &ThinkingConfig{Type: "enabled", BudgetTokens: 4096},
		Effort:                          effortPtr(EffortHigh),
		AllowedTools:                    []string{"Bash", "Read"},
		Betas:                           []string{"context-1m-2025-08-07"},
		SystemPrompt:                    "Be helpful",
		MaxBudgetUsd:                    float64Ptr(2.50),
		Debug:                           true,
	}
	args := buildArgs(opts)

	// Verify no duplicate --output-format (base always present)
	count := 0
	for _, a := range args {
		if a == "--output-format" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("expected exactly 1 --output-format, got %d", count)
	}

	// Spot-check a few critical flags
	if v := argValue(args, "--model"); v != "claude-sonnet-4-20250514" {
		t.Errorf("--model = %q", v)
	}
	if !contains(args, "--dangerously-skip-permissions") {
		t.Error("expected --dangerously-skip-permissions")
	}
	if v := argValue(args, "--max-turns"); v != "5" {
		t.Errorf("--max-turns = %q", v)
	}
	if v := argValue(args, "--thinking"); v != "enabled:4096" {
		t.Errorf("--thinking = %q", v)
	}
	if v := argValue(args, "--effort"); v != "high" {
		t.Errorf("--effort = %q", v)
	}
	if v := argValue(args, "--system-prompt"); v != "Be helpful" {
		t.Errorf("--system-prompt = %q", v)
	}
	if !contains(args, "--debug") {
		t.Error("expected --debug")
	}
}

// ── Environment constant tests ───────────────────────────────────────────────

func TestEnvConstants(t *testing.T) {
	tests := []struct {
		name     string
		constant string
		expected string
	}{
		{"CONFIG_DIR", CLAUDE_CODE_CONFIG_DIR, "CLAUDE_CONFIG_DIR"},
		{"STREAM_CLOSE_TIMEOUT", CLAUDE_CODE_STREAM_CLOSE_TIMEOUT, "CLAUDE_CODE_STREAM_CLOSE_TIMEOUT"},
		{"SKIP_VERSION_CHECK", CLAUDE_CODE_SKIP_VERSION_CHECK, "CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK"},
		{"ENABLE_FILE_CHECKPOINTING", CLAUDE_CODE_ENABLE_FILE_CHECKPOINTING, "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING"},
		{"ENTRYPOINT", CLAUDE_CODE_ENTRYPOINT, "CLAUDE_CODE_ENTRYPOINT"},
		{"SDK_VERSION", CLAUDE_CODE_SDK_VERSION, "CLAUDE_AGENT_SDK_VERSION"},
		{"NESTING_FILTER", CLAUDE_CODE_NESTING_FILTER, "CLAUDECODE"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.constant != tt.expected {
				t.Errorf("%s = %q, want %q", tt.name, tt.constant, tt.expected)
			}
		})
	}
}

func TestSDKMetadata(t *testing.T) {
	if SDKVersion != "0.1.0" {
		t.Errorf("SDKVersion = %q, want %q", SDKVersion, "0.1.0")
	}
	if MinimumClaudeCodeVersion != "2.0.0" {
		t.Errorf("MinimumClaudeCodeVersion = %q, want %q", MinimumClaudeCodeVersion, "2.0.0")
	}
	if SDKEntrypoint != "sdk-go" {
		t.Errorf("SDKEntrypoint = %q, want %q", SDKEntrypoint, "sdk-go")
	}
}

func TestEnvConstantsNotEmpty(t *testing.T) {
	constants := []string{
		CLAUDE_CODE_CONFIG_DIR,
		CLAUDE_CODE_STREAM_CLOSE_TIMEOUT,
		CLAUDE_CODE_SKIP_VERSION_CHECK,
		CLAUDE_CODE_ENABLE_FILE_CHECKPOINTING,
		CLAUDE_CODE_ENTRYPOINT,
		CLAUDE_CODE_SDK_VERSION,
		CLAUDE_CODE_NESTING_FILTER,
	}
	for _, c := range constants {
		if c == "" {
			t.Errorf("env constant should not be empty")
		}
		if strings.ContainsAny(c, " \t\n") {
			t.Errorf("env constant %q should not contain whitespace", c)
		}
	}
}

// ── buildSettingsValue tests ─────────────────────────────────────────────────

func TestBuildSettingsValue_Empty(t *testing.T) {
	result := buildSettingsValue(&ClaudeAgentOptions{})
	if result != "" {
		t.Errorf("expected empty string for no settings/sandbox, got %q", result)
	}
}

func TestBuildSettingsValue_SettingsMap(t *testing.T) {
	result := buildSettingsValue(&ClaudeAgentOptions{
		Settings: map[string]any{"key": "val"},
	})
	var parsed map[string]any
	if err := json.Unmarshal([]byte(result), &parsed); err != nil {
		t.Fatalf("failed to parse: %v", err)
	}
	if parsed["key"] != "val" {
		t.Errorf("key = %v, want val", parsed["key"])
	}
}

func TestBuildSettingsValue_SettingsString(t *testing.T) {
	result := buildSettingsValue(&ClaudeAgentOptions{
		Settings: `{"foo":"bar"}`,
	})
	var parsed map[string]any
	if err := json.Unmarshal([]byte(result), &parsed); err != nil {
		t.Fatalf("failed to parse: %v", err)
	}
	if parsed["foo"] != "bar" {
		t.Errorf("foo = %v, want bar", parsed["foo"])
	}
}

func TestBuildSettingsValue_SandboxOnly(t *testing.T) {
	enabled := true
	result := buildSettingsValue(&ClaudeAgentOptions{
		Sandbox: &SandboxSettings{Enabled: &enabled},
	})
	var parsed map[string]any
	if err := json.Unmarshal([]byte(result), &parsed); err != nil {
		t.Fatalf("failed to parse: %v", err)
	}
	sb, ok := parsed["sandbox"].(map[string]any)
	if !ok {
		t.Fatal("expected sandbox map")
	}
	if sb["enabled"] != true {
		t.Errorf("sandbox.enabled = %v, want true", sb["enabled"])
	}
}

// ── Extra coverage: argValue helper edge case ────────────────────────────────

func TestHelpers(t *testing.T) {
	t.Run("contains", func(t *testing.T) {
		if contains(nil, "x") {
			t.Error("nil slice should not contain anything")
		}
		if contains([]string{"a", "b"}, "c") {
			t.Error("should not find 'c'")
		}
		if !contains([]string{"a", "b"}, "b") {
			t.Error("should find 'b'")
		}
	})

	t.Run("argValue missing", func(t *testing.T) {
		if v := argValue([]string{"--foo"}, "--foo"); v != "" {
			t.Errorf("flag at end should return empty, got %q", v)
		}
		if v := argValue([]string{}, "--foo"); v != "" {
			t.Errorf("empty args should return empty, got %q", v)
		}
	})

	t.Run("argValues empty", func(t *testing.T) {
		vals := argValues([]string{"--other", "val"}, "--missing")
		if len(vals) != 0 {
			t.Errorf("expected no values, got %v", vals)
		}
	})
}

// ── Table-driven: verify no nil-pointer panics ───────────────────────────────

func TestBuildArgs_NilPointerSafety(t *testing.T) {
	// All pointer fields nil — should not panic.
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("buildArgs panicked with nil pointers: %v", r)
		}
	}()

	args := buildArgs(&ClaudeAgentOptions{})
	if len(args) < 3 {
		t.Error("expected at least base args")
	}
}

func TestBuildArgs_EmptySlices(t *testing.T) {
	// Empty slices should not produce any flags.
	args := buildArgs(&ClaudeAgentOptions{
		AllowedTools:          []string{},
		DisallowedTools:       []string{},
		AdditionalDirectories: []string{},
		Betas:                 []string{},
		SettingSources:        []SettingSource{},
		Plugins:               []SdkPluginConfig{},
	})

	for _, flag := range []string{"--allowedTools", "--disallowedTools", "--add-dir", "--beta", "--setting-source", "--plugin-dir"} {
		if contains(args, flag) {
			t.Errorf("flag %q should not appear for empty slices", flag)
		}
	}
}

func TestBuildArgs_AllFlagsFormat(t *testing.T) {
	// Verify every arg starts with "--" or is a value following a "--" flag.
	args := buildArgs(&ClaudeAgentOptions{
		Model:    "m",
		MaxTurns: intPtr(1),
		Debug:    true,
		Betas:    []string{"b1"},
	})

	for i, a := range args {
		if strings.HasPrefix(a, "--") {
			continue
		}
		// Must be a value preceded by a flag
		if i == 0 || !strings.HasPrefix(args[i-1], "--") {
			t.Errorf("arg[%d] = %q is not a flag and not preceded by a flag (prev: %q)",
				i, a, safeIndex(args, i-1))
		}
	}
}

func safeIndex(s []string, i int) string {
	if i < 0 || i >= len(s) {
		return "<none>"
	}
	return s[i]
}

// ── Benchmark ────────────────────────────────────────────────────────────────

func BenchmarkBuildArgs(b *testing.B) {
	opts := &ClaudeAgentOptions{
		Model:        "claude-sonnet-4-20250514",
		MaxTurns:     intPtr(10),
		AllowedTools: []string{"Bash", "Read", "Write"},
		Betas:        []string{"beta1"},
		Thinking:     &ThinkingConfig{Type: "enabled", BudgetTokens: 4096},
		Effort:       effortPtr(EffortHigh),
		MaxBudgetUsd: float64Ptr(5.0),
		SystemPrompt: "Be helpful",
		Debug:        true,
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = buildArgs(opts)
	}
}

func BenchmarkBuildSettingsValue(b *testing.B) {
	enabled := true
	opts := &ClaudeAgentOptions{
		Settings: map[string]any{"theme": "dark", "font": "mono"},
		Sandbox:  &SandboxSettings{Enabled: &enabled},
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = buildSettingsValue(opts)
	}
}

// Suppress unused import warning for fmt.
var _ = fmt.Sprintf

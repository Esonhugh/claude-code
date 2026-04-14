package claudesdk

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// SubprocessTransport implements Transport by spawning the Claude CLI as a subprocess.
type SubprocessTransport struct {
	opts      *ClaudeAgentOptions
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	stdout    io.ReadCloser
	stderr    io.ReadCloser
	ready     bool
	mu        sync.Mutex
	closeOnce sync.Once
}

// NewSubprocessTransport creates a new subprocess transport.
func NewSubprocessTransport(opts *ClaudeAgentOptions) *SubprocessTransport {
	return &SubprocessTransport{opts: opts}
}

// findClaudeBinary locates the claude CLI binary.
func findClaudeBinary(customPath string) (string, error) {
	if customPath != "" {
		if _, err := os.Stat(customPath); err == nil {
			return customPath, nil
		}
		return "", &CLINotFoundError{
			ClaudeSDKError: ClaudeSDKError{Message: fmt.Sprintf("claude binary not found at custom path: %s", customPath)},
			SearchPaths:    []string{customPath},
		}
	}

	searchPaths := []string{}

	// Check PATH first
	if p, err := exec.LookPath("claude"); err == nil {
		return p, nil
	}

	// Known locations
	home, _ := os.UserHomeDir()
	knownPaths := []string{
		filepath.Join(home, ".claude", "local", "claude"),
		"/usr/local/bin/claude",
		"/usr/bin/claude",
	}
	if runtime.GOOS == "windows" {
		knownPaths = append(knownPaths,
			filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "claude", "claude.exe"),
		)
	}

	for _, p := range knownPaths {
		searchPaths = append(searchPaths, p)
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}

	return "", NewCLINotFoundError(searchPaths)
}

// buildArgs constructs CLI arguments from options.
func buildArgs(opts *ClaudeAgentOptions) []string {
	args := []string{
		"--output-format", "stream-json",
		"--verbose",
	}

	if opts.Model != "" {
		args = append(args, "--model", opts.Model)
	}
	if opts.FallbackModel != "" {
		args = append(args, "--fallback-model", opts.FallbackModel)
	}
	if opts.PermissionMode != "" {
		args = append(args, "--permission-mode", string(opts.PermissionMode))
	}
	if opts.AllowDangerouslySkipPermissions {
		args = append(args, "--dangerously-skip-permissions")
	}
	if opts.CWD != "" {
		args = append(args, "--cwd", opts.CWD)
	}
	if opts.Continue {
		args = append(args, "--continue")
	}
	if opts.Resume != "" {
		args = append(args, "--resume", opts.Resume)
	}
	if opts.SessionID != "" {
		args = append(args, "--session-id", opts.SessionID)
	}
	if opts.MaxTurns != nil {
		args = append(args, "--max-turns", fmt.Sprintf("%d", *opts.MaxTurns))
	}
	if opts.MaxThinkingTokens != nil {
		args = append(args, "--max-thinking-tokens", fmt.Sprintf("%d", *opts.MaxThinkingTokens))
	}
	if opts.Debug {
		args = append(args, "--debug")
	}
	if opts.DebugFile != "" {
		args = append(args, "--debug-file", opts.DebugFile)
	}
	if opts.PersistSession != nil && !*opts.PersistSession {
		args = append(args, "--no-persist-session")
	}
	if opts.ForkSession {
		args = append(args, "--fork-session")
	}
	if opts.ResumeSessionAt != "" {
		args = append(args, "--resume-session-at", opts.ResumeSessionAt)
	}
	if opts.Agent != "" {
		args = append(args, "--agent", opts.Agent)
	}
	if opts.IncludePartialMessages {
		args = append(args, "--include-partial-messages")
	}
	if opts.IncludeHookEvents {
		args = append(args, "--include-hook-events")
	}
	if opts.EnableFileCheckpointing {
		args = append(args, "--enable-file-checkpointing")
	}
	if opts.PromptSuggestions {
		args = append(args, "--prompt-suggestions")
	}
	if opts.AgentProgressSummaries {
		args = append(args, "--agent-progress-summaries")
	}
	if opts.StrictMcpConfig {
		args = append(args, "--strict-mcp-config")
	}
	if opts.PermissionPromptToolName != "" {
		args = append(args, "--permission-prompt-tool-name", opts.PermissionPromptToolName)
	}

	for _, tool := range opts.AllowedTools {
		args = append(args, "--allowedTools", tool)
	}
	for _, tool := range opts.DisallowedTools {
		args = append(args, "--disallowedTools", tool)
	}
	for _, dir := range opts.AdditionalDirectories {
		args = append(args, "--add-dir", dir)
	}
	for _, beta := range opts.Betas {
		args = append(args, "--beta", beta)
	}
	for _, source := range opts.SettingSources {
		args = append(args, "--setting-source", string(source))
	}

	if opts.Thinking != nil {
		switch opts.Thinking.Type {
		case "disabled":
			args = append(args, "--thinking", "disabled")
		case "enabled":
			args = append(args, "--thinking", fmt.Sprintf("enabled:%d", opts.Thinking.BudgetTokens))
		case "adaptive":
			args = append(args, "--thinking", "adaptive")
		}
	}
	if opts.Effort != nil {
		args = append(args, "--effort", string(*opts.Effort))
	}
	if opts.OutputFormat != nil {
		if j, err := json.Marshal(opts.OutputFormat); err == nil {
			args = append(args, "--output-format-json", string(j))
		}
	}
	if opts.MaxBudgetUsd != nil {
		args = append(args, "--max-budget-usd", fmt.Sprintf("%.2f", *opts.MaxBudgetUsd))
	}
	if opts.TaskBudget != nil {
		args = append(args, "--task-budget", fmt.Sprintf("%d", opts.TaskBudget.TotalTokens))
	}

	// System prompt handling
	if opts.SystemPrompt != nil {
		switch v := opts.SystemPrompt.(type) {
		case string:
			args = append(args, "--system-prompt", v)
		case SystemPromptPreset:
			if v.Append != "" {
				args = append(args, "--append-system-prompt", v.Append)
			}
		case SystemPromptFile:
			args = append(args, "--system-prompt-file", v.Path)
		}
	}

	// Plugins
	for _, plugin := range opts.Plugins {
		if plugin.Path != "" {
			args = append(args, "--plugin-dir", plugin.Path)
		}
	}

	// MCP server configuration
	if len(opts.McpServers) > 0 {
		mcpJSON, err := json.Marshal(opts.McpServers)
		if err == nil {
			args = append(args, "--mcp-config", string(mcpJSON))
		}
	}

	// Sandbox settings are passed via --settings
	if opts.Sandbox != nil || opts.Settings != nil {
		settingsJSON := buildSettingsValue(opts)
		if settingsJSON != "" {
			args = append(args, "--settings", settingsJSON)
		}
	}

	// Extra args
	for k, v := range opts.ExtraArgs {
		if v == "" {
			args = append(args, "--"+k)
		} else {
			args = append(args, "--"+k, v)
		}
	}

	return args
}

// buildSettingsValue merges sandbox settings into a settings JSON string.
func buildSettingsValue(opts *ClaudeAgentOptions) string {
	settings := make(map[string]any)

	// If existing settings is a string (JSON), parse it
	if s, ok := opts.Settings.(string); ok && s != "" {
		json.Unmarshal([]byte(s), &settings)
	} else if m, ok := opts.Settings.(map[string]any); ok {
		for k, v := range m {
			settings[k] = v
		}
	}

	// Merge sandbox settings
	if opts.Sandbox != nil {
		sandboxJSON, err := json.Marshal(opts.Sandbox)
		if err == nil {
			var sandboxMap map[string]any
			json.Unmarshal(sandboxJSON, &sandboxMap)
			settings["sandbox"] = sandboxMap
		}
	}

	if len(settings) == 0 {
		return ""
	}

	data, err := json.Marshal(settings)
	if err != nil {
		return ""
	}
	return string(data)
}

// Connect starts the CLI process.
func (t *SubprocessTransport) Connect(ctx context.Context) error {
	t.mu.Lock()
	defer t.mu.Unlock()

	binary, err := findClaudeBinary(t.opts.PathToClaudeCode)
	if err != nil {
		return err
	}

	args := buildArgs(t.opts)

	// Use stream-json for bidirectional communication
	args = append(args, "--input-format", "stream-json", "--output-format", "stream-json", "-p", "-")

	t.cmd = exec.CommandContext(ctx, binary, args...)

	// Set environment
	env := os.Environ()
	// Filter out CLAUDECODE to prevent nesting
	filtered := make([]string, 0, len(env))
	for _, e := range env {
		if !strings.HasPrefix(e, CLAUDE_CODE_NESTING_FILTER+"=") {
			filtered = append(filtered, e)
		}
	}
	// Set SDK environment variables
	filtered = append(filtered,
		CLAUDE_CODE_ENTRYPOINT+"="+SDKEntrypoint,
		CLAUDE_CODE_SDK_VERSION+"="+SDKVersion,
	)
	if t.opts.EnableFileCheckpointing {
		filtered = append(filtered, CLAUDE_CODE_ENABLE_FILE_CHECKPOINTING+"=true")
	}
	// Add user-specified environment variables
	if t.opts.Env != nil {
		for k, v := range t.opts.Env {
			filtered = append(filtered, fmt.Sprintf("%s=%s", k, v))
		}
	}
	t.cmd.Env = filtered

	if t.opts.CWD != "" {
		t.cmd.Dir = t.opts.CWD
	}

	var err2 error
	t.stdin, err2 = t.cmd.StdinPipe()
	if err2 != nil {
		return NewCLIConnectionError("failed to create stdin pipe", err2)
	}

	t.stdout, err2 = t.cmd.StdoutPipe()
	if err2 != nil {
		return NewCLIConnectionError("failed to create stdout pipe", err2)
	}

	t.stderr, err2 = t.cmd.StderrPipe()
	if err2 != nil {
		return NewCLIConnectionError("failed to create stderr pipe", err2)
	}

	if err := t.cmd.Start(); err != nil {
		return NewCLIConnectionError("failed to start claude process", err)
	}

	// Read stderr in background
	go func() {
		scanner := bufio.NewScanner(t.stderr)
		for scanner.Scan() {
			line := scanner.Text()
			if t.opts.Stderr != nil {
				t.opts.Stderr(line)
			}
		}
	}()

	t.ready = true
	return nil
}

// Write sends data to the CLI stdin.
func (t *SubprocessTransport) Write(ctx context.Context, data string) error {
	t.mu.Lock()
	defer t.mu.Unlock()

	if !t.ready || t.stdin == nil {
		return NewCLIConnectionError("transport not connected", nil)
	}

	if !strings.HasSuffix(data, "\n") {
		data += "\n"
	}

	_, err := io.WriteString(t.stdin, data)
	if err != nil {
		return NewCLIConnectionError("failed to write to stdin", err)
	}
	return nil
}

// ReadMessages returns channels for JSON messages and errors.
func (t *SubprocessTransport) ReadMessages(ctx context.Context) (<-chan json.RawMessage, <-chan error) {
	msgCh := make(chan json.RawMessage, 64)
	errCh := make(chan error, 8)

	go func() {
		defer close(msgCh)
		defer close(errCh)

		scanner := bufio.NewScanner(t.stdout)
		// Allow large lines (up to 10MB)
		scanner.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)

		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}

			// Validate it's JSON
			if !json.Valid([]byte(line)) {
				errCh <- NewJSONDecodeError(line, fmt.Errorf("invalid JSON"))
				continue
			}

			select {
			case <-ctx.Done():
				return
			case msgCh <- json.RawMessage(line):
			}
		}

		if err := scanner.Err(); err != nil {
			errCh <- NewCLIConnectionError("stdout read error", err)
		}

		// Wait for process to exit
		if t.cmd != nil {
			if err := t.cmd.Wait(); err != nil {
				if exitErr, ok := err.(*exec.ExitError); ok {
					errCh <- NewProcessError(exitErr.ExitCode(), "")
				}
			}
		}
	}()

	return msgCh, errCh
}

// Close terminates the CLI process.
func (t *SubprocessTransport) Close() error {
	var finalErr error
	t.closeOnce.Do(func() {
		t.mu.Lock()
		defer t.mu.Unlock()

		t.ready = false

		// Close stdin to signal end
		if t.stdin != nil {
			t.stdin.Close()
		}

		if t.cmd == nil || t.cmd.Process == nil {
			return
		}

		// Wait briefly for graceful exit
		done := make(chan error, 1)
		go func() {
			done <- t.cmd.Wait()
		}()

		select {
		case <-done:
			return
		case <-time.After(5 * time.Second):
		}

		// SIGTERM
		t.cmd.Process.Signal(os.Interrupt)

		select {
		case <-done:
			return
		case <-time.After(5 * time.Second):
		}

		// Force kill
		finalErr = t.cmd.Process.Kill()
	})
	return finalErr
}

// IsReady returns true if connected.
func (t *SubprocessTransport) IsReady() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.ready
}

// EndInput closes the stdin pipe.
func (t *SubprocessTransport) EndInput() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.stdin != nil {
		return t.stdin.Close()
	}
	return nil
}

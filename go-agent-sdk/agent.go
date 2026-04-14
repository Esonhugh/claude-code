package claudesdk

import (
	"context"
	"fmt"
	"strings"
)

// AgentConfig defines a reusable agent configuration.
type AgentConfig struct {
	// Name is a human-readable identifier for this agent.
	Name string

	// SystemPrompt overrides the default system prompt.
	SystemPrompt string

	// Model specifies which Claude model to use.
	Model string

	// PermissionMode controls tool permission behavior.
	PermissionMode PermissionMode

	// MaxTurns limits the number of conversation turns.
	MaxTurns *int

	// MaxBudgetUsd caps the cost for this agent run.
	MaxBudgetUsd *float64

	// AllowedTools restricts which tools the agent can use.
	AllowedTools []string

	// DisallowedTools prevents the agent from using specific tools.
	DisallowedTools []string

	// CanUseTool is an optional permission callback.
	CanUseTool CanUseToolFunc

	// CWD sets the working directory for the agent.
	CWD string

	// Env adds extra environment variables.
	Env map[string]string

	// Debug enables debug output.
	Debug bool

	// PathToClaudeCode overrides the claude binary path.
	PathToClaudeCode string

	// TransportFactory overrides transport creation (for testing).
	TransportFactory func(opts *ClaudeAgentOptions) Transport
}

// Agent is a configured, reusable Claude agent.
// Create one with NewAgent, then call Run() for one-shot queries
// or StartSession() for multi-turn conversations.
type Agent struct {
	config AgentConfig
}

// NewAgent creates a new Agent from the given config.
func NewAgent(config AgentConfig) *Agent {
	return &Agent{config: config}
}

// AgentResult contains the outcome of an agent execution.
type AgentResult struct {
	// Text is the concatenated text output from the assistant.
	Text string

	// Messages is the full list of messages received.
	Messages []Message

	// Result is the final ResultMessage (nil if the agent was interrupted).
	Result *ResultMessage

	// CostUSD is the total cost of the query.
	CostUSD float64

	// DurationMs is the total duration in milliseconds.
	DurationMs float64
}

// buildOptions converts AgentConfig to ClaudeAgentOptions.
func (a *Agent) buildOptions() *ClaudeAgentOptions {
	opts := &ClaudeAgentOptions{
		Model:             a.config.Model,
		PermissionMode:    a.config.PermissionMode,
		MaxTurns:          a.config.MaxTurns,
		MaxBudgetUsd:      a.config.MaxBudgetUsd,
		AllowedTools:      a.config.AllowedTools,
		DisallowedTools:   a.config.DisallowedTools,
		CanUseTool:        a.config.CanUseTool,
		CWD:               a.config.CWD,
		Env:               a.config.Env,
		Debug:             a.config.Debug,
		PathToClaudeCode:  a.config.PathToClaudeCode,
	}
	if a.config.SystemPrompt != "" {
		opts.SystemPrompt = a.config.SystemPrompt
	}
	return opts
}

// Run executes a one-shot query and collects the full result.
func (a *Agent) Run(ctx context.Context, prompt string) (*AgentResult, error) {
	opts := a.buildOptions()

	var transport Transport
	if a.config.TransportFactory != nil {
		transport = a.config.TransportFactory(opts)
	} else {
		transport = NewSubprocessTransport(opts)
	}
	defer transport.Close()

	if err := transport.Connect(ctx); err != nil {
		return nil, fmt.Errorf("agent %q connect: %w", a.config.Name, err)
	}

	handler := newQueryHandler(transport, opts)
	routedMsgs := handler.runMessageRouter(ctx)

	if _, err := handler.initialize(ctx); err != nil {
		return nil, fmt.Errorf("agent %q initialize: %w", a.config.Name, err)
	}

	if err := handler.sendPrompt(ctx, prompt); err != nil {
		return nil, fmt.Errorf("agent %q send prompt: %w", a.config.Name, err)
	}

	result := &AgentResult{}
	var textParts []string

	for msg := range routedMsgs {
		result.Messages = append(result.Messages, msg)

		switch m := msg.(type) {
		case AssistantMessage:
			text := GetTextContent(m)
			if text != "" {
				textParts = append(textParts, text)
			}
		case ResultMessage:
			result.Result = &m
			result.CostUSD = m.CostUSD
			result.DurationMs = m.Duration
			result.Text = strings.Join(textParts, "\n")
			return result, nil
		}
	}

	result.Text = strings.Join(textParts, "\n")
	return result, nil
}

// StartSession creates a multi-turn session with this agent's configuration.
// Returns a ClaudeSDKClient that's already connected and initialized.
func (a *Agent) StartSession(ctx context.Context) (*ClaudeSDKClient, error) {
	opts := a.buildOptions()
	client := NewClient(opts)
	if a.config.TransportFactory != nil {
		// Use custom transport for testing
		t := a.config.TransportFactory(opts)
		client.transport = t
		if err := t.Connect(ctx); err != nil {
			return nil, err
		}
		client.handler = newQueryHandler(t, opts)
		client.msgCh = client.handler.runMessageRouter(ctx)
		if _, err := client.handler.initialize(ctx); err != nil {
			t.Close()
			return nil, err
		}
		client.connected = true
	} else {
		if err := client.Connect(ctx); err != nil {
			return nil, fmt.Errorf("agent %q session: %w", a.config.Name, err)
		}
	}
	return client, nil
}

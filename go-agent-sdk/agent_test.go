package claudesdk

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// --- Agent Tests ---

func TestAgent_Run_Basic(t *testing.T) {
	mt := NewMockTransport(QuickMockMessages("Hello from agent!", 0.002)...)

	agent := NewAgent(AgentConfig{
		Name:             "test-agent",
		TransportFactory: MockTransportFactory(mt),
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result, err := agent.Run(ctx, "Say hello")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if result.Text != "Hello from agent!" {
		t.Errorf("expected text 'Hello from agent!', got %q", result.Text)
	}
	if result.CostUSD != 0.002 {
		t.Errorf("expected cost 0.002, got %f", result.CostUSD)
	}
	if result.Result == nil {
		t.Fatal("expected non-nil Result")
	}
}

func TestAgent_Run_MultipleTextBlocks(t *testing.T) {
	msg1 := map[string]any{
		"type": "assistant",
		"message": map[string]any{
			"role":    "assistant",
			"content": []any{map[string]any{"type": "text", "text": "First part."}},
		},
	}
	msg2 := map[string]any{
		"type": "assistant",
		"message": map[string]any{
			"role":    "assistant",
			"content": []any{map[string]any{"type": "text", "text": "Second part."}},
		},
	}
	result := map[string]any{
		"type":     "result",
		"subtype":  "success",
		"cost_usd": 0.003,
	}

	b1, _ := json.Marshal(msg1)
	b2, _ := json.Marshal(msg2)
	b3, _ := json.Marshal(result)

	mt := NewMockTransport(b1, b2, b3)
	agent := NewAgent(AgentConfig{
		Name:             "multi-text",
		TransportFactory: MockTransportFactory(mt),
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	res, err := agent.Run(ctx, "test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if res.Text != "First part.\nSecond part." {
		t.Errorf("expected joined text, got %q", res.Text)
	}
	if len(res.Messages) != 3 {
		t.Errorf("expected 3 messages, got %d", len(res.Messages))
	}
}

func TestAgent_Run_WithSystemMessages(t *testing.T) {
	sys := map[string]any{
		"type":    "system",
		"subtype": "task_started",
		"task_id": "t1",
	}
	assistant := map[string]any{
		"type": "assistant",
		"message": map[string]any{
			"role":    "assistant",
			"content": []any{map[string]any{"type": "text", "text": "Working..."}},
		},
	}
	result := map[string]any{
		"type":     "result",
		"subtype":  "success",
		"cost_usd": 0.001,
	}

	b1, _ := json.Marshal(sys)
	b2, _ := json.Marshal(assistant)
	b3, _ := json.Marshal(result)

	mt := NewMockTransport(b1, b2, b3)
	agent := NewAgent(AgentConfig{
		Name:             "sys-msg-agent",
		TransportFactory: MockTransportFactory(mt),
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	res, err := agent.Run(ctx, "do work")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if res.Text != "Working..." {
		t.Errorf("expected 'Working...', got %q", res.Text)
	}

	// Should have system + assistant + result
	if len(res.Messages) != 3 {
		t.Errorf("expected 3 messages, got %d", len(res.Messages))
	}

	// First message should be TaskStartedMessage (system subtype task_started)
	if _, ok := res.Messages[0].(TaskStartedMessage); !ok {
		t.Errorf("expected TaskStartedMessage first, got %T", res.Messages[0])
	}
}

func TestAgent_BuildOptions(t *testing.T) {
	turns := 10
	budget := 1.5
	agent := NewAgent(AgentConfig{
		Name:            "cfg-test",
		SystemPrompt:    "You are helpful",
		Model:           "claude-opus-4-6",
		PermissionMode:  PermissionModeBypassPermissions,
		MaxTurns:        &turns,
		MaxBudgetUsd:    &budget,
		AllowedTools:    []string{"Read", "Write"},
		DisallowedTools: []string{"Bash"},
		CWD:             "/tmp",
		Debug:           true,
	})

	opts := agent.buildOptions()

	if opts.Model != "claude-opus-4-6" {
		t.Errorf("expected model claude-opus-4-6, got %s", opts.Model)
	}
	if opts.PermissionMode != PermissionModeBypassPermissions {
		t.Errorf("expected bypassPermissions, got %s", opts.PermissionMode)
	}
	if *opts.MaxTurns != 10 {
		t.Errorf("expected 10 turns, got %d", *opts.MaxTurns)
	}
	if *opts.MaxBudgetUsd != 1.5 {
		t.Errorf("expected budget 1.5, got %f", *opts.MaxBudgetUsd)
	}
	if len(opts.AllowedTools) != 2 {
		t.Errorf("expected 2 allowed tools, got %d", len(opts.AllowedTools))
	}
	if len(opts.DisallowedTools) != 1 {
		t.Errorf("expected 1 disallowed tool, got %d", len(opts.DisallowedTools))
	}
	if opts.CWD != "/tmp" {
		t.Errorf("expected CWD /tmp, got %s", opts.CWD)
	}
	if !opts.Debug {
		t.Error("expected Debug true")
	}
	sp, ok := opts.SystemPrompt.(string)
	if !ok || sp != "You are helpful" {
		t.Errorf("expected system prompt string, got %v", opts.SystemPrompt)
	}
}

func TestAgent_Run_ContextCancel(t *testing.T) {
	// Create a transport that delivers messages slowly (never sends result)
	assistant := map[string]any{
		"type": "assistant",
		"message": map[string]any{
			"role":    "assistant",
			"content": []any{map[string]any{"type": "text", "text": "thinking..."}},
		},
	}
	b, _ := json.Marshal(assistant)
	// No result message — agent should be cancelled by context
	mt := NewMockTransport(b)

	agent := NewAgent(AgentConfig{
		Name:             "cancel-test",
		TransportFactory: MockTransportFactory(mt),
	})

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	result, _ := agent.Run(ctx, "wait forever")
	// Should return partial result without error panic
	if result != nil && result.Text != "" && result.Text != "thinking..." {
		t.Errorf("unexpected text: %q", result.Text)
	}
}

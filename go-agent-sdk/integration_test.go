package claudesdk

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// --- Integration Tests using MockTransport ---

func TestIntegration_FullConversationFlow(t *testing.T) {
	// Simulate: assistant responds with thinking + text + tool_use + tool_result + text
	msg1 := map[string]any{
		"type": "assistant",
		"message": map[string]any{
			"role": "assistant",
			"content": []any{
				map[string]any{"type": "thinking", "thinking": "Let me check the files..."},
				map[string]any{"type": "text", "text": "I'll read the file for you."},
				map[string]any{"type": "tool_use", "id": "tu-1", "name": "Read", "input": map[string]any{"path": "/tmp/test.go"}},
			},
		},
	}
	msg2 := map[string]any{
		"type": "assistant",
		"message": map[string]any{
			"role": "assistant",
			"content": []any{
				map[string]any{"type": "tool_result", "tool_use_id": "tu-1", "content": "package main"},
				map[string]any{"type": "text", "text": "The file contains a Go package."},
			},
		},
	}
	result := map[string]any{
		"type":        "result",
		"subtype":     "success",
		"cost_usd":    0.005,
		"duration_ms": 2000.0,
		"reason":      "end_turn",
		"session_id":  "sess-123",
		"usage": map[string]any{
			"inputTokens":              100,
			"outputTokens":             50,
			"cacheReadInputTokens":     0,
			"cacheCreationInputTokens": 0,
			"costUSD":                  0.005,
		},
	}

	b1, _ := json.Marshal(msg1)
	b2, _ := json.Marshal(msg2)
	b3, _ := json.Marshal(result)

	mt := NewMockTransport(b1, b2, b3)
	agent := NewAgent(AgentConfig{
		Name:             "integration-agent",
		TransportFactory: MockTransportFactory(mt),
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	res, err := agent.Run(ctx, "Read /tmp/test.go and tell me what's in it")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Should have 3 messages
	if len(res.Messages) != 3 {
		t.Errorf("expected 3 messages, got %d", len(res.Messages))
	}

	// Text should combine both text blocks
	if !strings.Contains(res.Text, "I'll read the file for you.") {
		t.Errorf("missing first text block in output: %q", res.Text)
	}
	if !strings.Contains(res.Text, "The file contains a Go package.") {
		t.Errorf("missing second text block in output: %q", res.Text)
	}

	// Verify content blocks of first assistant message
	am := res.Messages[0].(AssistantMessage)
	blocks := am.GetContentBlocks()
	if len(blocks) != 3 {
		t.Errorf("expected 3 content blocks in first message, got %d", len(blocks))
	}
	if _, ok := blocks[0].(ThinkingBlock); !ok {
		t.Errorf("expected ThinkingBlock, got %T", blocks[0])
	}
	if _, ok := blocks[1].(TextBlock); !ok {
		t.Errorf("expected TextBlock, got %T", blocks[1])
	}
	if tu, ok := blocks[2].(ToolUseBlock); !ok || tu.Name != "Read" {
		t.Errorf("expected ToolUseBlock with name Read, got %T", blocks[2])
	}

	// Verify result
	if res.CostUSD != 0.005 {
		t.Errorf("expected cost 0.005, got %f", res.CostUSD)
	}
	if res.Result.SessionID != "sess-123" {
		t.Errorf("expected session_id sess-123, got %s", res.Result.SessionID)
	}
}

func TestIntegration_RateLimitThenSuccess(t *testing.T) {
	rateLimit := map[string]any{
		"type": "rate_limit_event",
		"retry_info": map[string]any{
			"retry_after_ms": 2000,
			"message":        "Rate limited, please retry",
		},
	}
	assistant := map[string]any{
		"type": "assistant",
		"message": map[string]any{
			"role":    "assistant",
			"content": []any{map[string]any{"type": "text", "text": "Done after rate limit"}},
		},
	}
	result := map[string]any{
		"type":     "result",
		"subtype":  "success",
		"cost_usd": 0.001,
	}

	b1, _ := json.Marshal(rateLimit)
	b2, _ := json.Marshal(assistant)
	b3, _ := json.Marshal(result)

	mt := NewMockTransport(b1, b2, b3)
	agent := NewAgent(AgentConfig{
		Name:             "rate-limit-agent",
		TransportFactory: MockTransportFactory(mt),
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	res, err := agent.Run(ctx, "test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Should receive all 3 messages including rate limit
	if len(res.Messages) != 3 {
		t.Errorf("expected 3 messages, got %d", len(res.Messages))
	}

	// First message should be rate limit event
	if _, ok := res.Messages[0].(RateLimitEvent); !ok {
		t.Errorf("expected RateLimitEvent, got %T", res.Messages[0])
	}

	if res.Text != "Done after rate limit" {
		t.Errorf("expected text after rate limit, got %q", res.Text)
	}
}

func TestIntegration_ErrorResult(t *testing.T) {
	result := map[string]any{
		"type":        "result",
		"subtype":     "error_api",
		"is_error":    true,
		"reason":      "error_api",
		"cost_usd":    0.0,
		"duration_ms": 100.0,
	}

	b, _ := json.Marshal(result)
	mt := NewMockTransport(b)
	agent := NewAgent(AgentConfig{
		Name:             "error-agent",
		TransportFactory: MockTransportFactory(mt),
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	res, err := agent.Run(ctx, "fail")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if res.Result == nil {
		t.Fatal("expected result")
	}
	if !res.Result.IsError {
		t.Error("expected is_error to be true")
	}
	if res.Result.Reason != TerminalReasonAPIError {
		t.Errorf("expected error_api reason, got %s", res.Result.Reason)
	}
}

// --- MockTransport Tests ---

func TestMockTransport_QuickMockMessages(t *testing.T) {
	msgs := QuickMockMessages("Hello!", 0.001)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}

	// First should be assistant
	var m1 map[string]any
	json.Unmarshal(msgs[0], &m1)
	if m1["type"] != "assistant" {
		t.Errorf("expected assistant, got %v", m1["type"])
	}

	// Second should be result
	var m2 map[string]any
	json.Unmarshal(msgs[1], &m2)
	if m2["type"] != "result" {
		t.Errorf("expected result, got %v", m2["type"])
	}
}

func TestMockTransport_Written(t *testing.T) {
	mt := NewMockTransport(QuickMockMessages("test", 0.001)...)
	mt.Connect(context.Background())
	mt.Write(context.Background(), "hello")
	mt.Write(context.Background(), "world")

	written := mt.Written()
	if len(written) != 2 {
		t.Fatalf("expected 2 writes, got %d", len(written))
	}
	if written[0] != "hello" || written[1] != "world" {
		t.Errorf("unexpected written data: %v", written)
	}
}

// --- Combined Pipeline + Parallel Test ---

func TestIntegration_PipelineWithParallelFanOut(t *testing.T) {
	// Simulate: generate → fan out to 2 reviewers → synthesize

	// Generator
	genMT := NewMockTransport(QuickMockMessages("func Add(a, b int) int { return a + b }", 0.001)...)
	generator := NewAgent(AgentConfig{
		Name:             "generator",
		TransportFactory: MockTransportFactory(genMT),
	})

	// Reviewers
	rev1MT := NewMockTransport(QuickMockMessages("Looks good, but add error handling", 0.001)...)
	reviewer1 := NewAgent(AgentConfig{
		Name:             "reviewer-1",
		TransportFactory: MockTransportFactory(rev1MT),
	})

	rev2MT := NewMockTransport(QuickMockMessages("Consider using generics for flexibility", 0.001)...)
	reviewer2 := NewAgent(AgentConfig{
		Name:             "reviewer-2",
		TransportFactory: MockTransportFactory(rev2MT),
	})

	// Synthesizer
	synthMT := NewMockTransport(QuickMockMessages("Final improved version with generics and error handling", 0.002)...)
	synthesizer := NewAgent(AgentConfig{
		Name:             "synthesizer",
		TransportFactory: MockTransportFactory(synthMT),
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Step 1: Generate
	genResult, err := generator.Run(ctx, "Write an add function")
	if err != nil {
		t.Fatalf("generator error: %v", err)
	}

	// Step 2: Fan out reviews
	reviews := FanOut(ctx, "Review: "+genResult.Text, reviewer1, reviewer2)
	feedback := ""
	for _, r := range reviews {
		if r.Error != nil {
			t.Fatalf("reviewer error: %v", r.Error)
		}
		feedback += r.Result.Text + "\n"
	}

	// Step 3: Synthesize
	synthResult, err := synthesizer.Run(ctx, "Improve based on: "+feedback)
	if err != nil {
		t.Fatalf("synthesizer error: %v", err)
	}

	if synthResult.Text != "Final improved version with generics and error handling" {
		t.Errorf("unexpected synthesis: %q", synthResult.Text)
	}

	// Total cost
	totalCost := genResult.CostUSD + synthResult.CostUSD
	for _, r := range reviews {
		totalCost += r.Result.CostUSD
	}
	if totalCost != 0.005 {
		t.Errorf("expected total cost 0.005, got %f", totalCost)
	}
}

// --- Compute-Focused Tests ---

func TestIntegration_CalculatorChain(t *testing.T) {
	// Calculator gives an answer, verifier confirms
	calcMT := NewMockTransport(QuickMockMessages("The sum of 1+2+3+4+5 = 15\nANSWER: 15", 0.001)...)
	calculator := NewAgent(AgentConfig{
		Name:             "calculator",
		TransportFactory: MockTransportFactory(calcMT),
	})

	verifyMT := NewMockTransport(QuickMockMessages("VERIFIED: correct. 1+2+3+4+5 = 15", 0.001)...)
	verifier := NewAgent(AgentConfig{
		Name:             "verifier",
		TransportFactory: MockTransportFactory(verifyMT),
	})

	pipeline := NewPipeline(
		PipelineStep{Name: "calculate", Agent: calculator},
		PipelineStep{
			Name:  "verify",
			Agent: verifier,
			Transform: func(calcOutput string) string {
				return "Verify this calculation:\n" + calcOutput
			},
		},
	)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result, err := pipeline.Run(ctx, "What is 1+2+3+4+5?")
	if err != nil {
		t.Fatalf("pipeline error: %v", err)
	}

	if !strings.Contains(result.FinalOutput, "VERIFIED: correct") {
		t.Errorf("expected verification, got %q", result.FinalOutput)
	}

	// Both steps should have run
	if len(result.StepResults) != 2 {
		t.Errorf("expected 2 steps, got %d", len(result.StepResults))
	}

	// Verify the transform was applied
	if !strings.HasPrefix(result.StepResults[1].Input, "Verify this calculation:") {
		t.Errorf("expected transformed input, got %q", result.StepResults[1].Input)
	}
}

func TestIntegration_MultiStepComputation(t *testing.T) {
	// Simulate a multi-step computation pipeline:
	// 1. Parse problem → 2. Solve → 3. Format answer

	parseMT := NewMockTransport(QuickMockMessages("Parsed: solve x^2 = 16, find positive root", 0.001)...)
	parser := NewAgent(AgentConfig{
		Name:             "parser",
		TransportFactory: MockTransportFactory(parseMT),
	})

	solveMT := NewMockTransport(QuickMockMessages("x = 4 (positive root of 16)", 0.001)...)
	solver := NewAgent(AgentConfig{
		Name:             "solver",
		TransportFactory: MockTransportFactory(solveMT),
	})

	formatMT := NewMockTransport(QuickMockMessages("The positive root of x² = 16 is **x = 4**.", 0.001)...)
	formatter := NewAgent(AgentConfig{
		Name:             "formatter",
		TransportFactory: MockTransportFactory(formatMT),
	})

	pipeline := NewPipeline(
		PipelineStep{Name: "parse", Agent: parser},
		PipelineStep{Name: "solve", Agent: solver, Transform: func(s string) string {
			return "Solve: " + s
		}},
		PipelineStep{Name: "format", Agent: formatter, Transform: func(s string) string {
			return "Format this answer nicely: " + s
		}},
	)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result, err := pipeline.Run(ctx, "What is the positive root of x squared equals 16?")
	if err != nil {
		t.Fatalf("pipeline error: %v", err)
	}

	if !strings.Contains(result.FinalOutput, "x = 4") {
		t.Errorf("expected x = 4 in output, got %q", result.FinalOutput)
	}

	if result.TotalCostUSD != 0.003 {
		t.Errorf("expected total cost 0.003, got %f", result.TotalCostUSD)
	}
}

func TestIntegration_PermissionCallbackInAgent(t *testing.T) {
	mt := NewMockTransport(QuickMockMessages("Safe output", 0.001)...)

	toolCalls := make(map[string]int)

	agent := NewAgent(AgentConfig{
		Name:             "permission-agent",
		TransportFactory: MockTransportFactory(mt),
		CanUseTool: func(toolName string, input map[string]any, ctx ToolPermissionContext) (PermissionResult, error) {
			toolCalls[toolName]++
			if toolName == "Bash" {
				return PermissionResult{
					Deny: &PermissionResultDeny{
						Behavior: "deny",
						Message:  "Bash is not allowed",
					},
				}, nil
			}
			return PermissionResult{
				Allow: &PermissionResultAllow{Behavior: "allow"},
			}, nil
		},
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	res, err := agent.Run(ctx, "do something")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if res.Text != "Safe output" {
		t.Errorf("unexpected text: %q", res.Text)
	}

	// Permission callback is set on the agent; actual invocation would
	// happen when the CLI sends a can_use_tool control request.
	// Here we just verify the agent was configured correctly.
	opts := agent.buildOptions()
	if opts.CanUseTool == nil {
		t.Error("expected CanUseTool to be set")
	}
}

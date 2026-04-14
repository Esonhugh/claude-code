package claudesdk

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestPipeline_TwoSteps(t *testing.T) {
	// Step 1 agent: echoes back with "Step1: " prefix
	step1MT := NewMockTransport(QuickMockMessages("Step1 output", 0.001)...)
	step1Agent := NewAgent(AgentConfig{
		Name:             "step1",
		TransportFactory: MockTransportFactory(step1MT),
	})

	// Step 2 agent: echoes back with "Step2: " prefix
	step2MT := NewMockTransport(QuickMockMessages("Final output", 0.002)...)
	step2Agent := NewAgent(AgentConfig{
		Name:             "step2",
		TransportFactory: MockTransportFactory(step2MT),
	})

	pipeline := NewPipeline(
		PipelineStep{Name: "First", Agent: step1Agent},
		PipelineStep{
			Name:  "Second",
			Agent: step2Agent,
			Transform: func(prev string) string {
				return "Transform: " + prev
			},
		},
	)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result, err := pipeline.Run(ctx, "initial input")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(result.StepResults) != 2 {
		t.Fatalf("expected 2 step results, got %d", len(result.StepResults))
	}

	if result.StepResults[0].StepName != "First" {
		t.Errorf("expected step name 'First', got %q", result.StepResults[0].StepName)
	}
	if result.StepResults[0].Output != "Step1 output" {
		t.Errorf("expected step1 output, got %q", result.StepResults[0].Output)
	}
	if result.StepResults[0].Input != "initial input" {
		t.Errorf("expected initial input, got %q", result.StepResults[0].Input)
	}

	if result.StepResults[1].StepName != "Second" {
		t.Errorf("expected step name 'Second', got %q", result.StepResults[1].StepName)
	}
	if result.StepResults[1].Input != "Transform: Step1 output" {
		t.Errorf("expected transformed input, got %q", result.StepResults[1].Input)
	}

	if result.FinalOutput != "Final output" {
		t.Errorf("expected final output, got %q", result.FinalOutput)
	}

	expectedCost := 0.003
	if result.TotalCostUSD != expectedCost {
		t.Errorf("expected total cost %.3f, got %f", expectedCost, result.TotalCostUSD)
	}
}

func TestPipeline_ThreeSteps(t *testing.T) {
	mocks := []struct {
		text string
		cost float64
	}{
		{"alpha", 0.001},
		{"beta", 0.002},
		{"gamma", 0.003},
	}

	var steps []PipelineStep
	for i, m := range mocks {
		mt := NewMockTransport(QuickMockMessages(m.text, m.cost)...)
		steps = append(steps, PipelineStep{
			Name:  m.text,
			Agent: NewAgent(AgentConfig{
				Name:             m.text,
				TransportFactory: MockTransportFactory(mt),
			}),
		})
		_ = i
	}

	pipeline := NewPipeline(steps...)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result, err := pipeline.Run(ctx, "start")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(result.StepResults) != 3 {
		t.Fatalf("expected 3 steps, got %d", len(result.StepResults))
	}

	if result.FinalOutput != "gamma" {
		t.Errorf("expected final output 'gamma', got %q", result.FinalOutput)
	}

	expectedTotal := 0.006
	if result.TotalCostUSD != expectedTotal {
		t.Errorf("expected total %.3f, got %f", expectedTotal, result.TotalCostUSD)
	}
}

func TestPipeline_DefaultStepNames(t *testing.T) {
	mt := NewMockTransport(QuickMockMessages("output", 0.001)...)
	agent := NewAgent(AgentConfig{
		Name:             "a",
		TransportFactory: MockTransportFactory(mt),
	})

	pipeline := NewPipeline(
		PipelineStep{Agent: agent}, // No name
	)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result, err := pipeline.Run(ctx, "in")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if result.StepResults[0].StepName != "step-1" {
		t.Errorf("expected default name 'step-1', got %q", result.StepResults[0].StepName)
	}
}

func TestPipeline_ContextCancel(t *testing.T) {
	// Create a transport that never sends result (hangs)
	hangMsg := map[string]any{
		"type": "assistant",
		"message": map[string]any{
			"role":    "assistant",
			"content": []any{map[string]any{"type": "text", "text": "..."}},
		},
	}
	b, _ := json.Marshal(hangMsg)
	mt := NewMockTransport(b) // no result message

	agent := NewAgent(AgentConfig{
		Name:             "hang",
		TransportFactory: MockTransportFactory(mt),
	})

	pipeline := NewPipeline(
		PipelineStep{Name: "hang-step", Agent: agent},
	)

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	// Should not hang forever
	result, _ := pipeline.Run(ctx, "input")
	// Should have at least partial result
	if result == nil {
		t.Fatal("expected non-nil result even on cancel")
	}
}

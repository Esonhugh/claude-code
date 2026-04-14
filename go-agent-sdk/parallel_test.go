package claudesdk

import (
	"context"
	"testing"
	"time"
)

func TestRunParallel_Basic(t *testing.T) {
	agents := make([]*Agent, 3)
	for i := range agents {
		mt := NewMockTransport(QuickMockMessages(
			[]string{"result-A", "result-B", "result-C"}[i],
			float64(i+1)*0.001,
		)...)
		agents[i] = NewAgent(AgentConfig{
			Name:             []string{"A", "B", "C"}[i],
			TransportFactory: MockTransportFactory(mt),
		})
	}

	tasks := []ParallelTask{
		{Name: "Task-A", Agent: agents[0], Prompt: "prompt A"},
		{Name: "Task-B", Agent: agents[1], Prompt: "prompt B"},
		{Name: "Task-C", Agent: agents[2], Prompt: "prompt C"},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	results := RunParallel(ctx, tasks)

	if len(results) != 3 {
		t.Fatalf("expected 3 results, got %d", len(results))
	}

	for i, r := range results {
		if r.Error != nil {
			t.Errorf("task %d error: %v", i, r.Error)
			continue
		}
		expected := []string{"result-A", "result-B", "result-C"}[i]
		if r.Result.Text != expected {
			t.Errorf("task %d: expected %q, got %q", i, expected, r.Result.Text)
		}
		if r.TaskName != tasks[i].Name {
			t.Errorf("task %d: expected name %q, got %q", i, tasks[i].Name, r.TaskName)
		}
	}
}

func TestRunParallel_PreservesOrder(t *testing.T) {
	// Even if tasks complete in different order, results should match input order
	tasks := make([]ParallelTask, 5)
	for i := range tasks {
		mt := NewMockTransport(QuickMockMessages(
			string(rune('A'+i)),
			0.001,
		)...)
		tasks[i] = ParallelTask{
			Name:   string(rune('A' + i)),
			Agent:  NewAgent(AgentConfig{
				Name:             string(rune('A' + i)),
				TransportFactory: MockTransportFactory(mt),
			}),
			Prompt: "test",
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	results := RunParallel(ctx, tasks)

	for i, r := range results {
		expectedName := string(rune('A' + i))
		if r.TaskName != expectedName {
			t.Errorf("result %d: expected task %q, got %q", i, expectedName, r.TaskName)
		}
	}
}

func TestFanOut(t *testing.T) {
	agents := make([]*Agent, 3)
	for i := range agents {
		mt := NewMockTransport(QuickMockMessages(
			[]string{"perspective-1", "perspective-2", "perspective-3"}[i],
			0.001,
		)...)
		agents[i] = NewAgent(AgentConfig{
			Name:             []string{"agent-1", "agent-2", "agent-3"}[i],
			TransportFactory: MockTransportFactory(mt),
		})
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	results := FanOut(ctx, "shared prompt", agents...)

	if len(results) != 3 {
		t.Fatalf("expected 3 results, got %d", len(results))
	}

	for i, r := range results {
		if r.Error != nil {
			t.Errorf("agent %d error: %v", i, r.Error)
		}
		if r.Result == nil {
			t.Errorf("agent %d: nil result", i)
			continue
		}
		expected := []string{"perspective-1", "perspective-2", "perspective-3"}[i]
		if r.Result.Text != expected {
			t.Errorf("agent %d: expected %q, got %q", i, expected, r.Result.Text)
		}
	}
}

func TestRunParallelCollect(t *testing.T) {
	mt1 := NewMockTransport(QuickMockMessages("r1", 0.001)...)
	mt2 := NewMockTransport(QuickMockMessages("r2", 0.002)...)

	tasks := []ParallelTask{
		{Name: "T1", Agent: NewAgent(AgentConfig{Name: "a1", TransportFactory: MockTransportFactory(mt1)}), Prompt: "p1"},
		{Name: "T2", Agent: NewAgent(AgentConfig{Name: "a2", TransportFactory: MockTransportFactory(mt2)}), Prompt: "p2"},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var collected []ParallelResult
	RunParallelCollect(ctx, tasks, func(pr ParallelResult) {
		collected = append(collected, pr)
	})

	if len(collected) != 2 {
		t.Fatalf("expected 2 collected results, got %d", len(collected))
	}

	// Verify both tasks completed (order may vary)
	names := map[string]bool{}
	for _, r := range collected {
		names[r.TaskName] = true
		if r.Error != nil {
			t.Errorf("task %s error: %v", r.TaskName, r.Error)
		}
	}
	if !names["T1"] || !names["T2"] {
		t.Error("expected both T1 and T2 in results")
	}
}

func TestRace(t *testing.T) {
	// Create two agents, both return results
	mt1 := NewMockTransport(QuickMockMessages("fast", 0.001)...)
	mt2 := NewMockTransport(QuickMockMessages("also fast", 0.001)...)

	a1 := NewAgent(AgentConfig{Name: "racer-1", TransportFactory: MockTransportFactory(mt1)})
	a2 := NewAgent(AgentConfig{Name: "racer-2", TransportFactory: MockTransportFactory(mt2)})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	result, err := Race(ctx, "who wins?", a1, a2)
	if err != nil {
		t.Fatalf("race error: %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	// One of the two should win
	if result.Result == nil {
		t.Fatal("expected non-nil agent result")
	}
	if result.Result.Text != "fast" && result.Result.Text != "also fast" {
		t.Errorf("unexpected result text: %q", result.Result.Text)
	}
}

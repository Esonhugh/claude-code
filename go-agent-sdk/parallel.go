package claudesdk

import (
	"context"
	"sync"
)

// ParallelTask defines a task to run concurrently.
type ParallelTask struct {
	// Name identifies this task in results.
	Name string

	// Agent is the agent that executes this task.
	Agent *Agent

	// Prompt is the input to the agent.
	Prompt string
}

// ParallelResult holds the result from a single parallel task.
type ParallelResult struct {
	TaskName string
	Result   *AgentResult
	Error    error
}

// RunParallel executes multiple agent tasks concurrently and waits for all to complete.
// Results are returned in the same order as the input tasks.
func RunParallel(ctx context.Context, tasks []ParallelTask) []ParallelResult {
	results := make([]ParallelResult, len(tasks))
	var wg sync.WaitGroup

	for i, task := range tasks {
		wg.Add(1)
		go func(idx int, t ParallelTask) {
			defer wg.Done()

			results[idx] = ParallelResult{TaskName: t.Name}

			agentResult, err := t.Agent.Run(ctx, t.Prompt)
			results[idx].Result = agentResult
			results[idx].Error = err
		}(i, task)
	}

	wg.Wait()
	return results
}

// RunParallelCollect executes tasks concurrently and collects results via a callback.
// The callback is invoked sequentially as each task completes (order is non-deterministic).
// It is safe to access shared state in the callback without synchronization.
func RunParallelCollect(ctx context.Context, tasks []ParallelTask, onResult func(ParallelResult)) {
	ch := make(chan ParallelResult, len(tasks))
	var wg sync.WaitGroup

	for _, task := range tasks {
		wg.Add(1)
		go func(t ParallelTask) {
			defer wg.Done()

			pr := ParallelResult{TaskName: t.Name}
			agentResult, err := t.Agent.Run(ctx, t.Prompt)
			pr.Result = agentResult
			pr.Error = err
			ch <- pr
		}(task)
	}

	// Close channel when all tasks are done
	go func() {
		wg.Wait()
		close(ch)
	}()

	// Invoke callback sequentially
	for pr := range ch {
		if onResult != nil {
			onResult(pr)
		}
	}
}

// FanOut sends the same prompt to multiple agents and collects all results.
// Useful for getting diverse perspectives or comparing model outputs.
func FanOut(ctx context.Context, prompt string, agents ...*Agent) []ParallelResult {
	tasks := make([]ParallelTask, len(agents))
	for i, agent := range agents {
		tasks[i] = ParallelTask{
			Name:   agent.config.Name,
			Agent:  agent,
			Prompt: prompt,
		}
	}
	return RunParallel(ctx, tasks)
}

// Race sends the same prompt to multiple agents and returns the first result.
// Remaining agents are cancelled via context cancellation.
func Race(ctx context.Context, prompt string, agents ...*Agent) (*ParallelResult, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	resultCh := make(chan ParallelResult, len(agents))

	for _, agent := range agents {
		go func(a *Agent) {
			pr := ParallelResult{TaskName: a.config.Name}
			agentResult, err := a.Run(ctx, prompt)
			pr.Result = agentResult
			pr.Error = err
			select {
			case resultCh <- pr:
			case <-ctx.Done():
			}
		}(agent)
	}

	select {
	case result := <-resultCh:
		return &result, result.Error
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

package claudesdk

import (
	"context"
	"fmt"
)

// PipelineStep is a single step in a pipeline.
type PipelineStep struct {
	// Name identifies this step in results.
	Name string

	// Agent is the agent that executes this step.
	Agent *Agent

	// Transform optionally transforms the previous step's output
	// before passing it as the prompt to this step.
	// If nil, the previous output is used verbatim.
	Transform func(prevOutput string) string
}

// StepResult holds the result from a single pipeline step.
type StepResult struct {
	StepName   string
	Input      string
	Output     string
	CostUSD    float64
	DurationMs float64
	Error      error
}

// PipelineResult holds the results from a full pipeline execution.
type PipelineResult struct {
	StepResults  []StepResult
	FinalOutput  string
	TotalCostUSD float64
	TotalDurationMs float64
}

// Pipeline chains multiple agents sequentially, passing each output as input to the next.
type Pipeline struct {
	Steps []PipelineStep
}

// NewPipeline creates a new pipeline from the given steps.
func NewPipeline(steps ...PipelineStep) *Pipeline {
	return &Pipeline{Steps: steps}
}

// Run executes all steps sequentially.
// The initial input is passed to the first step; each subsequent step receives
// the previous step's output (optionally transformed).
func (p *Pipeline) Run(ctx context.Context, input string) (*PipelineResult, error) {
	result := &PipelineResult{}
	currentInput := input

	for i, step := range p.Steps {
		select {
		case <-ctx.Done():
			return result, ctx.Err()
		default:
		}

		// Apply transform if provided
		prompt := currentInput
		if step.Transform != nil {
			prompt = step.Transform(currentInput)
		}

		name := step.Name
		if name == "" {
			name = fmt.Sprintf("step-%d", i+1)
		}

		agentResult, err := step.Agent.Run(ctx, prompt)

		sr := StepResult{
			StepName: name,
			Input:    prompt,
		}

		if err != nil {
			sr.Error = err
			result.StepResults = append(result.StepResults, sr)
			return result, fmt.Errorf("pipeline step %q failed: %w", name, err)
		}

		sr.Output = agentResult.Text
		sr.CostUSD = agentResult.CostUSD
		sr.DurationMs = agentResult.DurationMs
		result.StepResults = append(result.StepResults, sr)

		result.TotalCostUSD += agentResult.CostUSD
		result.TotalDurationMs += agentResult.DurationMs

		currentInput = agentResult.Text
	}

	result.FinalOutput = currentInput
	return result, nil
}

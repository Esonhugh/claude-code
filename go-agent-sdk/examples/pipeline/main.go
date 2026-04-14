// Example: Pipeline agent chaining.
//
// Demonstrates chaining agents sequentially where each agent's output
// becomes the next agent's input, with optional transforms.
//
// Usage:
//
//	go run ./examples/pipeline
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	sdk "github.com/Esonhugh/goClaudeAgentSDK"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	input := "Write a Go function that reverses a string, handling Unicode correctly."
	if len(os.Args) > 1 {
		input = os.Args[1]
	}

	// Step 1: Code generation agent
	coder := sdk.NewAgent(sdk.AgentConfig{
		Name:           "coder",
		SystemPrompt:   "You are an expert Go programmer. Write clean, idiomatic Go code. Output ONLY the code, no explanations.",
		PermissionMode: sdk.PermissionModeDontAsk,
	})

	// Step 2: Code review agent
	reviewer := sdk.NewAgent(sdk.AgentConfig{
		Name:           "reviewer",
		SystemPrompt:   "You are a senior Go code reviewer. Review the code for bugs, performance issues, and style. Suggest specific improvements. Be concise.",
		PermissionMode: sdk.PermissionModeDontAsk,
	})

	// Step 3: Documentation agent
	documenter := sdk.NewAgent(sdk.AgentConfig{
		Name:           "documenter",
		SystemPrompt:   "You are a technical writer. Given code and review feedback, write a clean final version with proper GoDoc comments. Output ONLY the final code.",
		PermissionMode: sdk.PermissionModeDontAsk,
	})

	pipeline := sdk.NewPipeline(
		sdk.PipelineStep{
			Name:  "Generate Code",
			Agent: coder,
		},
		sdk.PipelineStep{
			Name:  "Code Review",
			Agent: reviewer,
			Transform: func(code string) string {
				return fmt.Sprintf("Review this Go code and suggest improvements:\n\n```go\n%s\n```", code)
			},
		},
		sdk.PipelineStep{
			Name:  "Final Documentation",
			Agent: documenter,
			Transform: func(review string) string {
				return fmt.Sprintf("Based on this review, produce the final documented version:\n\n%s", review)
			},
		},
	)

	fmt.Printf("Running 3-step pipeline...\n")
	fmt.Printf("Input: %s\n\n", input)

	result, err := pipeline.Run(ctx, input)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Pipeline error: %v\n", err)
		os.Exit(1)
	}

	for _, sr := range result.StepResults {
		fmt.Printf("=== Step: %s (cost: $%.4f, %.1fs) ===\n", sr.StepName, sr.CostUSD, sr.DurationMs/1000)
		fmt.Println(sr.Output)
		fmt.Println()
	}

	fmt.Printf("--- Total cost: $%.4f, Total duration: %.1fs ---\n",
		result.TotalCostUSD, result.TotalDurationMs/1000)
}

// Example: Code review agent.
//
// Demonstrates a code review workflow where one agent writes code and
// another reviews it, with iterative refinement using FanOut for
// multiple reviewer perspectives.
//
// Usage:
//
//	go run ./examples/codereview
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

	task := "Write a thread-safe LRU cache in Go with generics support"
	if len(os.Args) > 1 {
		task = os.Args[1]
	}

	// Code author agent
	author := sdk.NewAgent(sdk.AgentConfig{
		Name:           "author",
		SystemPrompt:   "You are a Go developer. Write production-quality code. Include the package declaration and all imports. Output only code.",
		PermissionMode: sdk.PermissionModeDontAsk,
	})

	// Multiple reviewers with different focuses
	securityReviewer := sdk.NewAgent(sdk.AgentConfig{
		Name:           "security-reviewer",
		SystemPrompt:   "You are a security-focused code reviewer. Examine Go code for race conditions, memory leaks, injection vulnerabilities, and unsafe patterns. Be specific and concise.",
		PermissionMode: sdk.PermissionModeDontAsk,
	})

	performanceReviewer := sdk.NewAgent(sdk.AgentConfig{
		Name:           "performance-reviewer",
		SystemPrompt:   "You are a performance-focused code reviewer. Examine Go code for unnecessary allocations, algorithmic complexity issues, and optimization opportunities. Be specific and concise.",
		PermissionMode: sdk.PermissionModeDontAsk,
	})

	idiomsReviewer := sdk.NewAgent(sdk.AgentConfig{
		Name:           "idioms-reviewer",
		SystemPrompt:   "You are a Go idioms expert. Review code for proper Go conventions, error handling, naming, and code organization. Reference Effective Go and Go Proverbs where applicable. Be specific and concise.",
		PermissionMode: sdk.PermissionModeDontAsk,
	})

	// Step 1: Generate code
	fmt.Printf("Task: %s\n\n", task)
	fmt.Println("=== Step 1: Code Generation ===")

	codeResult, err := author.Run(ctx, task)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Code generation error: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(codeResult.Text)

	// Step 2: Fan out to multiple reviewers in parallel
	fmt.Println("\n=== Step 2: Parallel Code Review ===")

	reviewPrompt := fmt.Sprintf("Review this Go code:\n\n```go\n%s\n```", codeResult.Text)
	reviews := sdk.FanOut(ctx, reviewPrompt, securityReviewer, performanceReviewer, idiomsReviewer)

	totalCost := codeResult.CostUSD
	allFeedback := ""
	for _, r := range reviews {
		fmt.Printf("\n--- %s ---\n", r.TaskName)
		if r.Error != nil {
			fmt.Printf("Error: %v\n", r.Error)
			continue
		}
		fmt.Println(r.Result.Text)
		totalCost += r.Result.CostUSD
		allFeedback += fmt.Sprintf("\n## %s:\n%s\n", r.TaskName, r.Result.Text)
	}

	// Step 3: Author incorporates feedback
	fmt.Println("\n=== Step 3: Revised Code ===")

	reviser := sdk.NewAgent(sdk.AgentConfig{
		Name:           "reviser",
		SystemPrompt:   "You are a Go developer incorporating review feedback. Apply valid suggestions to improve the code. Output only the improved code.",
		PermissionMode: sdk.PermissionModeDontAsk,
	})

	revisedResult, err := reviser.Run(ctx, fmt.Sprintf(
		"Original code:\n```go\n%s\n```\n\nReview feedback:\n%s\n\nProduce the improved version:",
		codeResult.Text, allFeedback,
	))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Revision error: %v\n", err)
		os.Exit(1)
	}

	fmt.Println(revisedResult.Text)
	totalCost += revisedResult.CostUSD
	fmt.Printf("\n--- Total cost: $%.4f ---\n", totalCost)
}

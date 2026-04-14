// Example: Multi-agent orchestration.
//
// Demonstrates running multiple specialized agents in parallel, then combining
// their outputs with a synthesis agent.
//
// Usage:
//
//	go run ./examples/multiagent
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

	topic := "the Go programming language"
	if len(os.Args) > 1 {
		topic = os.Args[1]
	}

	// Define specialized agents
	researchAgent := sdk.NewAgent(sdk.AgentConfig{
		Name:           "researcher",
		SystemPrompt:   "You are a research assistant. Provide factual, well-organized information. Be concise and cite specifics.",
		PermissionMode: sdk.PermissionModeDontAsk,
	})

	criticAgent := sdk.NewAgent(sdk.AgentConfig{
		Name:           "critic",
		SystemPrompt:   "You are a critical analyst. Identify weaknesses, challenges, and counterarguments. Be constructive but thorough.",
		PermissionMode: sdk.PermissionModeDontAsk,
	})

	creativeAgent := sdk.NewAgent(sdk.AgentConfig{
		Name:           "creative",
		SystemPrompt:   "You are a creative thinker. Generate novel ideas, analogies, and unconventional perspectives. Be imaginative.",
		PermissionMode: sdk.PermissionModeDontAsk,
	})

	fmt.Printf("Running 3 agents in parallel on topic: %q\n\n", topic)

	// Run all three in parallel
	results := sdk.RunParallel(ctx, []sdk.ParallelTask{
		{Name: "Research", Agent: researchAgent, Prompt: fmt.Sprintf("Give a brief overview of %s", topic)},
		{Name: "Critique", Agent: criticAgent, Prompt: fmt.Sprintf("What are the main challenges and criticisms of %s?", topic)},
		{Name: "Creative", Agent: creativeAgent, Prompt: fmt.Sprintf("What are some creative or unconventional uses of %s?", topic)},
	})

	// Print each agent's output
	totalCost := 0.0
	perspectives := ""
	for _, r := range results {
		fmt.Printf("=== %s ===\n", r.TaskName)
		if r.Error != nil {
			fmt.Printf("Error: %v\n\n", r.Error)
			continue
		}
		fmt.Println(r.Result.Text)
		fmt.Printf("[cost: $%.4f]\n\n", r.Result.CostUSD)
		totalCost += r.Result.CostUSD
		perspectives += fmt.Sprintf("\n## %s perspective:\n%s\n", r.TaskName, r.Result.Text)
	}

	// Synthesis step
	fmt.Println("=== Synthesizing ===")
	synthesizer := sdk.NewAgent(sdk.AgentConfig{
		Name:           "synthesizer",
		SystemPrompt:   "You are a synthesis expert. Combine multiple perspectives into a coherent, balanced summary. Keep it under 200 words.",
		PermissionMode: sdk.PermissionModeDontAsk,
	})

	synthesisResult, err := synthesizer.Run(ctx, fmt.Sprintf(
		"Synthesize these three perspectives on %s into a balanced summary:\n%s",
		topic, perspectives,
	))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Synthesis error: %v\n", err)
		os.Exit(1)
	}

	fmt.Println(synthesisResult.Text)
	totalCost += synthesisResult.CostUSD
	fmt.Printf("\n--- Total cost: $%.4f ---\n", totalCost)
}

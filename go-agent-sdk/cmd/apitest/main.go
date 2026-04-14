package main

import (
	"context"
	"fmt"
	"os"
	"time"

	claudesdk "github.com/Esonhugh/goClaudeAgentSDK"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// Use default settings (ANTHROPIC_AUTH_TOKEN from settings.json)
	// No custom API override - let Ducc's infrastructure handle auth
	maxTurns := 1
	agent := claudesdk.NewAgent(claudesdk.AgentConfig{
		Name:           "sdk-test",
		Model:          "Claude Sonnet 4.5",
		PermissionMode: claudesdk.PermissionModeDontAsk,
		MaxTurns:       &maxTurns,
	})

	fmt.Println("=== Go Agent SDK Test ===")
	start := time.Now()

	result, err := agent.Run(ctx, "Say exactly: Hello from Go Agent SDK! Nothing else.")
	elapsed := time.Since(start)

	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Response: %s\n", result.Text)
	fmt.Printf("Messages: %d\n", len(result.Messages))
	fmt.Printf("Cost: $%.4f\n", result.CostUSD)
	fmt.Printf("Duration: %s\n", elapsed.Round(time.Millisecond))

	if result.Result != nil {
		fmt.Printf("Reason: %s\n", result.Result.Reason)
	}

	fmt.Println("\n=== Test Passed ===")
}

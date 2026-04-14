// Example: Tool permission callback usage.
//
// Demonstrates how to use CanUseTool to control which tools the agent can execute.
//
// Usage:
//
//	go run ./examples/tooluse
package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	sdk "github.com/Esonhugh/goClaudeAgentSDK"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	// Create an agent that only allows Read and Glob tools
	allowedTools := map[string]bool{
		"Read": true,
		"Glob": true,
		"Grep": true,
	}

	agent := sdk.NewAgent(sdk.AgentConfig{
		Name:           "read-only-agent",
		PermissionMode: sdk.PermissionModeDefault,
		CanUseTool: func(toolName string, input map[string]any, ctx sdk.ToolPermissionContext) (sdk.PermissionResult, error) {
			if allowedTools[toolName] {
				fmt.Printf("[ALLOW] Tool: %s\n", toolName)
				return sdk.PermissionResult{
					Allow: &sdk.PermissionResultAllow{Behavior: "allow"},
				}, nil
			}

			fmt.Printf("[DENY] Tool: %s (not in allowed list)\n", toolName)
			return sdk.PermissionResult{
				Deny: &sdk.PermissionResultDeny{
					Behavior: "deny",
					Message:  fmt.Sprintf("tool %q is not allowed in read-only mode", toolName),
				},
			}, nil
		},
	})

	prompt := "List all Go files in the current directory and show the first 5 lines of go.mod"
	if len(os.Args) > 1 {
		prompt = strings.Join(os.Args[1:], " ")
	}

	fmt.Printf("Prompt: %s\n\n", prompt)

	result, err := agent.Run(ctx, prompt)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("\n--- Agent Output ---")
	fmt.Println(result.Text)
	fmt.Printf("\n--- Cost: $%.4f, Duration: %.1fs ---\n", result.CostUSD, result.DurationMs/1000)
}

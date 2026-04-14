// Example: Quick-start usage of the Go Claude Agent SDK.
//
// Usage:
//
//	go run ./examples/quickstart
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	sdk "github.com/Esonhugh/goClaudeAgentSDK"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	prompt := "What is the capital of France? Answer in one sentence."
	if len(os.Args) > 1 {
		prompt = os.Args[1]
	}

	fmt.Println("Querying Claude...")

	msgs, errs := sdk.Query(ctx, prompt, &sdk.ClaudeAgentOptions{
		PermissionMode: sdk.PermissionModeDontAsk,
	})

	for {
		select {
		case msg, ok := <-msgs:
			if !ok {
				return
			}
			switch m := msg.(type) {
			case sdk.AssistantMessage:
				text := sdk.GetTextContent(m)
				if text != "" {
					fmt.Println("\nClaude:", text)
				}
			case sdk.ResultMessage:
				fmt.Printf("\n--- Done (cost: $%.4f, duration: %.1fs) ---\n",
					m.CostUSD, m.Duration/1000)
				return
			case sdk.SystemMessage:
				if m.Subtype == "task_started" {
					fmt.Println("[Task started]")
				}
			}
		case err, ok := <-errs:
			if !ok {
				continue
			}
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return
		}
	}
}

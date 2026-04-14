// Example: Multi-turn streaming conversation with the Claude Agent SDK.
//
// Usage:
//
//	go run ./examples/streaming
package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	sdk "github.com/Esonhugh/goClaudeAgentSDK"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	client := sdk.NewClient(&sdk.ClaudeAgentOptions{
		PermissionMode: sdk.PermissionModeDontAsk,
	})

	fmt.Println("Connecting to Claude...")
	if err := client.Connect(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "Connection failed: %v\n", err)
		os.Exit(1)
	}
	defer client.Close()

	fmt.Println("Connected! Type your messages (Ctrl+D to quit).")
	fmt.Println()

	reader := bufio.NewReader(os.Stdin)

	for {
		fmt.Print("You: ")
		line, err := reader.ReadString('\n')
		if err != nil {
			break // EOF
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		if err := client.SendQuery(ctx, line); err != nil {
			fmt.Fprintf(os.Stderr, "Send error: %v\n", err)
			continue
		}

		// Read response
		for msg := range client.ReceiveResponse(ctx) {
			switch m := msg.(type) {
			case sdk.AssistantMessage:
				text := sdk.GetTextContent(m)
				if text != "" {
					fmt.Println("\nClaude:", text)
				}
			case sdk.ResultMessage:
				fmt.Printf("[cost: $%.4f]\n\n", m.CostUSD)
			}
		}
	}
}

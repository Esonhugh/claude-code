// Example: Calculator agent.
//
// Demonstrates using Claude as a computation engine with structured output parsing,
// multi-step reasoning, and result validation via a second agent.
//
// Usage:
//
//	go run ./examples/calculator
//	go run ./examples/calculator "What is the derivative of x^3 * sin(x)?"
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

	problems := []string{
		"Calculate the sum of prime numbers less than 50",
		"What is 17! (17 factorial)?",
		"Solve the system of equations: 2x + 3y = 13, 5x - y = 7",
	}
	if len(os.Args) > 1 {
		problems = []string{strings.Join(os.Args[1:], " ")}
	}

	// Calculator agent - focused on computation
	calculator := sdk.NewAgent(sdk.AgentConfig{
		Name:         "calculator",
		SystemPrompt: "You are a precise calculator. Show your work step by step, then give the FINAL ANSWER on its own line prefixed with 'ANSWER: '. Use exact values where possible.",
		PermissionMode: sdk.PermissionModeDontAsk,
	})

	// Verifier agent - checks the calculation
	verifier := sdk.NewAgent(sdk.AgentConfig{
		Name:         "verifier",
		SystemPrompt: "You are a math verification expert. Check the given calculation for correctness. If correct, respond with 'VERIFIED: correct'. If wrong, respond with 'VERIFIED: incorrect' and explain the error. Be brief.",
		PermissionMode: sdk.PermissionModeDontAsk,
	})

	totalCost := 0.0

	for i, problem := range problems {
		fmt.Printf("Problem %d: %s\n", i+1, problem)
		fmt.Println(strings.Repeat("-", 60))

		// Step 1: Calculate
		calcResult, err := calculator.Run(ctx, problem)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Calculator error: %v\n", err)
			continue
		}

		fmt.Println("Calculation:")
		fmt.Println(calcResult.Text)
		totalCost += calcResult.CostUSD

		// Step 2: Verify
		verifyResult, err := verifier.Run(ctx, fmt.Sprintf(
			"Verify this calculation:\n\nProblem: %s\n\nSolution:\n%s",
			problem, calcResult.Text,
		))
		if err != nil {
			fmt.Fprintf(os.Stderr, "Verifier error: %v\n", err)
			continue
		}

		fmt.Printf("\nVerification: %s\n", verifyResult.Text)
		totalCost += verifyResult.CostUSD

		fmt.Println()
	}

	fmt.Printf("--- Total cost: $%.4f ---\n", totalCost)
}

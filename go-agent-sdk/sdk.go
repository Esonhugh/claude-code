// Package claudesdk provides a Go SDK for interacting with the Claude Code CLI.
//
// It wraps the Claude Code CLI via subprocess, communicating over stdin/stdout
// with JSON streaming.
//
// Quick start:
//
//	msgs, errs := claudesdk.Query(ctx, "Hello, Claude!", nil)
//	for msg := range msgs {
//	    if am, ok := msg.(claudesdk.AssistantMessage); ok {
//	        fmt.Println(claudesdk.GetTextContent(am))
//	    }
//	}
package claudesdk

import (
	"context"
)

// Query performs a one-shot query to Claude and returns channels for messages and errors.
// This is the simplest way to interact with Claude.
//
// Example:
//
//	msgs, errs := claudesdk.Query(ctx, "What is 2+2?", nil)
//	for msg := range msgs {
//	    switch m := msg.(type) {
//	    case claudesdk.AssistantMessage:
//	        fmt.Println(claudesdk.GetTextContent(m))
//	    case claudesdk.ResultMessage:
//	        fmt.Printf("Done! Cost: $%.4f\n", m.CostUSD)
//	    }
//	}
func Query(ctx context.Context, prompt string, opts *ClaudeAgentOptions) (<-chan Message, <-chan error) {
	if opts == nil {
		opts = &ClaudeAgentOptions{}
	}

	msgCh := make(chan Message, 64)
	errCh := make(chan error, 8)

	go func() {
		defer close(msgCh)
		defer close(errCh)

		transport := NewSubprocessTransport(opts)
		defer transport.Close()

		if err := transport.Connect(ctx); err != nil {
			errCh <- err
			return
		}

		handler := newQueryHandler(transport, opts)
		routedMsgs := handler.runMessageRouter(ctx)

		// Initialize
		if _, err := handler.initialize(ctx); err != nil {
			errCh <- err
			return
		}

		// Send prompt
		if err := handler.sendPrompt(ctx, prompt); err != nil {
			errCh <- err
			return
		}

		// Stream messages until result
		for msg := range routedMsgs {
			select {
			case msgCh <- msg:
			case <-ctx.Done():
				return
			}
			if IsResultMessage(msg) {
				return
			}
		}
	}()

	return msgCh, errCh
}

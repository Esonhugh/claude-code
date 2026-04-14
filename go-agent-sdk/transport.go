package claudesdk

import (
	"context"
	"encoding/json"
)

// Transport defines the interface for communicating with the Claude CLI process.
type Transport interface {
	// Connect starts the CLI process and establishes communication channels.
	Connect(ctx context.Context) error

	// Write sends data to the CLI process stdin.
	Write(ctx context.Context, data string) error

	// ReadMessages returns a channel of raw JSON messages from stdout
	// and a channel for errors. Both channels are closed when the transport closes.
	ReadMessages(ctx context.Context) (<-chan json.RawMessage, <-chan error)

	// Close terminates the CLI process and cleans up resources.
	Close() error

	// IsReady returns true if the transport is connected and ready.
	IsReady() bool

	// EndInput closes stdin to signal end of input.
	EndInput() error
}

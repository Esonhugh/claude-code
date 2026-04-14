package claudesdk

import (
	"context"
	"fmt"
	"sync"
)

// ClaudeSDKClient provides a bidirectional streaming interface to Claude.
// Use this for multi-turn conversations and advanced control.
type ClaudeSDKClient struct {
	opts       *ClaudeAgentOptions
	transport  Transport
	handler    *queryHandler
	msgCh      <-chan Message
	connected  bool
	mu         sync.Mutex
}

// NewClient creates a new ClaudeSDKClient with the given options.
func NewClient(opts *ClaudeAgentOptions) *ClaudeSDKClient {
	if opts == nil {
		opts = &ClaudeAgentOptions{}
	}
	return &ClaudeSDKClient{
		opts: opts,
	}
}

// Connect establishes the connection to the Claude CLI process
// and performs the initialization handshake.
func (c *ClaudeSDKClient) Connect(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.connected {
		return fmt.Errorf("client already connected")
	}

	c.transport = NewSubprocessTransport(c.opts)
	if err := c.transport.Connect(ctx); err != nil {
		return err
	}

	c.handler = newQueryHandler(c.transport, c.opts)
	c.msgCh = c.handler.runMessageRouter(ctx)

	// Initialize handshake
	if _, err := c.handler.initialize(ctx); err != nil {
		c.transport.Close()
		return err
	}

	c.connected = true
	return nil
}

// SendQuery sends a user prompt to Claude.
// Messages will appear on the channel returned by ReceiveMessages.
func (c *ClaudeSDKClient) SendQuery(ctx context.Context, prompt string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.connected {
		return fmt.Errorf("client not connected")
	}

	return c.handler.sendPrompt(ctx, prompt)
}

// ReceiveMessages returns a channel that yields all messages from Claude.
// The channel remains open across multiple queries until Close is called.
func (c *ClaudeSDKClient) ReceiveMessages(ctx context.Context) <-chan Message {
	return c.msgCh
}

// ReceiveResponse returns a channel that yields messages for the current query,
// stopping after a ResultMessage is received.
func (c *ClaudeSDKClient) ReceiveResponse(ctx context.Context) <-chan Message {
	out := make(chan Message, 64)
	go func() {
		defer close(out)
		for msg := range c.msgCh {
			select {
			case out <- msg:
			case <-ctx.Done():
				return
			}
			if IsResultMessage(msg) {
				return
			}
		}
	}()
	return out
}

// Interrupt sends an interrupt signal to stop the current query.
func (c *ClaudeSDKClient) Interrupt(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.connected {
		return fmt.Errorf("client not connected")
	}
	return c.handler.interrupt(ctx)
}

// SetPermissionMode changes the permission mode for the session.
func (c *ClaudeSDKClient) SetPermissionMode(ctx context.Context, mode PermissionMode) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.connected {
		return fmt.Errorf("client not connected")
	}
	return c.handler.setPermissionMode(ctx, mode)
}

// SetModel changes the model for subsequent responses.
func (c *ClaudeSDKClient) SetModel(ctx context.Context, model string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.connected {
		return fmt.Errorf("client not connected")
	}
	return c.handler.setModel(ctx, model)
}

// GetMCPStatus returns the status of all MCP server connections.
func (c *ClaudeSDKClient) GetMCPStatus(ctx context.Context) ([]McpServerStatus, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.connected {
		return nil, fmt.Errorf("client not connected")
	}
	return c.handler.mcpServerStatus(ctx)
}

// GetInitResult returns the initialization result (available commands, models, account info).
func (c *ClaudeSDKClient) GetInitResult() *InitializeResponse {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.handler != nil {
		return c.handler.initResult
	}
	return nil
}

// Close terminates the connection and cleans up resources.
func (c *ClaudeSDKClient) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.connected = false
	if c.transport != nil {
		return c.transport.Close()
	}
	return nil
}

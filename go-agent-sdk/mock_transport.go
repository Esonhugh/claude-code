package claudesdk

import (
	"context"
	"encoding/json"
	"sync"
)

// MockTransport is a test transport that replays predefined messages.
// Use it with Agent.TransportFactory for deterministic testing.
type MockTransport struct {
	mu       sync.Mutex
	messages []json.RawMessage
	written  []string
	connected bool
	closed    bool

	// InitResponse is the response to send for the initialize handshake.
	// If nil, a default successful response is used.
	InitResponse *InitializeResponse

	// OnWrite is called for each write, allowing tests to inject responses.
	OnWrite func(data string)
}

// NewMockTransport creates a MockTransport with predefined response messages.
// These messages are delivered after the initialize handshake.
func NewMockTransport(messages ...json.RawMessage) *MockTransport {
	return &MockTransport{
		messages: messages,
	}
}

func (m *MockTransport) Connect(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.connected = true
	return nil
}

func (m *MockTransport) Write(ctx context.Context, data string) error {
	m.mu.Lock()
	m.written = append(m.written, data)
	cb := m.OnWrite
	m.mu.Unlock()
	if cb != nil {
		cb(data)
	}
	return nil
}

func (m *MockTransport) ReadMessages(ctx context.Context) (<-chan json.RawMessage, <-chan error) {
	msgCh := make(chan json.RawMessage, len(m.messages)+16)
	errCh := make(chan error)

	go func() {
		defer close(msgCh)
		defer close(errCh)

		// Wait for the first write (initialize request), then send init response
		for {
			m.mu.Lock()
			nw := len(m.written)
			m.mu.Unlock()
			if nw > 0 {
				break
			}
			select {
			case <-ctx.Done():
				return
			default:
			}
		}

		// Send initialize response
		initResp := m.InitResponse
		if initResp == nil {
			initResp = &InitializeResponse{
				Commands:    []SlashCommand{{Name: "help"}},
				Agents:      []AgentInfo{},
				OutputStyle: "text",
				Models:      []ModelInfo{{Value: "claude-sonnet-4-6", DisplayName: "Claude Sonnet 4.6"}},
				Account:     AccountInfo{Email: "test@example.com"},
			}
		}

		// Build the control_response that wraps the initialize response
		respBytes, _ := json.Marshal(initResp)
		// Extract request_id from the first write
		var firstReq map[string]any
		m.mu.Lock()
		if len(m.written) > 0 {
			json.Unmarshal([]byte(m.written[0]), &firstReq)
		}
		m.mu.Unlock()

		reqID, _ := firstReq["request_id"].(string)
		controlResp := map[string]any{
			"type": "control_response",
			"response": map[string]any{
				"subtype":    "success",
				"request_id": reqID,
				"response":   json.RawMessage(respBytes),
			},
		}
		crBytes, _ := json.Marshal(controlResp)

		select {
		case msgCh <- json.RawMessage(crBytes):
		case <-ctx.Done():
			return
		}

		// Wait for the second write (the actual prompt), then send data messages
		for {
			m.mu.Lock()
			nw := len(m.written)
			m.mu.Unlock()
			if nw > 1 {
				break
			}
			select {
			case <-ctx.Done():
				return
			default:
			}
		}

		// Send predefined data messages
		for _, msg := range m.messages {
			select {
			case msgCh <- msg:
			case <-ctx.Done():
				return
			}
		}
	}()

	return msgCh, errCh
}

func (m *MockTransport) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	return nil
}

func (m *MockTransport) IsReady() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.connected && !m.closed
}

func (m *MockTransport) EndInput() error {
	return nil
}

// Written returns all data written to the transport.
func (m *MockTransport) Written() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := make([]string, len(m.written))
	copy(cp, m.written)
	return cp
}

// MockTransportFactory returns a TransportFactory that always returns the given MockTransport.
func MockTransportFactory(mt *MockTransport) func(opts *ClaudeAgentOptions) Transport {
	return func(opts *ClaudeAgentOptions) Transport {
		return mt
	}
}

// QuickMockMessages creates a standard assistant response + result message pair.
func QuickMockMessages(text string, costUSD float64) []json.RawMessage {
	assistant := map[string]any{
		"type": "assistant",
		"message": map[string]any{
			"role":    "assistant",
			"content": []any{map[string]any{"type": "text", "text": text}},
		},
	}
	result := map[string]any{
		"type":        "result",
		"subtype":     "success",
		"cost_usd":    costUSD,
		"duration_ms": 500.0,
		"reason":      "end_turn",
	}
	aBytes, _ := json.Marshal(assistant)
	rBytes, _ := json.Marshal(result)
	return []json.RawMessage{aBytes, rBytes}
}

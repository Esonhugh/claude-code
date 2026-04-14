package claudesdk

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
)

// queryHandler manages the control protocol and message routing.
type queryHandler struct {
	transport      Transport
	opts           *ClaudeAgentOptions
	requestCounter atomic.Int64
	pendingMu      sync.Mutex
	pending        map[string]chan json.RawMessage
	initialized    bool
	initResult     *InitializeResponse
	// Hook callback registry: callback_id -> callback function
	hookCallbacks  map[string]HookCallback
	nextCallbackID int
}

// newQueryHandler creates a new query handler.
func newQueryHandler(transport Transport, opts *ClaudeAgentOptions) *queryHandler {
	return &queryHandler{
		transport:     transport,
		opts:          opts,
		pending:       make(map[string]chan json.RawMessage),
		hookCallbacks: make(map[string]HookCallback),
	}
}

// nextRequestID generates a unique request ID.
func (q *queryHandler) nextRequestID() string {
	id := q.requestCounter.Add(1)
	return fmt.Sprintf("sdk-req-%d", id)
}

// sendControlRequest sends a control request and waits for the response.
func (q *queryHandler) sendControlRequest(ctx context.Context, subtype string, fields map[string]any) (json.RawMessage, error) {
	reqID := q.nextRequestID()

	request := map[string]any{
		"subtype": subtype,
	}
	for k, v := range fields {
		request[k] = v
	}

	msg := map[string]any{
		"type":       "control_request",
		"request_id": reqID,
		"request":    request,
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal control request: %w", err)
	}

	// Register pending response
	ch := make(chan json.RawMessage, 1)
	q.pendingMu.Lock()
	q.pending[reqID] = ch
	q.pendingMu.Unlock()

	defer func() {
		q.pendingMu.Lock()
		delete(q.pending, reqID)
		q.pendingMu.Unlock()
	}()

	if err := q.transport.Write(ctx, string(data)); err != nil {
		return nil, err
	}

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case resp := <-ch:
		return resp, nil
	}
}

// initialize performs the initialize handshake with the CLI.
func (q *queryHandler) initialize(ctx context.Context) (*InitializeResponse, error) {
	fields := map[string]any{}

	if q.opts.Agents != nil {
		fields["agents"] = q.opts.Agents
	}
	if q.opts.PromptSuggestions {
		fields["promptSuggestions"] = true
	}
	if q.opts.AgentProgressSummaries {
		fields["agentProgressSummaries"] = true
	}

	// System prompt
	if q.opts.SystemPrompt != nil {
		switch v := q.opts.SystemPrompt.(type) {
		case string:
			fields["systemPrompt"] = v
		case SystemPromptPreset:
			if v.Append != "" {
				fields["appendSystemPrompt"] = v.Append
			}
			if v.ExcludeDynamicSections != nil && *v.ExcludeDynamicSections {
				fields["excludeDynamicSections"] = true
			}
		case map[string]any:
			if preset, ok := v["preset"]; ok && preset == "claude_code" {
				if append, ok := v["append"]; ok {
					fields["appendSystemPrompt"] = append
				}
			}
		}
	}

	// Build hooks configuration
	if q.opts.HookCallbacks != nil {
		hooksConfig := map[string]any{}
		for event, matchers := range q.opts.HookCallbacks {
			if len(matchers) == 0 {
				continue
			}
			var matcherConfigs []map[string]any
			for _, matcher := range matchers {
				callbackIDs := make([]string, 0, len(matcher.Hooks))
				for _, callback := range matcher.Hooks {
					callbackID := fmt.Sprintf("hook_%d", q.nextCallbackID)
					q.nextCallbackID++
					q.hookCallbacks[callbackID] = callback
					callbackIDs = append(callbackIDs, callbackID)
				}
				matcherConfig := map[string]any{
					"matcher":         matcher.Matcher,
					"hookCallbackIds": callbackIDs,
				}
				if matcher.Timeout != nil {
					matcherConfig["timeout"] = *matcher.Timeout
				}
				matcherConfigs = append(matcherConfigs, matcherConfig)
			}
			hooksConfig[string(event)] = matcherConfigs
		}
		if len(hooksConfig) > 0 {
			fields["hooks"] = hooksConfig
		}
	}

	resp, err := q.sendControlRequest(ctx, "initialize", fields)
	if err != nil {
		return nil, fmt.Errorf("initialize handshake failed: %w", err)
	}

	var controlResp struct {
		Subtype  string              `json:"subtype"`
		Response *InitializeResponse `json:"response,omitempty"`
		Error    string              `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resp, &controlResp); err != nil {
		return nil, fmt.Errorf("failed to parse initialize response: %w", err)
	}

	if controlResp.Subtype == "error" {
		return nil, fmt.Errorf("initialize error: %s", controlResp.Error)
	}

	q.initialized = true
	q.initResult = controlResp.Response
	return controlResp.Response, nil
}

// routeMessage handles control responses and routes data messages.
func (q *queryHandler) routeMessage(raw json.RawMessage) (Message, bool, error) {
	var base struct {
		Type     string `json:"type"`
		Response *struct {
			Subtype   string          `json:"subtype"`
			RequestID string          `json:"request_id"`
			Response  json.RawMessage `json:"response,omitempty"`
			Error     string          `json:"error,omitempty"`
		} `json:"response,omitempty"`
	}
	if err := json.Unmarshal(raw, &base); err != nil {
		return nil, false, err
	}

	// Handle control responses
	if base.Type == "control_response" && base.Response != nil {
		reqID := base.Response.RequestID
		q.pendingMu.Lock()
		ch, ok := q.pending[reqID]
		q.pendingMu.Unlock()
		if ok {
			ch <- raw
		}
		return nil, false, nil // control message, not a data message
	}

	// Handle control requests from the CLI (permission, hooks, etc.)
	if base.Type == "control_request" {
		go q.handleControlRequest(raw)
		return nil, false, nil
	}

	// Parse as data message
	msg, err := ParseMessage(raw)
	if err != nil {
		return nil, false, err
	}
	if msg == nil {
		return nil, false, nil // unknown message type, skip
	}

	return msg, true, nil
}

// handleControlRequest handles incoming control requests from the CLI.
func (q *queryHandler) handleControlRequest(raw json.RawMessage) {
	var req struct {
		Type      string `json:"type"`
		RequestID string `json:"request_id"`
		Request   struct {
			Subtype               string          `json:"subtype"`
			ToolName              string          `json:"tool_name,omitempty"`
			Input                 json.RawMessage `json:"input,omitempty"`
			ToolUseID             string          `json:"tool_use_id,omitempty"`
			AgentID               string          `json:"agent_id,omitempty"`
			PermissionSuggestions json.RawMessage `json:"permission_suggestions,omitempty"`
			BlockedPath           string          `json:"blocked_path,omitempty"`
			// Hook callback fields
			CallbackID string `json:"callback_id,omitempty"`
			// MCP fields
			ServerName string          `json:"server_name,omitempty"`
			Message    json.RawMessage `json:"message,omitempty"`
		} `json:"request"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return
	}

	ctx := context.Background()

	switch req.Request.Subtype {
	case "can_use_tool":
		q.handlePermissionRequest(ctx, req.RequestID, req.Request.ToolName,
			req.Request.Input, req.Request.ToolUseID, req.Request.AgentID,
			req.Request.PermissionSuggestions, req.Request.BlockedPath)

	case "hook_callback":
		q.handleHookCallback(ctx, req.RequestID, req.Request.CallbackID,
			req.Request.Input, req.Request.ToolUseID)

	default:
		// Send default response for unhandled requests
		q.sendControlResponse(ctx, req.RequestID, map[string]any{})
	}
}

// handleHookCallback handles a hook_callback control request from the CLI.
func (q *queryHandler) handleHookCallback(ctx context.Context, requestID, callbackID string, inputRaw json.RawMessage, toolUseID string) {
	callback, ok := q.hookCallbacks[callbackID]
	if !ok {
		q.sendControlErrorResponse(ctx, requestID, fmt.Sprintf("no hook callback found for ID: %s", callbackID))
		return
	}

	output, err := callback(inputRaw, toolUseID)
	if err != nil {
		q.sendControlErrorResponse(ctx, requestID, err.Error())
		return
	}

	// Convert output to map for sending, handling the "continue" keyword
	respData, err := json.Marshal(output)
	if err != nil {
		q.sendControlErrorResponse(ctx, requestID, fmt.Sprintf("failed to marshal hook output: %v", err))
		return
	}
	var respMap map[string]any
	if err := json.Unmarshal(respData, &respMap); err != nil {
		q.sendControlErrorResponse(ctx, requestID, fmt.Sprintf("failed to unmarshal hook output: %v", err))
		return
	}

	q.sendControlResponse(ctx, requestID, respMap)
}

// handlePermissionRequest handles a can_use_tool request.
func (q *queryHandler) handlePermissionRequest(ctx context.Context, requestID, toolName string, inputRaw json.RawMessage, toolUseID, agentID string, suggestionsRaw json.RawMessage, blockedPath string) {
	if q.opts.CanUseTool == nil {
		// Default: allow with original input
		var input map[string]any
		json.Unmarshal(inputRaw, &input)
		q.sendControlResponse(ctx, requestID, map[string]any{
			"behavior":     "allow",
			"updatedInput": input,
		})
		return
	}

	var input map[string]any
	json.Unmarshal(inputRaw, &input)

	var suggestions []PermissionUpdate
	if len(suggestionsRaw) > 0 {
		json.Unmarshal(suggestionsRaw, &suggestions)
	}

	permCtx := ToolPermissionContext{
		ToolUseID:   toolUseID,
		AgentID:     agentID,
		Suggestions: suggestions,
		BlockedPath: blockedPath,
	}

	result, err := q.opts.CanUseTool(toolName, input, permCtx)
	if err != nil {
		q.sendControlResponse(ctx, requestID, map[string]any{
			"behavior": "deny",
			"message":  err.Error(),
		})
		return
	}

	if result.Allow != nil {
		resp := map[string]any{"behavior": "allow"}
		if result.Allow.UpdatedInput != nil {
			resp["updatedInput"] = result.Allow.UpdatedInput
		} else {
			resp["updatedInput"] = input
		}
		if result.Allow.UpdatedPermissions != nil {
			resp["updatedPermissions"] = result.Allow.UpdatedPermissions
		}
		q.sendControlResponse(ctx, requestID, resp)
	} else if result.Deny != nil {
		resp := map[string]any{
			"behavior": "deny",
			"message":  result.Deny.Message,
		}
		if result.Deny.Interrupt != nil {
			resp["interrupt"] = *result.Deny.Interrupt
		}
		q.sendControlResponse(ctx, requestID, resp)
	}
}

// sendControlResponse sends a success response to a control request from the CLI.
func (q *queryHandler) sendControlResponse(ctx context.Context, requestID string, response map[string]any) {
	msg := map[string]any{
		"type": "control_response",
		"response": map[string]any{
			"subtype":    "success",
			"request_id": requestID,
			"response":   response,
		},
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	q.transport.Write(ctx, string(data))
}

// sendControlErrorResponse sends an error response to a control request from the CLI.
func (q *queryHandler) sendControlErrorResponse(ctx context.Context, requestID string, errMsg string) {
	msg := map[string]any{
		"type": "control_response",
		"response": map[string]any{
			"subtype":    "error",
			"request_id": requestID,
			"error":      errMsg,
		},
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	q.transport.Write(ctx, string(data))
}

// runMessageRouter reads from transport and routes messages.
// Returns a channel of data messages.
func (q *queryHandler) runMessageRouter(ctx context.Context) <-chan Message {
	outCh := make(chan Message, 64)

	rawCh, errCh := q.transport.ReadMessages(ctx)

	go func() {
		defer close(outCh)
		for {
			select {
			case <-ctx.Done():
				return
			case raw, ok := <-rawCh:
				if !ok {
					return
				}
				msg, isData, err := q.routeMessage(raw)
				if err != nil {
					continue // skip unparseable messages
				}
				if isData && msg != nil {
					select {
					case outCh <- msg:
					case <-ctx.Done():
						return
					}
				}
			case _, ok := <-errCh:
				if !ok {
					// errCh closed — stop selecting on it but keep draining rawCh
					errCh = nil
					continue
				}
				// errors are logged but don't stop routing
			}
		}
	}()

	return outCh
}

// sendPrompt sends a user prompt to the CLI.
func (q *queryHandler) sendPrompt(ctx context.Context, prompt string) error {
	msg := map[string]any{
		"type": "user",
		"message": map[string]any{
			"role":    "user",
			"content": prompt,
		},
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("failed to marshal prompt: %w", err)
	}
	return q.transport.Write(ctx, string(data))
}

// interrupt sends an interrupt control request.
func (q *queryHandler) interrupt(ctx context.Context) error {
	_, err := q.sendControlRequest(ctx, "interrupt", nil)
	return err
}

// setPermissionMode sends a set_permission_mode control request.
func (q *queryHandler) setPermissionMode(ctx context.Context, mode PermissionMode) error {
	_, err := q.sendControlRequest(ctx, "set_permission_mode", map[string]any{
		"mode": string(mode),
	})
	return err
}

// setModel sends a set_model control request.
func (q *queryHandler) setModel(ctx context.Context, model string) error {
	fields := map[string]any{}
	if model != "" {
		fields["model"] = model
	}
	_, err := q.sendControlRequest(ctx, "set_model", fields)
	return err
}

// mcpServerStatus queries MCP server statuses.
func (q *queryHandler) mcpServerStatus(ctx context.Context) ([]McpServerStatus, error) {
	resp, err := q.sendControlRequest(ctx, "mcp_status", nil)
	if err != nil {
		return nil, err
	}
	var controlResp struct {
		Response struct {
			Response []McpServerStatus `json:"response"`
		} `json:"response"`
	}
	if err := json.Unmarshal(resp, &controlResp); err != nil {
		return nil, err
	}
	return controlResp.Response.Response, nil
}

// contextUsage queries context window usage breakdown.
func (q *queryHandler) contextUsage(ctx context.Context) (*ContextUsageResponse, error) {
	resp, err := q.sendControlRequest(ctx, "context_usage", nil)
	if err != nil {
		return nil, err
	}
	var controlResp struct {
		Response struct {
			Response *ContextUsageResponse `json:"response"`
		} `json:"response"`
	}
	if err := json.Unmarshal(resp, &controlResp); err != nil {
		return nil, err
	}
	return controlResp.Response.Response, nil
}

// rewindFiles reverts files to their state at the given user message ID.
func (q *queryHandler) rewindFiles(ctx context.Context, userMessageID string) error {
	_, err := q.sendControlRequest(ctx, "rewind_files", map[string]any{
		"user_message_id": userMessageID,
	})
	return err
}

// reconnectMcpServer reconnects a failed MCP server.
func (q *queryHandler) reconnectMcpServer(ctx context.Context, serverName string) error {
	_, err := q.sendControlRequest(ctx, "mcp_reconnect", map[string]any{
		"serverName": serverName,
	})
	return err
}

// toggleMcpServer enables or disables an MCP server.
func (q *queryHandler) toggleMcpServer(ctx context.Context, serverName string, enabled bool) error {
	_, err := q.sendControlRequest(ctx, "mcp_toggle", map[string]any{
		"serverName": serverName,
		"enabled":    enabled,
	})
	return err
}

// stopTask stops a running background task.
func (q *queryHandler) stopTask(ctx context.Context, taskID string) error {
	_, err := q.sendControlRequest(ctx, "stop_task", map[string]any{
		"task_id": taskID,
	})
	return err
}

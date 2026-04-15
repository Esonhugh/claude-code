package claudesdk

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

// --- Message Parser Tests ---

func TestParseMessage_User(t *testing.T) {
	raw := json.RawMessage(`{"type":"user","content":"hello","uuid":"abc-123"}`)
	msg, err := ParseMessage(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	um, ok := msg.(UserMessage)
	if !ok {
		t.Fatalf("expected UserMessage, got %T", msg)
	}
	if um.UUID != "abc-123" {
		t.Errorf("expected uuid abc-123, got %s", um.UUID)
	}
	if um.MessageType() != "user" {
		t.Errorf("expected type user, got %s", um.MessageType())
	}
}

func TestParseMessage_Assistant(t *testing.T) {
	raw := json.RawMessage(`{
		"type":"assistant",
		"message":{"role":"assistant","content":[{"type":"text","text":"Hello!"}]},
		"uuid":"def-456"
	}`)
	msg, err := ParseMessage(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	am, ok := msg.(AssistantMessage)
	if !ok {
		t.Fatalf("expected AssistantMessage, got %T", msg)
	}
	if am.UUID != "def-456" {
		t.Errorf("expected uuid def-456, got %s", am.UUID)
	}
	text := GetTextContent(am)
	if text != "Hello!" {
		t.Errorf("expected text 'Hello!', got %q", text)
	}
}

func TestParseMessage_PartialAssistant(t *testing.T) {
	raw := json.RawMessage(`{
		"type":"assistant",
		"subtype":"partial",
		"message":{"role":"assistant","content":[{"type":"text","text":"Hel"}]}
	}`)
	msg, err := ParseMessage(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	_, ok := msg.(PartialAssistantMessage)
	if !ok {
		t.Fatalf("expected PartialAssistantMessage, got %T", msg)
	}
}

func TestParseMessage_System(t *testing.T) {
	raw := json.RawMessage(`{
		"type":"system",
		"subtype":"task_started",
		"task_id":"task-1",
		"status":"running"
	}`)
	msg, err := ParseMessage(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	sm, ok := msg.(TaskStartedMessage)
	if !ok {
		t.Fatalf("expected TaskStartedMessage, got %T", msg)
	}
	if sm.Subtype != "task_started" {
		t.Errorf("expected subtype task_started, got %s", sm.Subtype)
	}
	if sm.TaskID != "task-1" {
		t.Errorf("expected task_id task-1, got %s", sm.TaskID)
	}
}

func TestParseMessage_Result(t *testing.T) {
	raw := json.RawMessage(`{
		"type":"result",
		"subtype":"success",
		"cost_usd":0.0042,
		"duration_ms":1500,
		"session_id":"sess-1",
		"reason":"end_turn"
	}`)
	msg, err := ParseMessage(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	rm, ok := msg.(ResultMessage)
	if !ok {
		t.Fatalf("expected ResultMessage, got %T", msg)
	}
	if rm.CostUSD != 0.0042 {
		t.Errorf("expected cost 0.0042, got %f", rm.CostUSD)
	}
	if rm.Reason != TerminalReasonEndTurn {
		t.Errorf("expected reason end_turn, got %s", rm.Reason)
	}
	if !IsResultMessage(rm) {
		t.Error("IsResultMessage returned false")
	}
}

func TestParseMessage_RateLimitEvent(t *testing.T) {
	raw := json.RawMessage(`{
		"type":"rate_limit_event",
		"retry_info":{"retry_after_ms":5000,"message":"rate limited"}
	}`)
	msg, err := ParseMessage(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	rle, ok := msg.(RateLimitEvent)
	if !ok {
		t.Fatalf("expected RateLimitEvent, got %T", msg)
	}
	if rle.RetryInfo == nil {
		t.Fatal("expected retry_info")
	}
	if rle.RetryInfo.RetryAfterMs != 5000 {
		t.Errorf("expected retry_after_ms 5000, got %d", rle.RetryInfo.RetryAfterMs)
	}
}

func TestParseMessage_AuthStatus(t *testing.T) {
	raw := json.RawMessage(`{"type":"auth_status","authenticated":true}`)
	msg, err := ParseMessage(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	sm, ok := msg.(SystemMessage)
	if !ok {
		t.Fatalf("expected SystemMessage for auth_status, got %T", msg)
	}
	if sm.Subtype != "auth_status" {
		t.Errorf("expected subtype auth_status, got %s", sm.Subtype)
	}
}

func TestParseMessage_UnknownType(t *testing.T) {
	raw := json.RawMessage(`{"type":"unknown_xyz"}`)
	msg, err := ParseMessage(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if msg != nil {
		t.Fatal("expected nil for unknown type")
	}
}

func TestParseMessage_InvalidJSON(t *testing.T) {
	raw := json.RawMessage(`not json`)
	_, err := ParseMessage(raw)
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

// --- Content Block Tests ---

func TestAssistantMessage_GetContentBlocks(t *testing.T) {
	am := AssistantMessage{
		Type: "assistant",
		Message: json.RawMessage(`{
			"role":"assistant",
			"content":[
				{"type":"thinking","thinking":"Let me think..."},
				{"type":"text","text":"The answer is 4."},
				{"type":"tool_use","id":"tu-1","name":"Read","input":{"path":"/tmp"}},
				{"type":"tool_result","tool_use_id":"tu-1","content":"file contents"}
			]
		}`),
	}

	blocks := am.GetContentBlocks()
	if len(blocks) != 4 {
		t.Fatalf("expected 4 blocks, got %d", len(blocks))
	}

	if _, ok := blocks[0].(ThinkingBlock); !ok {
		t.Errorf("block 0: expected ThinkingBlock, got %T", blocks[0])
	}
	if tb, ok := blocks[1].(TextBlock); !ok || tb.Text != "The answer is 4." {
		t.Errorf("block 1: expected TextBlock with text, got %T", blocks[1])
	}
	if tu, ok := blocks[2].(ToolUseBlock); !ok || tu.Name != "Read" {
		t.Errorf("block 2: expected ToolUseBlock, got %T", blocks[2])
	}
	if tr, ok := blocks[3].(ToolResultBlock); !ok || tr.ToolUseID != "tu-1" {
		t.Errorf("block 3: expected ToolResultBlock, got %T", blocks[3])
	}
}

func TestAssistantMessage_GetContentBlocks_BadJSON(t *testing.T) {
	am := AssistantMessage{Message: json.RawMessage(`not json`)}
	blocks := am.GetContentBlocks()
	if blocks != nil {
		t.Errorf("expected nil for bad JSON, got %v", blocks)
	}
}

// --- Helper Tests ---

func TestIsResultMessage(t *testing.T) {
	if IsResultMessage(UserMessage{}) {
		t.Error("UserMessage should not be ResultMessage")
	}
	if !IsResultMessage(ResultMessage{Type: "result"}) {
		t.Error("ResultMessage should be ResultMessage")
	}
}

func TestIsAssistantMessage(t *testing.T) {
	if IsAssistantMessage(UserMessage{}) {
		t.Error("UserMessage should not be AssistantMessage")
	}
	if !IsAssistantMessage(AssistantMessage{Type: "assistant"}) {
		t.Error("AssistantMessage should be AssistantMessage")
	}
}

// --- Command Building Tests ---

func TestBuildArgs_Defaults(t *testing.T) {
	args := buildArgs(&ClaudeAgentOptions{})
	// Should always include --output-format stream-json and --verbose
	found := map[string]bool{}
	for _, a := range args {
		found[a] = true
	}
	if !found["--output-format"] || !found["stream-json"] {
		t.Error("expected --output-format stream-json")
	}
	if !found["--verbose"] {
		t.Error("expected --verbose")
	}
}

func TestBuildArgs_Model(t *testing.T) {
	args := buildArgs(&ClaudeAgentOptions{Model: "claude-sonnet-4-6"})
	foundModel := false
	for i, a := range args {
		if a == "--model" && i+1 < len(args) && args[i+1] == "claude-sonnet-4-6" {
			foundModel = true
		}
	}
	if !foundModel {
		t.Error("expected --model claude-sonnet-4-6 in args")
	}
}

func TestBuildArgs_PermissionMode(t *testing.T) {
	args := buildArgs(&ClaudeAgentOptions{PermissionMode: PermissionModeBypassPermissions})
	found := false
	for i, a := range args {
		if a == "--permission-mode" && i+1 < len(args) && args[i+1] == "bypassPermissions" {
			found = true
		}
	}
	if !found {
		t.Error("expected --permission-mode bypassPermissions")
	}
}

func TestBuildArgs_MaxTurns(t *testing.T) {
	turns := 5
	args := buildArgs(&ClaudeAgentOptions{MaxTurns: &turns})
	found := false
	for i, a := range args {
		if a == "--max-turns" && i+1 < len(args) && args[i+1] == "5" {
			found = true
		}
	}
	if !found {
		t.Error("expected --max-turns 5")
	}
}

func TestBuildArgs_AllowedTools(t *testing.T) {
	args := buildArgs(&ClaudeAgentOptions{
		AllowedTools: []string{"Read", "Write"},
	})
	// Now comma-joined: single --allowedTools "Read,Write"
	v := argValue(args, "--allowedTools")
	if v != "Read,Write" {
		t.Errorf("expected --allowedTools 'Read,Write', got %q", v)
	}
}

func TestBuildArgs_DangerouslySkipPermissions(t *testing.T) {
	args := buildArgs(&ClaudeAgentOptions{AllowDangerouslySkipPermissions: true})
	found := false
	for _, a := range args {
		if a == "--dangerously-skip-permissions" {
			found = true
		}
	}
	if !found {
		t.Error("expected --dangerously-skip-permissions")
	}
}

func TestBuildArgs_Thinking(t *testing.T) {
	args := buildArgs(&ClaudeAgentOptions{
		Thinking: &ThinkingConfig{Type: "enabled", BudgetTokens: 4096},
	})
	// enabled maps to --max-thinking-tokens, not --thinking
	found := false
	for i, a := range args {
		if a == "--max-thinking-tokens" && i+1 < len(args) && args[i+1] == "4096" {
			found = true
		}
	}
	if !found {
		t.Error("expected --max-thinking-tokens 4096")
	}
}

func TestBuildArgs_Debug(t *testing.T) {
	args := buildArgs(&ClaudeAgentOptions{Debug: true, DebugFile: "/tmp/debug.log"})
	foundDebug := false
	foundFile := false
	for i, a := range args {
		if a == "--debug" {
			foundDebug = true
		}
		if a == "--debug-file" && i+1 < len(args) && args[i+1] == "/tmp/debug.log" {
			foundFile = true
		}
	}
	if !foundDebug {
		t.Error("expected --debug")
	}
	if !foundFile {
		t.Error("expected --debug-file /tmp/debug.log")
	}
}

// --- Permission Result Serialization ---

func TestPermissionResult_MarshalJSON_Allow(t *testing.T) {
	pr := PermissionResult{
		Allow: &PermissionResultAllow{
			Behavior: "allow",
		},
	}
	data, err := json.Marshal(pr)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}
	var m map[string]any
	json.Unmarshal(data, &m)
	if m["behavior"] != "allow" {
		t.Errorf("expected behavior allow, got %v", m["behavior"])
	}
}

func TestPermissionResult_MarshalJSON_Deny(t *testing.T) {
	pr := PermissionResult{
		Deny: &PermissionResultDeny{
			Behavior: "deny",
			Message:  "not allowed",
		},
	}
	data, err := json.Marshal(pr)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}
	var m map[string]any
	json.Unmarshal(data, &m)
	if m["behavior"] != "deny" {
		t.Errorf("expected behavior deny, got %v", m["behavior"])
	}
	if m["message"] != "not allowed" {
		t.Errorf("expected message 'not allowed', got %v", m["message"])
	}
}

func TestPermissionResult_MarshalJSON_Empty(t *testing.T) {
	pr := PermissionResult{}
	data, err := json.Marshal(pr)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}
	if string(data) != "null" {
		t.Errorf("expected null, got %s", data)
	}
}

// --- Error Types ---

func TestCLINotFoundError(t *testing.T) {
	err := NewCLINotFoundError([]string{"/usr/bin/claude", "/usr/local/bin/claude"})
	if err.SearchPaths[0] != "/usr/bin/claude" {
		t.Error("expected search path")
	}
	if err.Error() == "" {
		t.Error("expected non-empty error message")
	}
}

func TestProcessError(t *testing.T) {
	err := NewProcessError(1, "something failed")
	if err.ExitCode != 1 {
		t.Errorf("expected exit code 1, got %d", err.ExitCode)
	}
	if err.Stderr != "something failed" {
		t.Errorf("expected stderr, got %s", err.Stderr)
	}
}

func TestJSONDecodeError(t *testing.T) {
	err := NewJSONDecodeError("bad data", fmt.Errorf("parse error"))
	if err.RawData != "bad data" {
		t.Errorf("expected raw data")
	}
	wrapped := err.Unwrap()
	if wrapped == nil || wrapped.Error() != "parse error" {
		t.Error("expected wrapped error")
	}
}

func TestMessageParseError(t *testing.T) {
	err := NewMessageParseError(`{"type":"bad"}`, "type", fmt.Errorf("unknown"))
	if err.Field != "type" {
		t.Errorf("expected field 'type', got %s", err.Field)
	}
}

// --- Mock Transport for Unit Testing ---

type mockTransport struct {
	messages   []json.RawMessage
	written    []string
	connected  bool
	closed     bool
	endedInput bool
}

func (m *mockTransport) Connect(ctx context.Context) error {
	m.connected = true
	return nil
}

func (m *mockTransport) Write(ctx context.Context, data string) error {
	m.written = append(m.written, data)
	return nil
}

func (m *mockTransport) ReadMessages(ctx context.Context) (<-chan json.RawMessage, <-chan error) {
	msgCh := make(chan json.RawMessage, len(m.messages))
	errCh := make(chan error)
	for _, msg := range m.messages {
		msgCh <- msg
	}
	close(msgCh)
	close(errCh)
	return msgCh, errCh
}

func (m *mockTransport) Close() error {
	m.closed = true
	return nil
}

func (m *mockTransport) IsReady() bool {
	return m.connected && !m.closed
}

func (m *mockTransport) EndInput() error {
	m.endedInput = true
	return nil
}

// --- Query Handler Tests ---

func TestQueryHandler_RouteDataMessage(t *testing.T) {
	mt := &mockTransport{
		messages: []json.RawMessage{
			json.RawMessage(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}]}}`),
			json.RawMessage(`{"type":"result","subtype":"success","cost_usd":0.001}`),
		},
	}

	handler := newQueryHandler(mt, &ClaudeAgentOptions{})
	ctx := context.Background()
	ch := handler.runMessageRouter(ctx)

	var msgs []Message
	for msg := range ch {
		msgs = append(msgs, msg)
	}

	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	if _, ok := msgs[0].(AssistantMessage); !ok {
		t.Errorf("expected AssistantMessage, got %T", msgs[0])
	}
	if _, ok := msgs[1].(ResultMessage); !ok {
		t.Errorf("expected ResultMessage, got %T", msgs[1])
	}
}

func TestQueryHandler_SendPrompt(t *testing.T) {
	mt := &mockTransport{}
	mt.Connect(context.Background())

	handler := newQueryHandler(mt, &ClaudeAgentOptions{})
	err := handler.sendPrompt(context.Background(), "Hello, world!")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(mt.written) != 1 {
		t.Fatalf("expected 1 write, got %d", len(mt.written))
	}

	var msg map[string]any
	if err := json.Unmarshal([]byte(mt.written[0]), &msg); err != nil {
		t.Fatalf("written data is not valid JSON: %v", err)
	}
	if msg["type"] != "user" {
		t.Errorf("expected type user, got %v", msg["type"])
	}
	message, ok := msg["message"].(map[string]any)
	if !ok {
		t.Fatalf("expected message field to be a map, got %T", msg["message"])
	}
	if message["role"] != "user" {
		t.Errorf("expected role user, got %v", message["role"])
	}
	if message["content"] != "Hello, world!" {
		t.Errorf("expected content, got %v", message["content"])
	}
}

// --- Type Constant Tests ---

func TestPermissionModeConstants(t *testing.T) {
	modes := []PermissionMode{
		PermissionModeDefault, PermissionModeAcceptEdits, PermissionModeBypassPermissions,
		PermissionModePlan, PermissionModeDontAsk, PermissionModeAuto,
	}
	expected := []string{"default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"}
	for i, m := range modes {
		if string(m) != expected[i] {
			t.Errorf("PermissionMode[%d]: expected %s, got %s", i, expected[i], m)
		}
	}
}

func TestTerminalReasonConstants(t *testing.T) {
	reasons := []TerminalReason{
		TerminalReasonEndTurn, TerminalReasonMaxTurns, TerminalReasonInterrupt,
	}
	expected := []string{"end_turn", "max_turns", "interrupt"}
	for i, r := range reasons {
		if string(r) != expected[i] {
			t.Errorf("TerminalReason[%d]: expected %s, got %s", i, expected[i], r)
		}
	}
}

// --- New Message Type Tests ---

func TestParseMessage_TaskStarted(t *testing.T) {
	raw := json.RawMessage(`{
		"type":"system",
		"subtype":"task_started",
		"task_id":"task-42",
		"description":"Running tests",
		"uuid":"uuid-ts-1",
		"session_id":"sess-ts",
		"tool_use_id":"tu-ts",
		"task_type":"background"
	}`)
	msg, err := ParseMessage(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	ts, ok := msg.(TaskStartedMessage)
	if !ok {
		t.Fatalf("expected TaskStartedMessage, got %T", msg)
	}
	if ts.Type != "system" {
		t.Errorf("expected type system, got %s", ts.Type)
	}
	if ts.Subtype != "task_started" {
		t.Errorf("expected subtype task_started, got %s", ts.Subtype)
	}
	if ts.TaskID != "task-42" {
		t.Errorf("expected task_id task-42, got %s", ts.TaskID)
	}
	if ts.Description != "Running tests" {
		t.Errorf("expected description 'Running tests', got %s", ts.Description)
	}
	if ts.UUID != "uuid-ts-1" {
		t.Errorf("expected uuid uuid-ts-1, got %s", ts.UUID)
	}
	if ts.SessionID != "sess-ts" {
		t.Errorf("expected session_id sess-ts, got %s", ts.SessionID)
	}
	if ts.ToolUseID != "tu-ts" {
		t.Errorf("expected tool_use_id tu-ts, got %s", ts.ToolUseID)
	}
	if ts.TaskType != "background" {
		t.Errorf("expected task_type background, got %s", ts.TaskType)
	}
	if ts.MessageType() != "system" {
		t.Errorf("expected MessageType() system, got %s", ts.MessageType())
	}
}

func TestParseMessage_TaskProgress(t *testing.T) {
	raw := json.RawMessage(`{
		"type":"system",
		"subtype":"task_progress",
		"task_id":"task-43",
		"description":"Processing step 2",
		"uuid":"uuid-tp-1",
		"session_id":"sess-tp",
		"tool_use_id":"tu-tp",
		"last_tool_name":"Read",
		"usage":{"total_tokens":500,"tool_uses":3,"duration_ms":1200}
	}`)
	msg, err := ParseMessage(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	tp, ok := msg.(TaskProgressMessage)
	if !ok {
		t.Fatalf("expected TaskProgressMessage, got %T", msg)
	}
	if tp.Type != "system" {
		t.Errorf("expected type system, got %s", tp.Type)
	}
	if tp.Subtype != "task_progress" {
		t.Errorf("expected subtype task_progress, got %s", tp.Subtype)
	}
	if tp.TaskID != "task-43" {
		t.Errorf("expected task_id task-43, got %s", tp.TaskID)
	}
	if tp.Description != "Processing step 2" {
		t.Errorf("expected description 'Processing step 2', got %s", tp.Description)
	}
	if tp.UUID != "uuid-tp-1" {
		t.Errorf("expected uuid uuid-tp-1, got %s", tp.UUID)
	}
	if tp.LastToolName != "Read" {
		t.Errorf("expected last_tool_name Read, got %s", tp.LastToolName)
	}
	if tp.Usage == nil {
		t.Fatal("expected usage to be non-nil")
	}
	if tp.Usage.TotalTokens != 500 {
		t.Errorf("expected total_tokens 500, got %d", tp.Usage.TotalTokens)
	}
	if tp.Usage.ToolUses != 3 {
		t.Errorf("expected tool_uses 3, got %d", tp.Usage.ToolUses)
	}
	if tp.Usage.DurationMs != 1200 {
		t.Errorf("expected duration_ms 1200, got %d", tp.Usage.DurationMs)
	}
	if tp.MessageType() != "system" {
		t.Errorf("expected MessageType() system, got %s", tp.MessageType())
	}
}

func TestParseMessage_TaskNotification(t *testing.T) {
	raw := json.RawMessage(`{
		"type":"system",
		"subtype":"task_notification",
		"task_id":"task-44",
		"status":"completed",
		"output_file":"/out/result.txt",
		"summary":"All tests passed",
		"uuid":"uuid-tn-1",
		"session_id":"sess-tn",
		"tool_use_id":"tu-tn",
		"usage":{"total_tokens":1000,"tool_uses":5,"duration_ms":3000}
	}`)
	msg, err := ParseMessage(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	tn, ok := msg.(TaskNotificationMessage)
	if !ok {
		t.Fatalf("expected TaskNotificationMessage, got %T", msg)
	}
	if tn.Type != "system" {
		t.Errorf("expected type system, got %s", tn.Type)
	}
	if tn.Subtype != "task_notification" {
		t.Errorf("expected subtype task_notification, got %s", tn.Subtype)
	}
	if tn.TaskID != "task-44" {
		t.Errorf("expected task_id task-44, got %s", tn.TaskID)
	}
	if tn.Status != TaskNotificationCompleted {
		t.Errorf("expected status completed, got %s", tn.Status)
	}
	if tn.OutputFile != "/out/result.txt" {
		t.Errorf("expected output_file /out/result.txt, got %s", tn.OutputFile)
	}
	if tn.Summary != "All tests passed" {
		t.Errorf("expected summary 'All tests passed', got %s", tn.Summary)
	}
	if tn.UUID != "uuid-tn-1" {
		t.Errorf("expected uuid uuid-tn-1, got %s", tn.UUID)
	}
	if tn.Usage == nil {
		t.Fatal("expected usage to be non-nil")
	}
	if tn.Usage.TotalTokens != 1000 {
		t.Errorf("expected total_tokens 1000, got %d", tn.Usage.TotalTokens)
	}
	if tn.MessageType() != "system" {
		t.Errorf("expected MessageType() system, got %s", tn.MessageType())
	}
}

func TestParseMessage_StreamEvent(t *testing.T) {
	raw := json.RawMessage(`{
		"type":"stream_event",
		"uuid":"uuid-se-1",
		"session_id":"sess-se",
		"event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}},
		"parent_tool_use_id":"tu-parent"
	}`)
	msg, err := ParseMessage(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	se, ok := msg.(StreamEvent)
	if !ok {
		t.Fatalf("expected StreamEvent, got %T", msg)
	}
	if se.Type != "stream_event" {
		t.Errorf("expected type stream_event, got %s", se.Type)
	}
	if se.UUID != "uuid-se-1" {
		t.Errorf("expected uuid uuid-se-1, got %s", se.UUID)
	}
	if se.SessionID != "sess-se" {
		t.Errorf("expected session_id sess-se, got %s", se.SessionID)
	}
	if se.Event == nil {
		t.Fatal("expected event to be non-nil")
	}
	if se.Event["type"] != "content_block_delta" {
		t.Errorf("expected event type content_block_delta, got %v", se.Event["type"])
	}
	if se.ParentToolUseID == nil || *se.ParentToolUseID != "tu-parent" {
		t.Errorf("expected parent_tool_use_id tu-parent, got %v", se.ParentToolUseID)
	}
	if se.MessageType() != "stream_event" {
		t.Errorf("expected MessageType() stream_event, got %s", se.MessageType())
	}
}

// --- ResultMessage Custom JSON Tests ---

func TestResultMessage_UnmarshalCostUSD(t *testing.T) {
	data := []byte(`{
		"type":"result",
		"subtype":"success",
		"cost_usd":0.0042,
		"duration_ms":1500,
		"session_id":"sess-1",
		"num_turns":3
	}`)
	var rm ResultMessage
	if err := json.Unmarshal(data, &rm); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if rm.CostUSD != 0.0042 {
		t.Errorf("expected CostUSD 0.0042, got %f", rm.CostUSD)
	}
	if rm.SessionID != "sess-1" {
		t.Errorf("expected session_id sess-1, got %s", rm.SessionID)
	}
	if rm.NumTurns != 3 {
		t.Errorf("expected num_turns 3, got %d", rm.NumTurns)
	}
}

func TestResultMessage_UnmarshalTotalCostUSD(t *testing.T) {
	data := []byte(`{
		"type":"result",
		"subtype":"success",
		"total_cost_usd":0.0099,
		"duration_ms":2000,
		"session_id":"sess-2"
	}`)
	var rm ResultMessage
	if err := json.Unmarshal(data, &rm); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if rm.CostUSD != 0.0099 {
		t.Errorf("expected CostUSD 0.0099, got %f", rm.CostUSD)
	}
}

func TestResultMessage_MarshalCostUSD(t *testing.T) {
	rm := ResultMessage{
		Type:      "result",
		Subtype:   "success",
		CostUSD:   0.005,
		SessionID: "sess-3",
	}
	data, err := json.Marshal(rm)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("unmarshal map error: %v", err)
	}
	// MarshalJSON outputs "total_cost_usd"
	if v, ok := m["total_cost_usd"]; !ok {
		t.Error("expected total_cost_usd field in marshaled output")
	} else if v.(float64) != 0.005 {
		t.Errorf("expected total_cost_usd 0.005, got %v", v)
	}
	// CostUSD should not appear as a separate field since it has no json tag
	if _, ok := m["cost_usd"]; ok {
		t.Error("did not expect cost_usd field in marshaled output (should be total_cost_usd)")
	}
}

func TestResultMessage_BothCostFields(t *testing.T) {
	// When both fields are present, total_cost_usd wins because it's checked first
	data := []byte(`{
		"type":"result",
		"cost_usd":0.001,
		"total_cost_usd":0.009,
		"session_id":"sess-4"
	}`)
	var rm ResultMessage
	if err := json.Unmarshal(data, &rm); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if rm.CostUSD != 0.009 {
		t.Errorf("expected CostUSD 0.009 (total_cost_usd wins), got %f", rm.CostUSD)
	}
}

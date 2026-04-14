# Hooks Guide

## Overview

Hooks let you intercept and customize agent behavior at key lifecycle points. When a hook fires, the Claude CLI sends a callback to the SDK, which executes your registered function and returns the result.

## Hook Types

| Hook | When it fires | Use cases |
|------|---------------|-----------|
| `PreToolUse` | Before a tool is executed | Approve/deny tool calls, log tool usage |
| `PostToolUse` | After a tool completes | Audit results, modify outputs |
| `Notification` | When the agent emits a notification | Progress tracking, alerts |
| `Stop` | When the agent is about to stop | Cleanup, force continuation |

## Basic Usage

```go
agent := sdk.NewAgent(sdk.AgentConfig{
    Name:           "my-agent",
    PermissionMode: sdk.PermissionModeDontAsk,
    Hooks: map[string][]sdk.HookCallbackMatcher{
        "PreToolUse": {
            {
                Callback: func(input sdk.HookInput) (*sdk.HookJSONOutput, error) {
                    pre := input.(*sdk.PreToolUseHookInput)
                    fmt.Printf("Tool: %s\n", pre.ToolName)
                    return nil, nil // allow
                },
            },
        },
    },
})
```

## Hook Inputs

### PreToolUseHookInput

```go
type PreToolUseHookInput struct {
    SessionID  string         `json:"session_id"`
    ToolName   string         `json:"tool_name"`
    ToolInput  map[string]any `json:"tool_input"`
    ServerName string         `json:"server_name,omitempty"` // MCP server name
}
```

### PostToolUseHookInput

```go
type PostToolUseHookInput struct {
    SessionID   string         `json:"session_id"`
    ToolName    string         `json:"tool_name"`
    ToolInput   map[string]any `json:"tool_input"`
    ToolResult  any            `json:"tool_result"`
    ServerName  string         `json:"server_name,omitempty"`
}
```

### NotificationHookInput

```go
type NotificationHookInput struct {
    SessionID string `json:"session_id"`
    Message   string `json:"message"`
}
```

### StopHookInput

```go
type StopHookInput struct {
    SessionID  string `json:"session_id"`
    StopReason string `json:"stop_reason"`
}
```

## Hook Outputs

Return `nil` to allow the default behavior. Return a `HookJSONOutput` to modify behavior:

```go
type HookJSONOutput struct {
    SuppressOutput bool   `json:"suppressOutput,omitempty"`
    StopReason     string `json:"stopReason,omitempty"`
    Decision       string `json:"decision,omitempty"`       // "allow", "deny", "block"
    SystemMessage  string `json:"systemMessage,omitempty"`
    Reason         string `json:"reason,omitempty"`
    
    // Hook-specific output (depends on hook type)
    HookSpecificOutput *HookSpecificOutput `json:"hookSpecificOutput,omitempty"`
}
```

### Decisions

| Decision | Effect |
|----------|--------|
| `""` (empty) | Allow (default) |
| `"allow"` | Explicitly allow |
| `"deny"` | Deny the operation |
| `"block"` | Block with a system message |

## Examples

### Log All Tool Usage

```go
"PostToolUse": {
    {
        Callback: func(input sdk.HookInput) (*sdk.HookJSONOutput, error) {
            post := input.(*sdk.PostToolUseHookInput)
            log.Printf("Tool %s completed: %v", post.ToolName, post.ToolResult)
            return nil, nil
        },
    },
},
```

### Block Dangerous Commands

```go
"PreToolUse": {
    {
        ToolName: "Bash",  // Only match Bash tool
        Callback: func(input sdk.HookInput) (*sdk.HookJSONOutput, error) {
            pre := input.(*sdk.PreToolUseHookInput)
            cmd, _ := pre.ToolInput["command"].(string)
            if strings.Contains(cmd, "rm -rf") {
                return &sdk.HookJSONOutput{
                    Decision:      "block",
                    Reason:        "Dangerous command blocked",
                    SystemMessage: "That command is not allowed.",
                }, nil
            }
            return nil, nil
        },
    },
},
```

### Force Stop After Notification

```go
"Notification": {
    {
        Callback: func(input sdk.HookInput) (*sdk.HookJSONOutput, error) {
            notif := input.(*sdk.NotificationHookInput)
            if strings.Contains(notif.Message, "error") {
                return &sdk.HookJSONOutput{
                    StopReason: "Error detected in notification",
                }, nil
            }
            return nil, nil
        },
    },
},
```

## Matcher Filtering

Use `ToolName` on the matcher to filter which tool triggers the callback:

```go
sdk.HookCallbackMatcher{
    ToolName: "Read",     // Only fires for the Read tool
    Callback: myCallback,
}
```

Leave `ToolName` empty to match all tools.

## How It Works Internally

1. During `initialize`, the SDK registers each callback with a unique ID (`hook_0`, `hook_1`, etc.)
2. The hook configuration (including callback IDs) is sent to the CLI
3. When a hook fires, the CLI sends a `hook_callback` control request with the callback ID and input data
4. The SDK looks up and executes the callback
5. The callback's return value is sent back as a control response
6. If the callback returns an error, an error response is sent and the agent continues

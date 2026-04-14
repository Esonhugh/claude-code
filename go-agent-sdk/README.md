# Go Claude Agent SDK

A Go SDK for building AI agents powered by [Claude Code](https://docs.anthropic.com/en/docs/claude-code). This is a Go port of the official [Python `claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-python), providing the same feature set with idiomatic Go patterns.

## Features

- **Simple one-shot queries** — `Query()` for fire-and-forget prompts with streaming results
- **Multi-turn conversations** — `ClaudeSDKClient` for bidirectional streaming sessions
- **Agent abstraction** — `Agent` with configurable system prompts, tools, and permission modes
- **Pipeline chaining** — Compose agents sequentially with `Pipeline`
- **Parallel execution** — `RunParallel`, `FanOut`, and `Race` for concurrent agent tasks
- **Hook system** — Register callbacks for `pre_tool_use`, `post_tool_use`, `notification`, `stop` events
- **Session management** — List, read, rename, tag, delete, and fork sessions
- **Full control protocol** — MCP server management, context usage, file rewinding, task control

## Requirements

- Go 1.22+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

## Installation

```bash
go get github.com/Esonhugh/goClaudeAgentSDK
```

## Quick Start

### One-shot Query

```go
package main

import (
    "context"
    "fmt"
    "time"

    sdk "github.com/Esonhugh/goClaudeAgentSDK"
)

func main() {
    ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
    defer cancel()

    msgs, errs := sdk.Query(ctx, "What is the capital of France?", &sdk.ClaudeAgentOptions{
        PermissionMode: sdk.PermissionModeDontAsk,
    })

    for msg := range msgs {
        switch m := msg.(type) {
        case sdk.AssistantMessage:
            fmt.Println(sdk.GetTextContent(m))
        case sdk.ResultMessage:
            fmt.Printf("Done: %d turns, $%.4f\n", m.NumTurns, m.CostUSD)
        }
    }

    for err := range errs {
        fmt.Printf("Error: %v\n", err)
    }
}
```

### Multi-turn Conversation

```go
client := sdk.NewClient(&sdk.ClaudeAgentOptions{
    PermissionMode: sdk.PermissionModeDontAsk,
})

if err := client.Connect(ctx); err != nil {
    log.Fatal(err)
}
defer client.Close()

// First turn
client.SendQuery(ctx, "Write a hello world in Go")
for msg := range client.ReceiveMessages(ctx) {
    // process messages...
}

// Follow-up
client.SendQuery(ctx, "Now add error handling")
for msg := range client.ReceiveMessages(ctx) {
    // process messages...
}
```

### Agent with Configuration

```go
agent := sdk.NewAgent(sdk.AgentConfig{
    Name:           "code-reviewer",
    Model:          "claude-sonnet-4-20250514",
    SystemPrompt:   "You are an expert Go code reviewer. Be concise.",
    PermissionMode: sdk.PermissionModeDontAsk,
    MaxTurns:       intPtr(5),
})

result, err := agent.Run(ctx, "Review this function: ...")
if err != nil {
    log.Fatal(err)
}
fmt.Println(result.Text)
```

### Pipeline (Sequential Agent Chaining)

```go
pipeline := sdk.NewPipeline(
    sdk.PipelineStep{
        Agent: sdk.NewAgent(sdk.AgentConfig{
            Name:         "coder",
            SystemPrompt: "Write clean Go code.",
        }),
    },
    sdk.PipelineStep{
        Agent: sdk.NewAgent(sdk.AgentConfig{
            Name:         "reviewer",
            SystemPrompt: "Review Go code for bugs and improvements.",
        }),
        TransformInput: func(prev string) string {
            return "Review this code:\n" + prev
        },
    },
)

result, err := pipeline.Run(ctx, "Write a concurrent-safe LRU cache")
```

### Parallel Execution

```go
// Fan-out: same prompt to multiple agents
results := sdk.FanOut(ctx, "Explain monads", agent1, agent2, agent3)

// Race: first agent to complete wins
winner, err := sdk.Race(ctx, "Quick question", fastAgent, thoroughAgent)

// Custom parallel tasks
results := sdk.RunParallel(ctx, []sdk.ParallelTask{
    {Agent: agent1, Prompt: "Task A"},
    {Agent: agent2, Prompt: "Task B"},
})
```

## Configuration

### ClaudeAgentOptions

| Field | Type | Description |
|-------|------|-------------|
| `Model` | `string` | Claude model to use |
| `FallbackModel` | `string` | Fallback model if primary unavailable |
| `PermissionMode` | `PermissionMode` | Permission handling: `"default"`, `"acceptEdits"`, `"bypassPermissions"`, `"plan"` |
| `CWD` | `string` | Working directory for the agent |
| `MaxTurns` | `*int` | Maximum conversation turns |
| `MaxBudgetUsd` | `*float64` | Spending cap in USD |
| `SystemPrompt` | `any` | System prompt (`string`, `SystemPromptPreset`, or `SystemPromptFile`) |
| `AllowedTools` | `[]string` | Explicitly allowed tools |
| `DisallowedTools` | `[]string` | Explicitly disallowed tools |
| `Hooks` | `map[string][]HookCallbackMatcher` | Hook callbacks (see Hooks section) |
| `Debug` | `bool` | Enable debug output |
| `Env` | `map[string]string` | Additional environment variables |

See `types.go` for the full list of options.

### Environment Variables

The SDK defines constants for all Claude Code environment variables:

```go
sdk.CLAUDE_CODE_CONFIG_DIR              // Override config dir (~/.claude)
sdk.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT    // Handshake timeout (ms)
sdk.CLAUDE_CODE_SKIP_VERSION_CHECK      // Skip CLI version check
sdk.CLAUDE_CODE_ENABLE_FILE_CHECKPOINTING // Enable file checkpointing
sdk.CLAUDE_CODE_ENTRYPOINT              // SDK entrypoint identifier
sdk.CLAUDE_CODE_SDK_VERSION             // SDK version
```

### Permission Modes

```go
sdk.PermissionModeDefault          // Interactive permission prompts
sdk.PermissionModeAcceptEdits      // Auto-accept file edits
sdk.PermissionModeDontAsk          // Bypass all permissions (use with caution)
sdk.PermissionModePlan             // Planning mode, no execution
```

## Message Types

All messages implement the `Message` interface:

| Type | Description |
|------|-------------|
| `UserMessage` | User input |
| `AssistantMessage` | Claude's response with content blocks |
| `SystemMessage` | System events |
| `TaskStartedMessage` | Task lifecycle: started |
| `TaskProgressMessage` | Task lifecycle: progress update |
| `TaskNotificationMessage` | Task lifecycle: notification |
| `ResultMessage` | Final result with cost, turns, session ID |
| `StreamEvent` | Raw stream events |

### Content Blocks

Assistant messages contain typed content blocks:

```go
switch block := block.(type) {
case sdk.TextBlock:
    fmt.Println(block.Text)
case sdk.ToolUseBlock:
    fmt.Printf("Tool: %s(%v)\n", block.Name, block.Input)
case sdk.ToolResultBlock:
    fmt.Printf("Result: %v\n", block.Content)
case sdk.ThinkingBlock:
    fmt.Println("Thinking:", block.Thinking)
}
```

## Hooks

Register callbacks for agent lifecycle events:

```go
agent := sdk.NewAgent(sdk.AgentConfig{
    Hooks: map[string][]sdk.HookCallbackMatcher{
        "PreToolUse": {
            {
                Callback: func(input sdk.HookInput) (*sdk.HookJSONOutput, error) {
                    if pre, ok := input.(*sdk.PreToolUseHookInput); ok {
                        fmt.Printf("About to use tool: %s\n", pre.ToolName)
                    }
                    return nil, nil // allow
                },
            },
        },
    },
})
```

Hook types: `PreToolUse`, `PostToolUse`, `Notification`, `Stop`

## Session Management

```go
// List sessions for a project
sessions := sdk.ListSessions(sdk.ListSessionsOptions{
    Directory: "/path/to/project",
})

// Get session details
info, err := sdk.GetSessionInfo("session-uuid", "/path/to/project")

// Read session messages
messages, err := sdk.GetSessionMessages("session-uuid", "/path/to/project")

// Rename, tag, delete
sdk.RenameSession("session-uuid", "My Session", "/path/to/project")
sdk.TagSession("session-uuid", "important", "/path/to/project")
sdk.DeleteSession("session-uuid", "/path/to/project")

// Fork a session
result, err := sdk.ForkSession("session-uuid", "/path/to/project", "msg-id", "Fork Title")
```

## Client Control Methods

The `ClaudeSDKClient` provides control over active sessions:

```go
client.Interrupt(ctx)                              // Interrupt current operation
client.SetPermissionMode(ctx, sdk.PermissionModeDontAsk)
client.SetModel(ctx, "claude-sonnet-4-20250514")
client.GetMCPStatus(ctx)                           // MCP server status
client.GetContextUsage(ctx)                        // Token usage info
client.RewindFiles(ctx, messageID)                 // Revert file changes
client.ReconnectMcpServer(ctx, "server-name")      // Reconnect MCP server
client.ToggleMcpServer(ctx, "server-name", true)   // Enable/disable MCP
client.StopTask(ctx, "task-id")                    // Stop a running task
client.GetServerInfo()                             // Server capabilities
```

## Error Handling

The SDK provides typed errors for common failure modes:

```go
switch {
case errors.As(err, &sdk.CLIConnectionError{}):
    // CLI process failed to start
case errors.As(err, &sdk.CLINotFoundError{}):
    // Claude CLI not found in PATH
case errors.As(err, &sdk.ProcessExitError{}):
    // CLI process exited unexpectedly
}
```

## Examples

See the [`examples/`](./examples/) directory:

- [`quickstart`](./examples/quickstart/) — One-shot query
- [`streaming`](./examples/streaming/) — Multi-turn conversation
- [`tooluse`](./examples/tooluse/) — Tool use handling
- [`calculator`](./examples/calculator/) — Calculator agent
- [`codereview`](./examples/codereview/) — Code review agent
- [`pipeline`](./examples/pipeline/) — Sequential agent pipeline
- [`multiagent`](./examples/multiagent/) — Multi-agent orchestration

## Project Structure

```
├── sdk.go                  # Query() entry point
├── client.go               # ClaudeSDKClient (multi-turn)
├── agent.go                # Agent abstraction
├── pipeline.go             # Pipeline (sequential chaining)
├── parallel.go             # Parallel execution (FanOut, Race)
├── types.go                # All type definitions
├── transport.go            # Transport interface
├── subprocess_transport.go # CLI subprocess transport
├── query.go                # Control protocol handler
├── message_parser.go       # Message routing/parsing
├── sessions.go             # Session management
├── env.go                  # Environment variable constants
├── errors.go               # Error types
├── mock_transport.go       # Mock transport for testing
└── examples/               # Usage examples
```

## License

See [LICENSE](./LICENSE) for details.

## Acknowledgments

This SDK is a Go port of the [Python Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python) by Anthropic.

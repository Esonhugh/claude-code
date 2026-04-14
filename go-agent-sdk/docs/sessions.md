# Session Management Guide

## Overview

The Claude Code CLI persists conversations as JSONL files on disk. The Go SDK provides functions to list, read, rename, tag, delete, and fork these sessions programmatically.

## Session Storage

Sessions are stored at:
```
~/.claude/projects/<sanitized-project-path>/<session-uuid>.jsonl
```

The project path is sanitized by replacing non-alphanumeric characters with hyphens. For paths longer than 200 characters, a hash suffix is appended to prevent filesystem issues.

## Listing Sessions

```go
// All sessions across all projects
sessions := sdk.ListSessions(sdk.ListSessionsOptions{})

// Sessions for a specific project
sessions := sdk.ListSessions(sdk.ListSessionsOptions{
    Directory: "/path/to/my/project",
})

// With pagination
limit := 10
sessions := sdk.ListSessions(sdk.ListSessionsOptions{
    Directory: "/path/to/my/project",
    Limit:     &limit,
    Offset:    20,
})
```

### SDKSessionInfo

Each session returns:

```go
type SDKSessionInfo struct {
    SessionID   string    // UUID of the session
    ProjectDir  string    // Sanitized project directory name
    CustomTitle string    // User-set title (via RenameSession)
    AITitle     string    // AI-generated title
    LastPrompt  string    // Last user prompt
    Summary     string    // Session summary
    CreatedAt   time.Time // File creation time
    UpdatedAt   time.Time // File modification time
    GitBranch   string    // Git branch when session was active
    CWD         string    // Working directory
    Tag         string    // User-set tag (via TagSession)
}
```

Sessions are sorted by update time (most recent first).

## Reading Session Messages

```go
messages, err := sdk.GetSessionMessages("session-uuid", "/path/to/project")
if err != nil {
    log.Fatal(err)
}

for _, msg := range messages {
    fmt.Printf("[%s] %s\n", msg.Type, msg.Timestamp)
}
```

Each message is a `SessionMessage` with the raw JSON preserved in `Message`.

## Getting Session Info

```go
info, err := sdk.GetSessionInfo("session-uuid", "/path/to/project")
if err != nil {
    log.Fatal(err)
}
fmt.Printf("Title: %s\nBranch: %s\n", info.AITitle, info.GitBranch)
```

If `directory` is empty, all project directories are searched.

## Renaming Sessions

```go
err := sdk.RenameSession("session-uuid", "My Important Session", "/path/to/project")
```

This prepends a JSON instruction to the JSONL file that the CLI reads on next load.

## Tagging Sessions

```go
err := sdk.TagSession("session-uuid", "v1.0-release", "/path/to/project")
```

Tags are stored similarly to renames — as JSONL entries prepended to the file.

## Deleting Sessions

```go
err := sdk.DeleteSession("session-uuid", "/path/to/project")
```

Permanently removes the JSONL file from disk.

## Forking Sessions

```go
result, err := sdk.ForkSession(
    "session-uuid",          // Source session
    "/path/to/project",      // Project directory
    "msg-uuid-123",          // Fork up to this message ID
    "Experiment Branch",     // Title for the fork
)
if err != nil {
    log.Fatal(err)
}
fmt.Printf("New session: %s\nFile: %s\n", result.SessionID, result.FilePath)
```

Forking copies messages from the source session up to the specified message, creating a new session file with a new UUID. This is useful for branching conversations.

## Path Sanitization

The SDK matches the CLI's path sanitization algorithm:

1. Replace non-alphanumeric characters (except hyphens) with `-`
2. Collapse consecutive hyphens
3. Remove leading/trailing hyphens
4. For paths > 200 characters: truncate and append a hash suffix

```go
// Example transformations:
// "/Users/dev/my-project" → "Users-dev-my-project"
// "/very/long/.../path"   → "very-long-path-<hash>"
```

## Performance

Session metadata (title, branch, summary, etc.) is extracted using efficient head/tail reads of the JSONL file (64KB each direction) rather than parsing the entire file. This makes `ListSessions` fast even with large session files.

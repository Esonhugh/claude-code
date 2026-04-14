package claudesdk

import "fmt"

// ClaudeSDKError is the base error type for all SDK errors.
type ClaudeSDKError struct {
	Message string
	Cause   error
}

func (e *ClaudeSDKError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("claude sdk error: %s: %v", e.Message, e.Cause)
	}
	return fmt.Sprintf("claude sdk error: %s", e.Message)
}

func (e *ClaudeSDKError) Unwrap() error { return e.Cause }

// CLINotFoundError is returned when the claude CLI binary cannot be found.
type CLINotFoundError struct {
	ClaudeSDKError
	SearchPaths []string
}

// CLIConnectionError is returned when the connection to the CLI process fails.
type CLIConnectionError struct {
	ClaudeSDKError
}

// ProcessError is returned when the CLI process exits unexpectedly.
type ProcessError struct {
	ClaudeSDKError
	ExitCode int
	Stderr   string
}

// CLIJSONDecodeError is returned when JSON from the CLI cannot be decoded.
type CLIJSONDecodeError struct {
	ClaudeSDKError
	RawData string
}

// MessageParseError is returned when a message cannot be parsed into a typed message.
type MessageParseError struct {
	ClaudeSDKError
	RawJSON string
	Field   string
}

// NewCLINotFoundError creates a new CLINotFoundError.
func NewCLINotFoundError(paths []string) *CLINotFoundError {
	return &CLINotFoundError{
		ClaudeSDKError: ClaudeSDKError{Message: "claude CLI binary not found"},
		SearchPaths:    paths,
	}
}

// NewCLIConnectionError creates a new CLIConnectionError.
func NewCLIConnectionError(msg string, cause error) *CLIConnectionError {
	return &CLIConnectionError{
		ClaudeSDKError: ClaudeSDKError{Message: msg, Cause: cause},
	}
}

// NewProcessError creates a new ProcessError.
func NewProcessError(exitCode int, stderr string) *ProcessError {
	return &ProcessError{
		ClaudeSDKError: ClaudeSDKError{Message: fmt.Sprintf("process exited with code %d", exitCode)},
		ExitCode:       exitCode,
		Stderr:         stderr,
	}
}

// NewJSONDecodeError creates a new CLIJSONDecodeError.
func NewJSONDecodeError(raw string, cause error) *CLIJSONDecodeError {
	return &CLIJSONDecodeError{
		ClaudeSDKError: ClaudeSDKError{Message: "failed to decode JSON from CLI", Cause: cause},
		RawData:        raw,
	}
}

// NewMessageParseError creates a new MessageParseError.
func NewMessageParseError(rawJSON, field string, cause error) *MessageParseError {
	return &MessageParseError{
		ClaudeSDKError: ClaudeSDKError{Message: fmt.Sprintf("failed to parse message field '%s'", field), Cause: cause},
		RawJSON:        rawJSON,
		Field:          field,
	}
}

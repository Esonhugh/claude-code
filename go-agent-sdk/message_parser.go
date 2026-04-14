package claudesdk

import (
	"encoding/json"
)

// ParseMessage parses a raw JSON message into a typed Message.
// Unknown message types return nil (forward-compatible).
func ParseMessage(raw json.RawMessage) (Message, error) {
	var base struct {
		Type    string `json:"type"`
		Subtype string `json:"subtype,omitempty"`
	}
	if err := json.Unmarshal(raw, &base); err != nil {
		return nil, NewMessageParseError(string(raw), "type", err)
	}

	switch base.Type {
	case "user":
		var msg UserMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			return nil, NewMessageParseError(string(raw), "user", err)
		}
		return msg, nil

	case "assistant":
		if base.Subtype == "partial" {
			var msg PartialAssistantMessage
			if err := json.Unmarshal(raw, &msg); err != nil {
				return nil, NewMessageParseError(string(raw), "partial_assistant", err)
			}
			return msg, nil
		}
		var msg AssistantMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			return nil, NewMessageParseError(string(raw), "assistant", err)
		}
		return msg, nil

	case "system":
		return parseSystemMessage(raw, base.Subtype)

	case "result":
		var msg ResultMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			return nil, NewMessageParseError(string(raw), "result", err)
		}
		msg.Raw = raw
		return msg, nil

	case "stream_event":
		var msg StreamEvent
		if err := json.Unmarshal(raw, &msg); err != nil {
			return nil, NewMessageParseError(string(raw), "stream_event", err)
		}
		return msg, nil

	case "rate_limit_event":
		var msg RateLimitEvent
		if err := json.Unmarshal(raw, &msg); err != nil {
			return nil, NewMessageParseError(string(raw), "rate_limit_event", err)
		}
		return msg, nil

	case "auth_status":
		var msg SystemMessage
		msg.Type = "system"
		msg.Subtype = "auth_status"
		msg.Raw = raw
		return msg, nil

	default:
		// Forward-compatible: return nil for unknown types
		return nil, nil
	}
}

// parseSystemMessage handles system message subtypes.
func parseSystemMessage(raw json.RawMessage, subtype string) (Message, error) {
	switch subtype {
	case "task_started":
		var msg TaskStartedMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			return nil, NewMessageParseError(string(raw), "task_started", err)
		}
		return msg, nil

	case "task_progress":
		var msg TaskProgressMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			return nil, NewMessageParseError(string(raw), "task_progress", err)
		}
		return msg, nil

	case "task_notification":
		var msg TaskNotificationMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			return nil, NewMessageParseError(string(raw), "task_notification", err)
		}
		return msg, nil

	default:
		var msg SystemMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			return nil, NewMessageParseError(string(raw), "system", err)
		}
		msg.Raw = raw
		return msg, nil
	}
}

// IsResultMessage returns true if the message is a ResultMessage.
func IsResultMessage(msg Message) bool {
	_, ok := msg.(ResultMessage)
	return ok
}

// IsAssistantMessage returns true if the message is an AssistantMessage.
func IsAssistantMessage(msg Message) bool {
	_, ok := msg.(AssistantMessage)
	return ok
}

// GetTextContent extracts all text content from an AssistantMessage.
func GetTextContent(msg AssistantMessage) string {
	blocks := msg.GetContentBlocks()
	var texts []string
	for _, b := range blocks {
		if tb, ok := b.(TextBlock); ok {
			texts = append(texts, tb.Text)
		}
	}
	result := ""
	for i, t := range texts {
		if i > 0 {
			result += "\n"
		}
		result += t
	}
	return result
}

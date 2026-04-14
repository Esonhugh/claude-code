package claudesdk

import (
	"encoding/json"
	"fmt"
)

// ParseMessage parses a raw JSON message into a typed Message.
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
		var msg SystemMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			return nil, NewMessageParseError(string(raw), "system", err)
		}
		msg.Raw = raw
		return msg, nil

	case "result":
		var msg ResultMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			return nil, NewMessageParseError(string(raw), "result", err)
		}
		msg.Raw = raw
		return msg, nil

	case "rate_limit_event":
		var msg RateLimitEvent
		if err := json.Unmarshal(raw, &msg); err != nil {
			return nil, NewMessageParseError(string(raw), "rate_limit_event", err)
		}
		return msg, nil

	case "auth_status":
		// Treat auth_status as a system message
		var msg SystemMessage
		msg.Type = "system"
		msg.Subtype = "auth_status"
		msg.Raw = raw
		return msg, nil

	default:
		return nil, NewMessageParseError(string(raw), "type",
			fmt.Errorf("unknown message type: %s", base.Type))
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

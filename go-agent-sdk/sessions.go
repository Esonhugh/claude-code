package claudesdk

import (
	"bufio"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode"
)

// --- Path sanitization (matches CLI's directory naming) ---

var sanitizeRe = regexp.MustCompile(`[^a-zA-Z0-9]`)
var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

const maxSanitizedLength = 200
const liteReadBufSize = 65536

// simpleHash produces a 32-bit hash matching the CLI's directory naming.
func simpleHash(s string) string {
	var h int32
	for _, ch := range s {
		h = (h << 5) - h + int32(ch)
	}
	if h < 0 {
		h = -h
	}
	if h == 0 {
		return "0"
	}
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
	var out []byte
	n := h
	for n > 0 {
		out = append(out, digits[n%36])
		n /= 36
	}
	// reverse
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return string(out)
}

func sanitizePath(name string) string {
	sanitized := sanitizeRe.ReplaceAllString(name, "-")
	if len(sanitized) <= maxSanitizedLength {
		return sanitized
	}
	h := simpleHash(name)
	return sanitized[:maxSanitizedLength] + "-" + h
}

// getClaudeConfigDir returns the Claude config directory (respects CLAUDE_CONFIG_DIR).
func getClaudeConfigDir() string {
	if dir := os.Getenv(CLAUDE_CODE_CONFIG_DIR); dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

func getProjectsDir() string {
	return filepath.Join(getClaudeConfigDir(), "projects")
}

func getProjectDir(projectPath string) string {
	return filepath.Join(getProjectsDir(), sanitizePath(projectPath))
}

func canonicalizePath(d string) string {
	resolved, err := filepath.EvalSymlinks(d)
	if err != nil {
		return d
	}
	abs, err := filepath.Abs(resolved)
	if err != nil {
		return resolved
	}
	return abs
}

func findProjectDir(projectPath string) string {
	exact := getProjectDir(projectPath)
	if info, err := os.Stat(exact); err == nil && info.IsDir() {
		return exact
	}
	sanitized := sanitizePath(projectPath)
	if len(sanitized) <= maxSanitizedLength {
		return ""
	}
	prefix := sanitized[:maxSanitizedLength]
	projectsDir := getProjectsDir()
	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		return ""
	}
	for _, entry := range entries {
		if entry.IsDir() && strings.HasPrefix(entry.Name(), prefix+"-") {
			return filepath.Join(projectsDir, entry.Name())
		}
	}
	return ""
}

// --- JSON field extraction without full parsing ---

func extractJSONStringField(text, key string) string {
	patterns := []string{
		fmt.Sprintf(`"%s":"`, key),
		fmt.Sprintf(`"%s": "`, key),
	}
	for _, pattern := range patterns {
		idx := strings.Index(text, pattern)
		if idx < 0 {
			continue
		}
		start := idx + len(pattern)
		for i := start; i < len(text); i++ {
			if text[i] == '\\' {
				i++ // skip escaped char
				continue
			}
			if text[i] == '"' {
				return unescapeJSONString(text[start:i])
			}
		}
	}
	return ""
}

func extractLastJSONStringField(text, key string) string {
	patterns := []string{
		fmt.Sprintf(`"%s":"`, key),
		fmt.Sprintf(`"%s": "`, key),
	}
	var lastValue string
	for _, pattern := range patterns {
		searchFrom := 0
		for {
			idx := strings.Index(text[searchFrom:], pattern)
			if idx < 0 {
				break
			}
			idx += searchFrom
			start := idx + len(pattern)
			for i := start; i < len(text); i++ {
				if text[i] == '\\' {
					i++
					continue
				}
				if text[i] == '"' {
					lastValue = unescapeJSONString(text[start:i])
					break
				}
			}
			searchFrom = start + 1
		}
	}
	return lastValue
}

func unescapeJSONString(raw string) string {
	if !strings.Contains(raw, "\\") {
		return raw
	}
	var result string
	if err := json.Unmarshal([]byte(fmt.Sprintf(`"%s"`, raw)), &result); err != nil {
		return raw
	}
	return result
}

// --- Lite session file reading ---

type liteSessionFile struct {
	mtime int64 // milliseconds since epoch
	size  int64
	head  string
	tail  string
}

func readSessionLite(filePath string) *liteSessionFile {
	f, err := os.Open(filePath)
	if err != nil {
		return nil
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		return nil
	}
	size := stat.Size()
	mtime := stat.ModTime().UnixMilli()

	if size == 0 {
		return nil
	}

	headBuf := make([]byte, liteReadBufSize)
	n, _ := f.Read(headBuf)
	if n == 0 {
		return nil
	}
	head := string(headBuf[:n])

	var tail string
	tailOffset := size - int64(liteReadBufSize)
	if tailOffset <= 0 {
		tail = head
	} else {
		f.Seek(tailOffset, 0)
		tailBuf := make([]byte, liteReadBufSize)
		tn, _ := f.Read(tailBuf)
		tail = string(tailBuf[:tn])
	}

	return &liteSessionFile{mtime: mtime, size: size, head: head, tail: tail}
}

// --- Skip patterns for first prompt ---

var skipFirstPromptPattern = regexp.MustCompile(
	`^(?:<local-command-stdout>|<session-start-hook>|<tick>|<goal>|` +
		`\[Request interrupted by user[^\]]*\])`)

var commandNameRe = regexp.MustCompile(`<command-name>(.*?)</command-name>`)

func extractFirstPromptFromHead(head string) string {
	commandFallback := ""
	lines := strings.Split(head, "\n")
	for _, line := range lines {
		if !strings.Contains(line, `"type":"user"`) && !strings.Contains(line, `"type": "user"`) {
			continue
		}
		if strings.Contains(line, `"tool_result"`) {
			continue
		}
		if strings.Contains(line, `"isMeta":true`) || strings.Contains(line, `"isMeta": true`) {
			continue
		}
		if strings.Contains(line, `"isCompactSummary":true`) || strings.Contains(line, `"isCompactSummary": true`) {
			continue
		}

		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		if entry["type"] != "user" {
			continue
		}
		msg, ok := entry["message"].(map[string]any)
		if !ok {
			continue
		}
		content := msg["content"]

		var texts []string
		switch c := content.(type) {
		case string:
			texts = append(texts, c)
		case []any:
			for _, block := range c {
				if bm, ok := block.(map[string]any); ok {
					if bm["type"] == "text" {
						if t, ok := bm["text"].(string); ok {
							texts = append(texts, t)
						}
					}
				}
			}
		}

		for _, raw := range texts {
			result := strings.Map(func(r rune) rune {
				if r == '\n' {
					return ' '
				}
				return r
			}, raw)
			result = strings.TrimSpace(result)
			if result == "" {
				continue
			}

			if m := commandNameRe.FindStringSubmatch(result); len(m) > 1 {
				if commandFallback == "" {
					commandFallback = m[1]
				}
				continue
			}
			if skipFirstPromptPattern.MatchString(result) {
				continue
			}

			runes := []rune(result)
			if len(runes) > 200 {
				result = string(runes[:200])
				result = strings.TrimRightFunc(result, unicode.IsSpace) + "…"
			}
			return result
		}
	}
	return commandFallback
}

// --- Parse session info from lite data ---

func parseSessionInfoFromLite(sessionID string, lite *liteSessionFile, projectPath string) *SDKSessionInfo {
	head, tail := lite.head, lite.tail

	firstNewline := strings.Index(head, "\n")
	firstLine := head
	if firstNewline >= 0 {
		firstLine = head[:firstNewline]
	}
	if strings.Contains(firstLine, `"isSidechain":true`) || strings.Contains(firstLine, `"isSidechain": true`) {
		return nil
	}

	customTitle := extractLastJSONStringField(tail, "customTitle")
	if customTitle == "" {
		customTitle = extractLastJSONStringField(head, "customTitle")
	}
	if customTitle == "" {
		customTitle = extractLastJSONStringField(tail, "aiTitle")
	}
	if customTitle == "" {
		customTitle = extractLastJSONStringField(head, "aiTitle")
	}

	firstPrompt := extractFirstPromptFromHead(head)

	summary := customTitle
	if summary == "" {
		summary = extractLastJSONStringField(tail, "lastPrompt")
	}
	if summary == "" {
		summary = extractLastJSONStringField(tail, "summary")
	}
	if summary == "" {
		summary = firstPrompt
	}

	if summary == "" {
		return nil
	}

	gitBranch := extractLastJSONStringField(tail, "gitBranch")
	if gitBranch == "" {
		gitBranch = extractJSONStringField(head, "gitBranch")
	}

	sessionCWD := extractJSONStringField(head, "cwd")
	if sessionCWD == "" {
		sessionCWD = projectPath
	}

	// Extract tag from {"type":"tag"} lines only
	var tag string
	tailLines := strings.Split(tail, "\n")
	for i := len(tailLines) - 1; i >= 0; i-- {
		if strings.HasPrefix(tailLines[i], `{"type":"tag"`) {
			tag = extractLastJSONStringField(tailLines[i], "tag")
			break
		}
	}

	info := &SDKSessionInfo{
		SessionID:    sessionID,
		Summary:      summary,
		LastModified: lite.mtime,
		CustomTitle:  customTitle,
		FirstPrompt:  firstPrompt,
		GitBranch:    gitBranch,
		CWD:          sessionCWD,
		Tag:          tag,
	}
	size := lite.size
	info.FileSize = &size

	return info
}

// --- Core session functions ---

func readSessionsFromDir(projectDir string, projectPath string) []SDKSessionInfo {
	entries, err := os.ReadDir(projectDir)
	if err != nil {
		return nil
	}

	var results []SDKSessionInfo
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		sessionID := name[:len(name)-6]
		if !uuidRe.MatchString(sessionID) {
			continue
		}

		lite := readSessionLite(filepath.Join(projectDir, name))
		if lite == nil {
			continue
		}

		info := parseSessionInfoFromLite(sessionID, lite, projectPath)
		if info != nil {
			results = append(results, *info)
		}
	}
	return results
}

func deduplicateBySessionID(sessions []SDKSessionInfo) []SDKSessionInfo {
	byID := make(map[string]SDKSessionInfo)
	for _, s := range sessions {
		if existing, ok := byID[s.SessionID]; !ok || s.LastModified > existing.LastModified {
			byID[s.SessionID] = s
		}
	}
	result := make([]SDKSessionInfo, 0, len(byID))
	for _, s := range byID {
		result = append(result, s)
	}
	return result
}

// ListSessionsOptions configures the ListSessions function.
type ListSessionsOptions struct {
	Directory string
	Limit     *int
	Offset    int
}

// ListSessions lists sessions with metadata extracted from session files.
// When Directory is set, returns sessions for that project directory.
// When omitted, returns sessions across all projects.
func ListSessions(opts ListSessionsOptions) []SDKSessionInfo {
	if opts.Directory != "" {
		return listSessionsForProject(opts.Directory, opts.Limit, opts.Offset)
	}
	return listAllSessions(opts.Limit, opts.Offset)
}

func listSessionsForProject(directory string, limit *int, offset int) []SDKSessionInfo {
	canonical := canonicalizePath(directory)
	projectDir := findProjectDir(canonical)
	if projectDir == "" {
		return nil
	}
	sessions := readSessionsFromDir(projectDir, canonical)
	return applySortLimitOffset(sessions, limit, offset)
}

func listAllSessions(limit *int, offset int) []SDKSessionInfo {
	projectsDir := getProjectsDir()
	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		return nil
	}

	var allSessions []SDKSessionInfo
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(projectsDir, entry.Name())
		allSessions = append(allSessions, readSessionsFromDir(dir, "")...)
	}

	deduped := deduplicateBySessionID(allSessions)
	return applySortLimitOffset(deduped, limit, offset)
}

func applySortLimitOffset(sessions []SDKSessionInfo, limit *int, offset int) []SDKSessionInfo {
	sort.Slice(sessions, func(i, j int) bool {
		return sessions[i].LastModified > sessions[j].LastModified
	})
	if offset > 0 && offset < len(sessions) {
		sessions = sessions[offset:]
	} else if offset >= len(sessions) {
		return nil
	}
	if limit != nil && *limit > 0 && *limit < len(sessions) {
		sessions = sessions[:*limit]
	}
	return sessions
}

// GetSessionInfo returns metadata for a specific session.
func GetSessionInfo(sessionID string, directory string) (*SDKSessionInfo, error) {
	if !uuidRe.MatchString(sessionID) {
		return nil, fmt.Errorf("invalid session ID: %s", sessionID)
	}

	if directory != "" {
		canonical := canonicalizePath(directory)
		projectDir := findProjectDir(canonical)
		if projectDir == "" {
			return nil, fmt.Errorf("project directory not found for: %s", directory)
		}
		return getSessionInfoFromDir(sessionID, projectDir, canonical)
	}

	// Search all project directories
	projectsDir := getProjectsDir()
	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		return nil, fmt.Errorf("cannot read projects directory: %w", err)
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(projectsDir, entry.Name())
		info, err := getSessionInfoFromDir(sessionID, dir, "")
		if err == nil && info != nil {
			return info, nil
		}
	}

	return nil, fmt.Errorf("session not found: %s", sessionID)
}

func getSessionInfoFromDir(sessionID, projectDir, projectPath string) (*SDKSessionInfo, error) {
	filePath := filepath.Join(projectDir, sessionID+".jsonl")
	lite := readSessionLite(filePath)
	if lite == nil {
		return nil, fmt.Errorf("session file not found or empty: %s", filePath)
	}

	info := parseSessionInfoFromLite(sessionID, lite, projectPath)
	if info == nil {
		return nil, fmt.Errorf("session is sidechain or has no summary: %s", sessionID)
	}
	return info, nil
}

// GetSessionMessages reads conversation messages from a session transcript.
func GetSessionMessages(sessionID string, directory string) ([]SessionMessage, error) {
	if !uuidRe.MatchString(sessionID) {
		return nil, fmt.Errorf("invalid session ID: %s", sessionID)
	}

	filePath, err := findSessionFile(sessionID, directory)
	if err != nil {
		return nil, err
	}

	f, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("cannot open session file: %w", err)
	}
	defer f.Close()

	var messages []SessionMessage
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 10*1024*1024) // 10MB max line
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}

		msgType, _ := entry["type"].(string)
		if msgType != "user" && msgType != "assistant" {
			continue
		}

		uuid, _ := entry["uuid"].(string)
		sid, _ := entry["session_id"].(string)

		msg := SessionMessage{
			Type:      msgType,
			UUID:      uuid,
			SessionID: sid,
			Message:   entry["message"],
		}
		if ptuid, ok := entry["parent_tool_use_id"].(string); ok {
			msg.ParentToolUseID = &ptuid
		}
		messages = append(messages, msg)
	}

	return messages, nil
}

func findSessionFile(sessionID string, directory string) (string, error) {
	if directory != "" {
		canonical := canonicalizePath(directory)
		projectDir := findProjectDir(canonical)
		if projectDir == "" {
			return "", fmt.Errorf("project directory not found for: %s", directory)
		}
		p := filepath.Join(projectDir, sessionID+".jsonl")
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
		return "", fmt.Errorf("session file not found: %s", sessionID)
	}

	// Search all project directories
	projectsDir := getProjectsDir()
	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		return "", fmt.Errorf("cannot read projects directory: %w", err)
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		p := filepath.Join(projectsDir, entry.Name(), sessionID+".jsonl")
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("session file not found: %s", sessionID)
}

// --- Session mutations ---

// RenameSession sets a custom title for a session.
func RenameSession(sessionID string, title string, directory string) error {
	filePath, err := findSessionFile(sessionID, directory)
	if err != nil {
		return err
	}
	entry := map[string]any{
		"type":        "custom-title",
		"customTitle": title,
	}
	return appendJSONLEntry(filePath, entry)
}

// TagSession sets or clears a tag for a session.
func TagSession(sessionID string, tag string, directory string) error {
	filePath, err := findSessionFile(sessionID, directory)
	if err != nil {
		return err
	}
	entry := map[string]any{
		"type": "tag",
		"tag":  tag,
	}
	return appendJSONLEntry(filePath, entry)
}

// DeleteSession removes a session file.
func DeleteSession(sessionID string, directory string) error {
	filePath, err := findSessionFile(sessionID, directory)
	if err != nil {
		return err
	}
	return os.Remove(filePath)
}

// ForkSession creates a copy of a session, optionally up to a specific message.
func ForkSession(sessionID string, directory string, upToMessageID string, title string) (*ForkSessionResult, error) {
	filePath, err := findSessionFile(sessionID, directory)
	if err != nil {
		return nil, err
	}

	f, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("cannot open session file: %w", err)
	}
	defer f.Close()

	var lines []string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 10*1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		lines = append(lines, line)

		if upToMessageID != "" {
			if strings.Contains(line, fmt.Sprintf(`"uuid":"%s"`, upToMessageID)) ||
				strings.Contains(line, fmt.Sprintf(`"uuid": "%s"`, upToMessageID)) {
				break
			}
		}
	}

	// Generate new session ID (simplified - in production use a real UUID generator)
	newSessionID := generateUUID()

	// Write new session file in same directory
	dir := filepath.Dir(filePath)
	newPath := filepath.Join(dir, newSessionID+".jsonl")

	newF, err := os.Create(newPath)
	if err != nil {
		return nil, fmt.Errorf("cannot create fork: %w", err)
	}
	defer newF.Close()

	for _, line := range lines {
		fmt.Fprintln(newF, line)
	}

	if title != "" {
		entry := map[string]any{
			"type":        "custom-title",
			"customTitle": title,
		}
		data, _ := json.Marshal(entry)
		fmt.Fprintln(newF, string(data))
	}

	return &ForkSessionResult{SessionID: newSessionID}, nil
}

func appendJSONLEntry(filePath string, entry map[string]any) error {
	data, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("failed to marshal entry: %w", err)
	}

	f, err := os.OpenFile(filePath, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("cannot open session file: %w", err)
	}
	defer f.Close()

	_, err = fmt.Fprintln(f, string(data))
	return err
}

// generateUUID creates a v4 UUID string.
func generateUUID() string {
	b := make([]byte, 16)
	// Use crypto/rand for real randomness
	if _, err := cryptoRandRead(b); err != nil {
		// Fallback to time-based
		return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
			uint32(0), uint16(0x4000), uint16(0x8000|0), uint16(0), uint64(0))
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 1
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		uint32(b[0])<<24|uint32(b[1])<<16|uint32(b[2])<<8|uint32(b[3]),
		uint16(b[4])<<8|uint16(b[5]),
		uint16(b[6])<<8|uint16(b[7]),
		uint16(b[8])<<8|uint16(b[9]),
		uint64(b[10])<<40|uint64(b[11])<<32|uint64(b[12])<<24|uint64(b[13])<<16|uint64(b[14])<<8|uint64(b[15]))
}

// cryptoRandRead is a variable for testing.
var cryptoRandRead = rand.Read

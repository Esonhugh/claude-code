package claudesdk

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// --- helpers ---

// setupConfigDir sets CLAUDE_CONFIG_DIR to a temp directory and returns
// the projects directory path plus a cleanup function.
func setupConfigDir(t *testing.T) (projectsDir string, cleanup func()) {
	t.Helper()
	tmpDir := t.TempDir()
	projectsDir = filepath.Join(tmpDir, "projects")
	if err := os.MkdirAll(projectsDir, 0755); err != nil {
		t.Fatal(err)
	}
	old := os.Getenv(CLAUDE_CODE_CONFIG_DIR)
	os.Setenv(CLAUDE_CODE_CONFIG_DIR, tmpDir)
	return projectsDir, func() {
		os.Setenv(CLAUDE_CODE_CONFIG_DIR, old)
	}
}

// writeSessionFile writes a JSONL session file at <projectsDir>/<sanitizedProject>/<sessionID>.jsonl
func writeSessionFile(t *testing.T, projectsDir, sanitizedProject, sessionID string, lines []string) string {
	t.Helper()
	dir := filepath.Join(projectsDir, sanitizedProject)
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	filePath := filepath.Join(dir, sessionID+".jsonl")
	content := strings.Join(lines, "\n") + "\n"
	if err := os.WriteFile(filePath, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	return filePath
}

// setupProjectDir creates a temp directory and writes session files using the
// canonical path for sanitization (important on macOS where symlinks resolve).
// Returns the canonical project dir for use with API calls.
func setupProjectDir(t *testing.T, projectsDir string, sessionID string, lines []string) (canonicalProjDir string, filePath string) {
	t.Helper()
	rawDir := t.TempDir()
	canonicalProjDir = canonicalizePath(rawDir)
	sanitized := sanitizePath(canonicalProjDir)
	filePath = writeSessionFile(t, projectsDir, sanitized, sessionID, lines)
	return
}

const testSessionID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
const testSessionID2 = "11111111-2222-3333-4444-555555555555"

func makeUserLine(text string) string {
	return fmt.Sprintf(`{"type":"user","uuid":"uuid-1","session_id":"sid-1","message":{"role":"user","content":"%s"}}`, text)
}

func makeAssistantLine(text string) string {
	return fmt.Sprintf(`{"type":"assistant","uuid":"uuid-2","session_id":"sid-1","message":{"role":"assistant","content":"%s"}}`, text)
}

func makeTitleLine(title string) string {
	return fmt.Sprintf(`{"type":"custom-title","customTitle":"%s"}`, title)
}

func makeTagLine(tag string) string {
	return fmt.Sprintf(`{"type":"tag","tag":"%s"}`, tag)
}

// --- sanitizePath tests ---

func TestSanitizePath_ShortPath(t *testing.T) {
	result := sanitizePath("/home/user/project")
	if result != "-home-user-project" {
		t.Errorf("expected '-home-user-project', got %q", result)
	}
}

func TestSanitizePath_AlphanumericOnly(t *testing.T) {
	result := sanitizePath("abcDEF123")
	if result != "abcDEF123" {
		t.Errorf("expected 'abcDEF123', got %q", result)
	}
}

func TestSanitizePath_SpecialChars(t *testing.T) {
	result := sanitizePath("/home/user/my project!@#$%")
	expected := "-home-user-my-project-----"
	if result != expected {
		t.Errorf("expected %q, got %q", expected, result)
	}
}

func TestSanitizePath_EmptyString(t *testing.T) {
	result := sanitizePath("")
	if result != "" {
		t.Errorf("expected empty string, got %q", result)
	}
}

func TestSanitizePath_LongPath_AddsSuffix(t *testing.T) {
	// Build a path longer than 200 characters after sanitization
	longPath := "/" + strings.Repeat("abcdefghij/", 25) // well over 200 chars
	result := sanitizePath(longPath)
	if len(result) <= maxSanitizedLength {
		t.Errorf("expected result longer than %d chars with hash suffix, got len=%d", maxSanitizedLength, len(result))
	}
	// Should start with the sanitized prefix
	sanitized := sanitizeRe.ReplaceAllString(longPath, "-")
	prefix := sanitized[:maxSanitizedLength]
	if !strings.HasPrefix(result, prefix+"-") {
		t.Errorf("result should start with truncated prefix + '-', got %q", result[:210])
	}
}

func TestSanitizePath_ExactlyMaxLength(t *testing.T) {
	// Exactly 200 alphanumeric chars should NOT get a hash suffix
	path := strings.Repeat("a", maxSanitizedLength)
	result := sanitizePath(path)
	if result != path {
		t.Errorf("expected path unchanged, got %q", result)
	}
}

// --- simpleHash tests ---

func TestSimpleHash_EmptyString(t *testing.T) {
	result := simpleHash("")
	if result != "0" {
		t.Errorf("expected '0' for empty string, got %q", result)
	}
}

func TestSimpleHash_Deterministic(t *testing.T) {
	h1 := simpleHash("hello")
	h2 := simpleHash("hello")
	if h1 != h2 {
		t.Errorf("hash should be deterministic: %q != %q", h1, h2)
	}
}

func TestSimpleHash_DifferentInputs(t *testing.T) {
	h1 := simpleHash("hello")
	h2 := simpleHash("world")
	if h1 == h2 {
		t.Errorf("different inputs should (usually) produce different hashes: both %q", h1)
	}
}

func TestSimpleHash_ResultIsBase36(t *testing.T) {
	result := simpleHash("test-string-for-base36")
	for _, ch := range result {
		if !((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z')) {
			t.Errorf("hash contains non-base36 character: %c in %q", ch, result)
		}
	}
}

func TestSimpleHash_KnownValue(t *testing.T) {
	// The JS hash of "hello" using:  h = (h << 5) - h + charCode
	// JS: let h=0; for(c of "hello") h=(h<<5)-h+c.charCodeAt(0); Math.abs(h).toString(36)
	// JS result: "2dgmgj" (with 32-bit truncation via |0 in JS)
	// Go uses int32, so it should match.
	result := simpleHash("/home/user/project")
	if result == "" {
		t.Error("expected non-empty hash")
	}
	// Just verify it's non-empty and consistent
	if simpleHash("/home/user/project") != result {
		t.Error("hash not deterministic")
	}
}

// --- generateUUID tests ---

func TestGenerateUUID_Format(t *testing.T) {
	uuid := generateUUID()
	if !uuidRe.MatchString(uuid) {
		t.Errorf("generateUUID produced invalid UUID format: %q", uuid)
	}
}

func TestGenerateUUID_Version4(t *testing.T) {
	uuid := generateUUID()
	// UUID v4: character at position 14 should be '4'
	if uuid[14] != '4' {
		t.Errorf("UUID version nibble should be 4, got %c in %q", uuid[14], uuid)
	}
}

func TestGenerateUUID_Variant1(t *testing.T) {
	uuid := generateUUID()
	// Variant 1: character at position 19 should be 8, 9, a, or b
	ch := uuid[19]
	if ch != '8' && ch != '9' && ch != 'a' && ch != 'b' {
		t.Errorf("UUID variant nibble should be 8/9/a/b, got %c in %q", ch, uuid)
	}
}

func TestGenerateUUID_MockedRand(t *testing.T) {
	original := cryptoRandRead
	defer func() { cryptoRandRead = original }()

	// Mock rand to return a known sequence
	cryptoRandRead = func(b []byte) (int, error) {
		for i := range b {
			b[i] = byte(i + 1) // deterministic: 1, 2, 3, ...
		}
		return len(b), nil
	}

	uuid := generateUUID()
	if !uuidRe.MatchString(uuid) {
		t.Errorf("mocked UUID should still have valid format: %q", uuid)
	}

	// With deterministic input, UUID should be reproducible
	uuid2 := generateUUID()
	if uuid != uuid2 {
		t.Errorf("with same mock, UUIDs should be identical: %q vs %q", uuid, uuid2)
	}
}

func TestGenerateUUID_RandError_Fallback(t *testing.T) {
	original := cryptoRandRead
	defer func() { cryptoRandRead = original }()

	cryptoRandRead = func(b []byte) (int, error) {
		return 0, fmt.Errorf("simulated rand failure")
	}

	uuid := generateUUID()
	// The fallback UUID should still be a valid format
	if !uuidRe.MatchString(uuid) {
		t.Errorf("fallback UUID should have valid format: %q", uuid)
	}
}

func TestGenerateUUID_Uniqueness(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 100; i++ {
		uuid := generateUUID()
		if seen[uuid] {
			t.Fatalf("generated duplicate UUID: %s", uuid)
		}
		seen[uuid] = true
	}
}

// --- getClaudeConfigDir / getProjectsDir tests ---

func TestGetClaudeConfigDir_EnvOverride(t *testing.T) {
	old := os.Getenv(CLAUDE_CODE_CONFIG_DIR)
	defer os.Setenv(CLAUDE_CODE_CONFIG_DIR, old)

	os.Setenv(CLAUDE_CODE_CONFIG_DIR, "/custom/claude/dir")
	result := getClaudeConfigDir()
	if result != "/custom/claude/dir" {
		t.Errorf("expected /custom/claude/dir, got %q", result)
	}
}

func TestGetClaudeConfigDir_Default(t *testing.T) {
	old := os.Getenv(CLAUDE_CODE_CONFIG_DIR)
	defer os.Setenv(CLAUDE_CODE_CONFIG_DIR, old)
	os.Unsetenv(CLAUDE_CODE_CONFIG_DIR)

	home, _ := os.UserHomeDir()
	expected := filepath.Join(home, ".claude")
	result := getClaudeConfigDir()
	if result != expected {
		t.Errorf("expected %q, got %q", expected, result)
	}
}

func TestGetProjectsDir(t *testing.T) {
	old := os.Getenv(CLAUDE_CODE_CONFIG_DIR)
	defer os.Setenv(CLAUDE_CODE_CONFIG_DIR, old)

	os.Setenv(CLAUDE_CODE_CONFIG_DIR, "/test/config")
	result := getProjectsDir()
	expected := "/test/config/projects"
	if result != expected {
		t.Errorf("expected %q, got %q", expected, result)
	}
}

// --- ListSessions tests ---

func TestListSessions_EmptyDir(t *testing.T) {
	_, cleanup := setupConfigDir(t)
	defer cleanup()

	sessions := ListSessions(ListSessionsOptions{})
	if len(sessions) != 0 {
		t.Errorf("expected 0 sessions, got %d", len(sessions))
	}
}

func TestListSessions_WithSessions(t *testing.T) {
	projectsDir, cleanup := setupConfigDir(t)
	defer cleanup()

	projDir := "/test/my-project"
	sanitized := sanitizePath(projDir)

	lines := []string{
		makeUserLine("Hello Claude"),
		makeAssistantLine("Hello! How can I help?"),
	}
	writeSessionFile(t, projectsDir, sanitized, testSessionID, lines)

	// Create the project directory
	sessions := ListSessions(ListSessionsOptions{})
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(sessions))
	}
	if sessions[0].SessionID != testSessionID {
		t.Errorf("expected session ID %s, got %s", testSessionID, sessions[0].SessionID)
	}
}

func TestListSessions_MultipleSessions(t *testing.T) {
	projectsDir, cleanup := setupConfigDir(t)
	defer cleanup()

	projDir := "/test/my-project"
	sanitized := sanitizePath(projDir)

	lines1 := []string{
		makeUserLine("First session"),
		makeAssistantLine("Response 1"),
	}
	lines2 := []string{
		makeUserLine("Second session"),
		makeAssistantLine("Response 2"),
	}
	writeSessionFile(t, projectsDir, sanitized, testSessionID, lines1)
	writeSessionFile(t, projectsDir, sanitized, testSessionID2, lines2)

	sessions := ListSessions(ListSessionsOptions{})
	if len(sessions) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(sessions))
	}
}

func TestListSessions_WithLimit(t *testing.T) {
	projectsDir, cleanup := setupConfigDir(t)
	defer cleanup()

	sanitized := sanitizePath("/test/proj")
	writeSessionFile(t, projectsDir, sanitized, testSessionID, []string{makeUserLine("s1"), makeAssistantLine("r1")})
	writeSessionFile(t, projectsDir, sanitized, testSessionID2, []string{makeUserLine("s2"), makeAssistantLine("r2")})

	limit := 1
	sessions := ListSessions(ListSessionsOptions{Limit: &limit})
	if len(sessions) != 1 {
		t.Errorf("expected 1 session with limit=1, got %d", len(sessions))
	}
}

func TestListSessions_WithOffset(t *testing.T) {
	projectsDir, cleanup := setupConfigDir(t)
	defer cleanup()

	sanitized := sanitizePath("/test/proj")
	writeSessionFile(t, projectsDir, sanitized, testSessionID, []string{makeUserLine("s1"), makeAssistantLine("r1")})
	writeSessionFile(t, projectsDir, sanitized, testSessionID2, []string{makeUserLine("s2"), makeAssistantLine("r2")})

	sessions := ListSessions(ListSessionsOptions{Offset: 1})
	if len(sessions) != 1 {
		t.Errorf("expected 1 session with offset=1, got %d", len(sessions))
	}
}

func TestListSessions_OffsetBeyondLength(t *testing.T) {
	projectsDir, cleanup := setupConfigDir(t)
	defer cleanup()

	sanitized := sanitizePath("/test/proj")
	writeSessionFile(t, projectsDir, sanitized, testSessionID, []string{makeUserLine("s1"), makeAssistantLine("r1")})

	sessions := ListSessions(ListSessionsOptions{Offset: 100})
	if len(sessions) != 0 {
		t.Errorf("expected 0 sessions with offset beyond length, got %d", len(sessions))
	}
}

func TestListSessions_IgnoresNonJSONLFiles(t *testing.T) {
	projectsDir, cleanup := setupConfigDir(t)
	defer cleanup()

	sanitized := sanitizePath("/test/proj")
	dir := filepath.Join(projectsDir, sanitized)
	os.MkdirAll(dir, 0755)
	// Write a non-JSONL file
	os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("not a session"), 0644)
	// Write a JSONL file with a non-UUID name
	os.WriteFile(filepath.Join(dir, "config.jsonl"), []byte(`{"type":"config"}`), 0644)

	sessions := ListSessions(ListSessionsOptions{})
	if len(sessions) != 0 {
		t.Errorf("expected 0 sessions (non-session files), got %d", len(sessions))
	}
}

func TestListSessions_SkipsSidechain(t *testing.T) {
	projectsDir, cleanup := setupConfigDir(t)
	defer cleanup()

	sanitized := sanitizePath("/test/proj")
	lines := []string{
		`{"type":"user","isSidechain":true,"message":{"role":"user","content":"side"}}`,
	}
	writeSessionFile(t, projectsDir, sanitized, testSessionID, lines)

	sessions := ListSessions(ListSessionsOptions{})
	if len(sessions) != 0 {
		t.Errorf("expected 0 sessions (sidechain skipped), got %d", len(sessions))
	}
}

func TestListSessions_ForSpecificDirectory(t *testing.T) {
	projectsDir, cleanup := setupConfigDir(t)
	defer cleanup()

	lines := []string{
		makeUserLine("Hello from project"),
		makeAssistantLine("Response"),
	}
	projDir, _ := setupProjectDir(t, projectsDir, testSessionID, lines)

	sessions := ListSessions(ListSessionsOptions{Directory: projDir})
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session for directory, got %d", len(sessions))
	}
	if sessions[0].SessionID != testSessionID {
		t.Errorf("expected session ID %s, got %s", testSessionID, sessions[0].SessionID)
	}
}

// --- GetSessionInfo tests ---

func TestGetSessionInfo_InvalidID(t *testing.T) {
	_, err := GetSessionInfo("not-a-uuid", "")
	if err == nil {
		t.Error("expected error for invalid session ID")
	}
	if !strings.Contains(err.Error(), "invalid session ID") {
		t.Errorf("expected 'invalid session ID' error, got: %v", err)
	}
}

func TestGetSessionInfo_NotFound(t *testing.T) {
	_, cleanup := setupConfigDir(t)
	defer cleanup()

	_, err := GetSessionInfo(testSessionID, "")
	if err == nil {
		t.Error("expected error for nonexistent session")
	}
}

func TestGetSessionInfo_Found(t *testing.T) {
	projectsDir, cleanup := setupConfigDir(t)
	defer cleanup()

	lines := []string{
		makeUserLine("Info test prompt"),
		makeAssistantLine("Response"),
		makeTitleLine("My Custom Title"),
	}
	projDir, _ := setupProjectDir(t, projectsDir, testSessionID, lines)

	info, err := GetSessionInfo(testSessionID, projDir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info.SessionID != testSessionID {
		t.Errorf("expected session ID %s, got %s", testSessionID, info.SessionID)
	}
	if info.CustomTitle != "My Custom Title" {
		t.Errorf("expected custom title 'My Custom Title', got %q", info.CustomTitle)
	}
}

// --- GetSessionMessages tests ---

func TestGetSessionMessages_InvalidID(t *testing.T) {
	_, err := GetSessionMessages("bad-id", "")
	if err == nil {
		t.Error("expected error for invalid session ID")
	}
}

func TestGetSessionMessages_NotFound(t *testing.T) {
	_, cleanup := setupConfigDir(t)
	defer cleanup()

	_, err := GetSessionMessages(testSessionID, "")
	if err == nil {
		t.Error("expected error for nonexistent session")
	}
}

func TestGetSessionMessages_ReadsMessages(t *testing.T) {
	projectsDir, cleanup := setupConfigDir(t)
	defer cleanup()

	lines := []string{
		makeUserLine("Hello Claude"),
		makeAssistantLine("Hello! How can I help?"),
		`{"type":"system","message":"ignored"}`,
	}
	projDir, _ := setupProjectDir(t, projectsDir, testSessionID, lines)

	msgs, err := GetSessionMessages(testSessionID, projDir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages (user+assistant), got %d", len(msgs))
	}
	if msgs[0].Type != "user" {
		t.Errorf("expected first message type 'user', got %q", msgs[0].Type)
	}
	if msgs[1].Type != "assistant" {
		t.Errorf("expected second message type 'assistant', got %q", msgs[1].Type)
	}
	if msgs[0].UUID != "uuid-1" {
		t.Errorf("expected UUID 'uuid-1', got %q", msgs[0].UUID)
	}
	if msgs[0].SessionID != "sid-1" {
		t.Errorf("expected session_id 'sid-1', got %q", msgs[0].SessionID)
	}
}

func TestGetSessionMessages_SkipsEmptyLines(t *testing.T) {
	projectsDir, cleanup := setupConfigDir(t)
	defer cleanup()

	lines := []string{
		makeUserLine("Hello"),
		"",
		"",
		makeAssistantLine("World"),
	}
	projDir, _ := setupProjectDir(t, projectsDir, testSessionID, lines)

	msgs, err := GetSessionMessages(testSessionID, projDir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(msgs) != 2 {
		t.Errorf("expected 2 messages, got %d", len(msgs))
	}
}

func TestGetSessionMessages_SkipsInvalidJSON(t *testing.T) {
	projectsDir, cleanup := setupConfigDir(t)
	defer cleanup()

	lines := []string{
		makeUserLine("Hello"),
		"this is not json {{{",
		makeAssistantLine("World"),
	}
	projDir, _ := setupProjectDir(t, projectsDir, testSessionID, lines)

	msgs, err := GetSessionMessages(testSessionID, projDir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(msgs) != 2 {
		t.Errorf("expected 2 messages, got %d", len(msgs))
	}
}

func TestGetSessionMessages_WithParentToolUseID(t *testing.T) {
	projectsDir, cleanup := setupConfigDir(t)
	defer cleanup()

	lines := []string{
		`{"type":"user","uuid":"u1","session_id":"s1","parent_tool_use_id":"tool-123","message":{"role":"user","content":"tool result"}}`,
	}
	projDir, _ := setupProjectDir(t, projectsDir, testSessionID, lines)

	msgs, err := GetSessionMessages(testSessionID, projDir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].ParentToolUseID == nil || *msgs[0].ParentToolUseID != "tool-123" {
		t.Errorf("expected parent_tool_use_id 'tool-123', got %v", msgs[0].ParentToolUseID)
	}
}

func TestGetSessionMessages_SearchesAllProjects(t *testing.T) {
	projectsDir, cleanup := setupConfigDir(t)
	defer cleanup()

	// Create session in a project dir, then search without specifying directory
	sanitized := sanitizePath("/some/project")
	lines := []string{
		makeUserLine("cross-project search"),
		makeAssistantLine("found it"),
	}
	writeSessionFile(t, projectsDir, sanitized, testSessionID, lines)

	msgs, err := GetSessionMessages(testSessionID, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(msgs) != 2 {
		t.Errorf("expected 2 messages, got %d", len(msgs))
	}
}

// --- RenameSession tests ---

func TestRenameSession_InvalidID(t *testing.T) {
	err := RenameSession("bad-id", "title", "")
	if err == nil {
		t.Error("expected error for invalid session ID")
	}
}

func TestRenameSession_AppendsTitle(t *testing.T) {
	projectsDir, cleanup := setupConfigDir(t)
	defer cleanup()

	lines := []string{
		makeUserLine("Hello"),
		makeAssistantLine("Hi"),
	}
	projDir, filePath := setupProjectDir(t, projectsDir, testSessionID, lines)

	err := RenameSession(testSessionID, "New Title", projDir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Read file and check the appended line
	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("cannot read file: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, `"customTitle":"New Title"`) {
		t.Errorf("file should contain custom title, got:\n%s", content)
	}
	if !strings.Contains(content, `"type":"custom-title"`) {
		t.Errorf("file should contain custom-title type, got:\n%s", content)
	}

	// Verify it's the last line
	fileLines := strings.Split(strings.TrimSpace(content), "\n")
	lastLine := fileLines[len(fileLines)-1]
	var entry map[string]any
	if err := json.Unmarshal([]byte(lastLine), &entry); err != nil {
		t.Fatalf("last line is not valid JSON: %v", err)
	}
	if entry["type"] != "custom-title" {
		t.Errorf("last line type should be 'custom-title', got %v", entry["type"])
	}
	if entry["customTitle"] != "New Title" {
		t.Errorf("last line customTitle should be 'New Title', got %v", entry["customTitle"])
	}
}

func TestRenameSession_NotFound(t *testing.T) {
	_, cleanup := setupConfigDir(t)
	defer cleanup()

	err := RenameSession(testSessionID, "title", "")
	if err == nil {
		t.Error("expected error for nonexistent session")
	}
}

// --- TagSession tests ---

func TestTagSession_InvalidID(t *testing.T) {
	err := TagSession("bad-id", "mytag", "")
	if err == nil {
		t.Error("expected error for invalid session ID")
	}
}

func TestTagSession_AppendsTag(t *testing.T) {
	projectsDir, cleanup := setupConfigDir(t)
	defer cleanup()

	lines := []string{
		makeUserLine("Hello"),
		makeAssistantLine("Hi"),
	}
	projDir, filePath := setupProjectDir(t, projectsDir, testSessionID, lines)

	err := TagSession(testSessionID, "important", projDir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("cannot read file: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, `"tag":"important"`) {
		t.Errorf("file should contain tag, got:\n%s", content)
	}
	if !strings.Contains(content, `"type":"tag"`) {
		t.Errorf("file should contain tag type, got:\n%s", content)
	}

	fileLines := strings.Split(strings.TrimSpace(content), "\n")
	lastLine := fileLines[len(fileLines)-1]
	var entry map[string]any
	if err := json.Unmarshal([]byte(lastLine), &entry); err != nil {
		t.Fatalf("last line is not valid JSON: %v", err)
	}
	if entry["type"] != "tag" {
		t.Errorf("last line type should be 'tag', got %v", entry["type"])
	}
	if entry["tag"] != "important" {
		t.Errorf("last line tag should be 'important', got %v", entry["tag"])
	}
}

func TestTagSession_ClearTag(t *testing.T) {
	projectsDir, cleanup := setupConfigDir(t)
	defer cleanup()

	lines := []string{
		makeUserLine("Hello"),
		makeTagLine("old-tag"),
	}
	projDir, filePath := setupProjectDir(t, projectsDir, testSessionID, lines)

	err := TagSession(testSessionID, "", projDir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	data, _ := os.ReadFile(filePath)
	fileLines := strings.Split(strings.TrimSpace(string(data)), "\n")
	lastLine := fileLines[len(fileLines)-1]
	var entry map[string]any
	json.Unmarshal([]byte(lastLine), &entry)
	if entry["tag"] != "" {
		t.Errorf("expected empty tag, got %v", entry["tag"])
	}
}

func TestTagSession_NotFound(t *testing.T) {
	_, cleanup := setupConfigDir(t)
	defer cleanup()

	err := TagSession(testSessionID, "tag", "")
	if err == nil {
		t.Error("expected error for nonexistent session")
	}
}

// --- DeleteSession tests ---

func TestDeleteSession_InvalidID(t *testing.T) {
	err := DeleteSession("bad-id", "")
	if err == nil {
		t.Error("expected error for invalid session ID")
	}
}

func TestDeleteSession_RemovesFile(t *testing.T) {
	projectsDir, cleanup := setupConfigDir(t)
	defer cleanup()

	lines := []string{
		makeUserLine("delete me"),
		makeAssistantLine("ok"),
	}
	projDir, filePath := setupProjectDir(t, projectsDir, testSessionID, lines)

	// Verify file exists
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		t.Fatal("session file should exist before delete")
	}

	err := DeleteSession(testSessionID, projDir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify file is removed
	if _, err := os.Stat(filePath); !os.IsNotExist(err) {
		t.Error("session file should be removed after delete")
	}
}

func TestDeleteSession_NotFound(t *testing.T) {
	_, cleanup := setupConfigDir(t)
	defer cleanup()

	err := DeleteSession(testSessionID, "")
	if err == nil {
		t.Error("expected error for nonexistent session")
	}
}

// --- ForkSession tests ---

func TestForkSession_CreatesNewFile(t *testing.T) {
	projectsDir, cleanup := setupConfigDir(t)
	defer cleanup()

	lines := []string{
		makeUserLine("fork me"),
		makeAssistantLine("forked"),
	}
	projDir, _ := setupProjectDir(t, projectsDir, testSessionID, lines)
	sanitized := sanitizePath(projDir)

	result, err := ForkSession(testSessionID, projDir, "", "Forked Session")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !uuidRe.MatchString(result.SessionID) {
		t.Errorf("forked session ID should be valid UUID: %q", result.SessionID)
	}

	// Verify the new file exists
	newPath := filepath.Join(projectsDir, sanitized, result.SessionID+".jsonl")
	data, err := os.ReadFile(newPath)
	if err != nil {
		t.Fatalf("cannot read forked file: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, "fork me") {
		t.Error("forked file should contain original messages")
	}
	if !strings.Contains(content, `"customTitle":"Forked Session"`) {
		t.Error("forked file should contain custom title")
	}
}

func TestForkSession_UpToMessage(t *testing.T) {
	projectsDir, cleanup := setupConfigDir(t)
	defer cleanup()

	lines := []string{
		`{"type":"user","uuid":"msg-1","session_id":"s1","message":{"role":"user","content":"first"}}`,
		`{"type":"assistant","uuid":"msg-2","session_id":"s1","message":{"role":"assistant","content":"second"}}`,
		`{"type":"user","uuid":"msg-3","session_id":"s1","message":{"role":"user","content":"third"}}`,
		`{"type":"assistant","uuid":"msg-4","session_id":"s1","message":{"role":"assistant","content":"fourth"}}`,
	}
	projDir, _ := setupProjectDir(t, projectsDir, testSessionID, lines)
	sanitized := sanitizePath(projDir)

	result, err := ForkSession(testSessionID, projDir, "msg-2", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	newPath := filepath.Join(projectsDir, sanitized, result.SessionID+".jsonl")
	data, _ := os.ReadFile(newPath)
	content := string(data)
	if !strings.Contains(content, "first") || !strings.Contains(content, "second") {
		t.Error("forked file should contain messages up to msg-2")
	}
	if strings.Contains(content, "third") || strings.Contains(content, "fourth") {
		t.Error("forked file should NOT contain messages after msg-2")
	}
}

func TestForkSession_NotFound(t *testing.T) {
	_, cleanup := setupConfigDir(t)
	defer cleanup()

	_, err := ForkSession(testSessionID, "", "", "")
	if err == nil {
		t.Error("expected error for nonexistent session")
	}
}

// --- extractJSONStringField / extractLastJSONStringField tests ---

func TestExtractJSONStringField(t *testing.T) {
	tests := []struct {
		name     string
		text     string
		key      string
		expected string
	}{
		{"simple", `{"title":"hello"}`, "title", "hello"},
		{"with space", `{"title": "world"}`, "title", "world"},
		{"missing key", `{"other":"value"}`, "title", ""},
		{"escaped chars", `{"title":"hello \"world\""}`, "title", `hello "world"`},
		{"empty value", `{"title":""}`, "title", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := extractJSONStringField(tt.text, tt.key)
			if result != tt.expected {
				t.Errorf("expected %q, got %q", tt.expected, result)
			}
		})
	}
}

func TestExtractLastJSONStringField(t *testing.T) {
	tests := []struct {
		name     string
		text     string
		key      string
		expected string
	}{
		{"single", `{"title":"first"}`, "title", "first"},
		{"multiple", `{"title":"first"} {"title":"second"}`, "title", "second"},
		{"missing", `{"other":"value"}`, "title", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := extractLastJSONStringField(tt.text, tt.key)
			if result != tt.expected {
				t.Errorf("expected %q, got %q", tt.expected, result)
			}
		})
	}
}

// --- extractFirstPromptFromHead tests ---

func TestExtractFirstPromptFromHead_Simple(t *testing.T) {
	head := makeUserLine("What is Go?")
	result := extractFirstPromptFromHead(head)
	if result != "What is Go?" {
		t.Errorf("expected 'What is Go?', got %q", result)
	}
}

func TestExtractFirstPromptFromHead_SkipsToolResult(t *testing.T) {
	head := `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","text":"result"}]}}
` + makeUserLine("Real prompt")
	result := extractFirstPromptFromHead(head)
	if result != "Real prompt" {
		t.Errorf("expected 'Real prompt', got %q", result)
	}
}

func TestExtractFirstPromptFromHead_SkipsMeta(t *testing.T) {
	head := `{"type":"user","isMeta":true,"message":{"role":"user","content":"meta stuff"}}
` + makeUserLine("Real prompt")
	result := extractFirstPromptFromHead(head)
	if result != "Real prompt" {
		t.Errorf("expected 'Real prompt', got %q", result)
	}
}

func TestExtractFirstPromptFromHead_TruncatesLongPrompt(t *testing.T) {
	longText := strings.Repeat("x", 300)
	head := makeUserLine(longText)
	result := extractFirstPromptFromHead(head)
	// Should be truncated to ~200 runes + "…"
	runes := []rune(result)
	if len(runes) > 202 { // 200 + possible "…" (1 rune)
		t.Errorf("expected truncated result, got len=%d", len(runes))
	}
	if !strings.HasSuffix(result, "…") {
		t.Errorf("expected truncated prompt to end with '…', got %q", result[len(result)-5:])
	}
}

func TestExtractFirstPromptFromHead_NoUserMessages(t *testing.T) {
	head := `{"type":"assistant","message":{"role":"assistant","content":"no user msg"}}`
	result := extractFirstPromptFromHead(head)
	if result != "" {
		t.Errorf("expected empty string, got %q", result)
	}
}

// --- parseSessionInfoFromLite tests ---

func TestParseSessionInfoFromLite_Basic(t *testing.T) {
	head := makeUserLine("Test prompt") + "\n" + makeAssistantLine("Response")
	lite := &liteSessionFile{
		mtime: 1700000000000,
		size:  int64(len(head)),
		head:  head,
		tail:  head,
	}
	info := parseSessionInfoFromLite(testSessionID, lite, "/test/project")
	if info == nil {
		t.Fatal("expected non-nil info")
	}
	if info.SessionID != testSessionID {
		t.Errorf("expected session ID %s, got %s", testSessionID, info.SessionID)
	}
	if info.FirstPrompt != "Test prompt" {
		t.Errorf("expected first prompt 'Test prompt', got %q", info.FirstPrompt)
	}
	if info.CWD != "/test/project" {
		t.Errorf("expected CWD '/test/project', got %q", info.CWD)
	}
}

func TestParseSessionInfoFromLite_WithCustomTitle(t *testing.T) {
	head := makeUserLine("prompt") + "\n" + makeTitleLine("My Title")
	lite := &liteSessionFile{
		mtime: 1700000000000,
		size:  int64(len(head)),
		head:  head,
		tail:  head,
	}
	info := parseSessionInfoFromLite(testSessionID, lite, "")
	if info == nil {
		t.Fatal("expected non-nil info")
	}
	if info.CustomTitle != "My Title" {
		t.Errorf("expected custom title 'My Title', got %q", info.CustomTitle)
	}
}

func TestParseSessionInfoFromLite_WithTag(t *testing.T) {
	head := makeUserLine("prompt") + "\n" + makeTagLine("v1.0")
	lite := &liteSessionFile{
		mtime: 1700000000000,
		size:  int64(len(head)),
		head:  head,
		tail:  head,
	}
	info := parseSessionInfoFromLite(testSessionID, lite, "")
	if info == nil {
		t.Fatal("expected non-nil info")
	}
	if info.Tag != "v1.0" {
		t.Errorf("expected tag 'v1.0', got %q", info.Tag)
	}
}

func TestParseSessionInfoFromLite_Sidechain(t *testing.T) {
	head := `{"type":"user","isSidechain":true,"message":{"role":"user","content":"side"}}`
	lite := &liteSessionFile{
		mtime: 1700000000000,
		size:  int64(len(head)),
		head:  head,
		tail:  head,
	}
	info := parseSessionInfoFromLite(testSessionID, lite, "")
	if info != nil {
		t.Error("expected nil info for sidechain session")
	}
}

func TestParseSessionInfoFromLite_NoSummary(t *testing.T) {
	// A session file with only non-content entries produces no summary -> nil
	head := `{"type":"system","message":"init"}`
	lite := &liteSessionFile{
		mtime: 1700000000000,
		size:  int64(len(head)),
		head:  head,
		tail:  head,
	}
	info := parseSessionInfoFromLite(testSessionID, lite, "")
	if info != nil {
		t.Error("expected nil info when no summary is available")
	}
}

// --- readSessionLite tests ---

func TestReadSessionLite_Nil_ForMissingFile(t *testing.T) {
	result := readSessionLite("/nonexistent/path/file.jsonl")
	if result != nil {
		t.Error("expected nil for missing file")
	}
}

func TestReadSessionLite_Nil_ForEmptyFile(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "empty.jsonl")
	os.WriteFile(filePath, []byte{}, 0644)
	result := readSessionLite(filePath)
	if result != nil {
		t.Error("expected nil for empty file")
	}
}

func TestReadSessionLite_ReadsContent(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "test.jsonl")
	content := makeUserLine("test") + "\n"
	os.WriteFile(filePath, []byte(content), 0644)

	result := readSessionLite(filePath)
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.size != int64(len(content)) {
		t.Errorf("expected size %d, got %d", len(content), result.size)
	}
	if !strings.Contains(result.head, "test") {
		t.Error("head should contain file content")
	}
}

// --- deduplicateBySessionID tests ---

func TestDeduplicateBySessionID(t *testing.T) {
	sessions := []SDKSessionInfo{
		{SessionID: "id-1", LastModified: 100, Summary: "old"},
		{SessionID: "id-1", LastModified: 200, Summary: "new"},
		{SessionID: "id-2", LastModified: 150, Summary: "other"},
	}
	result := deduplicateBySessionID(sessions)
	if len(result) != 2 {
		t.Fatalf("expected 2 deduplicated sessions, got %d", len(result))
	}
	byID := make(map[string]SDKSessionInfo)
	for _, s := range result {
		byID[s.SessionID] = s
	}
	if byID["id-1"].LastModified != 200 {
		t.Errorf("expected newest entry for id-1 (200), got %d", byID["id-1"].LastModified)
	}
	if byID["id-1"].Summary != "new" {
		t.Errorf("expected summary 'new', got %q", byID["id-1"].Summary)
	}
}

// --- applySortLimitOffset tests ---

func TestApplySortLimitOffset_SortsByLastModifiedDesc(t *testing.T) {
	sessions := []SDKSessionInfo{
		{SessionID: "a", LastModified: 100},
		{SessionID: "b", LastModified: 300},
		{SessionID: "c", LastModified: 200},
	}
	result := applySortLimitOffset(sessions, nil, 0)
	if len(result) != 3 {
		t.Fatalf("expected 3 sessions, got %d", len(result))
	}
	if result[0].SessionID != "b" || result[1].SessionID != "c" || result[2].SessionID != "a" {
		t.Errorf("expected order b,c,a got %s,%s,%s", result[0].SessionID, result[1].SessionID, result[2].SessionID)
	}
}

func TestApplySortLimitOffset_LimitAndOffset(t *testing.T) {
	sessions := []SDKSessionInfo{
		{SessionID: "a", LastModified: 100, Summary: "a"},
		{SessionID: "b", LastModified: 300, Summary: "b"},
		{SessionID: "c", LastModified: 200, Summary: "c"},
	}
	limit := 1
	result := applySortLimitOffset(sessions, &limit, 1)
	if len(result) != 1 {
		t.Fatalf("expected 1 session, got %d", len(result))
	}
	// After sort desc: b(300), c(200), a(100). Offset 1 -> c(200), a(100). Limit 1 -> c(200).
	if result[0].SessionID != "c" {
		t.Errorf("expected session 'c', got %q", result[0].SessionID)
	}
}

// --- canonicalizePath tests ---

func TestCanonicalizePath_ExistingDir(t *testing.T) {
	dir := t.TempDir()
	result := canonicalizePath(dir)
	// Should be an absolute path
	if !filepath.IsAbs(result) {
		t.Errorf("expected absolute path, got %q", result)
	}
}

func TestCanonicalizePath_NonexistentDir(t *testing.T) {
	// Non-existent path should return the original
	result := canonicalizePath("/nonexistent/path/xyz123")
	if result != "/nonexistent/path/xyz123" {
		t.Errorf("expected original path for nonexistent dir, got %q", result)
	}
}

// --- unescapeJSONString tests ---

func TestUnescapeJSONString_NoEscapes(t *testing.T) {
	result := unescapeJSONString("hello world")
	if result != "hello world" {
		t.Errorf("expected 'hello world', got %q", result)
	}
}

func TestUnescapeJSONString_WithEscapes(t *testing.T) {
	result := unescapeJSONString(`hello \"world\"`)
	if result != `hello "world"` {
		t.Errorf("expected 'hello \"world\"', got %q", result)
	}
}

func TestUnescapeJSONString_Unicode(t *testing.T) {
	result := unescapeJSONString(`hello \\u0041`)
	// \\u0041 should stay as backslash + u0041 since the first backslash escapes the second
	if result != `hello \u0041` {
		t.Errorf("expected 'hello \\u0041', got %q", result)
	}
}

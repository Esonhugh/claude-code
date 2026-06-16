
VERSION := 2.1.666-test
FILE := ./dist/release/claude-code-v$(VERSION)-darwin-arm64

build:
	CLAUDE_CODE_VERSION=$(VERSION) bun package:binary
	mv $(FILE) ./built-claude



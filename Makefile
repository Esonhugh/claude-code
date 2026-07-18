
VERSION := 1.2.202
FILE := ./dist/release/claude-code-v$(VERSION)-darwin-arm64
CLAUDE_NPM_PACKAGE := @anthropic-ai/claude-code
CLAUDE_VERSION ?= latest
CLAUDE_PACK_DIR ?= package/npm
CLAUDE_PACK_EXTRACT_DIR ?= $(CLAUDE_PACK_DIR)/extracted
CLAUDE_PLATFORM_PACKAGE ?= auto
CLAUDE_BINARY_OUT ?= official-claude
CLAUDE_KEEP_PACK ?= 0

.PHONY: build test release-check download-claude clean-download-claude

build:
	CLAUDE_CODE_VERSION=$(VERSION) bun package:binary
	mv $(FILE) ./built-claude

test:
	./built-claude --dangerously-skip-permissions

release-check:
	node -e "const p=require('./package.json'); if (p.version !== '0.0.0-dev') { console.error('package.json version must stay 0.0.0-dev, got ' + p.version); process.exit(1); }"
	bunx tsc --noEmit --pretty false
	bun run lint
	bun run audit:missing
	git diff --check

download-claude:
	mkdir -p $(CLAUDE_PACK_DIR)
	rm -rf $(CLAUDE_PACK_EXTRACT_DIR)
	version=$$(bunx npm view "$(CLAUDE_NPM_PACKAGE)@$(CLAUDE_VERSION)" version); \
	os=$$(uname -s | tr '[:upper:]' '[:lower:]'); \
	arch=$$(uname -m); \
	case "$$arch" in \
		arm64|aarch64) arch=arm64 ;; \
		x86_64|amd64) arch=x64 ;; \
		*) echo "Unsupported architecture: $$arch" >&2; exit 1 ;; \
	esac; \
	case "$$os" in \
		darwin) platform="darwin-$$arch" ;; \
		linux) platform="linux-$$arch" ;; \
		msys*|mingw*|cygwin*) platform="win32-$$arch" ;; \
		*) echo "Unsupported OS: $$os" >&2; exit 1 ;; \
	esac; \
	if [ "$(CLAUDE_PLATFORM_PACKAGE)" = "auto" ]; then \
		platform_pkg="$(CLAUDE_NPM_PACKAGE)-$$platform"; \
	else \
		platform_pkg="$(CLAUDE_PLATFORM_PACKAGE)"; \
	fi; \
	tgz=$$(cd $(CLAUDE_PACK_DIR) && bunx npm pack "$$platform_pkg@$$version" | tail -n 1); \
	echo "$$platform_pkg@$$version" > $(CLAUDE_PACK_DIR)/latest-package.txt; \
	echo "$$tgz" > $(CLAUDE_PACK_DIR)/latest-tarball.txt; \
	mkdir -p $(CLAUDE_PACK_EXTRACT_DIR); \
	tar -xzf "$(CLAUDE_PACK_DIR)/$$tgz" -C $(CLAUDE_PACK_EXTRACT_DIR) --strip-components=1; \
	bin=$$(find "$(CLAUDE_PACK_EXTRACT_DIR)" -type f \( -name claude -o -name claude.exe \) | head -n 1); \
	if [ -z "$$bin" ]; then \
		echo "Could not find claude or claude.exe in $(CLAUDE_PACK_DIR)/$$tgz" >&2; \
		find "$(CLAUDE_PACK_EXTRACT_DIR)" -maxdepth 3 -type f >&2; \
		exit 1; \
	fi; \
	out="$(CLAUDE_BINARY_OUT)"; \
	case "$$bin" in *.exe) out="$(CLAUDE_BINARY_OUT).exe" ;; esac; \
	cp "$$bin" "$$out"; \
	chmod +x "$$out"; \
	printf "Downloaded %s -> %s/%s\n" "$$platform_pkg@$$version" "$(CLAUDE_PACK_DIR)" "$$tgz"; \
	printf "Extracted -> %s\n" "$(CLAUDE_PACK_EXTRACT_DIR)"; \
	printf "Binary -> %s\n" "$$out"; \
	if [ "$(CLAUDE_KEEP_PACK)" != "1" ]; then \
		rm -rf "$(CLAUDE_PACK_DIR)"; \
		printf "Cleaned -> %s\n" "$(CLAUDE_PACK_DIR)"; \
	fi

clean-download-claude:
	rm -rf $(CLAUDE_PACK_DIR)

clean: 
	rm -rf .*.bun-build
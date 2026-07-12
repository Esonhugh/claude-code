# InteractiveTerminal Acceptance Notes

- Verified `open / write / read / status / close` through `src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts`
- Verified structured error paths for `INVALID_ACTION_INPUT`, `INVALID_ACTION`, `SESSION_NOT_FOUND`, and `SESSION_ALREADY_CLOSED`
- Verified open-only permission gating in tool tests
- Verified `PtySessionManager` cursor, truncation, resize, SIGINT, and TTL reaping behavior in `src/utils/pty/PtySessionManager.test.ts`
- Verified real `node-pty` output and interrupt flow in `src/utils/pty/nodePtyDriver.integration.test.ts`
- Verified full combined acceptance suite passes:
  - `node --test src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts src/utils/pty/PtySessionManager.test.ts src/utils/pty/nodePtyDriver.integration.test.ts`
- Verified project build passes:
  - `CLAUDE_CODE_VERSION=2.1.165-dev pnpm build`

Deferred items:
- Advanced ANSI / screen buffer parsing
- Rich TUI screen semantics / snapshots
- More explicit forced-close behavior beyond the current close/kill split
- Workflow-specific UI integration on top of InteractiveTerminal

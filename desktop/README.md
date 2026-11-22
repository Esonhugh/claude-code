# Claude Code desktop (experimental)

An Electron window over `claude web`. The app starts the bundled `claude`
binary as `claude web --stdio` and talks to it over that process's stdin and
stdout, so it listens on no port. The page is served as `claude-app://app/`;
session sockets go through the preload script (`window.claudeDesktop`).

## Run from the repo

Build the binary at the repo root first (`make build` leaves it at
`./built-claude`), then:

```sh
cd desktop
bun install
CLAUDE_DESKTOP_SIDECAR=../built-claude bun run start
```

Or copy it into `desktop/sidecar/` once and start without the variable:

```sh
bun run stage            # copies ../built-claude; pass another path to override
bun run start
```

## Package

```sh
bun run stage <path to the claude binary for this platform>
bunx electron-builder --publish never
```

Installers land in `desktop/release/`. electron-builder builds for the platform
it runs on, so each platform needs its own binary and its own run; CI does this
in `.github/workflows/desktop.yml`. The installers are not signed: on macOS,
open the app the first time with right click → Open.

## Tests

```sh
bun test
bun run e2e              # opens the app against the staged sidecar; xvfb-run on Linux
```

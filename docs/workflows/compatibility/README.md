# Workflow Binary Compatibility

This directory documents how to compare this repository's workflow implementation against the currently installed official Claude Code binary at `/opt/homebrew/bin/claude`.

## Run a smoke case

```bash
npm run workflow:binary-compat -- --case=EXP-001
```

## Run a category

```bash
npm run workflow:binary-compat -- --category=args
```

## Run the full matrix

```bash
npm run workflow:binary-compat
```

## Run behavior

The runner rebuilds the local `dist/cli.js` before each run and defaults to a fresh run so stale reports are not reused after code changes. Pass `--resume` to skip cases that already exist in `workflow-compatibility-report.json`.

## Outputs

The runner writes outputs under:

```text
.claude/workflow-binary-compatibility/
```

Important files:

- `workflow-compatibility-report.json` — machine-readable comparison summary.
- `workflow-compatibility-evidence.md` — per-case evidence matrix with artifact links.
- `workflow-compatibility-development-guide.md` — source-area grouped development guide.
- `<CASE>/<official|local>/attempt-N/` — raw stdout, stderr, metadata, workspace files, and manifests.

## Difference confirmation

Every case runs once. If official and local behavior differs, the runner reruns that case two more times. Persistent differences are marked confirmed. Variable model-output differences should be reviewed through the raw artifacts before becoming implementation work.

Official `--bare` workflow probes use a shorter 30s timeout when the case asks Claude to call `Workflow({...})`, because current official binaries may not expose the Workflow tool in print/bare mode. If the official side explicitly reports that `Workflow` is unavailable, the diff is classified as `official-surface-unavailable` instead of a local compatibility failure.

## Compatibility target

The target is 90% practical execution compatibility with the installed official binary, not byte-for-byte text equality.

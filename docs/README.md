# Documentation Index

This directory contains project guides, recovery notes, architecture references, and design proposals for the recovered Claude Code source tree.

## Reading order

### 1. Start here

| Document | Purpose |
| --- | --- |
| [`../README.md`](../README.md) | Project purpose, quick start, validation commands, and change-tracking rules. |
| [`BUILD_MANUAL.md`](BUILD_MANUAL.md) | Build, run, verification, and troubleshooting guide. |
| [`SECONDARY_DEVELOPMENT_MANUAL.md`](SECONDARY_DEVELOPMENT_MANUAL.md) | Development workflow for extending and maintaining the recovered source tree. |
| [`claude-code-internals-index.md`](claude-code-internals-index.md) | Internal runtime index for CLI startup, REPL flow, tool execution, and Agent implementation logic. |

### 2. Architecture references

| Document | Scope |
| --- | --- |
| [`agent-architecture-analysis.md`](agent-architecture-analysis.md) | AgentTool, runAgent, local/background agents, resume/fork behavior, and safety controls. |
| [`agent-team-architecture.md`](agent-team-architecture.md) | Team/swarm coordination, inter-agent messaging, coordinator mode, and lifecycle. |
| [`plugin-marketplace-analysis.md`](plugin-marketplace-analysis.md) | Plugin loader, marketplace manager, install pipeline, cache, reconciliation, and policy model. |
| [`claude-agent-sdk-exports-analysis.md`](claude-agent-sdk-exports-analysis.md) | Agent SDK export map, plugin/agent/hook/session API surfaces, and unstable exports. |

### 3. Learning and design proposals

| Document | Scope |
| --- | --- |
| [`beginner-agent-development-guide.md`](beginner-agent-development-guide.md) | Learning path for agent concepts, tools, messages, hooks, plugins, and exercises. |
| [`private-plugin-marketplace-enterprise-design.md`](private-plugin-marketplace-enterprise-design.md) | Enterprise private marketplace design proposal, ACL model, distribution, and rollout plan. |

### 4. Historical working notes

| Document | Status |
| --- | --- |
| [`upgrade-plan.md`](upgrade-plan.md) | Historical implementation plan for the local feature set. Keep for traceability, but record completed changes in `CHANGELOG.md`. |

## Documentation style

Use this structure for new documents:

1. Purpose and audience.
2. Current status: implemented, recovered stub, proposal, or historical note.
3. Key files or subsystems.
4. Workflow or architecture details.
5. Validation or operational checklist.
6. Known limitations.

## Change recording rule

`CHANGELOG.md` is the authoritative record for changes after the `2.1.88` base. Architecture or design documents may explain context, but feature, behavior, dependency, and validation changes must be recorded in the changelog.

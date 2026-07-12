# Subagent nesting, /cd, and /reload-skills design

## Context

This project is based on recovered Claude Code `2.1.88` source plus local extensions. The official `anthropics/claude-code` changelog from `2.1.89` onward added several related capabilities that are valuable for this codebase:

- `2.1.172`: sub-agents can spawn their own sub-agents up to 5 levels deep.
- `2.1.181`: foreground subagents are also capped by the same 5-level depth limit.
- `2.1.178`: multiple nested subagent stability fixes around transcript viewing, live progress, message delivery, and backgrounding.
- `2.1.172`: nested-agent completion no longer leaves a parent panel stuck active.
- `2.1.169`: `/cd` changes a session's working directory without breaking prompt cache mid-session.
- `2.1.176`: `/cd` and worktree moves no longer leave stale git branch/cwd reporting.
- `2.1.152`: `/reload-skills` re-scans skill directories without restarting.

Local code already has useful primitives:

- `AgentTool` supports sync/async subagents, worktree isolation, `cwd` override, and root task-state updates.
- `runWithCwdOverride()` isolates cwd for async descendants.
- `setCwd()` updates the session cwd and resolves symlinks.
- `clearCommandsCache()` clears command/plugin/skill command caches.
- `skillChangeDetector` already supports hot reload for skill file changes.
- `/reload-plugins` refreshes active plugins, but is intentionally broader than a skill-only reload.

This spec adopts a targeted subset of official behavior instead of broad official UI parity.

## Goals

1. Allow ordinary subagents to spawn nested subagents safely, with a hard maximum depth of 5.
2. Fix the stability boundaries needed for nested subagents: task state, cwd/worktree isolation, skill visibility, and permission boundaries.
3. Add a user-facing `/cd <path>` command that changes the active session cwd without restarting or clearing history.
4. Add a user-facing `/reload-skills` command that re-scans skills without refreshing plugins.
5. Cover the behavior with minimal failing tests before implementation.

## Non-goals

- Do not migrate to official implicit agent teams or remove local `TeamCreate` / `TeamDelete` behavior.
- Do not attempt broad `claude agents` UI parity.
- Do not change Dynamic Workflows except where they naturally use `AgentTool` and benefit from nested-depth enforcement.
- Do not allow fork-subagent workers to fork again in this iteration. The existing fork-worker guard remains valid unless a separate design changes it.
- Do not implement `Agent(param:value)` permission-rule syntax in this iteration.
- Do not change InteractiveTerminal acceptance criteria.

## Design approach

Use the recommended approach B from the investigation: implement user-visible commands and a focused nested-subagent stability layer together.

### 1. Nested subagent depth model

Add explicit subagent nesting depth to the agent execution context.

- Main thread starts at depth `0`.
- A normal `AgentTool` spawn from the main thread runs at depth `1`.
- A subagent spawning another subagent runs at parent depth + 1.
- Maximum allowed depth is `5`.
- When depth is already `5`, `AgentTool` rejects further normal subagent spawning with a clear error:

```text
Subagent nesting limit reached (5). Complete the task directly instead of spawning another agent.
```

The same depth rule applies to foreground, async, background, and workflow-spawned normal subagents.

Implementation should avoid relying on transcript scans for ordinary subagent depth. Prefer a first-class field in `ToolUseContext.options` or equivalent query options so compaction and transcript rewrites cannot erase depth.

Fork subagents remain special:

- Existing `isInForkChild()` and fork-worker prompt rules continue to block fork workers from spawning subagents.
- This iteration does not make fork workers part of the normal nested-subagent depth chain.

### 2. Tool exposure and permission boundary

A nested subagent may receive `AgentTool` only if the parent agent's resolved tool set allows it. Depth checks are still enforced at call time so stale or exact-tool pools cannot bypass the limit.

Permission behavior:

- Keep existing `allowedTools` behavior: when an agent specifies allowed tools, parent session allow rules do not leak into the child except explicit CLI-level rules.
- Existing Agent deny rules continue to apply to nested spawns.
- A nested spawn must go through the same `canUseTool` / permission path as a top-level spawn.
- Cross-session messages must not acquire user authority merely because they came through a nested agent. If local code already implements relay-authority isolation, preserve it; otherwise add a targeted test and guard.

### 3. Task state and lifecycle stability

Nested async agents must register and update through the root task state, not a no-op parent subagent state setter.

Requirements:

- A nested child appears as its own agent task when running in background/async mode.
- Child progress and completion update root AppState.
- A child failure cannot leave the child task permanently `running`.
- A child completion cannot make the parent subagent look active again.
- Parent completion should not kill an independent nested child unless the parent explicitly owns and cancels that child.
- If a nested child is blocked on a further nested agent, UI state should show a waiting/blocking state rather than a misleading ticking active timer where the existing task model supports it.

The implementation should reuse existing `setAppStateForTasks` / `rootSetAppState` patterns already present in `AgentTool` and `runAgent()`.

### 4. cwd and worktree isolation

Nested subagents inherit the effective cwd of their parent execution context.

Rules:

- If the parent is running under `runWithCwdOverride()`, the child inherits that cwd by default.
- If the child specifies an explicit `cwd`, it overrides inherited cwd.
- If the child requests `isolation: "worktree"`, the worktree path becomes the child cwd.
- Explicit `cwd` remains mutually exclusive with `isolation: "worktree"`.
- A child Bash/Read/Edit/Glob/Grep operation must not leak the child cwd back to the parent session.
- Sidechain transcript metadata for resumable agents should include the effective cwd/worktree information needed to restore the agent correctly.

This is especially important because official changelog fixes mention cwd/worktree leakage and resumed subagents not restoring explicit cwd.

### 5. Skill visibility in subagents

Nested subagents should see the same relevant skill surface as normal subagents.

Requirements:

- Project, user, plugin, and bundled skills remain discoverable to subagents through the Skill tool.
- Nested subagents receive the same behavior.
- After `/reload-skills`, future subagent spawns see the refreshed skill list.
- Already-running subagents do not need forced live injection unless current architecture naturally supports it.

### 6. `/cd` command

Add a local command:

```text
/cd <path>
```

Behavior:

- Resolve relative paths against current session cwd.
- Require target to exist and be a directory.
- Resolve symlinks to the physical path, matching current `setCwd()` behavior.
- On success, update session cwd without clearing transcript or restarting the session.
- Refresh dependent runtime state:
  - session env cache
  - hook cwd-change notification
  - sandbox config
  - command/skill/workflow cache keyed by cwd
  - agent/output-style/nested `.claude` caches if present
- Return a concise success message.
- On error, return a concise error and leave cwd unchanged.

`/cd` should not add the path as an additional working directory. That remains `/add-dir`'s responsibility.

### 7. `/reload-skills` command

Add a local command:

```text
/reload-skills
```

Behavior:

- Clear skill and command memoization caches.
- Re-scan user and project skill directories.
- Preserve bundled skills.
- Preserve plugin skills as currently loaded, but do not refresh, install, update, or reconcile plugins.
- Refresh slash-command autocomplete and Skill tool command surfaces for the active session.
- Return a summary such as:

```text
Reloaded: 12 skills
```

If some skills fail to load:

```text
Reloaded: 11 skills · 1 error during load. Run /doctor for details.
```

Single-skill failures should not prevent other skills from loading.

## Testing plan

Write minimal failing tests first.

### `/cd` tests

- `/cd <absolute-dir>` updates `getCwd()`.
- `/cd <relative-dir>` resolves relative to current cwd.
- `/cd <missing>` reports an error and preserves old cwd.
- `/cd <file>` reports an error and preserves old cwd.
- `/cd` clears cwd-sensitive command caches so commands/skills from the new cwd are visible.
- `/cd` triggers the same cwd-change side effects as shell-driven cwd changes: session env invalidation and hook cwd-change notification.

### `/reload-skills` tests

- Creating a skill file after session start, then running `/reload-skills`, makes it visible through `getCommands()` or the Skill tool command list.
- Editing a skill description and running `/reload-skills` updates the command surface.
- A malformed skill does not block valid skills from loading.
- `/reload-skills` does not call plugin refresh/update paths.

### nested subagent tests

- Main thread spawns a normal subagent at depth 1.
- A depth-1 subagent can spawn a depth-2 subagent.
- Depth 5 rejects further normal subagent spawning.
- Foreground and async paths both enforce depth 5.
- A child spawned under parent cwd override sees the parent effective cwd.
- A child with explicit `cwd` uses explicit cwd and does not mutate parent cwd.
- A worktree-isolated child does not leak its cwd back to the parent.
- A nested async child completion marks the child complete and leaves no stale running task.
- A nested async child failure marks the child failed/completed according to existing task semantics and does not leave the parent active.
- A nested subagent can invoke a project/user/plugin skill available to normal subagents.

## Implementation notes

Likely touch points:

- `src/tools/AgentTool/AgentTool.tsx`
- `src/tools/AgentTool/runAgent.ts`
- `src/tools/AgentTool/forkSubagent.ts`
- `src/Tool.ts` / `ToolUseContext` types if depth belongs there
- `src/query.ts` if query options need to carry depth
- `src/tasks/LocalAgentTask/LocalAgentTask.ts`
- `src/utils/Shell.ts`
- `src/utils/cwd.ts`
- `src/commands.ts`
- new `src/commands/cd/` command
- new `src/commands/reload-skills/` command
- `src/skills/loadSkillsDir.ts`
- `src/utils/skills/skillChangeDetector.ts`

Keep edits minimal and follow existing React Ink command patterns. Use Bun for all test/build commands.

## Open decisions

None for the first implementation pass. If tests reveal that ordinary subagents already cannot see `AgentTool`, expose it only through the existing tool-resolution path rather than special-casing nested agents.

# Goal Statusline Design

## Goal

Show a visible `Goal is set` footer indicator while `/goal` mode is active, keep the actual goal prompt out of statusline data, and clear the goal status automatically when the goal StopHook determines the objective is complete.

## Current Behavior

- `/goal <prompt>` injects goal-mode instructions and sets `AppState.goalStatus.active = true`.
- `/goal clear` injects a clear prompt and sets `AppState.goalStatus.active = false`.
- `StatusLine` includes `goal: { active }` in the statusline command input.
- When a goal completes, the StopHook may allow the session to stop, but `goalStatus.active` is not cleared by the completion path.

## Desired Behavior

- `/goal <prompt>` sets only the session-local active flag in app state.
- `/goal clear` clears the active flag.
- Statusline command input continues to include only `goal.active`; it must not expose the goal prompt text.
- The footer/notification side of the prompt displays a bright `Goal is set` marker while a goal is active.
- When the `/goal` StopHook approves stopping because the objective is complete, the app clears `goalStatus` before the session becomes idle/stops.
- Goal status remains session-local. It does not need to persist across process restarts or session resume in this design.

## Command Semantics

`/goal <prompt>` remains the primary set command. There is no separate visible `/goal set` command.

Rules:

- If the trimmed argument is `clear` case-insensitively, clear the goal.
- Otherwise, use the trimmed argument in the model-facing goal prompt and set `goalStatus.active = true`.
- If the argument is empty, use the existing fallback text `(no goal provided)` in the model-facing prompt, but app state still stores only the active flag.

## State Shape

Keep `AppState.goalStatus` as:

```ts
goalStatus: {
  active: boolean
}
```

State updates:

- Set: `{ active: true }`
- Clear: `{ active: false }`

## Statusline Input and Footer Display

Statusline command input remains active-only:

```ts
goal: {
  active: goalStatus.active,
}
```

The UI marker is rendered by the prompt footer notification area so it appears alongside footer items like token/auto-compact notices:

```tsx
<Text color="warning" bold wrap="truncate">
  Goal is set
</Text>
```

Do not append the marker to the custom statusline command output and do not include the prompt content in the statusline JSON payload.

## StopHook Completion Clearing

The StopHook agent prompt already returns a decision that determines whether the assistant can stop or must continue. The implementation should clear `goalStatus` when the StopHook accepts completion for an active goal.

The clear should happen in the main session state update path that handles StopHook approval, not in the model-facing goal prompt. This avoids depending on the assistant remembering to clear state.

Expected behavior:

1. Active goal is set.
2. Assistant completes verified work.
3. StopHook returns approval to stop.
4. Main session clears `goalStatus`.
5. Footer rerenders without the `Goal is set` marker.

If StopHook rejects completion, keep `goalStatus` unchanged.

## Testing Strategy

Use TDD.

Unit tests should cover:

- `/goal <prompt>` sets `goalStatus.active = true` without storing the prompt in app state.
- `/goal clear` clears `goalStatus.active`.
- `StatusLine` command input includes only `goal.active`, even when callers pass a prompt-like object.
- `GoalStatusIndicator` returns a bright `Goal is set` text element only while active.
- StopHook approval path clears `goalStatus`.
- StopHook rejection path keeps `goalStatus`.

Interactive testing should cover:

- Run `/goal some visible target` and confirm the footer shows `Goal is set` without showing the prompt text.
- Run `/goal clear` and confirm the footer no longer shows the goal marker.
- Run a small goal that completes and confirm the goal indicator clears after StopHook approval.

## Non-Goals

- Do not persist goal status across process restarts.
- Do not add a separate `/goal set` subcommand.
- Do not expose goal prompt text to statusline commands.
- Do not change the StopHook decision model beyond clearing state on approval.
- Do not alter statusline setup command behavior.

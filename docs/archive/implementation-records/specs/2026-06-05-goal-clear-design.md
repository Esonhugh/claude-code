# Goal clear design

## Goal

Support `/goal clear` as a special form of the existing `/goal` command that clears the active autonomous goal, lets the StopHook treat the session as having no active goal, and shows `goal: active` in the status line while a goal is active.

## Approach

Use the existing prompt-command and status line architecture. Do not introduce persistent state or a new command.

- Add `goalStatus: { active: boolean }` to AppState with a default inactive state.
- Initialize `goalStatus` in the interactive `src/main.tsx` initial AppState object.
- Add `isGoalClear(args)` in `src/commands/goal.ts`.
- Treat `args.trim().toLowerCase() === 'clear'` as the clear operation.
- Add a `goalClearPrompt` that tells the assistant the current `/goal` objective is explicitly cleared, not replaced by a new goal named `clear`.
- Update `getPromptForCommand(args, context)`:
  - `/goal clear` sets `goalStatus.active` to `false` and returns `goalClearPrompt`.
  - any other `/goal <condition>` sets `goalStatus.active` to `true` and returns the existing goal prompt.
- Update the StopHook verifier prompt so it returns `ok: true` when the latest `/goal` command is `clear`.
- Fix the command `argumentHint` typo from `clearr` to `clear`.
- Update `StatusLine` so active goals append `goal: active` to the rendered status line.
- Add `goal: { active: boolean }` to the status line command input so custom status line scripts can render their own goal indicator.

## Behavior

- `/goal build release automation` keeps existing autonomous behavior and marks the goal active.
- `/goal clear` clears any prior active goal.
- `/goal clear` should not instruct the assistant to continue the previous goal.
- `/goal clear` should not start a new autonomous goal whose text is `clear`.
- If there was no active goal, `/goal clear` is still successful and leaves the session with no active goal.
- While a goal is active, the visible status line includes `goal: active`.
- After `/goal clear`, the status line no longer includes `goal: active`.
- The status line should not display the goal text, only the active marker.

## Verification

- Search for `clearr` and confirm it is removed.
- Search for `goalStatus`, `goal: active`, and `latest /goal command is clear` to confirm the source changes exist.
- Run `pnpm build`.
- Run `node ./dist/cli.js --help` to confirm command loading still works.

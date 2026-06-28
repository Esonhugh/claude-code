# Interactive Claude Code debugging

Use interactive debugging for UI, prompt handling, slash commands, permissions, workflows, task lists, and stream rendering.

## Choosing tmux vs InteractiveTerminal

Use tmux when:

- Comparing `official-claude` and `built-claude` terminal UI parity.
- Reproducing workflow/deep-research/task-list behavior where project instructions require tmux.
- Needing durable pane captures from both binaries with identical dimensions.

Use `InteractiveTerminal` when:

- Inspecting local terminal behavior quickly in this harness.
- Driving one process without a full parity matrix.
- Capturing visible terminal state through tool snapshots.

## tmux recipe

Create two sessions with matching geometry:

```sh
tmux new-session -d -s cc-official -x 120 -y 40 './official-claude --dangerously-skip-permissions'
tmux new-session -d -s cc-built -x 120 -y 40 './built-claude --dangerously-skip-permissions'
```

Send identical input:

```sh
tmux send-keys -t cc-official 'hello' Enter
tmux send-keys -t cc-built 'hello' Enter
```

Capture panes:

```sh
tmux capture-pane -p -e -t cc-official > /tmp/cc-official-pane.txt
tmux capture-pane -p -e -t cc-built > /tmp/cc-built-pane.txt
```

Record:

- session names;
- exact command lines;
- terminal size;
- input sequence;
- capture paths;
- observed difference.

Clean up only after capturing evidence:

```sh
tmux kill-session -t cc-official
tmux kill-session -t cc-built
```

## InteractiveTerminal recipe

Open a session with the target binary, then write input and read snapshots:

```text
InteractiveTerminal.open command='./built-claude --dangerously-skip-permissions'
InteractiveTerminal.write text='hello' enter=true
InteractiveTerminal.read
```

Use this mode for fast checks and for tasks where project memory prefers InteractiveTerminal over tmux. If nested Claude stalls, capture the stall state and switch to non-interactive or tmux-based verification.

## Evidence hygiene

Do not paste full terminal captures if they include secrets or private prompts. Summarize and quote only the relevant lines. Save full captures locally under `/tmp` or a named local debug directory.

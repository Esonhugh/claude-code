/**
 * CoordinatorTaskPanel — steerable list of sessions and background work.
 *
 * Renders below the prompt input footer whenever local_agent or local_workflow
 * tasks have visible rows. Enter switches to main/agent context or opens the
 * workflow detail dialog; x handling lives in PromptInput keyboard bindings.
 */

import figures from "figures";
import * as React from "react";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { Box, Text } from "../ink.js";
import { stringWidth } from "../ink/stringWidth.js";
import { useAppState, useSetAppState } from "../state/AppState.js";
import {
  enterTeammateView,
  exitTeammateView,
} from "../state/teammateViewHelpers.js";
import { isPanelAgentTask } from "../tasks/LocalAgentTask/LocalAgentTask.js";
import { logForDebugging } from "../utils/debug.js";
import { evictTerminalTask } from "../utils/task/framework.js";
import { truncateToWidth } from "../utils/truncate.js";
import {
  type CoordinatorSessionRow,
  getCoordinatorSessionRows,
  getCoordinatorTaskAtIndex,
  getCoordinatorTaskCount,
  getCoordinatorTaskIndex,
  getVisibleAgentTasks,
  resolveCoordinatorSelection,
} from "./CoordinatorAgentStatusRows.js";

export {
  getCoordinatorSessionRows,
  getCoordinatorTaskAtIndex,
  getCoordinatorTaskCount,
  getCoordinatorTaskIndex,
  getVisibleAgentTasks,
  resolveCoordinatorSelection,
};
export type {
  CoordinatorPanelTask,
  CoordinatorSessionRow,
} from "./CoordinatorAgentStatusRows.js";

export function CoordinatorTaskPanel({
  onOpenTasksDialog,
}: {
  onOpenTasksDialog?: (taskId?: string) => void;
}): React.ReactNode {
  const tasks = useAppState((s) => s.tasks);
  const viewingAgentTaskId = useAppState((s) => s.viewingAgentTaskId);
  const coordinatorTaskIndex = useAppState((s) => s.coordinatorTaskIndex);
  const tasksSelected = useAppState((s) => s.footerSelection === "tasks");
  const selectedIndex = tasksSelected ? coordinatorTaskIndex : undefined;
  const setAppState = useSetAppState();
  const setCoordinatorSelection = React.useCallback(
    (index: number, targetId?: string) => {
      setAppState((prev) => {
        if (
          prev.coordinatorTaskIndex === index &&
          prev.coordinatorTaskTargetId === targetId
        ) {
          return prev;
        }
        logForDebugging(
          `[coordinator_selection_changed] before_index=${prev.coordinatorTaskIndex} after_index=${index} before_target=${prev.coordinatorTaskTargetId ?? (prev.coordinatorTaskIndex === -1 ? "background" : "main")} after_target=${targetId ?? (index === -1 ? "background" : "main")} reason=click visible_targets=${getCoordinatorTaskCount(prev.tasks, prev.viewingAgentTaskId)}`,
        );
        return {
          ...prev,
          coordinatorTaskIndex: index,
          coordinatorTaskTargetId: targetId,
        };
      });
    },
    [setAppState],
  );

  const visibleTasks = getVisibleAgentTasks(tasks, viewingAgentTaskId);
  const hasAgentTasks = visibleTasks.some(
    (task) => task.type === "local_agent",
  );
  const hasWorkflowTasks = visibleTasks.some(
    (task) => task.type === "local_workflow",
  );

  // 1s tick: re-render for elapsed time + evict local agents past their
  // deadline. Workflows stay visible through their task lifecycle.
  const tasksRef = React.useRef(tasks);
  tasksRef.current = tasks;
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!hasAgentTasks && !hasWorkflowTasks) return;
    const interval = setInterval(
      (tasksRef, setAppState, setTick) => {
        const now = Date.now();
        for (const t of Object.values(tasksRef.current)) {
          if (isPanelAgentTask(t) && (t.evictAfter ?? Infinity) <= now) {
            evictTerminalTask(t.id, setAppState);
          }
        }
        setTick((prev: number) => prev + 1);
      },
      1000,
      tasksRef,
      setAppState,
      setTick,
    );
    return () => clearInterval(interval);
  }, [hasAgentTasks, hasWorkflowTasks, setAppState]);

  if (visibleTasks.length === 0) {
    return null;
  }

  const rows = getCoordinatorSessionRows({
    tasks,
    selectedIndex,
    viewingAgentTaskId,
  });
  const primaryColumnWidth = Math.max(
    0,
    ...rows.map(
      (row) => stringWidth(treePrefixText(row)) + stringWidth(row.primaryText),
    ),
  );

  return (
    <Box flexDirection="column" marginTop={0} paddingX={2}>
      {rows.map((row) => (
        <SessionRow
          key={row.id}
          row={row}
          primaryColumnWidth={primaryColumnWidth}
          onClick={() => {
            if (row.kind === "main") {
              setCoordinatorSelection(0, undefined);
              exitTeammateView(setAppState);
            } else if (row.kind === "agent" && row.taskId) {
              const nextIndex = getCoordinatorTaskIndex(
                tasks,
                row.taskId,
                row.taskId,
              );
              if (nextIndex !== undefined) {
                setCoordinatorSelection(nextIndex, row.taskId);
              }
              exitTeammateView(setAppState);
              enterTeammateView(row.taskId, setAppState);
            } else if (row.kind === "workflow" && row.taskId) {
              onOpenTasksDialog?.(row.taskId);
            }
          }}
        />
      ))}
    </Box>
  );
}

/**
 * Returns the number of visible coordinator rows including main.
 * Shared with PromptInput navigation bounds.
 */
export function useCoordinatorTaskCount(): number {
  const tasks = useAppState((s) => s.tasks);
  const viewingAgentTaskId = useAppState((s) => s.viewingAgentTaskId);
  return React.useMemo(
    () => getCoordinatorTaskCount(tasks, viewingAgentTaskId),
    [tasks, viewingAgentTaskId],
  );
}

function treePrefixText(row: CoordinatorSessionRow): string {
  if (row.depth === 0) return "";
  return `${"  ".repeat(Math.max(0, row.depth - 1))}${row.branch === "middle" ? "├─" : "└─"} `;
}

function SessionRow({
  row,
  primaryColumnWidth,
  onClick,
}: {
  row: CoordinatorSessionRow;
  primaryColumnWidth: number;
  onClick: () => void;
}): React.ReactNode {
  const { columns } = useTerminalSize();
  const [hover, setHover] = React.useState(false);
  const active = row.selected || hover;
  const prefix = active ? `${figures.pointer} ` : "  ";
  const treePrefix = treePrefixText(row);
  const meta = row.meta ? ` ${row.meta}` : "";
  const status = row.statusText ? ` ${row.statusText}` : "";
  const availableTextWidth = Math.max(
    0,
    columns -
      stringWidth(prefix) -
      stringWidth(row.icon) -
      1 -
      stringWidth(meta) -
      stringWidth(status),
  );
  const displayedPrimaryWidth = Math.min(primaryColumnWidth, availableTextWidth);
  const primaryAvailable = Math.max(
    0,
    displayedPrimaryWidth - stringWidth(treePrefix),
  );
  const primaryText =
    primaryAvailable > 0 ? truncateToWidth(row.primaryText, primaryAvailable) : "";
  const primaryPadding = " ".repeat(
    Math.max(0, displayedPrimaryWidth - stringWidth(treePrefix) - stringWidth(primaryText)),
  );
  const secondaryAvailable = Math.max(
    0,
    availableTextWidth - displayedPrimaryWidth - (row.secondaryText ? 2 : 0),
  );
  const secondaryText =
    secondaryAvailable > 0
      ? truncateToWidth(row.secondaryText, secondaryAvailable)
      : "";
  const secondary = secondaryText ? `  ${secondaryText}` : "";
  return (
    <Box
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Text
        dimColor={!active && !row.viewed}
        bold={row.viewed || active}
        wrap="truncate"
      >
        {prefix}
        {row.icon} {treePrefix}
        {primaryText}
        {primaryPadding}
        {secondary}
        {meta}
        {status}
      </Text>
    </Box>
  );
}

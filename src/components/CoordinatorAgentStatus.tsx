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
import { KeyboardShortcutHint } from "./design-system/KeyboardShortcutHint.js";
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
  const verbose = useAppState((s) => s.verbose);
  const { columns } = useTerminalSize();
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
  const selectedRow = rows.find((row) => row.selected);
  const selectedTask = selectedRow?.taskId
    ? tasks[selectedRow.taskId]
    : undefined;
  const contentWidth = Math.max(0, columns - 4);
  const showMetrics = contentWidth >= 60;
  const showDetails = verbose && contentWidth >= 100;
  const showTools = showDetails || hasWorkflowTasks;
  const showStatus = showDetails || hasWorkflowTasks;
  const metricWidths = {
    elapsed: Math.max(...rows.map((row) => stringWidth(row.elapsed))),
    tokens: Math.max(...rows.map((row) => stringWidth(row.tokens))),
    tools: showTools
      ? Math.max(...rows.map((row) => stringWidth(row.tools)))
      : 0,
    status: showStatus
      ? Math.max(...rows.map((row) => stringWidth(row.statusText)))
      : 0,
  };
  const metricsWidth = showMetrics
    ? metricWidths.elapsed +
      metricWidths.tokens +
      7 +
      (showTools ? metricWidths.tools + 2 : 0) +
      (showStatus ? metricWidths.status + 2 : 0)
    : 0;
  const primaryColumnWidth = Math.min(
    Math.max(0, contentWidth - 4 - metricsWidth - 2),
    Math.max(
      ...rows.map(
        (row) =>
          stringWidth(treePrefixText(row)) + stringWidth(row.primaryText),
      ),
    ),
  );

  return (
    <Box flexDirection="column" marginTop={0} paddingX={2}>
      {rows.map((row) => (
        <SessionRow
          key={row.id}
          row={row}
          primaryColumnWidth={primaryColumnWidth}
          contentWidth={contentWidth}
          metricWidths={metricWidths}
          showMetrics={showMetrics}
          showDetails={showDetails}
          showTools={showTools}
          showStatus={showStatus}
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
      {selectedRow && (
        <Text dimColor wrap="truncate">
          <KeyboardShortcutHint shortcut="Enter" action="view" />
          {selectedRow.kind === "agent" &&
            !selectedRow.viewed &&
            selectedTask && (
              <>
                {" · "}
                <KeyboardShortcutHint
                  shortcut="x"
                  action={selectedTask.status === "running" ? "stop" : "clear"}
                />
              </>
            )}
          {" · "}
          <KeyboardShortcutHint shortcut="Esc" action="cancel" />
        </Text>
      )}
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
  contentWidth,
  metricWidths,
  showMetrics,
  showDetails,
  showTools,
  showStatus,
  onClick,
}: {
  row: CoordinatorSessionRow;
  primaryColumnWidth: number;
  contentWidth: number;
  metricWidths: {
    elapsed: number;
    tokens: number;
    tools: number;
    status: number;
  };
  showMetrics: boolean;
  showDetails: boolean;
  showTools: boolean;
  showStatus: boolean;
  onClick: () => void;
}): React.ReactNode {
  const [hover, setHover] = React.useState(false);
  const active = row.selected || hover;
  const description = showDetails
    ? row.activity || row.secondaryText
    : row.secondaryText;
  return (
    <Box
      width={contentWidth}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Box width={4} flexShrink={0}>
        <Text bold={active || row.viewed} dimColor={!active && !row.viewed}>
          {active ? figures.pointer : " "} {row.icon}{" "}
        </Text>
      </Box>
      <Box width={primaryColumnWidth} flexShrink={0}>
        <Text
          color={row.color}
          bold={active || row.viewed}
          dimColor={!active && !row.viewed}
          wrap="truncate"
        >
          {treePrefixText(row)}
          {row.primaryText}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0} marginLeft={2}>
        <Text dimColor wrap="truncate">
          {showDetails ? description : truncateToWidth(description, 60)}
        </Text>
      </Box>
      {showMetrics && row.kind !== "main" && (
        <>
          {showStatus && (
            <Box width={metricWidths.status} marginLeft={2} flexShrink={0}>
              <Text dimColor>
                {showDetails || row.kind === "workflow" ? row.statusText : ""}
              </Text>
            </Box>
          )}
          {showTools && (
            <Box
              width={metricWidths.tools}
              marginLeft={2}
              flexShrink={0}
              justifyContent="flex-end"
            >
              <Text dimColor>
                {showDetails || row.kind === "workflow" ? row.tools : ""}
              </Text>
            </Box>
          )}
          <Box
            width={metricWidths.elapsed}
            marginLeft={2}
            flexShrink={0}
            justifyContent="flex-end"
          >
            <Text dimColor>{row.elapsed}</Text>
          </Box>
          <Box width={5} flexShrink={0}>
            <Text dimColor> · ↓ </Text>
          </Box>
          <Box
            width={metricWidths.tokens}
            flexShrink={0}
            justifyContent="flex-end"
          >
            <Text dimColor>{row.tokens}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}

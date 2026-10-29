/**
 * CoordinatorTaskPanel — steerable list of sessions and background work.
 *
 * Renders below the prompt input footer whenever local_agent or local_workflow
 * tasks have visible rows. Enter switches to main/agent context or opens the
 * workflow detail dialog; x handling lives in PromptInput keyboard bindings.
 */

import figures from "figures";
import * as React from "react";
import { useSubagentStatusLine } from "../hooks/useSubagentStatusLine.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { Ansi } from "../ink/Ansi.js";
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
import { hideIdleTeammates } from "../state/teammateViewHelpers.js";
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

// Official 2.1.311 shows at most five task rows under main and scrolls the
// window with the selection, so many agents cannot push the prompt off screen.
const MAX_VISIBLE_TASK_ROWS = 5;

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
  const ultracodeActive = useAppState((s) => s.effortValue === "ultracode");
  const idleTeammatesExpanded = useAppState(
    (s) => s.idleTeammatesExpanded ?? false,
  );
  const { columns } = useTerminalSize();
  const taskDecorations = useAppState((s) => s.taskDecorations);
  useSubagentStatusLine(Math.max(0, columns - 8));
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
          `[coordinator_selection_changed] before_index=${prev.coordinatorTaskIndex} after_index=${index} before_target=${prev.coordinatorTaskTargetId ?? (prev.coordinatorTaskIndex === -1 ? "background" : "main")} after_target=${targetId ?? (index === -1 ? "background" : "main")} reason=click visible_targets=${getCoordinatorTaskCount(prev.tasks, prev.viewingAgentTaskId, prev.idleTeammatesExpanded)}`,
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

  const visibleTasks = getVisibleAgentTasks(
    tasks,
    viewingAgentTaskId,
    idleTeammatesExpanded,
  );
  const hasAgentTasks = visibleTasks.some(
    (task) =>
      task.type === "local_agent" || task.type === "in_process_teammate",
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
        hideIdleTeammates(setAppState, now);
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
    ultracodeActive,
    idleTeammatesExpanded,
  });
  const mainRow = rows[0]?.kind === "main" ? rows[0] : undefined;
  const taskRows = mainRow ? rows.slice(1) : rows;
  const selectedTaskIndex = taskRows.findIndex((row) => row.selected);
  const anchorIndex = Math.max(
    0,
    selectedTaskIndex >= 0
      ? selectedTaskIndex
      : taskRows.findIndex((row) => row.viewed),
  );
  const windowStart = Math.min(
    Math.max(0, anchorIndex - MAX_VISIBLE_TASK_ROWS + 1),
    Math.max(0, taskRows.length - MAX_VISIBLE_TASK_ROWS),
  );
  const windowEnd = Math.min(
    windowStart + MAX_VISIBLE_TASK_ROWS,
    taskRows.length,
  );
  const moreAbove = windowStart;
  const moreBelow = taskRows.length - windowEnd;
  const visibleRows = [
    ...(mainRow
      ? [
          moreAbove > 0
            ? { ...mainRow, secondaryText: `↑ ${moreAbove} more` }
            : mainRow,
        ]
      : []),
    ...taskRows.slice(windowStart, windowEnd),
  ];
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
    // Token-less rows (idle teammates) right-align their state across the
    // elapsed and token columns, so they do not widen the elapsed column.
    elapsed: Math.max(
      0,
      ...rows.map((row) => (row.tokens ? stringWidth(row.elapsed) : 0)),
    ),
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
      ...rows.map((row) =>
        row.kind === "idle_summary"
          ? 0
          : stringWidth(treePrefixText(row)) + stringWidth(row.primaryText),
      ),
    ),
  );

  return (
    <Box flexDirection="column" marginTop={0} paddingX={2}>
      {!mainRow && moreAbove > 0 && (
        <Text dimColor>
          {`  ↑ ${moreAbove} more`}
        </Text>
      )}
      {visibleRows.map((row) => (
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
          decoration={
            row.kind === "agent" && row.taskId
              ? taskDecorations[row.taskId]?.content || undefined
              : undefined
          }
          onClick={() => {
            if (row.kind === "main") {
              setCoordinatorSelection(0, undefined);
              exitTeammateView(setAppState);
            } else if (
              (row.kind === "agent" || row.kind === "teammate") &&
              row.taskId
            ) {
              const nextIndex = getCoordinatorTaskIndex(
                tasks,
                row.taskId,
                row.taskId,
                idleTeammatesExpanded,
              );
              if (nextIndex !== undefined) {
                setCoordinatorSelection(nextIndex, row.taskId);
              }
              exitTeammateView(setAppState);
              enterTeammateView(row.taskId, setAppState);
            } else if (row.kind === "workflow" && row.taskId) {
              onOpenTasksDialog?.(row.taskId);
            } else if (row.kind === "idle_summary") {
              const summaryIndex = rows.indexOf(row);
              const firstRevealed = getCoordinatorTaskAtIndex(
                tasks,
                summaryIndex,
                viewingAgentTaskId,
              );
              setCoordinatorSelection(
                summaryIndex,
                firstRevealed?.type === "idle_summary"
                  ? firstRevealed.taskIds[0]
                  : undefined,
              );
              setAppState((prev) => ({ ...prev, idleTeammatesExpanded: true }));
            }
          }}
        />
      ))}
      {taskRows.length > MAX_VISIBLE_TASK_ROWS && (
        <Text dimColor>
          {moreBelow > 0 ? `  ↓ ${moreBelow} more` : " "}
        </Text>
      )}
      {selectedRow && (
        <Text dimColor wrap="truncate">
          <KeyboardShortcutHint
            shortcut="Enter"
            action={selectedRow.kind === "idle_summary" ? "expand" : "view"}
          />
          {(selectedRow.kind === "agent" || selectedRow.kind === "teammate") &&
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
          <KeyboardShortcutHint
            shortcut="Esc"
            action={
              idleTeammatesExpanded &&
              getVisibleAgentTasks(tasks, viewingAgentTaskId).some(
                (task) => task.type === "idle_summary",
              )
                ? "collapse"
                : "cancel"
            }
          />
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
  const idleTeammatesExpanded = useAppState(
    (s) => s.idleTeammatesExpanded ?? false,
  );
  return React.useMemo(
    () =>
      getCoordinatorTaskCount(tasks, viewingAgentTaskId, idleTeammatesExpanded),
    [tasks, viewingAgentTaskId, idleTeammatesExpanded],
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
  decoration,
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
  decoration?: string;
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
      <Box
        width={row.kind === "idle_summary" ? undefined : primaryColumnWidth}
        flexShrink={0}
      >
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
      {decoration !== undefined ? (
        <Box flexGrow={1} flexShrink={1} minWidth={0} marginLeft={2}>
          <Text bold={row.viewed} wrap="truncate">
            <Ansi>{decoration}</Ansi>
          </Text>
        </Box>
      ) : (
        <SessionRowDetails
          row={row}
          description={description}
          metricWidths={metricWidths}
          showMetrics={showMetrics}
          showDetails={showDetails}
          showTools={showTools}
          showStatus={showStatus}
        />
      )}
    </Box>
  );
}

function SessionRowDetails({
  row,
  description,
  metricWidths,
  showMetrics,
  showDetails,
  showTools,
  showStatus,
}: {
  row: CoordinatorSessionRow;
  description: string;
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
}): React.ReactNode {
  return (
    <>
      <Box flexGrow={1} flexShrink={1} minWidth={0} marginLeft={2}>
        <Text dimColor wrap="truncate">
          {showDetails ? description : truncateToWidth(description, 60)}
        </Text>
      </Box>
      {showMetrics && row.kind !== "main" && row.kind !== "idle_summary" && (
        <>
          {showStatus && (
            <Box width={metricWidths.status} marginLeft={2} flexShrink={0}>
              <Text dimColor>
                {showDetails || row.kind === "workflow" ? row.statusText : ""}
              </Text>
            </Box>
          )}
          {row.warning !== undefined && (
            <Box marginLeft={2} flexShrink={0}>
              <Text color="warning">{row.warning}</Text>
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
          {row.tokens ? (
            <>
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
          ) : (
            <Box
              minWidth={metricWidths.elapsed + 5 + metricWidths.tokens}
              marginLeft={2}
              flexShrink={0}
              justifyContent="flex-end"
            >
              <Text dimColor>{row.elapsed}</Text>
            </Box>
          )}
        </>
      )}
    </>
  );
}

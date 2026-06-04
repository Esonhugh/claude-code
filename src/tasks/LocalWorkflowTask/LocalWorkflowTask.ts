import type { Task, TaskStateBase } from '../../Task.js';
import type { AppState } from '../../state/AppState.js';

// Recovered external build stub.
// Workflow scripts are feature-gated and their implementation was not present
// in the public bundle/source map.
export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow';
  currentAgentId?: string;
  workflowName?: string;
  summary?: string;
  description?: string;
  agentCount?: number;
};

function endWorkflowTask(taskId: string, status: LocalWorkflowTaskState['status']) {
  return (prev: AppState): AppState => {
    const task = prev.tasks?.[taskId];
    if (!task || task.type !== 'local_workflow') {
      return prev;
    }

    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: {
          ...task,
          status,
          endTime: Date.now(),
        },
      },
    };
  };
}

export const LocalWorkflowTask: Task = {
  name: 'LocalWorkflowTask',
  type: 'local_workflow',
  async kill(taskId, setAppState) {
    setAppState(endWorkflowTask(taskId, 'killed'));
  },
};

export function killWorkflowTask(
  taskId: string,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  setAppState(endWorkflowTask(taskId, 'killed'));
}

export function skipWorkflowAgent(
  _taskId: string,
  _agentId: string,
  _setAppState: (f: (prev: AppState) => AppState) => void,
): void {}

export function retryWorkflowAgent(
  _taskId: string,
  _agentId: string,
  _setAppState: (f: (prev: AppState) => AppState) => void,
): void {}

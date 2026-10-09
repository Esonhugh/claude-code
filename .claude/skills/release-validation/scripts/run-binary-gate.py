#!/usr/bin/env python3
import argparse
import atexit
import base64
import fcntl
import hashlib
import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import stat
import ssl
import socket
import stat
import select
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit


sys.dont_write_bytecode = True
_clock_spec = importlib.util.spec_from_file_location('native_driver_clock',
    Path(__file__).resolve().parents[4] / 'scripts/native-driver-clock.py')
_driver_clock = importlib.util.module_from_spec(_clock_spec)
_clock_spec.loader.exec_module(_driver_clock)


AUTH_ENV_VARS = (
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY',
    'OPENAI_AUTH_TOKEN',
)
WORKFLOW_RUNS_ROOT = '.claude/workflow-runs'
IGNORED_FILES_EXCLUDED_ROOTS = (
    'node_modules',
    WORKFLOW_RUNS_ROOT,
    '.claude-test-evidence',
    'built-claude',
    'dist',
    'official-claude',
)
MOCK_OPENAI_TARGETS = frozenset({
    'readiness-smoke',
    'goal-lifecycle',
    'ssh-remote-session-lifecycle',
    'plugins-reload',
    'deferred-tool-discovery',
    'deferred-tool-discovery-off',
    'transcript-retention',
    'workflow-failure-detail',
    'workflow-retry-partial-failure',
    'coordinator-selector',
    'effort-openai-responses-wire',
    'fast-openai-responses-wire',
    'openai-image-input-wire',
    'openai-remote-compaction',
    'subagent-stop-failure-lifecycle',
    'openai-responses-usage-error',
    'model-discovery-picker',
    'model-discovery-empty-picker',
    'model-internal-update-config-skill',
    'prompt-modes-cache-prefix',
    'team-concurrency',
    'agent-fg-bg',
    'nested-agent',
    'workflow',
    'code-review',
    'terminal-interaction',
    'terminal-canonical-diff',
})
# These scenarios exercise the supported synchronous caller contract. Keep the
# default fork route for every other target, including Workflow workers.
FOREGROUND_FIXTURES = {
    'agent-fg-bg': ('release-foreground', 'Read'),
    'nested-agent': ('release-nested-foreground', 'Agent'),
    'coordinator-selector': ('release-coordinator-foreground', 'Bash, Read'),
    'subagent-stop-failure-lifecycle': ('release-stop-foreground', ''),
}
WORKFLOW_FAULT_SCRIPTS = {
    'workflow-failure-detail': """export const meta = { name: 'release-failure-detail', description: 'Deterministic workflow failure diagnostics.', phases: [{ title: 'Failure probe' }] }
phase('Failure probe')
const result = await agent('Return any short answer.', { label: 'invalid-schema-worker', schema: { type: 'definitely-invalid-json-schema-type' } })
if (result === null) throw new Error('release deterministic workflow failure')
return result
""",
    'workflow-retry-partial-failure': """export const meta = { name: 'release-partial-retry', description: 'Controlled partial transient retry.', phases: [{ title: 'Retry probe' }] }
phase('Retry probe')
return await parallel([
  () => agent('Return exactly stable-worker-ok.', { label: 'stable-worker' }),
  () => agent('Return exactly transient-worker-ok.', { label: 'transient-worker' }),
])
""",
}
INLINE_WORKFLOW_SCRIPT = """export const meta = { name: 'release-inline-workflow', description: 'Read-only two-agent release probe.', phases: [{ title: 'Probe' }] }
phase('Probe')
const results = await parallel([
  () => agent('Read-only. Read Makefile and report only VERSION.', { label: 'probe-a' }),
  () => agent('Read-only. Read package.json and report only version.', { label: 'probe-b' }),
])
return { results }
"""
LIFECYCLE_MOCK_KINDS = {
    'nested-agent': (
        'nested-root-launch', 'nested-parent-launch', 'nested-child-completed',
        'nested-parent-completed', 'nested-root-completed',
    ),
    'workflow': (
        'workflow-search', 'workflow-launch', 'workflow-probe-a-read',
        'workflow-probe-a-completed', 'workflow-probe-b-read',
        'workflow-probe-b-completed', 'workflow-parent-completed',
    ),
    'code-review': (
        'code-review-launch', 'code-review-scope-output',
        'code-review-scope-completed', 'code-review-parent-completed',
    ),
}
DUMMY_OPENAI_API_KEY = 'release-validation-dummy-key'
DUMMY_ANTHROPIC_API_KEY = 'release-validation-dummy-anthropic-key'
OFFICIAL_BUILTIN_MODS_SHA256 = '7529d618a2048f43b92070be542bfa6171d78932cdd24aed73b3392a33c6f161'
CUSTOM_SYSTEM_PROMPT_MARKER = 'RELEASE_CUSTOM_SYSTEM_PROMPT_MARKER'
TITLE_GENERATION_INSTRUCTION = 'Generate a concise, sentence-case title'
BUN_BUILD_TEMPORARY_PATTERN = re.compile(
    r'^\.[0-9a-f]{16}-[0-9a-f]{8}\.bun-build$'
)
PYTHON_BYTECODE_PATTERN = re.compile(r'^.+\.py[cod]$')
TARGET_PATH_RULES = (
    ('openai-stats', (
        'src/commands/stats', 'src/components/Stats', 'src/components/OpenAIStats',
        'src/components/OpenAIActivity', 'src/services/api/usage',
        'src/utils/auth', 'src/services/openai-oauth/',
    )),
    ('plugins-reload', (
        'src/utils/plugins/', 'src/services/plugins/',
        'src/commands/plugin/', 'src/commands/reload-plugins/',
        'src/cli/handlers/plugins', 'src/hooks/useManagePlugins',
        'src/services/mcp/useManageMCPConnections', 'src/services/mcp/utils',
    )),
    ('deferred-tool-discovery', (
        'src/tools/ToolSearchTool/',
        'src/tools/TerminalTool/',
        'src/utils/pty/',
        'src/tasks/TerminalTask',
        'src/tools/WorkflowTool/WorkflowFacadeTool',
        'src/tools/WorkflowTool/WorkflowTool',
        'src/tools/WorkflowTool/workflowFeatureFlags',
        'src/constants/tools',
        'src/utils/toolSearch',
        'src/utils/settings/',
        'src/services/api/openai-compat',
    )),
    ('goal-lifecycle', (
        'src/commands/goal',
        'src/tools/ClearGoalTool/',
    )),
    ('agent-fg-bg', (
        'src/tools/AgentTool/',
        'src/tools/ClearGoalTool/',
    )),
    ('nested-agent', (
        'src/tools/AgentTool/',
        'src/QueryEngine',
        'src/query',
        'src/tools/shared/spawnMultiAgent',
    )),
    ('subagent-stop-failure-lifecycle', (
        'src/tools/AgentTool/runAgent',
    )),
    ('workflow', (
        'src/tools/WorkflowTool/bundled/',
    )),
    ('code-review', (
        'src/tools/WorkflowTool/bundled/',
    )),
    ('effort-openai-responses-wire', (
        'src/commands/effort/',
        'src/components/EffortIndicator',
        'src/components/ModelPicker',
        'src/entrypoints/sdk/controlSchemas',
        'src/entrypoints/sdk/coreSchemas',
        'src/entrypoints/sdk/coreTypes.generated',
        'src/entrypoints/sdk/effortSchemas',
        'src/entrypoints/sdk/runtimeTypes',
        'src/services/api/claude-effort',
        'src/services/api/client',
        'src/services/api/openai-compat',
        'src/utils/effort',
        'src/utils/settings/types',
    )),
    ('fast-openai-responses-wire', (
        'src/commands/fast/',
        'src/services/api/claude',
        'src/services/api/openai-compat',
        'src/services/api/withRetry',
        'src/utils/fastMode',
    )),
    ('openai-image-input-wire', (
        '.github/workflows/release.yml',
        'scripts/build.mjs',
        'scripts/package-binary.mjs',
        'scripts/verify-bundled-image-runtime.mjs',
        'scripts/shims/embedded-ripgrep.js',
        'scripts/shims/embedded-sharp.js',
        'scripts/shims/image-processor-napi.js',
        'scripts/shims/sharp-native.cjs',
        'src/services/api/openai-compat',
        'src/tools/FileReadTool/FileReadTool',
        'src/tools/FileReadTool/imageProcessor',
        'src/utils/imageResizer',
    )),
    ('openai-remote-compaction', (
        'src/commands/compact/',
        'src/services/api/claude',
        'src/services/api/openai-compat',
        'src/services/compact/',
    )),
    ('openai-responses-usage-error', (
        'src/services/api/openai-compat',
    )),
    ('model-discovery-picker', (
        'src/services/api/openai-compat',
        'src/services/api/bootstrap',
        'src/utils/config',
        'src/utils/model/modelOptions',
        'src/utils/model/openaiModelOptions',
    )),
    ('first-party-bootstrap-picker', (
        'src/services/api/bootstrap',
        'src/utils/config',
        'src/utils/model/modelOptions',
        'src/utils/model/openaiModelOptions',
    )),
    ('model-discovery-empty-picker', (
        'src/utils/model/modelOptions',
    )),
    ('model-internal-update-config-skill', (
        'src/skills/bundled/modelInternalSkills',
        'src/skills/bundled/updateConfig',
    )),
    ('prompt-modes-cache-prefix', (
        'src/QueryEngine',
        'src/constants/prompts',
        'src/screens/REPL.customPrompt',
        'src/tools/BashTool/prompt',
        'src/tools/SkillTool/prompt',
        'src/tools/TaskCreateTool/prompt',
        'src/utils/attachments',
        'src/utils/claudemd',
        'src/utils/messages',
        'src/services/api/openai-compat',
        'src/utils/promptLayers',
        'src/utils/queryContext.customPrompt',
        'src/utils/systemPrompt',
    )),
    ('team-concurrency', (
        'src/utils/swarm/',
        'src/tools/shared/spawnMultiAgent',
    )),
    ('workflow-retry-partial-failure', (
        'src/tools/WorkflowTool/workflowOrchestrator',
        'src/tools/WorkflowTool/workflowPhaseScheduler',
        'src/tools/WorkflowTool/workflowScriptRuntime',
        'src/tools/WorkflowTool/runWorkflow',
        'src/tasks/LocalWorkflowTask/',
    )),
    ('workflow-failure-detail', (
        'src/tools/WorkflowTool/workflowDiagnostics',
        'src/tools/WorkflowTool/workflowEvents',
        'src/tools/WorkflowTool/workflowOrchestrator',
        'src/tools/WorkflowTool/runWorkflow',
        'src/tasks/LocalWorkflowTask/',
        'src/commands/workflows/',
    )),
    ('coordinator-selector', (
        'src/components/CoordinatorAgentStatus',
        'src/components/PromptInput/',
        'src/components/tasks/BackgroundTaskStatus',
    )),
    ('transcript-retention', (
        'src/state/selectors',
        'src/state/teammateViewHelpers',
        'src/utils/swarm/inProcessRunner',
        'src/components/TeammateViewHeader',
        'src/components/Spinner',
        'src/components/PromptInput/',
        'src/tasks/InProcessTeammateTask/',
        'src/hooks/useBackgroundTaskNavigation',
        'src/components/tasks/BackgroundTasksDialog',
        'src/components/tasks/InProcessTeammateDetailDialog',
        'src/components/tasks/backgroundTasksDialogState',
    )),
    ('ssh-remote-session-lifecycle', (
        'src/hooks/useSSHSession',
        'src/hooks/useRemoteSession',
        'src/ssh/remoteHistoryReplay',
        'src/ssh/createSSHSession',
        'src/screens/REPL',
        'src/entrypoints/sdk/controlSchemas',
    )),
    ('terminal-interaction', (
        'scripts/builtin-terminal-evidence',
        'scripts/terminal-evidence-broker',
        'scripts/test-terminal-evidence-broker',
        'scripts/verify-pty-terminal-evidence',
        'scripts/recheck-builtin-terminal-evidence',
        'scripts/terminal-capture-', 'scripts/terminal-input-evidence',
        'scripts/terminal-frame-semantics',
        'src/components/FullscreenLayout',
        'src/components/LogoV2/',
        'src/components/ModsPane',
        'src/components/PromptInput/',
        'src/components/diff/',
        'src/hooks/useTextInput',
        'src/ink/',
        'src/keybindings/',
        'src/screens/REPL',
        'src/types/textInputTypes',
        'src/utils/handlePromptSubmit',
        'src/utils/processUserInput/',
    )),
    ('builtin-mods', (
        'scripts/mods-test-lab',
        'scripts/builtin-terminal-evidence',
        'scripts/terminal-evidence-broker',
        'scripts/test-terminal-evidence-broker',
        'scripts/verify-pty-terminal-evidence',
        'scripts/recheck-builtin-terminal-evidence',
        'scripts/terminal-capture-', 'scripts/terminal-input-evidence',
        'scripts/terminal-frame-semantics',
        'src/services/mods/',
        'src/components/ModsPane',
        'src/screens/REPL',
        'src/QueryEngine',
        'src/query',
        'src/utils/handlePromptSubmit',
        'src/utils/processUserInput/',
        'src/entrypoints/cli',
        'src/plugins/builtinMods',
        'src/plugins/builtinShippedMods',
        'src/plugins/builtinPlugins',
        'src/plugins/bundled/',
        'assets/builtin-mods-',
        'assets/builtin-diff-',
    )),
)
TARGET_PATH_RULES += (('terminal-canonical-diff', (
    *next(prefixes for target, prefixes in TARGET_PATH_RULES if target == 'terminal-interaction'),
    'scripts/terminal-capture-', 'scripts/terminal-input-evidence',
    'scripts/terminal-frame-semantics',
    'src/plugins/builtinShippedMods', 'src/plugins/builtinPlugins',
    'src/services/mods/', 'assets/builtin-diff-',
)),)
TARGET_PATH_RULES += (('mods-process-spawn', (
    'src/services/mods/hostOperations', 'src/services/mods/runtime',
    'src/services/mods/dispatch', 'src/services/mods/protocol',
    'src/services/mods/loader', 'src/services/mods/environment',
    'src/services/mods/worker', 'src/services/mods/testing/runner',
    'src/services/mods/processSpawn', 'scripts/validate-mods-process-spawn.py',
)),)
SSH_LIFECYCLE_IDS = {
    'session_id': 'release-ssh-session-0001',
    'task_id': 'release-ssh-task-0001',
    'tool_use_id': 'release-ssh-tool-0001',
    'permission_request_id': 'release-ssh-permission-0001',
}
DEFAULT_TARGETS = ()
ASSERTION_RUNTIME_STATES = {'running', 'done', 'failed', 'stopped'}


def merge_no_proxy(value, *hosts):
    entries = [entry.strip() for entry in (value or '').split(',') if entry.strip()]
    entries.extend(host for host in hosts if host not in entries)
    return ','.join(entries)


def code_review_prompt(release_base):
    diff_range = f'{release_base}..HEAD'
    paths = (
        'src/tools/WorkflowTool/bundled/index.ts '
        'src/tools/WorkflowTool/bundled/index.test.ts'
    )
    return (
        f'/code-review high Read-only validation using exactly: git diff {diff_range} -- {paths}. '
        'Do not widen the diff range or path scope, run repository-wide searches, inspect '
        'unrelated commits, modify files, commit, push, release, or create worktrees.'
    )


def code_review_scope_identity(*, run_args, task_id, run_id, artifact, parents, children, log, wire=None):
    """Bind the bounded empty-Scope fixture to its actual native child, including Fork."""
    from datetime import datetime
    from xml.etree import ElementTree
    checks = []

    def require(value, reason):
        if not value:
            raise ValueError(reason)
        checks.append(reason)

    def milliseconds(value):
        return round(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)

    def blocks(entry, kind):
        content = entry.get('message', {}).get('content')
        return [block for block in content if isinstance(block, dict) and block.get('type') == kind] if isinstance(content, list) else []

    try:
        require(bool(task_id) and bool(run_id), 'owned Workflow IDs')
        require(all(artifact.get(key) == value for key, value in {
            'taskId': task_id, 'workflowRunId': run_id, 'workflowName': 'code-review',
            'scriptPath': 'bundled:code-review', 'status': 'completed', 'runArgs': run_args,
        }.items()), 'same completed bundled Workflow artifact')
        start, finish = artifact['startedAt'], artifact['updatedAt']
        require(isinstance(start, int) and isinstance(finish, int) and start <= finish, 'artifact execution interval')
        workers, cached = artifact['results'], artifact['resumeCacheEntries']
        require(len(workers) == len(cached) == 1, 'one Scope worker and one cached result')
        worker, cache = workers[0], cached[0]
        require(all(worker.get(key) == value for key, value in {
            'phaseId': 'Scope', 'agentId': 'scope', 'index': 0, 'status': 'completed',
        }.items()), 'Scope worker completed without retry')
        output = json.loads(worker['output'])
        diff = re.search(r'using exactly: (git diff [^\n]+?)\. Do not widen', run_args)
        require(diff and output.get('diffCommand') == diff.group(1) and output.get('files') == []
                and isinstance(output.get('summary'), str) and bool(output['summary']), 'exact bounded empty-scope output')
        require(all(cache.get(key) == value for key, value in {
            'phase': 'Scope', 'label': 'scope', 'index': 0, 'result': output,
        }.items()) and start <= cache['completedAt'] <= finish, 'cache matches actual worker output')
        launches = [(parent, entry, block) for parent in parents for entry in parent['entries']
                    if entry.get('type') == 'assistant' for block in blocks(entry, 'tool_use')
                    if block.get('name') == 'WorkflowTool' and block.get('input') == {
                        'action': 'run', 'selector': 'code-review', 'runArgs': run_args}]
        require(len(launches) == 1, 'one exact parent WorkflowTool launch')
        parent, launch, call = launches[0]
        cli_session, tool_id = parent['session_id'], call['id']
        parent_messages = [entry for entry in parent['entries'] if entry.get('type') in ('assistant', 'user')]
        parent_uuids = [entry.get('uuid') for entry in parent_messages]
        require(all(isinstance(value, str) and bool(value) for value in parent_uuids)
                and len(parent_uuids) == len(set(parent_uuids))
                and all(entry.get('isSidechain') is False for entry in parent_messages), 'unique native parent UUIDs')
        require(bool(cli_session) and bool(tool_id) and bool(launch.get('uuid')) and all(
            entry.get('sessionId') == cli_session for entry in parent['entries']
            if entry.get('type') in ('assistant', 'user')), 'one parent CLI session')
        replies = [(entry, block) for entry in parent['entries'] for block in blocks(entry, 'tool_result')
                   if entry.get('type') == 'user' and block.get('tool_use_id') == tool_id]
        require(len(replies) == 1, 'one native Workflow launch receipt')
        reply_entry, reply = replies[0]
        require(reply.get('is_error') is not True and reply_entry.get('parentUuid') == launch['uuid']
                and reply_entry.get('sourceToolAssistantUUID') == launch['uuid']
                and isinstance(reply.get('content'), str)
                and f'Workflow launched in background. Task ID: {task_id}\n' in reply['content']
                and re.search(rf'(?m)^Run ID: {re.escape(run_id)}$', reply['content']), 'launch receipt links task/run and parent tool')
        notes = [entry for entry in parent['entries'] if entry.get('type') == 'user'
                 and entry.get('origin', {}).get('kind') == 'task-notification']
        require(len(notes) == 1 and isinstance(notes[0]['message']['content'], str), 'one native completion notification')
        notification_text = notes[0]['message']['content']
        require(notification_text.startswith('<task-notification>')
                and notification_text.endswith('</task-notification>')
                and '<!DOCTYPE' not in notification_text and '<!ENTITY' not in notification_text, 'bounded notification document')
        notification = ElementTree.fromstring(notification_text)
        require(notification.tag == 'task-notification' and not notification.attrib
                and len(list(notification.iter('task-notification'))) == 1, 'one notification root')
        for tag, expected in (('task-id', task_id), ('tool-use-id', tool_id), ('status', 'completed')):
            nodes = notification.findall(tag)
            require(len(nodes) == 1 and not list(nodes[0]) and not nodes[0].attrib
                    and nodes[0].text == expected, 'exact direct notification ' + tag)
        result_nodes, usage_nodes = notification.findall('result'), notification.findall('usage')
        require(len(result_nodes) == len(usage_nodes) == 1 and not list(result_nodes[0]), 'one final result and usage')
        require(json.loads(result_nodes[0].text) == {
            'level': 'high', 'target': run_args.removeprefix('high '),
            'summary': 'No changes found to review.', 'findings': [],
            'stats': {'finders': 0, 'candidates': 0, 'verified': 0},
        }, 'bounded empty-scope final report')
        for tag, expected in (('total_tokens', artifact['tokenCount']), ('tool_uses', artifact['toolUseCount'])):
            nodes = usage_nodes[0].findall(tag)
            require(len(nodes) == 1 and not list(nodes[0]) and isinstance(expected, int)
                    and expected >= 0 and nodes[0].text == str(expected), 'notification matches artifact ' + tag)
        duration = usage_nodes[0].findall('duration_ms')
        require(len(duration) == 1 and not list(duration[0]) and re.fullmatch(r'[0-9]+', duration[0].text or ''), 'native notification duration')
        require(milliseconds(launch['timestamp']) <= start <= milliseconds(reply_entry['timestamp'])
                and finish <= milliseconds(notes[0]['timestamp'])
                and milliseconds(reply_entry['timestamp']) <= milliseconds(notes[0]['timestamp']),
                'parent launch and completion notification bind this execution')
        scope = f'task={task_id} run={run_id} '
        lines = log.splitlines()
        starts = [index for index, line in enumerate(lines) if 'workflow_worker_start ' + scope in line]
        ends = [index for index, line in enumerate(lines) if 'workflow_worker_terminal ' + scope in line]
        require(len(starts) == len(ends) == 1 and starts[0] < ends[0], 'one same-run worker interval')
        exact = 'phase=Scope logical=scope agent=scope attempt=0 worker=0'
        require(lines[starts[0]].endswith(exact) and lines[ends[0]].endswith(exact + ' status=completed'), 'exact Scope attempt terminal')
        begin_ms, end_ms = (milliseconds(lines[index].split(' ', 1)[0]) for index in (starts[0], ends[0]))
        require(start <= begin_ms <= end_ms <= finish, 'worker belongs to artifact interval')
        window = lines[starts[0] + 1:ends[0]]
        require(not any('workflow_worker_start ' in line for line in window), 'no competing worker in identity interval')
        actual = [match for line in window if (match := re.search(
            r'\[runAgent\] agentId=([^, ]+), agentType=general-purpose, model=([^, ]+),', line))]
        params = [json.loads(line.split('AgentTool launch params ', 1)[1])
                  for line in window if 'AgentTool launch params ' in line]
        require(len(actual) == len(params) == 1, 'one actual native child execution')
        agent_id, model = actual[0].groups()
        require(all(params[0].get(key) == value for key, value in {
            'selectedAgentType': 'general-purpose', 'permissionMode': 'plan', 'toolUseId': tool_id,
            'spawnDepth': 1, 'model': model,
        }.items()) and isinstance(params[0].get('isAsync'), bool), 'Agent launch metadata links parent tool')
        candidates = [child for child in children if child.get('session_id') == cli_session
                      and child.get('agent_id') == agent_id]
        require(len(candidates) == 1, 'one child transcript in same CLI session')
        child = candidates[0]
        require(all(child['meta'].get(key) == value for key, value in {
            'agentType': 'general-purpose', 'description': 'code-review: scope', 'toolUseId': tool_id,
            'permissionMode': 'plan', 'spawnDepth': 1, 'model': model,
        }.items()), 'native child meta links Scope and parent')
        entries = [entry for entry in child['entries'] if entry.get('type') in ('user', 'assistant')]
        child_uuids = [entry.get('uuid') for entry in entries]
        require(all(isinstance(value, str) and bool(value) for value in child_uuids)
                and len(child_uuids) == len(set(child_uuids)) and not set(child_uuids).intersection(parent_uuids)
                and all(entry.get('isSidechain') is True for entry in entries), 'unique native sidechain UUIDs')
        require(len(entries) == 3 and all(entry.get('agentId') == agent_id
                and entry.get('sessionId') == cli_session
                and begin_ms <= milliseconds(entry['timestamp']) <= end_ms for entry in entries), 'child messages belong to this native execution')
        schema = {'type': 'object', 'required': ['diffCommand', 'files', 'summary'],
                  'properties': {'diffCommand': {'type': 'string'}, 'files': {'type': 'array', 'items': {'type': 'string'}},
                                 'summary': {'type': 'string'}, 'conventions': {'type': 'string'}}}
        suffix = ('\n\nYou MUST call the `StructuredOutput` tool exactly once to return your answer.\n'
                  'The tool input must match this JSON Schema:\n```json\n' + json.dumps(schema, indent=2) + '\n```\n'
                  'Do NOT put your answer in a text response. The script reads ONLY the tool call.\n'
                  'If schema validation fails, read the error and call the tool again with corrected input.')
        require(entries[0].get('type') == 'user' and isinstance(worker.get('prompt'), str) and bool(worker['prompt'])
                and entries[0]['message']['content'] == worker['prompt'] + suffix, 'exact actual worker prompt and schema')
        structured = blocks(entries[1], 'tool_use')
        require(entries[1].get('type') == 'assistant' and len(structured) == 1
                and structured[0].get('name') == 'StructuredOutput' and structured[0].get('input') == output
                and entries[1].get('parentUuid') == entries[0].get('uuid'), 'actual StructuredOutput matches artifact/cache')
        receipts = blocks(entries[2], 'tool_result')
        require(entries[2].get('type') == 'user' and len(receipts) == 1
                and receipts[0].get('tool_use_id') == structured[0].get('id') and bool(structured[0].get('id'))
                and receipts[0].get('is_error') is not True
                and receipts[0].get('content') == 'Structured output provided successfully'
                and entries[2].get('sourceToolAssistantUUID') == entries[1]['uuid']
                and entries[2].get('parentUuid') == entries[1].get('uuid'), 'native successful StructuredOutput receipt')
        parent_wire = []
        for kind in ('code-review-launch', 'code-review-parent-completed', 'code-review-notification-completed'):
            matches = [request for request in wire if request.get('response_kind') == kind]
            require(len(matches) == 1, 'one transported parent ' + kind)
            request = matches[0]
            require(request.get('method') == 'POST' and request.get('path') == '/v1/responses'
                    and request.get('authorization', {}).get('matches_dummy') is True
                    and all(request.get('headers', {}).get(key) == cli_session for key in (
                        'session-id', 'x-claude-code-session-id', 'thread-id')), 'transported native parent CLI identity')
            if kind != 'code-review-launch':
                items = request['body']['input']
                calls = [item for item in items if item.get('type') == 'function_call' and item.get('name') == 'WorkflowTool']
                returns = [item for item in items if item.get('type') == 'function_call_output' and item.get('call_id') == tool_id]
                require(len(calls) == len(returns) == 1 and calls[0].get('id') == calls[0].get('call_id') == tool_id
                        and json.loads(calls[0]['arguments']) == call['input']
                        and returns[0].get('output') == reply['content'], 'transported parent call and exact task/run receipt')
            if kind == 'code-review-notification-completed':
                messages = [block.get('text') for item in request['body']['input'] if item.get('role') == 'user'
                            for block in item.get('content', []) if isinstance(block, dict) and block.get('type') == 'input_text']
                require(messages.count(notification_text) == 1, 'transported exact native completion notification')
            parent_wire.append(request)
        wire_sides = []
        for kind in ('code-review-scope-output', 'code-review-scope-completed'):
            matches = [request for request in wire if request.get('response_kind') == kind]
            require(len(matches) == 1, 'one transported ' + kind)
            request = matches[0]
            require(request.get('method') == 'POST' and request.get('path') == '/v1/responses'
                    and request.get('authorization', {}).get('matches_dummy') is True
                    and all(request.get('headers', {}).get(key) == value for key, value in {
                        'session-id': cli_session, 'x-claude-code-session-id': cli_session,
                        'thread-id': agent_id,
                    }.items()), 'transport belongs to same native CLI/child with dummy auth')
            body = request['body']
            require(body['input'][1].get('role') == 'user'
                    and body['input'][1]['content'][1] == {'type': 'input_text', 'text': worker['prompt'] + suffix},
                    'transported actual worker prompt')
            tools = [tool for tool in body['tools'] if tool.get('name') == 'StructuredOutput']
            require(len(tools) == 1 and tools[0].get('type') == 'function'
                    and tools[0].get('parameters') == schema, 'transported exact StructuredOutput schema')
            wire_sides.append(request)
        require(isinstance(wire_sides[0]['sequence'], int) and wire_sides[0]['sequence'] < wire_sides[1]['sequence'],
                'native child transport order')
        require(parent_wire[0]['sequence'] < parent_wire[1]['sequence'] < parent_wire[2]['sequence']
                and parent_wire[0]['sequence'] < wire_sides[0]['sequence']
                < wire_sides[1]['sequence'] < parent_wire[2]['sequence'],
                'each native parent/child stream precedes the completion notification')
        wire_items = wire_sides[1]['body']['input']
        calls = [item for item in wire_items if item.get('type') == 'function_call']
        returns = [item for item in wire_items if item.get('type') == 'function_call_output']
        require(len(calls) == len(returns) == 1 and calls[0].get('name') == 'StructuredOutput'
                and calls[0].get('call_id') == calls[0].get('id') == structured[0]['id']
                and json.loads(calls[0]['arguments']) == output
                and returns[0].get('call_id') == structured[0]['id'], 'transported call/result IDs and exact arguments')
        # The native side transcript above remains the authoritative unwrapped
        # receipt. Wire may append complete system-reminder blocks, never arbitrary
        # text or a second result. Reminder contents are data, not identity evidence.
        transported = returns[0].get('output')
        require(isinstance(transported, str) and re.fullmatch(
            re.escape(receipts[0]['content']) + r'(?:\n\n<system-reminder>\n(?:(?!</?system-reminder>)[\s\S])+\n</system-reminder>)*',
            transported), 'transported successful receipt with bounded reminder wrappers')
        return {'complete': True, 'agent_ids': [agent_id], 'cli_session': cli_session,
                'task_id': task_id, 'run_id': run_id, 'parent_tool_use_id': tool_id,
                'structured_tool_use_id': structured[0]['id'], 'checks': checks,
                'scope': 'bounded empty Scope; same CLI/task/run identity; actual pane/TTY and later review phases require separate evidence'}
    except (ValueError, KeyError, TypeError, IndexError, AttributeError, ElementTree.ParseError) as error:
        return {'complete': False, 'agent_ids': [], 'checks': checks, 'reason': str(error)}


def submitted_input_pending(pane):
    plain = strip_ansi(pane).replace('\u00a0', ' ')
    lines = plain.splitlines()
    prompt_indexes = [
        index for index, line in enumerate(lines)
        if '❯' in line
    ]
    if not prompt_indexes:
        return False
    prompt_index = prompt_indexes[-1]
    prompt_text = lines[prompt_index].split('❯', 1)[1].strip()
    if not prompt_text or prompt_text.startswith('Message @'):
        return False

    def is_terminal_chrome(line):
        compact = line.replace(' ', '')
        lower = line.lower()
        return (
            bool(compact) and set(compact) <= {'─'}
        ) or (
            'bypass permissions on' in line
            or 'Debug mode' in line
            or 'Goal is set' in line
            or 'plan mode on' in lower
            or 'shift + ↓ to expand' in line
        )

    trailing_content = [
        line.strip()
        for line in lines[prompt_index + 1:]
        if line.strip()
    ]
    separator_index = next(
        (
            index
            for index, line in enumerate(trailing_content)
            if bool(line.replace(' ', ''))
            and set(line.replace(' ', '')) <= {'─'}
        ),
        None,
    )
    if separator_index is not None:
        content_after_separator = [
            line
            for line in trailing_content[separator_index + 1:]
            if not is_terminal_chrome(line)
        ]
        if not content_after_separator:
            return True
        return all(line.lstrip().startswith('/') for line in content_after_separator)
    return not any(
        not is_terminal_chrome(line)
        for line in trailing_content
    )


def submitted_input_visible(pane, text):
    plain = strip_ansi(pane).replace('\u00a0', ' ')
    lines = plain.splitlines()
    prompt_indexes = [
        index for index, line in enumerate(lines)
        if '❯' in line
    ]
    if not prompt_indexes:
        return False
    prompt_index = prompt_indexes[-1]
    prompt_lines = [lines[prompt_index].split('❯', 1)[1].strip()]
    for line in lines[prompt_index + 1:]:
        stripped = line.strip()
        compact = stripped.replace(' ', '')
        if bool(compact) and set(compact) <= {'─'}:
            break
        prompt_lines.append(stripped)
    visible_text = '\n'.join(prompt_lines).strip()
    if re.sub(r'\s+', ' ', visible_text) == re.sub(r'\s+', ' ', text.strip()):
        return True
    pasted_ref = re.fullmatch(
        r'\[Pasted text #\d+(?: \+(\d+) lines)?\]',
        visible_text,
    )
    if not pasted_ref:
        return False
    visible_lines = int(pasted_ref.group(1) or 0)
    return visible_lines == len(re.findall(r'\r\n|\r|\n', text))


def _terminal_native_exit_receipts_passed(run, capture, binary_sha256, collector_closed):
    """Backend originals; outer collector EOF is a separate closing stage."""
    try:
        if type(capture.get('nativeJournal')) is not bool:
            return False
        if capture['nativeJournal'] and (not isinstance(binary_sha256, str) or not re.fullmatch(r'[a-f0-9]{64}', binary_sha256)):
            return False
        if capture['nativeJournal'] and (not isinstance(capture.get('captureId'), str) or not capture['captureId']):
            return False
        names = (('start.json', 'cleanup.json', 'broker-cleanup.json', 'producer-expected-native.json') +
                 (('capture-eof',) if collector_closed else ())
                 if capture['nativeJournal'] else ('native-pty-eof.json',))
        values = {}
        for name in names:
            named = os.lstat(run / name)
            if not stat.S_ISREG(named.st_mode):
                return False
            fd = os.open(run / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as file:
                info = os.fstat(file.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
                        (capture['nativeJournal'] and stat.S_IMODE(info.st_mode) != 0o600) or info.st_nlink != 1 or
                        (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)):
                    return False
                data = file.read()
            values[name] = data.decode().strip() if name == 'capture-eof' else json.loads(data)
        if not capture['nativeJournal']:
            value = values['native-pty-eof.json']
            return type(value.get('childExitCode')) is int and value['childExitCode'] == 0
        start, closed, producer = (values[name] for name in ('start.json', 'cleanup.json', 'producer-expected-native.json'))
        pid = start.get('childPid')
        return (type(pid) is int and pid > 0 and type(start.get('childPgid')) is int and start['childPgid'] == pid and
                start.get('binarySha256') == binary_sha256 and json.dumps(closed, sort_keys=True) == json.dumps(values['broker-cleanup.json'], sort_keys=True) and
                closed.get('backend') == producer.get('backend') == 'native-shared-slot-v1' and
                closed.get('captureId') == producer.get('captureId') == capture.get('captureId') and
                type(closed.get('childPid')) is type(producer.get('childPid')) is int and
                closed['childPid'] == producer['childPid'] == pid and
                producer.get('binarySha256') == binary_sha256 and
                type(closed.get('childExitCode')) is int and closed['childExitCode'] == 0 and
                closed.get('childReaped') is True and closed.get('physicalEof') is True and
                closed.get('normalCompletion') is True and 'failure' in closed and closed['failure'] is None and
                closed.get('signalsSent') == [] and closed.get('cleanupErrors') == [] and
                type(producer.get('nativeClose')) is dict and type(producer.get('ioClose')) is dict and
                json.dumps(producer['nativeClose'], sort_keys=True) == json.dumps(closed.get('nativeClose'), sort_keys=True) and
                json.dumps(producer['ioClose'], sort_keys=True) == json.dumps(closed.get('ioClose'), sort_keys=True) and
                producer['nativeClose'].get('method') == 'owned-broker-closed-native-v1' and
                producer['ioClose'].get('method') == 'owned-broker-closed-io-v1' and
                (not collector_closed or values['capture-eof'] == '0'))
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return False


def terminal_native_exit_identity(run, launch, binary_sha256):
    """Keep the launch-bound primitive identity across close clearing members."""
    if (not isinstance(launch, dict) or launch.get('run') != str(run.resolve()) or
            not isinstance(binary_sha256, str) or not re.fullmatch(r'[a-f0-9]{64}', binary_sha256) or
            launch.get('binarySha256') != binary_sha256):
        return None
    capture = launch.get('capture')
    if (not isinstance(capture, dict) or type(capture.get('nativeJournal')) is not bool or
            not isinstance(capture.get('captureId'), str) or not capture['captureId']):
        return None
    return {'capture': {'nativeJournal': capture['nativeJournal'], 'captureId': capture['captureId']},
            'binarySha256': binary_sha256}


def terminal_native_producer_exit_passed(run, capture, binary_sha256):
    """Normal native producer closure only; never validates the outer pipe."""
    return _terminal_native_exit_receipts_passed(run, capture, binary_sha256, False)


def terminal_native_exit_passed(run, capture, binary_sha256):
    """Normal producer plus actual collector EOF; never a full UI verdict."""
    return _terminal_native_exit_receipts_passed(run, capture, binary_sha256, True)


def input_prompt_ready(pane):
    plain = strip_ansi(pane).replace('\u00a0', ' ')
    lines = plain.splitlines()
    prompt_indexes = [
        index for index, line in enumerate(lines)
        if re.fullmatch(r'\s*❯\s*', line)
    ]
    if not prompt_indexes:
        return False
    trailing = '\n'.join(lines[prompt_indexes[-1] + 1:]).lower()
    return 'esc to interrupt' not in trailing


def parse_target_list(raw, *, option_name='targets'):
    if raw is None:
        return []
    if raw == '':
        raise ValueError(f'{option_name} must not be empty')
    parsed = []
    seen = set()
    for index, item in enumerate(raw.split(','), start=1):
        target = item.strip()
        if not target:
            raise ValueError(
                f'{option_name} contains an empty target at position {index}'
            )
        if target in seen:
            raise ValueError(f'{option_name} contains a duplicate target: {target}')
        seen.add(target)
        parsed.append(target)
    return parsed



def listed_paths(text):
    return {
        line.strip()
        for line in text.splitlines()
        if line.strip()
    }



def resolve_release_base(repo, baseline, explicit_base_ref=None):
    if explicit_base_ref:
        merge_base = command(
            ['git', '-C', str(repo), 'merge-base', 'HEAD', explicit_base_ref],
            check=False,
        )
        resolved = merge_base.stdout.strip()
        if merge_base.returncode != 0 or not resolved:
            raise RuntimeError(
                f'could not determine merge-base for --base-ref {explicit_base_ref!r}'
            )
        return {
            'base_ref': explicit_base_ref,
            'merge_base': resolved,
            'source': '--base-ref merge-base',
        }
    release_base_commit = baseline.get('release_base_commit')
    if not release_base_commit:
        raise RuntimeError(
            'baseline did not record immutable release_base_commit; '
            'pass --base-ref <commit-ish> to validate committed release-range targets'
        )
    merge_base = command(
        ['git', '-C', str(repo), 'merge-base', 'HEAD', release_base_commit],
        check=False,
    )
    resolved = merge_base.stdout.strip()
    if merge_base.returncode != 0 or resolved != release_base_commit:
        raise RuntimeError(
            'baseline release_base_commit is not an ancestor of HEAD; '
            'pass --base-ref <commit-ish>'
        )
    return {
        'base_ref': baseline.get('release_base_ref', release_base_commit),
        'merge_base': release_base_commit,
        'source': 'baseline immutable release base commit',
    }



def collect_required_target_inputs(repo, baseline, explicit_base_ref=None):
    release_base = resolve_release_base(repo, baseline, explicit_base_ref)
    paths_by_source = {
        'committed_release_range': sorted(listed_paths(command(
            [
                'git', '-C', str(repo), 'diff', '--name-only',
                f"{release_base['merge_base']}..HEAD",
            ],
            check=True,
        ).stdout)),
        'staged': sorted(listed_paths(command(
            ['git', '-C', str(repo), 'diff', '--cached', '--name-only'],
            check=True,
        ).stdout)),
        'unstaged': sorted(listed_paths(command(
            ['git', '-C', str(repo), 'diff', '--name-only'],
            check=True,
        ).stdout)),
        'untracked': sorted(
            baseline['untracked_files_manifest']
            if baseline.get('retain_artifacts') else untracked_manifest(repo)
        ),
    }
    all_paths = sorted({
        path
        for paths in paths_by_source.values()
        for path in paths
    })
    return {
        'release_base': release_base,
        'paths_by_source': paths_by_source,
        'all_paths': all_paths,
    }



def required_targets_for_paths(paths):
    return {
        target
        for target, prefixes in TARGET_PATH_RULES
        if any(
            path == prefix or path.startswith(prefix)
            for path in paths
            for prefix in prefixes
        )
    }



def plan_targets(extra_targets, required_targets, *, retain_artifacts=False):
    duplicate_defaults = sorted(set(DEFAULT_TARGETS) & set(extra_targets))
    if duplicate_defaults:
        raise ValueError(
            '--targets may only append non-default targets; already included by '
            f'default: {duplicate_defaults}'
        )
    planned = list(DEFAULT_TARGETS)
    seen = set(planned)
    for target in [*sorted(required_targets), *extra_targets]:
        if target not in seen:
            planned.append(target)
            seen.add(target)
    return planned



def assertion_source_runs(runs, registered_runs):
    source_runs = {}
    driver_runs = {run.get('driver_run') for run in runs}
    if len(driver_runs) != 1 or not all(driver_runs):
        return source_runs
    for run in runs:
        for source in [run, *run.get('cases', []), *run.get('scenarios', [])]:
            evidence_dir = source.get('evidence_dir')
            if not isinstance(evidence_dir, str) or not evidence_dir:
                continue
            root = Path(evidence_dir).resolve(strict=False)
            try:
                metadata_text = (root / 'run-metadata.json').read_text()
                if registered_runs.get(str(root)) != metadata_text:
                    continue
                metadata = json.loads(metadata_text)
            except (OSError, ValueError):
                continue
            if (not isinstance(metadata, dict)
                    or metadata.get('driver_run') != run['driver_run']
                    or metadata.get('source_run') != root.name
                    or metadata.get('evidence_dir') != str(root)
                    or metadata.get('label') != source.get('label')
                    or root.parent != Path(run['evidence_dir']).resolve().parent):
                continue
            source_runs[root.name] = root
    return source_runs





BUILTIN_SIDE_NAMES = ('privacyOff', 'privacyOn', 'enabled', 'disabled',
                      'securityOrdinary', 'securityTeam', 'securityEnterprise')
BUILTIN_ASSERTIONS = frozenset({'completeness', 'cleanup', 'agents', 'diff', 'security',
                              'ui', 'dynamicTools', 'suggestionReload', 'telemetry', 'terminalEvidence'})
BUILTIN_CHECKS = frozenset({'subprocess', 'report', 'assertions', 'binary', 'sides',
                           'evidence_ownership', 'cache_cleanup', 'independent_frame_replay'})


def revalidate_builtin_assertion(source_root, acceptance_path, binary_sha256):
    script = Path(__file__).resolve().parents[4] / 'scripts/recheck-builtin-terminal-evidence.mjs'
    try:
        completed = subprocess.run(
            [shutil.which('bun') or 'bun', '--no-env-file', str(script), '--final',
             str(acceptance_path), binary_sha256, str(source_root / 'builtin-terminal-recheck.json'),
             str(source_root / 'builtin-cache-archive.json')],
            cwd=script.parent.parent,
            env={'PATH': '/opt/homebrew/bin:/usr/bin:/bin', 'HOME': str(source_root),
                 'TMPDIR': '/private/tmp', 'DISABLE_TELEMETRY': '1',
                 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'},
            capture_output=True, text=True, timeout=60,
        )
        result = json.loads(completed.stdout)
        return (completed.returncode == 0 and result.get('verdict') == 'passed'
                and result.get('acceptance') == str(acceptance_path)
                and result.get('binarySha256') == binary_sha256)
    except (OSError, ValueError, TypeError, subprocess.TimeoutExpired):
        return False



def canonical_wire_checks(run_dir, wire, debug, expected_host):
    invalid = {'canonical_wire_complete': False, 'canonical_wire_identity': False,
               'canonical_wire_tool_receipts': False}
    try:
        session_ids = set(re.findall(r'\[ForkMode\] enabled source=default sessionId=([a-f0-9-]{36})', debug))
        if len(session_ids) != 1 or not isinstance(wire, list) or len(wire) != 8:
            return invalid
        session = next(iter(session_ids))
        posts = [row for row in wire if row.get('method') == 'POST' and row.get('path') == '/v1/responses']
        main = [row for row in posts if is_main_response_request(row)]
        kinds = [f'canonical-{file}-{step}' for file in ('alpha', 'omega')
                 for step in ('read', 'write', 'completed')]
        complete = (len(posts) == 7 and len(main) == 6
                    and [row.get('response_kind') for row in main] == kinds
                    and sum(row.get('response_kind') == 'title' and not is_main_response_request(row)
                            for row in posts) == 1
                    and sum(row.get('method') == 'GET' and row.get('path') == '/v1/models'
                            and row.get('response_kind') == 'models' for row in wire) == 1
                    and [row.get('sequence') for row in wire] == list(range(1, 9)))
        request_ids = [row.get('headers', {}).get('x-client-request-id') for row in posts]
        models = {row.get('body', {}).get('model') for row in main}
        identity = (bool(expected_host) and len(models) == 1 and all(isinstance(model, str) and model for model in models)
                    and len(set(request_ids)) == 7
                    and all(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value)
                            for value in request_ids)
                    and all(row.get('authorization') == {'present': True, 'matches_dummy': True} for row in wire)
                    and all(openai_request_metadata_matches(row.get('headers', {}), session)
                            and row['headers'].get('host') == expected_host
                            and row['headers'].get('content-type') == 'application/json'
                            and row['body'].get('prompt_cache_key') == session
                            and row['body'].get('stream') is True and row['body'].get('store') is False
                            for row in posts))
        server = object.__new__(MockOpenAIServer)
        server.run_dir = run_dir
        receipts = complete and all(server.canonical_diff_response(row['body'])[0] == kind
                                    for row, kind in zip(main, kinds))
        # Every tool continuation must retain the exact preceding input bytes.
        # The live Responses adapter appends one call/result pair per step.
        receipts = receipts and all(
            len(following['body']['input']) == len(previous['body']['input']) + 2
            and following['body']['input'][:-2] == previous['body']['input']
            for base in (0, 3)
            for previous, following in zip(main[base:base + 2], main[base + 1:base + 3]))
        return {'canonical_wire_complete': complete, 'canonical_wire_identity': identity,
                'canonical_wire_tool_receipts': receipts}
    except (AttributeError, KeyError, TypeError, ValueError):
        return invalid


def revalidate_terminal_assertion(source_root):
    script = Path(__file__).resolve().parents[4] / 'scripts/terminal-capture-driver.mjs'
    try:
        completed = subprocess.run(
            [shutil.which('bun') or 'bun', '--no-env-file', str(script), 'verify',
             str(source_root / 'capture-launch.json')],
            cwd=script.parent.parent,
            env={'PATH': '/opt/homebrew/bin:/usr/bin:/bin', 'HOME': str(source_root),
                 'TMPDIR': '/private/tmp', 'DISABLE_TELEMETRY': '1',
                 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'},
            capture_output=True, text=True, timeout=60,
        )
        result = json.loads(completed.stdout)
        launch = json.loads((source_root / 'capture-launch.json').read_text())
        return (completed.returncode == 0 and result.get('verdict') == 'passed'
                and result.get('run') == str(source_root)
                and result.get('captureId') == launch['capture']['captureId']
                and result.get('binarySha256') == launch['binarySha256'])
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
        return False


def assertion_is_valid(assertion, source_runs, registered_runs=None):
    if not isinstance(assertion, dict):
        return False
    if assertion.get('validation_verdict') != 'passed':
        return False
    assertion_id = assertion.get('assertion_id')
    source_run = assertion.get('source_run')
    runtime_state = assertion.get('runtime_state')
    evidence_paths = assertion.get('observed_evidence_paths')
    if not isinstance(assertion_id, str) or not assertion_id.strip():
        return False
    if not isinstance(source_run, str) or not source_run.strip():
        return False
    if source_run not in source_runs:
        return False
    if runtime_state not in ASSERTION_RUNTIME_STATES:
        return False
    if not isinstance(evidence_paths, list) or not evidence_paths:
        return False
    required_paths = assertion.get('required_evidence')
    if not isinstance(required_paths, list) or not required_paths or any(
        not isinstance(path, str) or not Path(path).is_absolute()
        for path in required_paths
    ):
        return False
    if {str(Path(path).resolve()) for path in required_paths} != {
        str(Path(path).resolve()) for path in evidence_paths
        if isinstance(path, str)
    }:
        return False
    source_root = source_runs[source_run]
    nonempty_proof = False
    for evidence_path in evidence_paths:
        if not isinstance(evidence_path, str) or not evidence_path.strip():
            return False
        absolute_path = Path(evidence_path)
        if not absolute_path.is_absolute() or not absolute_path.exists():
            return False
        if not is_relative_to(absolute_path.resolve(strict=False), source_root):
            return False
        if absolute_path.is_file() and absolute_path.stat().st_size > 0:
            nonempty_proof = True
    expected_hashes = assertion.get('evidence_sha256')
    terminal_target = next((target for target, (required_id, _) in TERMINAL_ACCEPTANCE.items()
                            if assertion_id == required_id), None)
    if expected_hashes is not None or assertion_id in ('code-review-native-scope-identity', 'builtin-mods-compiled-acceptance', 'mods-process-spawn-real-author') or terminal_target:
        if (not isinstance(expected_hashes, dict) or not expected_hashes
                or any(not isinstance(path, str) or not Path(path).is_absolute()
                       or not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest)
                       for path, digest in expected_hashes.items())):
            return False
        try:
            if set(expected_hashes) != {str(Path(path).resolve()) for path in evidence_paths}:
                return False
            verified_bytes = {}
            for path in evidence_paths:
                file = Path(path)
                if file.is_symlink() or not file.is_file():
                    return False
                data = file.read_bytes()
                key = str(file.resolve())
                if hashlib.sha256(data).hexdigest() != expected_hashes[key]:
                    return False
                verified_bytes[key] = data
            if assertion_id == 'code-review-native-scope-identity':
                proof_path = str((source_root / 'workflow-agent-identity-proof.json').resolve())
                if proof_path not in verified_bytes:
                    return False
                proof = json.loads(verified_bytes[proof_path])
                if not isinstance(proof, dict):
                    return False
                snapshots = proof.get('source_hashes')
                if (proof.get('complete') is not True or not isinstance(snapshots, dict) or not snapshots
                        or any(not isinstance(path, str) or not Path(path).is_absolute()
                               or not is_relative_to(Path(path).resolve(), source_root / 'workflow-identity-inputs')
                               or not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest)
                               for path, digest in snapshots.items())
                        or set(expected_hashes) != {*snapshots, proof_path}
                        or any(expected_hashes.get(path) != digest for path, digest in snapshots.items())):
                    return False
            if assertion_id == 'builtin-mods-compiled-acceptance':
                registered = json.loads((registered_runs or {}).get(str(source_root), '{}'))
                acceptance_path = Path(registered.get('acceptance_report', ''))
                acceptance_key = str(acceptance_path)
                checks_key = str(source_root / 'builtin-mods-checks.json')
                required = {checks_key, str(source_root / 'builtin-terminal-recheck.json'),
                            str(source_root / 'stdout.txt'), str(source_root / 'stderr.txt'), acceptance_key}
                if (not acceptance_path.is_absolute() or not is_relative_to(acceptance_path, source_root)
                        or not required <= verified_bytes.keys()
                        or expected_hashes[acceptance_key] != registered.get('acceptance_sha256')):
                    return False
                report = json.loads(verified_bytes[acceptance_key])
                checks = json.loads(verified_bytes[checks_key]).get('checks')
                pair = report.get('pair', {})
                assertions = report.get('assertions', {})
                if (not isinstance(checks, dict) or set(checks) != BUILTIN_CHECKS
                        or not all(value is True for value in checks.values())
                        or set(pair) != set(BUILTIN_SIDE_NAMES) or set(assertions) != BUILTIN_ASSERTIONS
                        or not all(value.get('verdict') == 'passed' for value in assertions.values())):
                    return False
                archive_key = str(source_root / 'builtin-cache-archive.json')
                if (archive_key not in verified_bytes
                        or expected_hashes[archive_key] != registered.get('builtin_archive_receipt_sha256')):
                    return False
                archive_proof = json.loads(verified_bytes[archive_key])
                if (archive_proof.get('source') != registered.get('builtin_archive_source')
                        or archive_proof.get('archive') != registered.get('builtin_archive_root')
                        or archive_proof.get('archive') != str(source_root / 'acceptance-cache')
                        or any(archive_proof.get(key) is not True for key in
                               ('archiveComplete', 'sourceFilesStable', 'archiveFilesMatch'))):
                    return False
                registry = registered.get('builtin_capture_registry', {})
                if set(registry) != set(BUILTIN_SIDE_NAMES):
                    return False
                owned_runs, capture_ids = set(), set()
                for name in BUILTIN_SIDE_NAMES:
                    side = pair[name]
                    root = Path(side['run'])
                    capture = side['cleanup']['terminalCapture']
                    identity = {key: side.get(key) for key in ('run', 'target', 'pane', 'captureId', 'binarySha256')}
                    if (identity != {key: registry[name].get(key) for key in identity} or side['binarySha256'] != registered.get('binary_sha256')
                            or not root.is_absolute() or root.is_symlink() or root.resolve() != root
                            or not is_relative_to(root, source_root / 'acceptance-cache')
                            or str(root) in owned_runs or side['captureId'] in capture_ids
                            or expected_hashes.get(str(root / 'bin/claude')) != side['binarySha256']):
                        return False
                    owned_runs.add(str(root)); capture_ids.add(side['captureId'])
                    launch_key = str(root / 'capture-launch.json')
                    if launch_key not in verified_bytes:
                        return False
                    launch = json.loads(verified_bytes[launch_key])
                    if (any(launch.get(key) != registry[name].get(key)
                            for key in ('target', 'pane', 'binarySha256', 'driverPid', 'capture'))
                            or launch.get('run') != registry[name].get('originalRun')
                            or launch.get('capture', {}).get('captureId') != side['captureId']):
                        return False
                    original_relative = str(root.relative_to(source_root / 'acceptance-cache'))
                    original_launch = archive_proof.get('sourceManifest', {}).get(original_relative + '/capture-launch.json', {})
                    if (registry[name].get('originalRun') != str(Path(archive_proof['source']) / original_relative)
                            or original_launch.get('type') != 'file'
                            or original_launch.get('sha256') != expected_hashes.get(launch_key)):
                        return False
                    required_files = terminal_capture_required_files(launch)
                    files = capture['files']
                    if (required_files is None or not required_files <= files.keys()
                            or (launch['capture']['nativeJournal']
                                and capture.get('backend') != 'native-shared-slot-v1')
                            or (not launch['capture']['nativeJournal'] and capture.get('backend') is not None)):
                        return False
                    for filename, info in files.items():
                        key = str(root / filename)
                        if (info.get('path') != key or key not in verified_bytes
                                or expected_hashes[key] != info.get('sha256')
                                or len(verified_bytes[key]) != info.get('bytes')):
                            return False
                    for sent in (json.loads(line) for line in verified_bytes[str(root / 'inputs.jsonl')].splitlines()):
                        if sent.get('phase') == 'send' and sent.get('transport') == 'tmux-paste-buffer':
                            key = sent.get('inputFile')
                            if (key not in verified_bytes or verified_bytes[key].hex() != sent.get('hex')
                                    or expected_hashes[key] != sent.get('bytesSHA256')):
                                return False
                if not revalidate_builtin_assertion(source_root, acceptance_path, registered['binary_sha256']):
                    return False
                if any(Path(path).read_bytes() != data for path, data in verified_bytes.items()):
                    return False
            if assertion_id == 'mods-process-spawn-real-author':
                import importlib.util
                registered = json.loads((registered_runs or {}).get(str(source_root), '{}'))
                native = source_root / 'native'
                report_key = str(native / 'evidence/result.json')
                checks_key = str(source_root / 'process-spawn-checks.json')
                probe_path = Path(__file__).resolve().parents[4] / 'scripts/validate-mods-process-spawn.py'
                if (expected_hashes != registered.get('process_spawn_evidence_sha256')
                        or registered.get('process_spawn_root') != str(native)
                        or report_key not in verified_bytes
                        or expected_hashes[report_key] != registered.get('process_spawn_report_sha256')
                        or sha256(probe_path) != registered.get('process_spawn_probe_sha256')):
                    return False
                report = json.loads(verified_bytes[report_key])
                artifacts = report.get('artifactsSHA256')
                if not isinstance(artifacts, dict) or not artifacts:
                    return False
                required = {checks_key, str(source_root / 'stdout.txt'),
                            str(source_root / 'stderr.txt'), report_key,
                            *(str(native / name) for name in artifacts)}
                if required != set(verified_bytes):
                    return False
                if (report.get('originalBinary') != registered.get('binary')
                        or json.loads(verified_bytes[str(source_root / 'stdout.txt')]).get('reportSHA256') != registered.get('process_spawn_report_sha256')):
                    return False
                spec = importlib.util.spec_from_file_location('mods_spawn_final_probe', probe_path)
                probe = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(probe)
                checks = {'foreground_native_exit': True, **probe.recheck_process_spawn_report(
                    native, registered['process_spawn_report_sha256'], registered['binary_sha256']),
                    'closed_originals_rechecked': True}
                if (not all(value is True for value in checks.values())
                        or json.loads(verified_bytes[checks_key]).get('checks') != checks
                        or any(Path(path).read_bytes() != data for path, data in verified_bytes.items())):
                    return False
            if terminal_target:
                required_files = {'capture-launch.json', 'terminal-capture.json',
                    'independent-pty-checks.json', 'bin/claude',
                    TERMINAL_ACCEPTANCE[terminal_target][1], *TERMINAL_BUSINESS_FILES[terminal_target]}
                if not {str((source_root / name).resolve()) for name in required_files} <= set(verified_bytes):
                    return False
                def decoded(name):
                    return json.loads(verified_bytes[str((source_root / name).resolve())])
                capture = decoded('terminal-capture.json')
                fresh = decoded('independent-pty-checks.json')
                launch = decoded('capture-launch.json')
                checks = decoded(TERMINAL_ACCEPTANCE[terminal_target][1])
                metadata = json.loads((registered_runs or {}).get(str(source_root), '{}'))
                registered = metadata.get('terminal_capture')
                if (expected_hashes != metadata.get('terminal_evidence_sha256')
                        or not isinstance(registered, dict)
                        or any(launch.get(key) != registered.get(key)
                               for key in ('run', 'driverPid', 'target', 'pane', 'binarySha256', 'socket',
                                           'socketRoot', 'serverPid', 'socketIdentity'))
                        or launch.get('capture') != registered.get('capture')):
                    return False
                if (not isinstance(checks, dict)
                        or not TERMINAL_REQUIRED_CHECKS[terminal_target] <= checks.keys()
                        or not all(value is True for value in checks.values())
                        or fresh.get('captureIdentityPassed') is not True
                        or fresh.get('recheck', {}).get('verdict') != 'passed'
                        or fresh.get('side', {}).get('run') != str(source_root)
                        or fresh.get('recheck', {}).get('run') != str(source_root)
                        or fresh.get('recheck', {}).get('captureId') != capture.get('captureId')
                        or fresh.get('side', {}).get('captureId') != capture.get('captureId')
                        or fresh.get('side', {}).get('binarySha256') != capture.get('binarySha256')
                        or fresh.get('side', {}).get('target') != launch.get('target')
                        or fresh.get('side', {}).get('pane') != launch.get('pane')
                        or capture.get('target') != launch.get('target')
                        or capture.get('pane') != launch.get('pane')
                        or fresh.get('side', {}).get('cleanup', {}).get('terminalCapture') != capture
                        or launch.get('run') != str(source_root)
                        or launch.get('capture', {}).get('captureId') != capture.get('captureId')
                        or capture.get('framePhysicalVerdict') != 'passed'
                        or capture.get('eofPassed') is not True
                        or capture.get('binarySha256') != launch.get('binarySha256')
                        or expected_hashes[str((source_root / 'bin/claude').resolve())] != capture.get('binarySha256')):
                    return False
                files = capture.get('files')
                required_files = terminal_capture_required_files(registered)
                if (not isinstance(files, dict) or required_files is None or not required_files <= files.keys()
                        or (registered['capture']['nativeJournal']
                            and capture.get('backend') != 'native-shared-slot-v1')
                        or (not registered['capture']['nativeJournal'] and capture.get('backend') is not None)):
                    return False
                for name, info in files.items():
                    key = str((source_root / name).resolve())
                    if (not isinstance(info, dict) or info.get('path') != key
                            or key not in verified_bytes or expected_hashes[key] != info.get('sha256')
                            or len(verified_bytes[key]) != info.get('bytes')):
                        return False
                inputs = [json.loads(line) for line in verified_bytes[str((source_root / 'inputs.jsonl').resolve())].splitlines()]
                for sent in inputs:
                    if sent.get('phase') == 'send' and sent.get('transport') == 'tmux-paste-buffer':
                        key = sent.get('inputFile')
                        if (not isinstance(key, str) or key not in verified_bytes
                                or verified_bytes[key].hex() != sent.get('hex')
                                or expected_hashes[key] != sent.get('bytesSHA256')):
                            return False
                replay = fresh.get('recheck', {}).get('replay', {})
                sizes = terminal_resize_sizes(replay)
                if sizes is None:
                    return False
                if terminal_target == 'terminal-interaction':
                    logical = terminal_frame_report_checks(replay)
                    if (not logical['frame_semantics'] or not logical['frame_resize_sequence']
                            or sizes != [(109, 34), (110, 34), (109, 34), (110, 34), (109, 34)]):
                        return False
                elif sizes != [(110, 34), (109, 34), (110, 34), (109, 34)]:
                    return False
                if terminal_target == 'terminal-canonical-diff':
                    keys = {str(source_root / 'canonical-wire.json'), str(source_root / 'debug.log')}
                    if not keys <= verified_bytes.keys():
                        return False
                    metadata = json.loads((registered_runs or {}).get(str(source_root), '{}'))
                    host = urlsplit(metadata.get('mock_openai', {}).get('base_url', '')).netloc
                    protocol = canonical_wire_checks(source_root, decoded('canonical-wire.json'),
                        verified_bytes[str(source_root / 'debug.log')].decode(), host)
                    if not all(protocol.values()):
                        return False
                    git_keys = {str(source_root / name) for name in
                        ('canonical-git.jsonl', 'canonical-release.json',
                         'canonical-git-output.json', 'canonical-git-output.raw')}
                    if not git_keys <= verified_bytes.keys():
                        return False
                    events = [json.loads(line) for line in verified_bytes[str(source_root / 'canonical-git.jsonl')].splitlines()]
                    if not all(canonical_git_checks(source_root, events, decoded('canonical-release.json'),
                                verified_bytes[str(source_root / 'debug.log')].decode()).values()):
                        return False
                    native_context = None
                    if launch.get('capture', {}).get('nativeJournal') is True:
                        native_context = canonical_native_context(source_root, launch,
                            expected_hashes[str((source_root / 'bin/claude').resolve())])
                        if native_context is None:
                            return False
                    if not all(canonical_ui_checks(source_root, native_context).values()):
                        return False
                if not revalidate_terminal_assertion(source_root):
                    return False
                # Replay is read-only; also reject evidence changed during it.
                if any(Path(path).read_bytes() != data for path, data in verified_bytes.items()):
                    return False
        except (OSError, ValueError, TypeError, AttributeError, KeyError):
            return False
    return nonempty_proof


TERMINAL_CAPTURE_FILES = frozenset({'pty.raw', 'native-pty.raw', 'native-pty-initial.json',
    'native-pty-eof.json', 'native-input.jsonl', 'pty-io.jsonl', 'broker-cleanup.json',
    'frames.jsonl', 'inputs.jsonl', 'geometry.jsonl', 'initial-termios.txt', 'observations.jsonl',
    'capture-eof', 'frame-stream-map.json', 'frame-physical-report.json'})

NATIVE_TERMINAL_CAPTURE_FILES = frozenset({
    'pty.raw', 'native-pty.raw', 'raw.bin', 'records.bin', 'journal.bin', 'registration.json',
    'header.json', 'native-initial.json', 'start.json', 'launch.json', 'cleanup.json',
    'broker-cleanup.json', 'pty-io.jsonl', 'frames.jsonl', 'inputs.jsonl', 'geometry.jsonl',
    'observations.jsonl', 'initial-termios.txt', 'capture-eof', 'expected-native.json',
    'producer-expected-native.json', 'native-observer.json', 'observer.dylib',
    'observer-compile.log', 'frame-stream-map.json', 'frame-physical-report.json',
})


def terminal_capture_required_files(launch):
    """Protocol from the held prepared launch, never the final report's labels."""
    capture = launch.get('capture') if isinstance(launch, dict) else None
    if (not isinstance(capture, dict) or type(capture.get('nativeJournal')) is not bool
            or not isinstance(capture.get('captureId'), str) or not capture['captureId']):
        return None
    return NATIVE_TERMINAL_CAPTURE_FILES if capture['nativeJournal'] else TERMINAL_CAPTURE_FILES

TERMINAL_ACCEPTANCE = {
    'terminal-interaction': ('terminal-interaction-frame-and-input-matrix', 'terminal-interaction-checks.json'),
    'terminal-canonical-diff': ('terminal-canonical-diff-real-tools-and-pty', 'canonical-checks.json'),
}

TERMINAL_BUSINESS_FILES = {
    'terminal-interaction': frozenset({'omega-body-blocked.json', 'input-chunks.json'}),
    'terminal-canonical-diff': frozenset({'canonical-checkpoints.json', 'canonical-ui-states.json',
        'omega-body-blocked.json', 'canonical-wire.json', 'debug.log', 'canonical-git.jsonl',
        'canonical-release.json', 'canonical-git-output.json', 'canonical-git-output.raw'}),
}


TERMINAL_REQUIRED_CHECKS = {
    'terminal-interaction': frozenset({
        'ready', 'custom_clawd_layout', 'same_chunk_utf8_submit', 'csi_u_submit',
        'raw_backspace_submit', 'raw_del_submit', 'forward_delete_submit',
        'cursor_combination_submit', 'paste_head_visible', 'paste_continuation_visible',
        'paste_recovery_submit', 'diff_alpha_ready', 'diff_partial_loading',
        'diff_same_chunk_navigation', 'resize_intent', 'resize_keyboard_ownership',
        'diff_closed', 'diff_reopened', 'frame_physical', 'frame_resize_sequence',
        'frame_semantics', 'cleanup', 'bounded_terminal_evidence', 'full_terminal_coverage', 'independent_pty_capture_identity',
        'independent_pty_resize_sequence', 'normal_native_exit',
        'same_chunk_utf8_submit_prompt_restored', 'same_chunk_utf8_submit_exact_request',
        'csi_u_submit_prompt_restored', 'csi_u_submit_exact_request',
        'raw_backspace_submit_prompt_restored', 'raw_backspace_submit_exact_request',
        'raw_del_submit_prompt_restored', 'raw_del_submit_exact_request',
        'forward_delete_submit_prompt_restored', 'forward_delete_submit_exact_request',
        'cursor_combination_submit_prompt_restored', 'cursor_combination_submit_exact_request',
        'paste_head_not_submitted', 'paste_continuation_not_submitted',
        'paste_recovery_submit_prompt_restored', 'paste_recovery_submit_exact_request',
        'diff_dialog_entry', 'omega_body_blocked', 'diff_partial_publish',
        'loading_keyboard_ownership', 'resize_detail_preserved',
        'resize_files_after_explicit_back', 'diff_files_before_close',
    }),
    'terminal-canonical-diff': frozenset({
        'ready', 'canonical_command_owner', 'alpha_real_write_receipt',
        'alpha_prompt_restored', 'canonical_alpha_dock', 'canonical_initial_focus',
        'omega_real_write_receipt', 'omega_prompt_restored', 'canonical_batch_blocked',
        'canonical_exact_git_lane', 'canonical_two_files_before_select',
        'canonical_focus_landing', 'canonical_omega_control', 'canonical_before_press_alpha_body',
        'canonical_file_body', 'canonical_escape_keeps_open', 'canonical_inline_same_identity',
        'canonical_redocked', 'canonical_refocus_landing', 'canonical_person_closed',
        'canonical_reopened', 'canonical_reopen_scroll_reset', 'canonical_command_closed',
        'canonical_narrow_refused', 'canonical_no_native_fallback', 'canonical_keyboard_owner',
        'canonical_release_watcher_stopped', 'scenario_completed', 'normal_native_exit',
        'cleanup', 'bounded_terminal_evidence', 'full_terminal_coverage', 'independent_pty_capture_identity', 'independent_pty_ink_frames',
        'independent_pty_resize_sequence', 'canonical_wire_complete', 'canonical_wire_identity',
        'canonical_wire_tool_receipts', 'canonical_git_release_causal', 'canonical_git_success',
        'canonical_pane_frame_association', 'canonical_pane_lifecycle', 'canonical_keyboard_landing',
    }),
}


def validate_required_target_results(required_targets, runs, registered_runs=None):
    runs_by_label = {run.get('label'): run for run in runs}
    missing = sorted(required_targets - set(runs_by_label))
    invalid = []
    source_runs = assertion_source_runs(runs, registered_runs or {})
    for target in sorted(required_targets & set(runs_by_label)):
        run = runs_by_label[target]
        assertions = run.get('assertions')
        own_sources = {name: root for name, root in assertion_source_runs([run], registered_runs or {}).items()
                       if source_runs.get(name) == root}
        valid = (
            run.get('validation_verdict') == 'passed'
            and isinstance(assertions, list)
            and bool(assertions)
            and all(assertion_is_valid(assertion, own_sources, registered_runs) for assertion in assertions)
        )
        if valid and target == 'code-review':
            for assertion_id in ('code-review-native-scope-identity', 'code-review-mock-wire',
                                 'code-review-workflow-lifecycle'):
                matching = [item for item in assertions if item.get('assertion_id') == assertion_id]
                if len(matching) != 1 or matching[0].get('source_run') != Path(run['evidence_dir']).name:
                    valid = False
                    break
        if valid and target == 'mods-process-spawn':
            matching = [item for item in assertions
                        if item.get('assertion_id') == 'mods-process-spawn-real-author']
            valid = len(matching) == 1 and matching[0].get('source_run') == Path(run['evidence_dir']).name
        if valid and target == 'builtin-mods':
            matching = [item for item in assertions
                        if item.get('assertion_id') == 'builtin-mods-compiled-acceptance']
            valid = len(matching) == 1 and matching[0].get('source_run') == Path(run['evidence_dir']).name
        if valid and target in TERMINAL_ACCEPTANCE:
            matching = [item for item in assertions
                        if item.get('assertion_id') == TERMINAL_ACCEPTANCE[target][0]]
            valid = len(matching) == 1 and matching[0].get('source_run') == Path(run['evidence_dir']).name
        if not valid:
            invalid.append(target)
    return {
        'passed': not missing and not invalid,
        'missing_targets': missing,
        'invalid_targets': invalid,
    }


def command(args, *, check=False, timeout=120):
    result = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
    if check and result.returncode != 0:
        raise RuntimeError(
            f"command failed: {args!r}\nstdout={result.stdout}\nstderr={result.stderr}"
        )
    return result


def initialize_terminal_interaction_repository(fixture):
    fixture.mkdir()
    command(['git', '-C', str(fixture), 'init', '-q'], check=True)
    command(['git', '-C', str(fixture), 'config', 'user.name', 'Release Validation'], check=True)
    command(['git', '-C', str(fixture), 'config', 'user.email', 'release-validation@example.invalid'], check=True)
    (fixture / 'alpha.txt').write_text('alpha before\n')
    (fixture / 'omega.txt').write_text('omega before\n')
    command(['git', '-C', str(fixture), 'add', 'alpha.txt', 'omega.txt'], check=True)
    command([
        'git', '-C', str(fixture), '-c', 'commit.gpgSign=false',
        'commit', '-q', '-m', 'fixture',
    ], check=True)


def mutate_terminal_interaction_repository(fixture):
    (fixture / 'alpha.txt').write_text('alpha before\nALPHA_RELEASE_BODY\n')
    (fixture / 'omega.txt').write_text('omega before\nOMEGA_RELEASE_BODY\n')


def terminal_request_submitted(requests, offset, expected):
    main_requests = [request for request in requests[offset:]
                     if is_main_response_request(request)]
    if len(main_requests) != 1:
        return False
    items = main_requests[0].get('body', {}).get('input', [])
    if (
        not items
        or not isinstance(items[-1], dict)
        or items[-1].get('role') != 'user'
        or any(isinstance(item, dict) and item.get('type') == 'function_call_output'
               for item in items)
    ):
        return False
    content = items[-1].get('content')
    if content == expected:
        return True
    if not isinstance(content, list):
        return False
    texts = []
    for block in content:
        if not isinstance(block, dict) or block.get('type') != 'input_text':
            return False
        text = block.get('text')
        if not isinstance(text, str):
            return False
        if text.startswith(('<available-deferred-tools>', '<system-reminder>')):
            continue
        texts.append(text)
    return texts == [expected]


def create_terminal_git_wrapper(run_dir):
    real_git = shutil.which('git')
    if not real_git:
        raise RuntimeError('git unavailable for terminal fixture')
    wrapper_dir = run_dir / 'driver-bin'
    wrapper_dir.mkdir()
    os.mkfifo(run_dir / 'omega-body.fifo', 0o600)
    wrapper = wrapper_dir / 'git'
    wrapper.write_text(f'''#!{sys.executable} -S
import json, os, select, sys
from pathlib import Path
root = Path({str(run_dir)!r})
args = sys.argv[1:]
tail = list(args)
while tail and (tail[0] in ('--no-optional-locks', '--literal-pathspecs')
                or tail[0].startswith(('--git-dir=', '--work-tree='))):
    tail.pop(0)
prefix = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=dirty']
body = (len(tail) == len(prefix) + 3 and tail[:len(prefix)] == prefix
        and not tail[len(prefix)].startswith('-') and tail[-2:] == ['--', 'omega.txt'])
if body and not (root / 'omega-body-released').exists():
    fd = os.open(root / 'omega-body.fifo', os.O_RDWR | os.O_NONBLOCK)
    try:
        marker = root / ('omega-body-' + str(os.getpid()) + '.tmp')
        marker.write_text(json.dumps({{'pid': os.getpid(), 'argv': args}}))
        marker.replace(root / 'omega-body-blocked.json')
        if not (root / 'omega-body-released').exists():
            if not select.select([fd], [], [], 30)[0]:
                raise RuntimeError('omega body release timed out')
            os.read(fd, 1)
        if not (root / 'omega-body-released').exists():
            raise RuntimeError('omega body release missing latch')
    finally:
        os.close(fd)
os.execv({real_git!r}, [{real_git!r}, *args])
''')
    wrapper.chmod(0o700)
    return wrapper_dir


def release_terminal_git_wrapper(run_dir):
    fifo = run_dir / 'omega-body.fifo'
    if not fifo.exists():
        return
    (run_dir / 'omega-body-released').touch(mode=0o600)
    fd = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
    try:
        os.write(fd, b'1')
    finally:
        os.close(fd)


def canonical_diff_content(file):
    return (f'{file} before\n{file.upper()}_RELEASE_BODY\n'
            + ''.join(f'{file.upper()}_RELEASE_LINE_{index:03d}\n' for index in range(80)))



def canonical_git_prefix(run_dir):
    project = run_dir / 'project'
    return ['-c', 'core.hooksPath=/dev/null',
        '--git-dir=' + str(project / '.git'), '--work-tree=' + str(project),
        '--literal-pathspecs', '--no-optional-locks',
        '-c', 'diff.relative=false', '-c', 'core.quotePath=false',
        'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty',
        '--submodule=short', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/',
        '--raw', '-z', '-p', 'HEAD', '--']


def canonical_git_output(run_dir, argv):
    project = run_dir / 'project'
    prefix = canonical_git_prefix(run_dir)
    if (project.is_symlink() or not project.is_dir() or argv[:len(prefix)] != prefix
            or argv[len(prefix):] not in (['omega.txt'], ['alpha.txt', 'omega.txt'])):
        raise ValueError('unowned canonical Git command')
    files = {}
    for name in ('alpha', 'omega'):
        path = project / (name + '.txt')
        if path.is_symlink() or path.read_text() != canonical_diff_content(name):
            raise ValueError('canonical Git worktree is not the actual completed Write')
        files[path.name] = sha256(path)
    git = Path(shutil.which('git', path='/opt/homebrew/bin:/usr/bin:/bin')).resolve()
    env = {'PATH': '/opt/homebrew/bin:/usr/bin:/bin', 'HOME': str(run_dir),
           'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1'}
    def run(args):
        return subprocess.run([str(git), *args], cwd=project, env=env,
                              capture_output=True, check=True, timeout=5)
    head = run(['-c', 'core.hooksPath=/dev/null', 'rev-parse', '--verify', 'HEAD']).stdout.decode().strip()
    completed = run(argv)
    if len(completed.stdout) > 4 * 1024 * 1024 or len(completed.stderr) > 4 * 1024 * 1024:
        raise ValueError('independent Git output exceeds the unchanged process budget')
    return {'method': 'owned-independent-git-read-v1',
        'git': {'path': str(git), 'sha256': sha256(git)}, 'project': str(project),
        'head': head, 'files': files, 'argv': argv, 'exitCode': completed.returncode,
        'stdoutBytes': len(completed.stdout), 'stdoutSHA256': hashlib.sha256(completed.stdout).hexdigest(),
        'stderrBytes': len(completed.stderr), 'stderrSHA256': hashlib.sha256(completed.stderr).hexdigest()}, completed.stdout


def canonical_git_checks(run_dir, events, watcher, debug):
    failed = {'canonical_git_release_causal': False, 'canonical_git_success': False}
    try:
        blocked = [row for row in events if row.get('phase') == 'blocked']
        released = [row for row in events if row.get('phase') == 'released']
        if len(blocked) != 1 or len(released) != 1:
            return failed
        block, release = blocked[0], released[0]
        prefix = canonical_git_prefix(run_dir)
        argv = block['argv']
        args_hash = hashlib.sha256(json.dumps(argv, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        pid = block['pid']
        start = [row for row in events if row.get('phase') == 'start' and row.get('pid') == pid]
        marker = watcher.get('blockedMarker', {})
        causal = (len(start) == 1 and start[0]['monotonic'] <= block['monotonic']
            and all(row.get('lane') == 'canonical-292' and row.get('pid') == pid
                    and row.get('argv') == argv and row.get('cwd') == str(run_dir / 'project')
                    and row.get('matched') is True for row in (start[0], block, release))
            and argv[:len(prefix)] == prefix and argv[len(prefix):] in
                (['omega.txt'], ['alpha.txt', 'omega.txt'])
            and watcher.get('source') == 'owned-blocked-marker-watcher'
            and watcher.get('livePidObserved') is True and marker.get('pid') == pid
            and marker.get('argv') == argv and marker.get('lane') == 'canonical-292'
            and block['monotonic'] <= watcher['signalStartedAt'] <= release['monotonic']
            and 0 <= release['monotonic'] - block['monotonic'] < 5)
        host = []
        for line in debug.splitlines():
            if '[ModsProcess] ' in line:
                row = json.loads(line.split('[ModsProcess] ', 1)[1])
                if row.get('pid') == pid:
                    host.append(row)
        closed = [row for row in host if row.get('phase') == 'close']
        opened = [row for row in host if row.get('phase') == 'start']
        output, raw = canonical_git_output(run_dir, argv)
        saved = json.loads((run_dir / 'canonical-git-output.json').read_text())
        success = (causal and len(opened) == 1
            and all(row.get('owner') == 'cc-plugin-diff@builtin'
                    and row.get('argsSHA256') == args_hash and row.get('timeoutMs') == 5000 for row in host)
            and not any(row.get('phase') in ('stop', 'error') for row in host)
            and len(closed) == 1 and closed[0].get('exitCode') == 0
            and closed[0].get('timeoutMs') == 5000 and not closed[0].get('stopped')
            and closed[0].get('isStdoutTruncated') is False
            and closed[0].get('isStderrTruncated') is False
            and 0 < closed[0].get('elapsedMs', 0) < 5000
            and closed[0]['elapsedMs'] - opened[0]['elapsedMs'] >=
                (release['monotonic'] - start[0]['monotonic']) * 1000
            and saved == output and (run_dir / 'canonical-git-output.raw').read_bytes() == raw
            and output['stdoutBytes'] > 0
            and all(closed[0].get(key) == output[key] for key in
                    ('stdoutBytes', 'stdoutSHA256')))
        return {'canonical_git_release_causal': causal, 'canonical_git_success': success}
    except (OSError, AttributeError, KeyError, TypeError, ValueError, subprocess.SubprocessError):
        return failed


def create_canonical_terminal_git_wrapper(run_dir):
    real_git = shutil.which('git')
    if not real_git:
        raise RuntimeError('git unavailable for canonical terminal fixture')
    wrapper_dir = run_dir / 'driver-bin'
    wrapper_dir.mkdir()
    os.mkfifo(run_dir / 'omega-body.fifo', 0o600)
    wrapper = wrapper_dir / 'git'
    wrapper.write_text(f'''#!{sys.executable} -S
import json, os, select, sys, time
from pathlib import Path
root = Path({str(run_dir)!r})
project = root / 'project'
args = sys.argv[1:]
prefix = {canonical_git_prefix(run_dir)!r}
paths = args[len(prefix):]
body = (Path.cwd() == project and args[:len(prefix)] == prefix and paths in (
 ['omega.txt'], ['alpha.txt', 'omega.txt']))
latched = body and (root / 'canonical-omega-arm').exists() and not (root / 'omega-body-released').exists()
def log(phase, **fields):
 with (root / 'canonical-git.jsonl').open('a') as stream:
  stream.write(json.dumps({{'lane':'canonical-292', 'phase':phase,
   'pid':os.getpid(), 'cwd':os.getcwd(), 'argv':args,
   'monotonic':time.monotonic(), 'matched':body, **fields}}) + '\\n')
log('start')
if latched:
 fd = os.open(root / 'omega-body.fifo', os.O_RDWR | os.O_NONBLOCK)
 try:
  log('blocked')
  marker = root / ('omega-body-' + str(os.getpid()) + '.tmp')
  marker.write_text(json.dumps({{'pid':os.getpid(),'argv':args,'lane':'canonical-292'}}))
  marker.replace(root / 'omega-body-blocked.json')
  if not (root / 'omega-body-released').exists():
   if not select.select([fd], [], [], 5)[0]:
    raise RuntimeError('canonical body release exceeded the official Git budget')
   os.read(fd, 1)
  if not (root / 'omega-body-released').exists():
   raise RuntimeError('canonical body release missing latch')
  log('released')
 finally:
  os.close(fd)
os.execv({real_git!r}, [{real_git!r}, *args])
''')
    wrapper.chmod(0o700)
    return wrapper_dir


CANONICAL_PANE_CHECKPOINTS = (
    'canonical_alpha_dock', 'canonical_two_files_before_select', 'canonical_focus_landing',
    'canonical_omega_control', 'canonical_file_body', 'canonical_escape_keeps_open',
    'canonical_inline_same_identity', 'canonical_redocked', 'canonical_refocus_landing',
    'canonical_person_closed', 'canonical_reopened', 'canonical_command_closed',
    'canonical_narrow_refused',
)


def canonical_native_context(run, launch, binary_sha256):
    """Read only the bounded header identity, never live slots or counters."""
    launch_identity = terminal_native_exit_identity(run, launch, binary_sha256)
    if launch_identity is None or launch_identity['capture']['nativeJournal'] is not True:
        return None
    try:
        import importlib.util
        import struct
        schema_path = Path(__file__).resolve().parents[4] / 'scripts/native-terminal-journal.py'
        spec = importlib.util.spec_from_file_location('canonical_native_schema', schema_path)
        schema = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(schema)
        def read(name, limit, header=False):
            path = run / name
            named = os.lstat(path)
            if not stat.S_ISREG(named.st_mode):
                raise ValueError('Native context requires an owned regular file')
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                opened = os.fstat(fd)
                if (not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.getuid() or
                        stat.S_IMODE(opened.st_mode) != 0o600 or opened.st_nlink != 1 or
                        (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino) or
                        (not header and opened.st_size > limit)):
                    raise ValueError('Native context file identity changed')
                data = os.pread(fd, limit, 0)
                after, current = os.fstat(fd), os.lstat(path)
                if ((after.st_dev, after.st_ino, after.st_size) != (opened.st_dev, opened.st_ino, opened.st_size) or
                        (current.st_dev, current.st_ino, current.st_size, current.st_nlink, current.st_mode) !=
                        (opened.st_dev, opened.st_ino, opened.st_size, 1, opened.st_mode)):
                    raise ValueError('Native context changed during read')
                return data, opened
            finally:
                os.close(fd)
        start = json.loads(read('start.json', 65536)[0])
        pid = start.get('childPid')
        if (type(pid) is not int or pid <= 0 or type(start.get('childPgid')) is not int or
                start['childPgid'] != pid or start.get('binarySha256') != binary_sha256):
            return None
        data, identity = read('journal.bin', schema.HEADER.size, True)
        size = identity.st_size
        words = schema.HEADER.unpack(data)
        data, reread = read('journal.bin', schema.HEADER.size, True)
        if (identity.st_dev, identity.st_ino, identity.st_size) != (reread.st_dev, reread.st_ino, reread.st_size):
            return None
        again = schema.HEADER.unpack(data)
        stable = (0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 13, 19)
        if (any(words[key] != again[key] for key in stable) or words[0] != schema.MAGIC or
                words[1] != 1 or words[2] != schema.HEADER.size or words[8] != pid or
                not 1 <= words[4] <= 4096 or not 1 <= words[5] <= 1048576 or
                words[3] < schema.RECORD.size + words[5] or words[3] % 64 or
                size != words[2] + words[3] * words[4] or
                not words[12] or not words[13] or not words[19]):
            return None
        initial = launch['capture']['initialSize']
        if any(type(initial.get(key)) is not int or not 0 < initial[key] <= 1000 for key in ('columns', 'rows')):
            return None
        return {'nativeJournal': True, 'captureId': launch_identity['capture']['captureId'],
                'binarySha256': binary_sha256, 'childPid': pid,
                'clock': {'nonce': f'{words[6]:016x}{words[7]:016x}', 'pid': pid,
                          'timebaseNumer': words[12], 'timebaseDenom': words[13], 'openedAt': str(words[19])},
                'initialSize': dict(initial)}
    except (OSError, ValueError, KeyError, TypeError, AttributeError, OverflowError, struct.error):
        return None


def canonical_native_frame_binding(entry, entries, io, context):
    """Native span/geometry association; final original re-derivation is mandatory."""
    try:
        import struct
        def tick(value):
            if (type(value) is not str or not value.isascii() or not value.isdecimal() or
                    not 0 < len(value) <= 20 or value[0] == '0' or not 0 < int(value) < 2 ** 64):
                raise ValueError('Exact native uint64 clock required')
            return int(value)
        if (not isinstance(context, dict) or context.get('nativeJournal') is not True or
                type(context.get('captureId')) is not str or not context['captureId'] or
                type(context.get('childPid')) is not int or context['childPid'] <= 0 or
                type(context.get('binarySha256')) is not str or not re.fullmatch(r'[a-f0-9]{64}', context['binarySha256'])):
            return None
        clock = context['clock']
        if (type(clock) is not dict or type(clock.get('nonce')) is not str or
                not re.fullmatch(r'[a-f0-9]{32}', clock['nonce']) or
                any(type(clock.get(key)) is not int or clock[key] <= 0 for key in ('pid', 'timebaseNumer', 'timebaseDenom')) or
                clock['pid'] != context['childPid']):
            return None
        opened = tick(clock['openedAt'])
        geometry_id, offset = 0, 0
        if not io or io[0].get('kind') != 'initial-geometry':
            return None
        initial = io[0]
        if (type(initial.get('childPid')) is not int or initial['childPid'] != context['childPid'] or
                any(type(initial.get(key)) is not int or initial[key] != context['initialSize'][key] for key in ('columns', 'rows'))):
            return None
        current_size = context['initialSize'].copy()
        events, previous_return = [], opened
        for index, row in enumerate(io, 1):
            if row.get('kind') == 'resize-ack':
                geometry_id += 1
            if (type(row.get('ioId')) is not int or row['ioId'] != index or
                    type(row.get('geometryId')) is not int or row['geometryId'] != geometry_id or
                    type(row.get('rawOffset')) is not int or row['rawOffset'] < 0 or
                    row.get('captureId') != context['captureId'] or
                    row.get('kind') not in ('initial-geometry', 'input', 'output', 'resize-ack') or
                    (row['kind'] == 'initial-geometry') != (index == 1)):
                return None
            if row['kind'] == 'output':
                if (type(row.get('start')) is not int or type(row.get('end')) is not int or
                        row['start'] != offset or not offset < row['end'] == row['rawOffset']):
                    return None
                offset = row['end']
            elif row['rawOffset'] != offset:
                return None
            if row['kind'] != 'resize-ack':
                continue
            bracket = row['nativeBracket']
            a, b = tick(bracket['entry']), tick(bracket['return'])
            if (row.get('succeeded') is not True or row.get('nativeClockCorrelationCovered') is not True or
                    bracket.get('method') != 'native-mach-ioctl-resize-v1' or bracket.get('nonce') != clock['nonce'] or
                    type(bracket.get('childPid')) is not int or bracket['childPid'] != context['childPid'] or
                    any(type(bracket.get(key)) is not int or bracket[key] != clock[key] for key in ('timebaseNumer', 'timebaseDenom')) or
                    type(bracket.get('result')) is not int or bracket['result'] != 0 or
                    type(bracket.get('errno')) is not int or not 0 <= bracket['errno'] < 2 ** 31 or
                    not previous_return <= a <= b):
                return None
            before = struct.unpack('HHHH', bytes.fromhex(bracket['beforeSizeHex']))
            after = struct.unpack('HHHH', bytes.fromhex(bracket['afterSizeHex']))
            if (before[:2] != (current_size['rows'], current_size['columns']) or
                    any(type(row.get(key)) is not int or not 0 < row[key] <= 1000 for key in ('columns', 'rows')) or
                    after[:2] != (row['rows'], row['columns'])):
                return None
            current_size = {'columns': row['columns'], 'rows': row['rows']}
            events.append((a, b, row))
            previous_return = b
        def span(value):
            native, data = value['native'], value['nativeSpan']
            frame_id = value['frameId']
            if ('broker' in value or type(frame_id) is not int or frame_id <= 0 or
                    native.get('profile') != 'ink-post-write-v1' or native.get('captureId') != context['captureId'] or
                    any(type(native.get(key)) is not int or native[key] <= 0 for key in ('spanId','rendererId','rootEpoch','columns','rows')) or
                    native['spanId'] != frame_id or data.get('method') != 'native-mach-frame-span-v1' or
                    json.dumps(data.get('clock'), sort_keys=True) != json.dumps(clock, sort_keys=True) or
                    type(data.get('threadId')) is not int or data['threadId'] <= 0):
                return None
            markers = data['markers']
            if (type(markers) is not list or len(markers) != 4 or
                    [row.get('kind') for row in markers] != [10,12,13,11] or
                    any(type(row.get('kind')) is not int or type(row.get('sequence')) is not int or row['sequence'] <= 0 for row in markers)):
                return None
            ticks = [(tick(row['entry']), tick(row['return'])) for row in markers]
            if (ticks[0][0] < opened or any(a > b for a,b in ticks) or
                    any(a['sequence'] >= b['sequence'] for a,b in zip(markers, markers[1:])) or
                    any(a[1] > b[0] for a,b in zip(ticks,ticks[1:]))):
                return None
            writes = data['writes']
            if type(writes) is not list or value.get('writeSequences') != [row.get('sequence') for row in writes]:
                return None
            previous_sequence, byte_count = markers[1]['sequence'], 0
            for write in writes:
                if (type(write.get('sequence')) is not int or not previous_sequence < write['sequence'] < markers[2]['sequence'] or
                        type(write.get('result')) is not int or write['result'] < -1 or
                        any(type(write.get(key)) is not int or write[key] < 0 for key in ('errno','outputBytes')) or
                        (write['result'] == -1 and (write['errno'] == 0 or write['outputBytes'] != 0)) or
                        not ticks[1][1] <= tick(write['entry']) <= tick(write['return']) <= ticks[2][0]):
                    return None
                previous_sequence = write['sequence']; byte_count += write['outputBytes']
            if (any(type(value.get(key)) is not int or value[key] < 0 for key in ('rawStart','rawEnd')) or
                    value['rawEnd']-value['rawStart'] != byte_count or value['rawEnd'] > offset or
                    data.get('observationKind') != ('output-transaction' if byte_count else 'logical-observation')):
                return None
            selected = {'geometryId':0,'ioId':1,**context['initialSize']}
            for a,b,row in events:
                if ticks[2][1] <= a:
                    continue
                if ticks[0][0] < b:
                    return None
                selected = row
            if (native['columns'],native['rows']) != (selected['columns'],selected['rows']):
                return None
            frame = json.loads(base64.b64decode(value['frameBase64'], validate=True))
            if (frame.get('viewport') != {'width': selected['columns'],'height': selected['rows']} or
                    frame.get('columns') != selected['columns'] or frame.get('buffer') != 'alternate'):
                return None
            return {'frame':frame,'geometryId':selected['geometryId'],'resizeIoId':selected['ioId'],
                    'columns':selected['columns'],'rows':selected['rows'],'outputBytes':byte_count}
        bound = span(entry)
        if bound is None:
            return None
        output = entry
        if not bound['outputBytes']:
            output = None
            for previous in reversed(entries):
                if (previous.get('frameId',0) >= entry['frameId'] or
                        previous.get('native',{}).get('rootEpoch') != entry['native']['rootEpoch'] or
                        previous.get('native',{}).get('rendererId') != entry['native']['rendererId']):
                    continue
                other = span(previous)
                if (other and other['outputBytes'] and other['geometryId'] == bound['geometryId'] and
                        previous['rawEnd'] == entry['rawEnd'] and other['frame'] == bound['frame']):
                    output = previous
                    break
            if output is None:
                return None
        return {'method':'native-canonical-span-geometry-v1','captureId':context['captureId'],
                'frameId':entry['frameId'],'observationKind':entry['nativeSpan']['observationKind'],
                'geometryId':bound['geometryId'],'resizeIoId':bound['resizeIoId'],
                'outputSourceFrameId':output['frameId'],'outputRawStart':output['rawStart'],'outputRawEnd':output['rawEnd'],
                'actualInputOwnerCovered':False,'productTimingEquivalent':False}
    except (KeyError, ValueError, TypeError, AttributeError, OverflowError, struct.error):
        return None


def canonical_native_action_associated(entry, binding, io, action, boundary):
    """Bounded transport/output association, never a child read or owner claim."""
    try:
        receipt = action['receipt']
        lower = receipt
        if action['kind'] == 'resize':
            lower = action.get('send')
            if (type(lower) is not dict or lower.get('phase') != 'resize-send' or
                    receipt.get('phase') != 'resize-return' or type(receipt.get('exitCode')) is not int or
                    receipt['exitCode'] != 0 or type(lower.get('actionId')) is not int or lower['actionId'] <= 0 or
                    type(receipt.get('actionId')) is not int or lower['actionId'] != receipt['actionId'] or
                    any(type(value.get(key)) is not int or not 0 < value[key] <= 1000
                        for value in (lower,receipt) for key in ('columns','rows')) or
                    any(lower[key] != receipt[key] for key in ('columns','rows'))):
                return False
        if (not isinstance(binding, dict) or binding.get('method') != 'native-canonical-span-geometry-v1' or
                any(type(value.get(key)) is not int or value[key] < 0 for value in (lower,receipt,boundary)
                    for key in ('lastObservedFrameId','lastObservedIoId','observedRawBytes')) or
                not lower['lastObservedFrameId'] < entry['frameId'] <= boundary['lastObservedFrameId'] or
                not lower['observedRawBytes'] <= binding['outputRawStart'] <= binding['outputRawEnd'] <= boundary['observedRawBytes']):
            return False
        if action['kind'] == 'resize' and any(not lower[key] <= receipt[key] <= boundary[key]
                for key in ('lastObservedFrameId','lastObservedIoId','observedRawBytes')):
            return False
        window = [row for row in io if lower['lastObservedIoId'] < row['ioId'] <= boundary['lastObservedIoId']]
        if action['kind'] == 'resize':
            return (receipt.get('phase') == 'resize-return' and type(receipt.get('exitCode')) is int and receipt['exitCode']==0 and
                    any(row['kind']=='resize-ack' and row['ioId']==binding['resizeIoId'] and
                        (row['columns'],row['rows'])==(receipt['columns'],receipt['rows']) for row in window))
        if action['kind'] != 'input' or receipt.get('phase') != 'send' or receipt.get('transport') != 'tmux-paste-buffer':
            return False
        data = bytes.fromhex(receipt['hex'])
        if not data:
            return False
        inputs = [row for row in window if row['kind']=='input' and row.get('captureId')==binding['captureId']]
        matches = []
        for start in range(len(inputs)):
            chunks = b''
            for end in range(start,len(inputs)):
                chunks += bytes.fromhex(inputs[end]['hex'])
                if chunks==data:
                    matches.append(inputs[start:end+1]);break
                if not data.startswith(chunks):break
        return (len(matches)==1 and all(type(row.get('rawOffset')) is int and
                receipt['observedRawBytes'] <= row['rawOffset'] <= binding['outputRawStart'] for row in matches[0]))
    except (KeyError, ValueError, TypeError, AttributeError):
        return False


def canonical_frame_snapshot(states, entries, floor=0, io=None, native_context=None, action=None, boundary=None):
    if not states:
        return None
    state = states[-1]
    pane = state.get('pane')
    for entry in reversed(entries):
        if entry.get('frameId', 0) <= floor or entry.get('terminalUiRevision') != state.get('revision'):
            continue
        witnesses = entry.get('terminalPanes')
        if not isinstance(witnesses, list):
            continue
        witnesses = [row for row in witnesses if row.get('plugin') == 'cc-plugin-diff' and row.get('id') == 'diff']
        frame = json.loads(base64.b64decode(entry['frameBase64']))
        viewport = frame.get('viewport', {})
        columns, rows = viewport.get('width'), viewport.get('height')
        if (columns not in (109, 110) or rows != 34 or frame.get('columns') != columns
                or frame.get('buffer') != 'alternate'):
            continue
        native_binding = None
        if native_context is not None and entry.get('native') is None:
            continue
        if entry.get('native') is not None:
            native_binding = canonical_native_frame_binding(entry, entries, io, native_context)
            if native_binding is None or (action is not None and not canonical_native_action_associated(entry, native_binding, io, action, boundary)):
                continue
        elif io is not None:
            broker = entry.get('broker', {})
            start, end = broker.get('start', {}), broker.get('end', {})
            acks = [row for row in io if row.get('kind') == 'resize-ack' and row.get('geometryId') == start.get('geometryId')]
            if (len(acks) != 1 or start.get('geometryId') != end.get('geometryId')
                    or acks[0].get('succeeded') is not True
                    or acks[0].get('captureId') != entry.get('captureId')
                    or acks[0].get('columns') != columns or acks[0].get('rows') != rows
                    or type(start.get('ioId')) is not int or acks[0]['ioId'] > start['ioId']):
                continue
        cells = {(x, y): (char, width) for x, y, char, width, *_ in frame['cells']}
        screen = '\n'.join(''.join(cells.get((x, y), (' ', 1))[0]
                                  for x in range(columns) if cells.get((x, y), (' ', 1))[1] != 0)
                           for y in range(rows))
        witness = None
        body = ''
        if pane and pane.get('visible') and pane.get('shown') and pane.get('hasTree'):
            if len(witnesses) != 1:
                continue
            witness = witnesses[0]
            if (witness.get('revision') != state.get('revision')
                    or any(witness.get(key) != pane.get(key) for key in
                        ('plugin', 'id', 'activation', 'lease', 'drawing', 'visible', 'shown',
                         'placement', 'focused', 'focusedElement', 'focusedPlugin'))
                    or any(type(witness.get(key)) is not int or witness[key] <= 0
                           for key in ('activation', 'lease', 'mount', 'drawing'))
                    or witness.get('actualFocusWithin') is not pane.get('focused')):
                continue
            if pane.get('focusedElement'):
                controls = [row for row in witness.get('controls', [])
                            if row.get('key') == pane['focusedElement'] and row.get('plugin') == pane.get('focusedPlugin')]
                if (len(controls) != 1 or witness.get('actualFocusedElement') != pane['focusedElement']
                        or witness.get('actualFocusedPlugin') != pane.get('focusedPlugin')):
                    continue
            rect, body_rect = witness.get('rect', {}), witness.get('bodyRect', {})
            if (witness.get('paintable') is not True or not isinstance(rect, dict) or not isinstance(body_rect, dict)
                    or any(type(value.get(key)) is not int for value in (rect, body_rect)
                    for key in ('x', 'y', 'width', 'height'))
                    or any(value['width'] <= 0 or value['height'] <= 0 for value in (rect, body_rect))
                    or rect['x'] < 0 or rect['x'] + rect['width'] > columns
                    or body_rect['x'] < rect['x'] or body_rect['y'] < rect['y']
                    or body_rect['x'] + body_rect['width'] > rect['x'] + rect['width']
                    or body_rect['y'] + body_rect['height'] > rect['y'] + rect['height']
                    or body_rect['y'] >= rows or body_rect['y'] + body_rect['height'] <= 0):
                continue
            if pane.get('focusedElement'):
                control = controls[0]
                control_rect = control.get('rect')
                empty_button = (control.get('emptyButton') is True and control.get('paintable') is False
                                and control_rect is None)
                if not empty_button and (control.get('paintable') is not True or not isinstance(control_rect, dict)
                        or any(type(control_rect.get(key)) is not int for key in ('x', 'y', 'width', 'height'))
                        or control_rect['width'] <= 0 or control_rect['height'] <= 0
                        or control_rect['x'] >= body_rect['x'] + body_rect['width']
                        or control_rect['x'] + control_rect['width'] <= body_rect['x']
                        or control_rect['y'] >= min(rows, body_rect['y'] + body_rect['height'])
                        or control_rect['y'] + control_rect['height'] <= max(0, body_rect['y'])):
                    continue
            body = '\n'.join(''.join(cells.get((x, y), (' ', 1))[0]
                                    for x in range(body_rect['x'], body_rect['x'] + body_rect['width'])
                                    if cells.get((x, y), (' ', 1))[1] != 0)
                             for y in range(max(0, body_rect['y']), min(rows, body_rect['y'] + body_rect['height'])))
        elif witnesses:
            continue
        return {'state': state, 'frameId': entry['frameId'], 'terminalUiRevision': entry['terminalUiRevision'],
                'terminalViewport': viewport, 'witness': witness, 'body': body, 'screen': screen,
                **({'nativeBinding': native_binding} if native_binding else {})}
    return None


def canonical_debug_states(debug):
    states = []
    for line in debug.splitlines():
        if '[ModsUI] ' not in line:
            continue
        row = json.loads(line.split('[ModsUI] ', 1)[1])
        if row.get('event') != 'publish':
            continue
        panes = [pane for pane in row.get('panes', [])
                 if pane.get('plugin') == 'cc-plugin-diff' and pane.get('id') == 'diff']
        if len(panes) > 1:
            raise ValueError('ambiguous canonical Pane publish')
        states.append({'revision': row['revision'], 'pane': panes[0] if panes else None})
    return states


def canonical_input_file_matches(root, receipt, native=False):
    try:
        path = Path(receipt['inputFile'])
        if (receipt.get('phase') != 'send' or receipt.get('transport') != 'tmux-paste-buffer' or path.parent != root):
            return False
        named = os.lstat(path)
        if not stat.S_ISREG(named.st_mode):
            return False
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as file:
            opened = os.fstat(file.fileno())
            if (not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.getuid() or opened.st_nlink != 1 or
                    opened.st_size > 65536 or (native and stat.S_IMODE(opened.st_mode) != 0o600) or
                    (opened.st_dev,opened.st_ino) != (named.st_dev,named.st_ino)):
                return False
            data = file.read(65537)
            after, current = os.fstat(file.fileno()), os.lstat(path)
            if (len(data) != opened.st_size or
                    (after.st_dev,after.st_ino,after.st_size) != (opened.st_dev,opened.st_ino,opened.st_size) or
                    (current.st_dev,current.st_ino,current.st_size,current.st_nlink,current.st_mode) !=
                    (opened.st_dev,opened.st_ino,opened.st_size,1,opened.st_mode)):
                return False
        return data.hex() == receipt['hex'] and hashlib.sha256(data).hexdigest() == receipt['bytesSHA256']
    except (OSError, KeyError, ValueError, TypeError):
        return False


def canonical_ui_checks(root, native_context=None):
    checks = {'canonical_pane_frame_association': False,
              'canonical_pane_lifecycle': False, 'canonical_keyboard_landing': False}
    def read(name):
        return json.loads((root / name).read_bytes())
    def lines(name):
        return [json.loads(line) for line in (root / name).read_bytes().splitlines()]
    try:
        states, checkpoints, frames = read('canonical-ui-states.json'), read('canonical-checkpoints.json'), lines('frames.jsonl')
        if states != canonical_debug_states((root / 'debug.log').read_text()):
            return checks
        if not states or any(a['revision'] >= b['revision'] for a, b in zip(states, states[1:])):
            return checks
        selected = [row for row in checkpoints if row.get('name') in CANONICAL_PANE_CHECKPOINTS
                    or row.get('name', '').startswith('canonical_tab_landing_')]
        names = [row['name'] for row in selected]
        if (len(names) != len(set(names))
                or [name for name in names if name in CANONICAL_PANE_CHECKPOINTS] != list(CANONICAL_PANE_CHECKPOINTS)):
            return checks
        tabs = [name for name in names if name.startswith('canonical_tab_landing_')]
        if tabs != [f'canonical_tab_landing_{i}' for i in range(len(tabs))]:
            return checks
        inputs, geometry, io = lines('inputs.jsonl'), lines('geometry.jsonl'), lines('pty-io.jsonl')
        tab_inputs = [row for row in inputs if row.get('phase') == 'send' and
                      re.fullmatch(r'raw-canonical-tab-\d+\.bin', Path(row.get('inputFile', '')).name)]
        if ([Path(row['inputFile']).stem.removeprefix('raw-').replace('canonical-tab-', 'canonical_tab_landing_')
             for row in tab_inputs] != tabs):
            return checks
        focus_index, omega_index = names.index('canonical_focus_landing'), names.index('canonical_omega_control')
        if names[focus_index + 1:omega_index] != tabs:
            return checks
        observed = {}
        previous_id = 0
        for checkpoint in selected:
            observation, action = checkpoint['observation'], checkpoint['action']
            if checkpoint.get('passed') is not True or not isinstance(observation, dict) or not isinstance(action, dict):
                return checks
            receipt = action['receipt']
            journal = inputs if action['kind'] == 'input' else geometry if action['kind'] == 'resize' else []
            if sum(row == receipt for row in journal) != 1:
                return checks
            frame_id = observation['frameId']
            frame = [entry for entry in frames if entry['frameId'] == frame_id]
            state = [entry for entry in states if entry['revision'] == observation['terminalUiRevision']]
            if (len(frame) != 1 or len(state) != 1 or frame_id < previous_id
                    or type(checkpoint.get('lastObservedFrameId')) is not int
                    or frame_id > checkpoint['lastObservedFrameId']):
                return checks
            native = frame[0].get('native') is not None
            lower = action.get('send') if native and action['kind'] == 'resize' else receipt
            if not isinstance(lower, dict) or checkpoint['frameFloor'] > lower['lastObservedFrameId']:
                return checks
            # Authenticate the recorded observation; publication may advance
            # between observing it and recording the checkpoint boundary.
            matched = canonical_frame_snapshot(state, frames[:frame_id],
                lower['lastObservedFrameId'], io[:checkpoint['lastObservedIoId']], native_context, action, checkpoint)
            if matched is None:
                return checks
            if matched != observation or checkpoint.get('pane') != matched['state']['pane']:
                return checks
            native = frame[0].get('native') is not None
            if native:
                if not canonical_native_action_associated(frame[0], matched.get('nativeBinding'), io, action, checkpoint):
                    return checks
                ack = [row for row in io if row.get('ioId') == matched['nativeBinding']['resizeIoId']]
            else:
                start, end = frame[0]['broker']['start'], frame[0]['broker']['end']
                if (any(type(row.get(key)) is not int for row in (start, end) for key in ('ioId', 'geometryId', 'rawOffset'))
                        or start['geometryId'] != end['geometryId']
                        or not receipt['lastObservedIoId'] < start['ioId'] < end['ioId'] <= checkpoint['lastObservedIoId']
                        or not receipt['observedRawBytes'] <= start['rawOffset'] <= end['rawOffset'] <= checkpoint['observedRawBytes']
                        or any(row.get('captureId') != frame[0].get('captureId') for row in (start, end))):
                    return checks
                ack = [row for row in io if row.get('kind') == 'resize-ack' and row.get('geometryId') == start['geometryId']]
                if (len(ack) != 1 or ack[0].get('succeeded') is not True
                        or ack[0].get('captureId') != frame[0].get('captureId') or ack[0]['ioId'] > start['ioId']
                        or matched['terminalViewport'] != {'width': ack[0]['columns'], 'height': ack[0]['rows']}):
                    return checks
            if action['kind'] == 'input':
                path = Path(receipt['inputFile'])
                if not canonical_input_file_matches(root, receipt, native):
                    return checks
                if native:
                    sent = [row for row in inputs if row.get('actionId') == receipt.get('actionId') and row.get('phase') == 'sent']
                    if (len(sent) != 1 or sent[0].get('exitCodes') != [0,0] or
                            any(type(code) is not int for code in sent[0]['exitCodes'])):
                        return checks
            else:
                if (receipt.get('phase') != 'resize-return' or receipt.get('exitCode') != 0
                        or matched['terminalViewport'] != {'width': receipt['columns'], 'height': receipt['rows']}):
                    return checks
                sent = [row for row in geometry if row.get('phase') == 'resize-send' and row.get('actionId') == receipt.get('actionId')]
                if (len(sent) != 1 or sent[0]['columns'] != receipt['columns'] or sent[0]['rows'] != receipt['rows']
                        or (native and action.get('send') != sent[0])
                        or ack[0]['ioId'] <= sent[0]['lastObservedIoId']):
                    return checks
            previous_id = frame_id
            observed[checkpoint['name']] = (matched, action)
        checks['canonical_pane_frame_association'] = True
        def match(name): return observed[name][0]
        def witness(name): return match(name)['witness']
        def body(name): return match(name)['body']
        def input_is(name, stem, data):
            action = observed[name][1]
            return (action['kind'] == 'input' and Path(action['receipt']['inputFile']).name == f'raw-{stem}.bin'
                    and action['receipt']['hex'] == data.hex())
        navigation = ('canonical_focus_landing', *tabs)
        if observed['canonical_omega_control'][1] != observed[navigation[-1]][1]:
            return checks
        if any(observed[name][1]['receipt'] != receipt for name, receipt in zip(tabs, tab_inputs)):
            return checks
        keyboard = all(witness(name) and witness(name)['focused'] is True and witness(name)['actualFocusWithin'] is True
                       for name in ('canonical_focus_landing', *tabs, 'canonical_omega_control', 'canonical_refocus_landing'))
        keyboard = keyboard and witness('canonical_omega_control')['focusedElement'] == 'file:omega.txt'
        previous_key = witness('canonical_focus_landing').get('focusedElement')
        for index, name in enumerate(tabs):
            current_key = witness(name).get('focusedElement')
            keyboard = keyboard and current_key != previous_key and input_is(name, f'canonical-tab-{index}', b'\t')
            previous_key = current_key
        checks['canonical_keyboard_landing'] = bool(keyboard and
            input_is('canonical_focus_landing', 'canonical-focus-chord', b'\x18\t') and
            input_is('canonical_refocus_landing', 'canonical-refocus', b'\x18\t') and
            input_is('canonical_file_body', 'canonical-file-press', b'\r') and
            input_is('canonical_escape_keeps_open', 'canonical-leave-focus', b'\x1b'))
        first = witness('canonical_alpha_dock')
        continuation = ('canonical_two_files_before_select', 'canonical_focus_landing', *tabs,
            'canonical_omega_control', 'canonical_file_body', 'canonical_escape_keeps_open',
            'canonical_inline_same_identity', 'canonical_redocked', 'canonical_refocus_landing')
        same_lease = all(witness(name) and all(witness(name)[key] == first[key] for key in ('activation', 'lease'))
                         for name in continuation)
        reopened = witness('canonical_reopened')
        checks['canonical_pane_lifecycle'] = bool(first and same_lease and reopened and
            first['placement'] == 'dock' and first['focused'] is False and
            'ALPHA_RELEASE_BODY' in body('canonical_alpha_dock') and 'omega.txt' not in body('canonical_alpha_dock') and
            all(text in body('canonical_two_files_before_select') for text in ('alpha.txt', 'omega.txt', 'ALPHA_RELEASE_BODY')) and
            'OMEGA_RELEASE_BODY' not in body('canonical_two_files_before_select') and
            'OMEGA_RELEASE_BODY' in body('canonical_file_body') and 'ALPHA_RELEASE_BODY' not in body('canonical_file_body') and
            witness('canonical_escape_keeps_open')['focused'] is False and
            witness('canonical_inline_same_identity')['placement'] == 'inline' and
            observed['canonical_inline_same_identity'][1]['kind'] == 'resize' and
            observed['canonical_inline_same_identity'][1]['receipt']['columns'] == 109 and
            'Resize' in match('canonical_inline_same_identity')['screen'] and
            witness('canonical_redocked')['placement'] == 'dock' and
            observed['canonical_redocked'][1]['kind'] == 'resize' and
            observed['canonical_redocked'][1]['receipt']['columns'] == 110 and
            'OMEGA_RELEASE_BODY' in body('canonical_redocked') and
            witness('canonical_person_closed') is None and
            input_is('canonical_person_closed', 'canonical-close-chord', b'\x18x') and
            reopened['activation'] == first['activation'] and reopened['lease'] != first['lease'] and
            'ALPHA_RELEASE_BODY' in body('canonical_reopened') and 'ALPHA_RELEASE_LINE_000' in body('canonical_reopened') and
            'OMEGA_RELEASE_BODY' not in body('canonical_reopened') and reopened['paintedScrollTop'] == 0 and
            input_is('canonical_reopened', 'canonical-reopen', b'/diff\r') and
            witness('canonical_command_closed') is None and input_is('canonical_command_closed', 'canonical-command-close', b'/diff\r') and
            witness('canonical_narrow_refused') is None and input_is('canonical_narrow_refused', 'canonical-too-narrow', b'/diff\r') and
            match('canonical_narrow_refused')['terminalViewport']['width'] == 109 and
            'Resize your terminal to at least 110 columns to show the diff panel' in match('canonical_narrow_refused')['screen'])
    except (OSError, ValueError, TypeError, AttributeError, KeyError):
        pass
    return checks


def terminal_resize_sizes(report):
    """Keep native request/ACK/paint proof distinct from legacy broker proof."""
    if not isinstance(report, dict) or report.get('verdict') != 'passed':
        return None
    native = report.get('method') == 'native-journal-ioctl-geometry-replay-v1'
    if not native and report.get('method') != 'independent-pty-replay-v1':
        return None
    proof = report.get('nativeGeometryProof' if native else 'geometryProof', {})
    if (not isinstance(proof, dict) or proof.get('verdict') != 'passed' or
            (native and (proof.get('method') != 'native-driver-mach-frame-geometry-v2' or
                         report.get('framePhysicalBoundary') != 'native-frame-end-v1' or
                         report.get('parserSHA256') != '17a90b650cf6b77cce2b98c4063884d43545e4ce177a54b76ccfc906f1aacaed'))):
        return None
    rows = proof.get('sizes')
    if not isinstance(rows, list) or any(not isinstance(row, dict) or
            any(type(row.get(key)) is not int or not 0 < row[key] <= 1000 for key in ('columns', 'rows'))
            for row in rows):
        return None
    if native:
        frames = report.get('frames')
        if (not isinstance(frames, list) or type(proof.get('requested')) is not int or
                type(proof.get('acknowledged')) is not int or
                proof['requested'] != proof['acknowledged'] or proof['requested'] != len(rows) or
                any(any(type(row.get(key)) is not int or row[key] <= 0
                        for key in ('actionId', 'ioId', 'geometryId', 'frameId')) or
                    row['actionId'] != index or row['geometryId'] != index or
                    not any(isinstance(frame, dict) and type(frame.get('frameId')) is int and
                        frame['frameId'] == row['frameId'] and
                        frame.get('verdict') == 'passed' and type(frame.get('outputBytes')) is int and
                        frame['outputBytes'] > 0 and
                        (frame.get('columns'), frame.get('rows')) == (row['columns'], row['rows'])
                        for frame in frames)
                    for index, row in enumerate(rows, 1)) or
                any(left['ioId'] >= right['ioId'] or left['frameId'] >= right['frameId']
                    for left, right in zip(rows, rows[1:]))):
            return None
    return [(row['columns'], row['rows']) for row in rows]


def terminal_frame_report_checks(report):
    invalid = {'renderer_write_replay': False, 'frame_resize_sequence': False, 'frame_semantics': False}
    if not isinstance(report, dict):
        return invalid
    frames = report.get('frames', [])
    if not isinstance(frames, list) or any(
        not isinstance(frame, dict) or not isinstance(frame.get('semantic', {}), dict)
        for frame in frames
    ):
        return invalid
    native = (report.get('method') == 'native-journal-ioctl-geometry-replay-v1' and
              report.get('framePhysicalBoundary') == 'native-frame-end-v1' and
              report.get('semanticSource') == 'independent-xterm-native-frame-end-v1' and
              report.get('parserSHA256') == '17a90b650cf6b77cce2b98c4063884d43545e4ce177a54b76ccfc906f1aacaed')
    replay = ((native or report.get('method') in {'renderer-write-replay-v1', 'independent-pty-replay-v1'})
                and report.get('verdict') == 'passed' and bool(frames)
                and type(report.get('frameCount')) is int and report['frameCount'] == len(frames)
                and all(f.get('verdict') == 'passed' for f in frames)
                and all(type(f.get('frameId')) is int and f['frameId'] > 0 and
                    all(type(f.get(key)) is int and 0 < f[key] <= 1000 for key in ('columns', 'rows'))
                    for f in frames)
                and (not native or all(type(f.get('outputBytes')) is int and f['outputBytes'] >= 0 and
                    type(f.get('replayBytes')) is int and f['replayBytes'] >= f['outputBytes'] for f in frames))
                and all(a['frameId'] < b['frameId'] for a, b in zip(frames, frames[1:])))
    sequence = []
    for frame in frames:
        size = (frame.get('columns'), frame.get('rows'))
        if not sequence or size != (sequence[-1]['columns'], sequence[-1]['rows']):
            sequence.append({'columns': size[0], 'rows': size[1], 'frameId': frame.get('frameId')})
    resize = bool(sequence) and report.get('sizeSequence') == sequence and any(
        [f['columns'] for f in sequence[i:i + 3]] == [110, 109, 110]
        for i in range(len(sequence) - 2))
    # Require ordered semantic states, not just a physically self-consistent blank screen.
    predicates = [
        lambda f, s: f.get('columns') == 110 and s.get('alphaBody') is True,
        lambda f, s: s.get('diffMode') == 'detail' and s.get('omegaFile') is True
                     and s.get('loading') is True and s.get('omegaBody') is False,
        lambda f, s: f.get('columns') == 110 and s.get('diffMode') == 'detail'
                     and s.get('omegaFile') is True and s.get('omegaBody') is True,
        lambda f, s: f.get('columns') == 109 and s.get('diffMode') == 'detail'
                     and s.get('omegaFile') is True and s.get('omegaBody') is True,
        lambda f, s: f.get('columns') == 110 and s.get('diffMode') == 'detail'
                     and s.get('omegaFile') is True and s.get('omegaBody') is True,
    ]
    stage = 0
    for frame in frames:
        if stage < len(predicates) and predicates[stage](frame, frame.get('semantic', {})):
            stage += 1
    return {'renderer_write_replay': replay and report.get('method') == 'renderer-write-replay-v1',
            'frame_resize_sequence': resize,
            'frame_semantics': replay and resize and stage == len(predicates)}


def terminal_socket_identity(capture):
    root = Path(capture['socketRoot'])
    path = Path(capture['socket'])
    if (not root.is_absolute() or root.is_symlink() or root.resolve() != root
            or path.parent != root or path.name != 's' or path.is_symlink()):
        raise ValueError('terminal socket is outside its owned canonical directory')
    root_info, info = root.lstat(), path.lstat()
    if (not stat.S_ISDIR(root_info.st_mode) or root_info.st_mode & 0o077
            or root_info.st_uid != os.getuid() or not stat.S_ISSOCK(info.st_mode)
            or info.st_uid != os.getuid()):
        raise ValueError('terminal socket ownership or file type is invalid')
    return {'rootDevice': root_info.st_dev, 'rootInode': root_info.st_ino,
            'device': info.st_dev, 'inode': info.st_ino}


def release_owned_terminal_socket(capture):
    path = Path(capture['socket'])
    result = {'socket_released': False, 'server_exited': False, 'stale_socket_removed': False}
    try:
        pid = capture.get('serverPid')
        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1:
            raise ValueError('terminal socket server identity is missing')
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            result['server_exited'] = True
        else:
            raise ValueError('terminal socket server has not exited')
        if not path.exists() and not path.is_symlink():
            result['socket_released'] = True
            return result
        if terminal_socket_identity(capture) != capture.get('socketIdentity'):
            raise ValueError('terminal socket inode no longer belongs to this run')
        # A dead server may leave its unix socket entry after the last session.
        # Refuse a live/replaced endpoint; remove only the captured owned inode.
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
            probe.settimeout(0.2)
            try:
                probe.connect(str(path))
            except ConnectionRefusedError:
                pass
            else:
                raise ValueError('terminal socket endpoint is still live')
        if terminal_socket_identity(capture) != capture['socketIdentity']:
            raise ValueError('terminal socket changed during cleanup')
        path.unlink()
        result.update(socket_released=True, stale_socket_removed=True)
    except (OSError, ValueError) as error:
        result['error'] = str(error)
    return result


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def png_dimensions(data):
    if len(data) < 24 or data[:8] != b'\x89PNG\r\n\x1a\n':
        return None
    return (
        int.from_bytes(data[16:20], 'big'),
        int.from_bytes(data[20:24], 'big'),
    )


def text_sha256(text):
    return hashlib.sha256(text.encode()).hexdigest()


def tree_manifest(root):
    manifest = {}
    if not root.exists():
        return manifest
    for path in sorted(root.rglob('*')):
        relative = str(path.relative_to(root))
        if path.is_symlink():
            manifest[relative] = {
                'type': 'link',
                'target': str(path.readlink()),
            }
        elif path.is_file():
            manifest[relative] = {'type': 'file', 'sha256': sha256(path)}
        elif path.is_dir():
            manifest[relative] = {'type': 'dir'}
    return manifest


def tree_sha256(manifest):
    return text_sha256(json.dumps(manifest, sort_keys=True))


def git_paths_manifest(repo, *args, excluded_roots=()):
    manifest = {}
    result = command(
        ['git', '-C', str(repo), 'ls-files', *args, '-z'],
        check=True,
    )
    for relative in sorted(path for path in result.stdout.split('\0') if path):
        relative = relative.rstrip('/')
        if (
            BUN_BUILD_TEMPORARY_PATTERN.fullmatch(relative)
            or '/__pycache__/' in f'/{relative}'
            or PYTHON_BYTECODE_PATTERN.fullmatch(relative)
            or any(
                relative == root or relative.startswith(f'{root}/')
                for root in excluded_roots
            )
        ):
            continue
        file_path = repo / relative
        if file_path.is_symlink():
            manifest[relative] = {
                'type': 'link',
                'target': str(file_path.readlink()),
            }
        elif file_path.is_file():
            manifest[relative] = {'type': 'file', 'sha256': sha256(file_path)}
        elif file_path.is_dir():
            manifest[relative] = {'type': 'dir'}
            manifest.update({
                f'{relative}/{child}': entry
                for child, entry in tree_manifest(file_path).items()
            })
        else:
            raise RuntimeError(f'git-listed path does not exist: {relative}')
    return manifest


def untracked_manifest(repo):
    return git_paths_manifest(
        repo,
        '--others', '--exclude-standard',
        excluded_roots=(WORKFLOW_RUNS_ROOT,),
    )


def ignored_manifest(repo):
    return git_paths_manifest(
        repo,
        '--others', '--ignored', '--exclude-standard',
        excluded_roots=IGNORED_FILES_EXCLUDED_ROOTS,
    )


def is_relative_to(path, parent):
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def builtin_cache_producers_closed(cache, binary_sha256):
    """Deleting a captured run also requires its producer's EOF and reap receipt."""
    artifacts = ('native-pty.raw', 'pty-io.jsonl', 'native-pty-initial.json',
                 'native-pty-eof.json', 'broker-cleanup.json',
                 'frame-request.fifo', 'frame-response.fifo')
    for run in (cache / 'runs').glob('r-*'):
        if run.is_symlink():
            return False
        if not any((run / name).exists() or (run / name).is_symlink() for name in artifacts):
            continue
        try:
            paths = [run / name for name in ('native-pty.raw', 'native-pty-initial.json',
                                           'native-pty-eof.json', 'broker-cleanup.json')]
            if any(path.is_symlink() or not path.is_file() for path in paths):
                return False
            raw, initial_path, eof_path, cleanup_path = paths
            initial, eof, cleanup = [json.loads(path.read_text())
                                     for path in (initial_path, eof_path, cleanup_path)]
            if not all(isinstance(value, dict) for value in (initial, eof, cleanup)):
                return False
            pid, capture_id = initial.get('pid'), initial.get('captureId')
            removed = cleanup.get('fifoRemoved')
            if (type(pid) is not int or pid <= 0 or not isinstance(capture_id, str) or not capture_id
                    or initial.get('pgid') != pid or initial.get('binarySha256') != binary_sha256
                    or eof.get('captureId') != capture_id or cleanup.get('captureId') != capture_id
                    or eof.get('childPid') != pid or cleanup.get('childPid') != pid
                    or type(eof.get('childExitCode')) is not int or eof['childExitCode'] != 0
                    or type(eof.get('rawBytes')) is not int or eof['rawBytes'] != raw.stat().st_size
                    or cleanup.get('childReaped') is not True
                    or type(eof.get('childStatus')) is not int or eof['childStatus'] != 0
                    or type(cleanup.get('childStatus')) is not int or cleanup['childStatus'] != eof['childStatus']
                    or cleanup.get('physicalEof') is not True or cleanup.get('normalCompletion') is not True
                    or cleanup.get('cleanupErrors') != [] or 'failure' not in cleanup or cleanup['failure'] is not None
                    or 'stopReason' not in cleanup or cleanup['stopReason'] is not None
                    or not isinstance(removed, list) or sorted(removed) != ['frame-request.fifo', 'frame-response.fifo']
                    or any((run / name).exists() or (run / name).is_symlink() for name in removed)):
                return False
        except (OSError, ValueError, TypeError):
            return False
    return True


def builtin_cache_endpoints_match(root, expected):
    """Only the original, explicitly excluded IPC nodes may remain in the source."""
    if root.is_symlink() or not root.is_dir() or not isinstance(expected, list):
        return False
    allowed = {}
    for row in expected:
        if (not isinstance(row, dict) or set(row) != {'path', 'type', 'device', 'inode', 'mode'}
                or not isinstance(row['path'], str)):
            return False
        parts = Path(row['path']).parts
        if (len(parts) != 3 or parts[0] != 'runs'
                or not re.fullmatch(r'r-[0-9a-f]{12}', parts[1])
                or not ((row['type'] == 'fifo' and parts[2] in ('frame-request.fifo', 'frame-response.fifo'))
                        or (row['type'] == 'socket' and parts[2] == 'tmux.sock'))
                or any(type(row[key]) is not int for key in ('device', 'inode', 'mode'))
                or row['path'] in allowed):
            return False
        allowed[row['path']] = row
    for path in sorted(root.rglob('*')):
        info = path.lstat()
        if stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            continue
        kind = 'fifo' if stat.S_ISFIFO(info.st_mode) else 'socket' if stat.S_ISSOCK(info.st_mode) else None
        relative = str(path.relative_to(root))
        actual = {'path': relative, 'type': kind, 'device': info.st_dev,
                  'inode': info.st_ino, 'mode': stat.S_IMODE(info.st_mode)}
        if actual != allowed.get(relative):
            return False
    return True


def builtin_cache_archive_matches(source, archive, receipt, expected_snapshot):
    """Deletion requires both trees to still match the original verified snapshot."""
    try:
        if receipt.is_symlink() or not receipt.is_file():
            return False
        saved = json.loads(receipt.read_text())
        if not isinstance(expected_snapshot, dict):
            return False
        expected_manifest = expected_snapshot.get('sourceManifest')
        expected_endpoints = expected_snapshot.get('excludedTransports')
        if (not isinstance(saved, dict) or not isinstance(expected_manifest, dict)
                or saved.get('source') != str(source) or saved.get('archive') != str(archive)
                or any(saved.get(key) is not True for key in (
                    'archiveComplete', 'sourceFilesStable', 'archiveFilesMatch'))
                or saved.get('sourceManifest') != expected_manifest
                or saved.get('excludedTransports') != expected_endpoints):
            return False
        return (builtin_cache_endpoints_match(source, expected_endpoints)
                and builtin_cache_endpoints_match(archive, [])
                and tree_manifest(source) == expected_manifest
                and tree_manifest(archive) == expected_manifest)
    except (OSError, ValueError, TypeError):
        return False


def archive_builtin_cache(source, archive, receipt):
    """Copy durable evidence without opening the run's ephemeral IPC endpoints."""
    if archive.exists() or receipt.exists():
        raise FileExistsError('builtin evidence archive or receipt already exists')
    before = tree_manifest(source)
    excluded = []
    stable = matched = False
    completed = False

    def ignore(directory, names):
        ignored = []
        for name in sorted(names):
            path = Path(directory) / name
            relative = path.relative_to(source)
            parts = relative.parts
            if (len(parts) != 3 or parts[0] != 'runs'
                    or not re.fullmatch(r'r-[0-9a-f]{12}', parts[1])):
                continue
            info = path.lstat()
            kind = None
            if (name in ('frame-request.fifo', 'frame-response.fifo')
                    and stat.S_ISFIFO(info.st_mode)):
                kind = 'fifo'
            elif name == 'tmux.sock' and stat.S_ISSOCK(info.st_mode):
                kind = 'socket'
            if kind is not None:
                ignored.append(name)
                excluded.append({'path': str(relative), 'type': kind,
                                 'device': info.st_dev, 'inode': info.st_ino,
                                 'mode': stat.S_IMODE(info.st_mode)})
        return ignored

    try:
        # Preserve links as links, rather than reading a target outside this cache.
        shutil.copytree(source, archive, ignore=ignore, symlinks=True)
        stable = tree_manifest(source) == before
        matched = tree_manifest(archive) == before
        if not stable or not matched:
            raise OSError('builtin evidence changed or archive bytes differ')
        completed = True
    finally:
        with receipt.open('x', encoding='utf-8') as stream:
            json.dump({'source': str(source), 'archive': str(archive),
                       'archiveComplete': completed, 'sourceFilesStable': stable,
                       'archiveFilesMatch': matched, 'sourceManifest': before,
                       'excludedTransports': excluded,
                       'scope': 'File preservation only; EOF, reap, timing and business verdicts remain separate.'},
                      stream, indent=2)
            stream.write('\n')
    return {'sourceManifest': before, 'excludedTransports': excluded}


def remap_path_strings(value, source_root, target_root):
    if isinstance(value, dict):
        return {
            key: remap_path_strings(item, source_root, target_root)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [remap_path_strings(item, source_root, target_root) for item in value]
    if isinstance(value, str):
        source = str(source_root)
        if value == source or value.startswith(source + os.sep):
            return str(target_root) + value[len(source):]
    return value


def strip_ansi(text):
    return re.sub(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))', '', text)


def tool_result_text(content):
    if isinstance(content, str):
        return content
    if content is None:
        return ''
    return json.dumps(content, ensure_ascii=False, sort_keys=True)


def normalize_source_url(url):
    if not isinstance(url, str):
        return None
    parsed = urlsplit(url)
    if parsed.scheme not in {'http', 'https'} or not parsed.netloc:
        return None
    query = f'?{parsed.query}' if parsed.query else ''
    return f'{parsed.scheme}://{parsed.netloc.casefold()}{parsed.path}{query}'


def assistant_structured_output(entries):
    text_blocks = [
        block['text']
        for entry in entries
        if entry.get('type') == 'assistant'
        and isinstance(entry.get('message'), dict)
        and isinstance(entry['message'].get('content'), list)
        for block in entry['message']['content']
        if isinstance(block, dict)
        and block.get('type') == 'text'
        and isinstance(block.get('text'), str)
    ]
    if len(text_blocks) != 1:
        return None
    try:
        output = json.loads(text_blocks[0])
    except json.JSONDecodeError:
        return None
    return output if isinstance(output, dict) else None


def assistant_selected_source(entries):
    output = assistant_structured_output(entries)
    if output is None:
        return None
    selected = output.get('selectedSource')
    if not isinstance(selected, dict):
        return None
    return {
        'rank': selected.get('oneBasedRank'),
        'url': normalize_source_url(selected.get('url')),
    }


def assistant_selected_sources(entries):
    output = assistant_structured_output(entries)
    if output is None or not isinstance(output.get('sources'), list):
        return None
    return [
        {
            'rank': source.get('oneBasedRank'),
            'url': normalize_source_url(source.get('url')),
        }
        if isinstance(source, dict)
        else {'rank': None, 'url': None}
        for source in output['sources']
    ]


def tool_occurrence_count(evidence):
    return sum(evidence['tool_use_counts'].values())


def sse_completed(text, *, output_tokens=1, reasoning=None, usage=None):
    events = []
    if reasoning:
        events.extend([
            {
                'type': 'response.reasoning_summary_text.delta',
                'delta': reasoning,
            },
            {
                'type': 'response.reasoning_summary_text.done',
                'text': reasoning,
            },
        ])
    if text:
        events.append({
            'type': 'response.output_text.delta',
            'delta': text,
        })
    events.append({
        'type': 'response.completed',
        'response': {
            'usage': usage if usage is not None else {
                'input_tokens': 1,
                'output_tokens': output_tokens,
            },
        },
    })
    return ''.join(
        f'data: {json.dumps(event, separators=(",", ":"))}\n\n'
        for event in events
    )


def sse_incomplete(reason):
    event = {
        'type': 'response.incomplete',
        'response': {
            'incomplete_details': {'reason': reason},
        },
    }
    return f'data: {json.dumps(event, separators=(",", ":"))}\n\n'


def sse_compaction(item_id, encrypted_content):
    events = [
        {
            'type': 'response.output_item.done',
            'item': {
                'type': 'compaction',
                'id': item_id,
                'encrypted_content': encrypted_content,
            },
        },
        {
            'type': 'response.completed',
            'response': {
                'usage': {'input_tokens': 100, 'output_tokens': 5},
            },
        },
    ]
    return ''.join(
        f'data: {json.dumps(event, separators=(",", ":"))}\n\n'
        for event in events
    )


def sse_function_calls(calls):
    events = []
    for call_id, name, arguments in calls:
        events.extend([
            {
                'type': 'response.output_item.added',
                'item': {
                    'type': 'function_call',
                    'id': call_id,
                    'call_id': call_id,
                    'name': name,
                },
            },
            {
                'type': 'response.function_call_arguments.done',
                'item_id': call_id,
                'call_id': call_id,
                'name': name,
                'arguments': json.dumps(arguments, separators=(',', ':')),
            },
        ])
    events.append({
        'type': 'response.completed',
        'response': {
            'usage': {'input_tokens': 1, 'output_tokens': len(calls)},
        },
    })
    return ''.join(
        f'data: {json.dumps(event, separators=(",", ":"))}\n\n'
        for event in events
    )


def sse_function_call(call_id, name, arguments):
    return sse_function_calls([(call_id, name, arguments)])


def is_main_response_request(request):
    if (
        request.get('method') != 'POST'
        or urlsplit(request['path']).path != '/v1/responses'
    ):
        return False
    body = request.get('body') if isinstance(request.get('body'), dict) else {}
    return TITLE_GENERATION_INSTRUCTION not in str(body.get('instructions', ''))


class MockOpenAIServer:
    def __init__(self, run_dir, label):
        self.run_dir = run_dir
        self.label = label
        self.lock = threading.Lock()
        self.requests = []
        self.server = None
        self.thread = None
        self.request_handlers = set()
        self.stop_result = None
        self.lifecycle_responses = set()
        if label == 'retained-turn-end-load':
            self.turn_waiting = threading.Event()
            self.turn_release = threading.Event()
        if label == 'transcript-retention':
            self.retention_release = threading.Event()
            self.retention_parent_waiting = threading.Event()
            self.retention_child_waiting = threading.Event()
            self.retention_child_release = threading.Event()
            self.retention_stopped = threading.Event()
        if label == 'coordinator-selector':
            self.coordinator_release = threading.Event()
            self.coordinator_tools_done = threading.Event()
            self.coordinator_stopped = threading.Event()
        if label == 'agent-fg-bg':
            self.agent_fgbg_release = threading.Event()
            self.agent_fgbg_child_waiting = threading.Event()

    def start(self):
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, _format, *_args):
                return

            def send_json(self, value):
                body = json.dumps(value, separators=(',', ':')).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Connection', 'close')
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                request = owner.record(self, None)
                path = urlsplit(self.path).path
                if path == '/api/claude_cli/bootstrap':
                    request['response_kind'] = 'bootstrap'
                    owner.flush()
                    self.send_json({
                        'client_data': {
                            'release_validation': 'first-party-bootstrap',
                        },
                        'additional_model_options': [{
                            'model': 'release-first-party-bootstrap-model',
                            'name': 'RELEASE_FIRST_PARTY_BOOTSTRAP_MODEL',
                            'description': 'Release validation bootstrap model',
                        }],
                    })
                    return
                if path == '/v1/models':
                    request['response_kind'] = 'models'
                    owner.flush()
                    if owner.label == 'model-discovery-empty-picker':
                        self.send_json({'data': []})
                    else:
                        self.send_json({
                            'data': [{
                                'id': 'gpt-release-discovered',
                                'display_name': 'GPT Release Discovered',
                                'description': 'Release validation model',
                            }],
                        })
                    return
                request['response_kind'] = 'not-found'
                owner.flush()
                self.send_error(404)

            def do_POST(self):
                length = int(self.headers.get('Content-Length', '0'))
                raw = self.rfile.read(length)
                try:
                    body = json.loads(raw) if raw else {}
                except json.JSONDecodeError:
                    body = {'_invalid_json': raw.decode(errors='replace')}
                request = owner.record(self, body)
                if urlsplit(self.path).path != '/v1/responses':
                    self.send_error(404)
                    return
                if owner.label in LIFECYCLE_MOCK_KINDS and not request['authorization']['matches_dummy']:
                    request['response_kind'] = 'invalid-auth'
                    owner.flush()
                    self.send_error(401)
                    return
                response_kind, response = owner.response_for(body)
                request['response_kind'] = response_kind
                owner.flush()
                if response_kind == 'retention-child-cancelled':
                    self.close_connection = True
                    return
                encoded = response.encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Cache-Control', 'no-cache')
                self.send_header('Content-Length', str(len(encoded)))
                self.send_header('Connection', 'close')
                self.end_headers()
                self.wfile.write(encoded)

        class OwnedServer(ThreadingHTTPServer):
            def process_request(self, request, client_address):
                thread = threading.Thread(target=self.process_request_thread,
                    args=(request, client_address), name=f'release-mock-handler-{owner.label}', daemon=True)
                with owner.lock:
                    owner.request_handlers.add(thread)
                try:
                    thread.start()
                except BaseException:
                    with owner.lock:
                        owner.request_handlers.discard(thread)
                    self.shutdown_request(request)
                    raise

            def process_request_thread(self, request, client_address):
                try:
                    super().process_request_thread(request, client_address)
                finally:
                    with owner.lock:
                        owner.request_handlers.discard(threading.current_thread())

        self.server = OwnedServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            name=f'release-mock-openai-{self.label}',
            daemon=True,
        )
        self.thread.start()
        self.flush()
        return f'http://127.0.0.1:{self.server.server_address[1]}'

    def record(self, request, body):
        headers = {
            name.lower(): value
            for name, value in request.headers.items()
            if name.lower() != 'authorization'
        }
        authorization = request.headers.get('Authorization')
        item = {
            'sequence': 0,
            'method': request.command,
            'path': request.path,
            'headers': headers,
            'authorization': {
                'present': authorization is not None,
                'matches_dummy': authorization == f'Bearer {DUMMY_OPENAI_API_KEY}',
            },
            'body': body,
            'response_kind': None,
        }
        with self.lock:
            item['sequence'] = len(self.requests) + 1
            self.requests.append(item)
            self.flush_locked()
        return item

    def flush_locked(self):
        (self.run_dir / 'mock-openai-requests.json').write_text(
            json.dumps(self.requests, indent=2) + '\n'
        )

    def flush(self):
        with self.lock:
            self.flush_locked()

    def snapshot(self):
        with self.lock:
            return json.loads(json.dumps(self.requests))

    def lifecycle_response(self, body):
        items = body.get('input', [])
        outputs = {item.get('call_id'): item.get('output') for item in items
                   if isinstance(item, dict) and item.get('type') == 'function_call_output'}
        users = []
        for item in items:
            if not isinstance(item, dict) or item.get('role') != 'user':
                continue
            content = item.get('content', '')
            if isinstance(content, str):
                users.append(content)
            elif isinstance(content, list):
                users.extend(block.get('text', '') for block in content if isinstance(block, dict))
        kind, response = self.label + '-unrecognized', sse_incomplete('Unrecognized lifecycle fixture request')
        if self.label == 'nested-agent':
            if any(text.startswith('RELEASE_NESTED_CHILD_REQUEST:') for text in users):
                kind, response = 'nested-child-completed', sse_completed('RELEASE_NESTED_CHILD_DONE')
            elif any(text.startswith('RELEASE_NESTED_PARENT_REQUEST:') for text in users):
                if 'fc_nested_child' in outputs:
                    kind, response = 'nested-parent-completed', sse_completed('RELEASE_NESTED_PARENT_DONE')
                else:
                    kind, response = 'nested-parent-launch', sse_function_call(
                        'fc_nested_child', 'Agent', {
                            'description': 'release nested child', 'subagent_type': 'release-nested-foreground',
                            'run_in_background': False,
                            'prompt': 'RELEASE_NESTED_CHILD_REQUEST: Reply exactly RELEASE_NESTED_CHILD_DONE.',
                        })
            elif any(text.startswith('Release gate read-only nested Agent validation.') for text in users):
                if 'fc_nested_parent' in outputs:
                    kind, response = 'nested-root-completed', sse_completed('RELEASE_NESTED_ROOT_DONE')
                else:
                    kind, response = 'nested-root-launch', sse_function_call(
                        'fc_nested_parent', 'Agent', {
                            'description': 'release nested parent', 'subagent_type': 'release-nested-foreground',
                            'run_in_background': False,
                            'prompt': 'RELEASE_NESTED_PARENT_REQUEST: Use Agent once to launch a foreground child, then reply RELEASE_NESTED_PARENT_DONE.',
                        })
        elif self.label == 'workflow':
            if any(text.startswith('Use Workflow with this exact inline script.')
                   and INLINE_WORKFLOW_SCRIPT in text for text in users):
                if 'fc_workflow_launch' in outputs:
                    kind, response = 'workflow-parent-completed', sse_completed('RELEASE_WORKFLOW_PARENT_DONE')
                elif 'fc_workflow_search' in outputs:
                    kind, response = 'workflow-launch', sse_function_call(
                        'fc_workflow_launch', 'Workflow', {'script': INLINE_WORKFLOW_SCRIPT})
                else:
                    kind, response = 'workflow-search', sse_function_call(
                        'fc_workflow_search', 'ToolSearch', {'query': 'select:Workflow'})
            else:
                for name, path, version in (('a', 'Makefile', 'VERSION'), ('b', 'package.json', 'version')):
                    if any(text.strip() == f'Read-only. Read {path} and report only {version}.' for text in users):
                        call_id = f'fc_workflow_probe_{name}_read'
                        if call_id in outputs:
                            kind, response = f'workflow-probe-{name}-completed', sse_completed(str(outputs[call_id]))
                        else:
                            kind, response = f'workflow-probe-{name}-read', sse_function_call(
                                call_id, 'Read', {'file_path': str(Path(__file__).resolve().parents[4] / path)})
        elif self.label == 'code-review':
            scope = any(text.startswith('Establish the scope of a code review.\n') for text in users)
            if scope:
                if 'fc_code_review_scope' in outputs:
                    kind, response = 'code-review-scope-completed', sse_completed('')
                else:
                    diff = next((match.group(1) for text in users
                                 if (match := re.search(r'using exactly: (git diff [^\n]+?)\. Do not widen', text))), None)
                    if diff:
                        kind, response = 'code-review-scope-output', sse_function_call(
                            'fc_code_review_scope', 'StructuredOutput', {
                                'diffCommand': diff, 'files': [],
                                'summary': 'Deterministic empty-scope release fixture.',
                            })
            else:
                prompt = next((text for text in users if text.startswith('Workflow: code-review\n')
                               and 'selector-based input' in text and 'selector: "code-review"' in text), None)
                if prompt:
                    match = re.search(r'\nUser input:\n(.*?)\n\nExecute this validated workflow', prompt, re.DOTALL)
                    if match:
                        if 'fc_code_review_launch' in outputs:
                            kind, response = 'code-review-parent-completed', sse_completed('RELEASE_CODE_REVIEW_PARENT_DONE')
                        else:
                            kind, response = 'code-review-launch', sse_function_call(
                                'fc_code_review_launch', 'WorkflowTool', {
                                    'action': 'run', 'selector': 'code-review', 'runArgs': match.group(1),
                                })
        # Task notifications are a distinct root turn, not a second workflow launch.
        if (kind == self.label + '-parent-completed'
                and kind in self.lifecycle_responses) and any(
            '<task-notification>' in text and '<status>completed</status>' in text for text in users
        ):
            kind = self.label + '-notification-completed'
            response = sse_completed('RELEASE_WORKFLOW_NOTIFICATION_DONE')
        with self.lock:
            if kind in self.lifecycle_responses:
                return self.label + '-duplicate', sse_incomplete('Duplicate lifecycle fixture request: ' + kind)
            if kind in LIFECYCLE_MOCK_KINDS[self.label] or kind == self.label + '-notification-completed':
                self.lifecycle_responses.add(kind)
        return kind, response

    def canonical_diff_response(self, body):
        nonce = hashlib.sha256(str(self.run_dir.resolve()).encode()).hexdigest()[:24]
        items = body.get('input', [])
        users = [(index, item) for index, item in enumerate(items)
                 if isinstance(item, dict) and item.get('role') == 'user']
        invalid = ('canonical-invalid', sse_incomplete('Invalid owned canonical Read/Write continuation'))
        if not users:
            return invalid
        user_index, user = users[-1]
        content = user.get('content')
        if isinstance(content, list):
            texts = []
            for block in content:
                if (not isinstance(block, dict) or block.get('type') != 'input_text'
                        or not isinstance(block.get('text'), str)):
                    return invalid
                text = block['text']
                if re.fullmatch(r'<(system-reminder|available-deferred-tools)>.*</\1>\s*',
                                text, re.DOTALL):
                    continue
                texts.append(text)
            caveat = ('<local-command-caveat>Caveat: The messages below were generated by the user '
                      'while running local commands. DO NOT respond to these messages or otherwise '
                      'consider them in your response unless the user explicitly asks you to.'
                      '</local-command-caveat>')
            if texts and texts[0].strip() == caveat:
                if (len(texts) != 4
                        or not re.fullmatch(r'<command-name>/diff</command-name>\s*'
                            r'<command-message>diff</command-message>\s*'
                            r'<command-args></command-args>\s*', texts[1])
                        or not re.fullmatch(r'<local-command-stdout>Diff panel '
                            r'(shown|hidden)</local-command-stdout>\s*', texts[2])):
                    return invalid
                texts = texts[3:]
            if len(texts) != 1:
                return invalid
            content = texts[0]
        file = next((name for name in ('alpha', 'omega')
                     if content == f'RELEASE_CANONICAL_DIFF:{nonce}:{name}'), None)
        if file is None:
            return invalid
        read_id = f'fc_canonical_{file}_read_{nonce}'
        write_id = f'fc_canonical_{file}_write_{nonce}'
        outputs = [item for item in items[user_index + 1:]
                   if isinstance(item, dict) and item.get('type') == 'function_call_output']
        if any(item.get('call_id') not in {read_id, write_id} for item in outputs):
            return invalid
        read = [item for item in outputs if item.get('call_id') == read_id]
        wrote = [item for item in outputs if item.get('call_id') == write_id]
        if len(read) > 1 or len(wrote) > 1 or (wrote and not read):
            return invalid
        calls = [item for item in items[user_index + 1:] if isinstance(item, dict)
                 and item.get('type') == 'function_call']
        if len(calls) != len(outputs):
            return invalid
        tail = items[user_index + 1:]
        expected_tail = [(kind, call_id) for call_id in
                         ([read_id, write_id] if wrote else [read_id] if read else [])
                         for kind in ('function_call', 'function_call_output')]
        if (len(tail) != len(expected_tail) or any(
                not isinstance(item, dict) or (item.get('type'), item.get('call_id')) != expected
                for item, expected in zip(tail, expected_tail))):
            return invalid
        path = self.run_dir / f'project/{file}.txt'
        for item in outputs:
            paired = [call for call in calls if call.get('call_id') == item.get('call_id')]
            if len(paired) != 1 or items.index(paired[0]) >= items.index(item):
                return invalid
            call = paired[0]
            reading = item.get('call_id') == read_id
            expected_args = {'file_path': str(path)} if reading else {
                'file_path': str(path), 'content': canonical_diff_content(file)}
            try:
                arguments = json.loads(call.get('arguments', ''))
            except (ValueError, TypeError):
                return invalid
            if call.get('name') != ('Read' if reading else 'Write') or arguments != expected_args:
                return invalid
            output = item.get('output')
            if not isinstance(output, str) or not output.strip() or re.search(
                r'(?i)(?:^|\n)\s*(?:error:|permission denied|tool use rejected)', output):
                return invalid
        if read and f'{file} before' not in read[0]['output']:
            return invalid
        if wrote:
            if 'successfully' not in wrote[0]['output'] or f'{file}.txt' not in wrote[0]['output']:
                return invalid
            return f'canonical-{file}-completed', sse_completed(f'RELEASE_CANONICAL_{file.upper()}_DONE:{nonce}')
        if read:
            return f'canonical-{file}-write', sse_function_call(write_id, 'Write', {
                'file_path': str(path),
            'content': canonical_diff_content(file),
            })
        return f'canonical-{file}-read', sse_function_call(read_id, 'Read', {'file_path': str(path)})

    def response_for(self, body):
        current_request = {
            'method': 'POST',
            'path': '/v1/responses',
            'body': body,
        }
        if not is_main_response_request(current_request):
            return 'title', sse_completed('{"title":"Release validation"}')
        if self.label == 'terminal-canonical-diff':
            return self.canonical_diff_response(body)
        if self.label == 'retained-turn-end-load':
            self.turn_waiting.set()
            if not self.turn_release.wait(90):
                return 'retained-timeout', sse_incomplete('G5 harness release not observed')
            return 'retained-readiness', sse_completed('RELEASE_RETAINED_RESPONSE')
        if self.label == 'retained-readiness':
            return 'retained-readiness', sse_completed('RELEASE_RETAINED_RESPONSE')
        if self.label in LIFECYCLE_MOCK_KINDS:
            return self.lifecycle_response(body)
        if self.label == 'agent-fg-bg':
            items = body.get('input', [])
            outputs = {
                item.get('call_id'): item.get('output')
                for item in items if isinstance(item, dict)
                and item.get('type') == 'function_call_output'
            }
            users = [
                item for item in items
                if isinstance(item, dict) and item.get('role') == 'user'
            ]
            child = any(
                'RELEASE_FGBG_CHILD_REQUEST' in json.dumps(item.get('content'))
                for item in users
            )
            if child:
                if 'fc_release_fgbg_read' in outputs:
                    self.agent_fgbg_child_waiting.set()
                    if not self.agent_fgbg_release.wait(timeout=120):
                        return 'agent-fg-bg-child-timeout', sse_incomplete(
                            'foreground/background fixture was not released'
                        )
                    return 'agent-fg-bg-child-completed', sse_completed(
                        'VERSION := release-validation\nRELEASE_FGBG_CHILD_DONE'
                    )
                return 'agent-fg-bg-read-call', sse_function_call(
                    'fc_release_fgbg_read', 'Read',
                    {'file_path': str(Path(__file__).resolve().parents[4] / 'Makefile')},
                )
            if 'fc_release_fgbg_agent' in outputs:
                return 'agent-fg-bg-parent-completed', sse_completed(
                    'RELEASE_FGBG_PARENT_RESTORED'
                )
            return 'agent-fg-bg-agent-call', sse_function_call(
                'fc_release_fgbg_agent', 'Agent', {
                    'description': 'release foreground background',
                    'prompt': (
                        'RELEASE_FGBG_CHILD_REQUEST: Read Makefile and report its '
                        'VERSION line, then print RELEASE_FGBG_CHILD_DONE.'
                    ),
                    'subagent_type': 'release-foreground',
                    'run_in_background': False,
                },
            )
        if self.label in WORKFLOW_FAULT_SCRIPTS:
            items = body.get('input', [])
            outputs = {item.get('call_id'): item.get('output')
                       for item in items if isinstance(item, dict)
                       and item.get('type') == 'function_call_output'}
            users = []
            for item in items:
                if not isinstance(item, dict) or item.get('role') != 'user':
                    continue
                content = item.get('content', '')
                if isinstance(content, str):
                    users.append(content)
                else:
                    users.extend(block.get('text', '') for block in content if isinstance(block, dict))
            if 'fc_workflow_launch' in outputs:
                return 'workflow-parent-completed', sse_completed('RELEASE_WORKFLOW_PARENT_DONE')
            if any('Use Workflow with this exact inline script.' in text for text in users):
                if 'fc_workflow_search' not in outputs:
                    return 'workflow-search', sse_function_call(
                        'fc_workflow_search', 'ToolSearch', {'query': 'select:Workflow'})
                return 'workflow-launch', sse_function_call(
                    'fc_workflow_launch', 'Workflow', {'script': WORKFLOW_FAULT_SCRIPTS[self.label]})
            if self.label == 'workflow-retry-partial-failure':
                for worker in ('stable', 'transient'):
                    if any(text.strip() == f'Return exactly {worker}-worker-ok.' for text in users):
                        return f'workflow-{worker}-completed', sse_completed(f'{worker}-worker-ok')
            return 'workflow-unrecognized', sse_incomplete('Unrecognized workflow fixture request')
        if self.label == 'plugins-reload':
            phase = (self.run_dir / 'plugin-phase.txt').read_text().strip()
            outputs = {item.get('call_id'): item.get('output')
                       for item in body.get('input', []) if isinstance(item, dict)
                       and item.get('type') == 'function_call_output'}
            if phase == 'update':
                steps = [('update', 'Bash', {'command': shlex.join([
                    str(self.run_dir / 'plugin-update.sh')])})]
            else:
                version = 'v1' if phase == 'v1' else 'v2'
                names = [f'mcp__plugin_fixture_server__probe_{version}', 'mcp__retained__probe_other']
                steps = [('search', 'ToolSearch', {'query': 'select:' + ','.join(names)}),
                         ('plugin', names[0], {'phase': phase}),
                         ('other', names[1], {'phase': phase})]
                for name in ('version', 'standalone', 'removed-command', 'removed-skill'):
                    steps.append((name, 'Skill', {'skill': f'fixture:{name}'}))
            for step, name, arguments in steps:
                call_id = f'fc_plugins-{phase}-{step}'
                if call_id not in outputs:
                    return call_id.removeprefix('fc_'), sse_function_call(call_id, name, arguments)
            return f'plugins-{phase}-completed', sse_completed(f'Plugin probe {phase} complete.')
        if self.label == 'team-concurrency':
            items = body.get('input', [])
            worker = next((
                name
                for name in ('worker-a', 'worker-b', 'worker-c')
                if any(
                    isinstance(item, dict)
                    and item.get('role') == 'user'
                    and f'Reply exactly {name}.' in json.dumps(item.get('content'))
                    for item in items
                )
            ), None)
            if worker:
                return 'team-worker-completed', sse_completed(worker)
            outputs = {
                item.get('call_id'): item.get('output')
                for item in items
                if isinstance(item, dict)
                and item.get('type') == 'function_call_output'
            }
            if 'fc_team_create' not in outputs:
                return 'team-create', sse_function_call(
                    'fc_team_create',
                    'TeamCreate',
                    {'team_name': 'release-team-concurrency'},
                )
            worker_calls = [
                (
                    f'fc_team_worker_{suffix}',
                    'Agent',
                    {
                        'description': f'release team concurrency {name}',
                        'name': name,
                        'subagent_type': 'general-purpose',
                        'run_in_background': True,
                        'prompt': f'Reply exactly {name}. Do not use tools or modify files.',
                    },
                )
                for suffix, name in (
                    ('a', 'worker-a'),
                    ('b', 'worker-b'),
                    ('c', 'worker-c'),
                )
            ]
            if not all(call_id in outputs for call_id, _name, _arguments in worker_calls):
                return 'team-agents', sse_function_calls(worker_calls)
            return 'team-completed', sse_completed('RELEASE_TEAM_CONCURRENCY_DONE')
        if self.label in {'deferred-tool-discovery', 'deferred-tool-discovery-off'}:
            outputs = {item.get('call_id'): item.get('output')
                       for item in body.get('input', []) if isinstance(item, dict)
                       and item.get('type') == 'function_call_output'}
            if 'fc_deferred-search' not in outputs:
                return 'deferred-search', sse_function_call(
                    'fc_deferred-search', 'ToolSearch', {'query': 'select:Terminal,Workflow'})
            if self.label.endswith('-off'):
                if 'fc_deferred-workflow-off' not in outputs:
                    return 'deferred-workflow-off', sse_function_call(
                        'fc_deferred-workflow-off', 'ToolSearch', {'query': 'select:Workflow'})
                return 'deferred-completed', sse_completed('RELEASE_DEFERRED_DONE')
            if 'fc_deferred-open' not in outputs:
                return 'deferred-open', sse_function_call('fc_deferred-open', 'Terminal', {
                    'action': 'new-session', 'command': '/bin/sh',
                    'args': ['-c', 'stty -echo; exec cat'],
                    'cwd': str(self.run_dir), 'cols': 80, 'rows': 24,
                })
            try:
                opened = json.loads(outputs['fc_deferred-open'])
                target = opened['target']
                if not isinstance(target, str) or not target:
                    raise ValueError('missing terminal target')
            except (TypeError, ValueError, KeyError):
                return 'deferred-invalid-open', sse_incomplete('Terminal did not return a target')
            steps = [
                ('write', {'action': 'send-keys', 'text': 'RELEASE_TERMINAL_ROUNDTRIP', 'enter': True}),
                ('resize', {'action': 'resize-pane', 'cols': 91, 'rows': 31}),
                ('read', {'action': 'capture-pane', 'mode': 'full'}),
                ('status', {'action': 'display-message'}),
                ('signal', {'action': 'send-signal', 'signal': 'SIGINT'}),
                ('close', {'action': 'kill-pane', 'force': True}),
                ('closed-status', {'action': 'display-message'}),
            ]
            for step, arguments in steps:
                call_id = f'fc_deferred-{step}'
                if call_id not in outputs:
                    return call_id.removeprefix('fc_'), sse_function_call(
                        call_id, 'Terminal', {**arguments, 'target': target})
            if BinaryGate.deferred_terminal_notifications(body):
                return 'deferred-notification-ack', sse_completed('RELEASE_DEFERRED_NOTIFICATION_ACK')
            return 'deferred-completed', sse_completed('RELEASE_DEFERRED_DONE')
        if self.label == 'model-discovery-picker':
            users = [item for item in body.get('input', [])
                     if isinstance(item, dict) and item.get('role') == 'user']
            latest = json.dumps(users[-1].get('content')) if users else ''
            for case in ('EXPLICIT', 'DEFAULT'):
                if f'RELEASE_{case}_MODEL_REQUEST' in latest:
                    return 'model-mapping-completed', sse_completed(
                        f'RELEASE_{case}_MODEL_OK'
                    )
        if self.label == 'coordinator-selector':
            items = body.get('input', [])
            outputs = {
                item.get('call_id'): item.get('output')
                for item in items if isinstance(item, dict)
                and item.get('type') == 'function_call_output'
            }
            # Only user message content identifies the child, never the parent's
            # Agent arguments (which contain the same marker).
            child = any(
                isinstance(item, dict) and item.get('role') == 'user'
                and 'RELEASE_COORDINATOR_CHILD_REQUEST' in json.dumps(item.get('content'))
                for item in items
            )
            if 'fc_release_coordinator_agent' in outputs:
                return 'coordinator-parent-completed', sse_completed('RELEASE_COORDINATOR_PARENT_OK')
            if child:
                if 'fc_release_coordinator_read' in outputs:
                    self.coordinator_tools_done.set()
                    released = self.coordinator_release.wait(timeout=180)
                    if not released or self.coordinator_stopped.is_set():
                        return 'coordinator-cancelled', sse_incomplete('coordinator fixture released by cleanup or timed out')
                    return 'coordinator-child-completed', sse_completed('RELEASE_COORDINATOR_CHILD_OK')
                if 'fc_release_coordinator_bash' in outputs:
                    return 'coordinator-read-call', sse_function_call(
                        'fc_release_coordinator_read', 'Read',
                        {'file_path': str(Path(__file__).resolve().parents[4] / 'Makefile')},
                    )
                return 'coordinator-bash-call', sse_function_call(
                    'fc_release_coordinator_bash', 'Bash',
                    {'command': 'printf RELEASE_COORDINATOR_BASH_OK', 'description': 'Print coordinator validation marker'},
                )
            return 'coordinator-agent-call', sse_function_call(
                'fc_release_coordinator_agent', 'Agent',
                {
                    'description': 'release coordinator selector',
                    'prompt': 'RELEASE_COORDINATOR_CHILD_REQUEST: Run Bash then Read Makefile and report its VERSION line.',
                    'subagent_type': 'release-coordinator-foreground',
                    'run_in_background': False,
                },
            )
        if self.label == 'transcript-retention':
            items = body.get('input', [])
            outputs = {
                item.get('call_id'): item.get('output') for item in items
                if isinstance(item, dict) and item.get('type') == 'function_call_output'
            }
            user_texts = []
            for item in items:
                if not isinstance(item, dict) or item.get('role') != 'user':
                    continue
                content = item.get('content', '')
                if isinstance(content, str):
                    user_texts.append(content)
                elif isinstance(content, list):
                    user_texts.extend(part.get('text', '') for part in content if isinstance(part, dict))
            child = any('RELEASE_RETENTION_CHILD_REQUEST' in text for text in user_texts)
            if child:
                if 'fc_retention_approve' in outputs:
                    return 'retention-child-completed', sse_completed('RELEASE_RETENTION_SHUTDOWN_OK')
                # Mailbox JSON uses requestId; SendMessage's public schema uses request_id.
                for text in reversed(user_texts):
                    for match in re.finditer(r'\{', text):
                        try:
                            message, _ = json.JSONDecoder().raw_decode(text[match.start():])
                        except ValueError:
                            continue
                        if (isinstance(message, dict) and message.get('type') == 'shutdown_request'
                                and isinstance(message.get('requestId'), str) and message['requestId']
                                and message.get('from') == 'team-lead'):
                            return 'retention-approve-call', sse_function_call(
                                'fc_retention_approve', 'SendMessage',
                                {'to': 'team-lead', 'message': {'type': 'shutdown_response',
                                 'request_id': message['requestId'], 'approve': True}},
                            )
                if not any(text.strip() == 'RELEASE_RETENTION_RESUME' for text in user_texts):
                    self.retention_child_waiting.set()
                    self.retention_child_release.wait(timeout=180)
                    return 'retention-child-cancelled', sse_incomplete('retention initial turn released')
                return 'retention-worker-marker', sse_completed('RELEASE_RETENTION_WORKER_DONE')
            latest_user = next((text.strip() for text in reversed(user_texts)
                                if text.strip() and not re.fullmatch(
                                    r'<system-reminder>.*</system-reminder>', text.strip(), re.DOTALL)), '')
            probe = re.fullmatch(r'RELEASE_RETENTION_PROBE ([A-Za-z0-9_-]+) (before|after)', latest_user)
            if probe:
                task, phase = probe.groups()
                call_id = f'fc_retention_probe_{phase}'
                if call_id in outputs:
                    return f'retention-probe-{phase}-completed', sse_completed(
                        f'RELEASE_RETENTION_PROBE_{phase.upper()}_DONE')
                return f'retention-probe-{phase}-call', sse_function_call(
                    call_id, 'TaskOutput', {'task_id': task, 'block': False})
            if latest_user == 'RELEASE_RETENTION_GC_TICK':
                return 'retention-gc-tick', sse_completed('RELEASE_RETENTION_GC_TICK_DONE')
            if 'fc_retention_shutdown' in outputs:
                return 'retention-parent-completed', sse_completed('RELEASE_RETENTION_PARENT_OK')
            if 'fc_retention_agent' in outputs:
                self.retention_parent_waiting.set()
                if not self.retention_release.wait(timeout=180) or self.retention_stopped.is_set():
                    return 'retention-cancelled', sse_incomplete('retention fixture released by cleanup or timed out')
                return 'retention-shutdown-call', sse_function_call(
                    'fc_retention_shutdown', 'SendMessage',
                    {'to': 'retention-worker', 'message': {'type': 'shutdown_request'}},
                )
            if 'fc_retention_team' in outputs:
                return 'retention-agent-call', sse_function_call(
                    'fc_retention_agent', 'Agent',
                    {'description': 'release transcript retention worker', 'name': 'retention-worker',
                     'subagent_type': 'general-purpose', 'run_in_background': True,
                     'prompt': 'RELEASE_RETENTION_CHILD_REQUEST: Reply RELEASE_RETENTION_WORKER_DONE. Approve a subsequent shutdown request using its actual request ID.'},
                )
            return 'retention-team-call', sse_function_call(
                'fc_retention_team', 'TeamCreate', {'team_name': 'release-transcript-retention'},
            )
        main_responses = [
            request
            for request in self.snapshot()
            if is_main_response_request(request)
        ]
        if (
            self.label == 'model-internal-update-config-skill'
            and is_main_response_request(current_request)
            and len(main_responses) == 1
        ):
            return (
                'skill-call',
                sse_function_call(
                    'fc_release_update_config',
                    'Skill',
                    {'skill': 'update-config', 'args': 'set model to opus'},
                ),
            )
        if self.label == 'openai-responses-usage-error':
            if len(main_responses) == 1:
                return 'usage-completed', sse_completed(
                    'RELEASE_OPENAI_USAGE_OK',
                    usage={
                        'input_tokens': 100,
                        'output_tokens': 7,
                        'input_tokens_details': {
                            'cached_tokens': 60,
                            'cache_write_tokens': 15,
                        },
                    },
                )
            return (
                'response.incomplete',
                sse_incomplete('RELEASE_OPENAI_INCOMPLETE_REASON'),
            )
        if self.label == 'subagent-stop-failure-lifecycle':
            if len(main_responses) == 1:
                return (
                    'agent-call',
                    sse_function_call(
                        'fc_release_subagent_stop',
                        'Agent',
                        {
                            'description': 'Trigger stop fallback',
                            'prompt': (
                                'This release validation request is expected to fail. '
                                'Do not call tools.'
                            ),
                            'subagent_type': 'release-stop-foreground',
                            'run_in_background': False,
                        },
                    ),
                )
            return 'parent-completed', sse_completed(
                'RELEASE_SUBAGENT_STOP_PARENT_OK'
            )
        if self.label == 'openai-remote-compaction':
            input_items = body.get('input')
            if (
                isinstance(input_items, list)
                and input_items
                and isinstance(input_items[-1], dict)
                and input_items[-1].get('type') == 'compaction_trigger'
            ):
                compact_count = sum(
                    request.get('response_kind') == 'compaction'
                    for request in main_responses
                )
                return (
                    'compaction',
                    sse_compaction(
                        f'cmp_release_{compact_count}',
                        f'release-opaque-state-{compact_count}',
                    ),
                )
            return 'completed', sse_completed(
                'RELEASE_COMPACTION_SEED_OK'
                if len(main_responses) == 1
                else 'RELEASE_COMPACTION_CONTINUATION_OK'
            )
        if self.label == 'openai-image-input-wire':
            if len(main_responses) == 1:
                return (
                    'read-call',
                    sse_function_call(
                        'fc_release_read_image',
                        'Read',
                        {'file_path': str(self.run_dir / 'fixture.png')},
                    ),
                )
            return 'completed', sse_completed('RELEASE_OPENAI_IMAGE_WIRE_OK')
        marker = {
            'effort-openai-responses-wire': 'RELEASE_EFFORT_WIRE_OK',
            'fast-openai-responses-wire': 'RELEASE_FAST_WIRE_OK',
            'model-internal-update-config-skill': 'RELEASE_UPDATE_CONFIG_SKILL_OK',
            'prompt-modes-cache-prefix': 'RELEASE_PROMPT_CACHE_OK',
        }.get(self.label, 'RELEASE_MOCK_OK')
        reasoning = (
            'Release validation reasoning marker.'
            if self.label == 'effort-openai-responses-wire'
            else None
        )
        return 'completed', sse_completed(marker, reasoning=reasoning)

    def stop(self):
        if self.label == 'transcript-retention':
            self.retention_stopped.set()
            self.retention_release.set()
            self.retention_child_release.set()
        if self.label == 'coordinator-selector':
            self.coordinator_stopped.set()
            self.coordinator_release.set()
        if self.label == 'agent-fg-bg':
            self.agent_fgbg_release.set()
        if self.server is None:
            self.stop_result = {'stopped': True, 'thread_alive': False, 'active_handlers': []}
            return self.stop_result
        self.server.shutdown()
        self.server.server_close()
        if self.thread is not None:
            self.thread.join(timeout=5)
        alive = bool(self.thread and self.thread.is_alive())
        deadline = time.monotonic() + 5
        with self.lock:
            handlers = list(self.request_handlers)
        for handler in handlers:
            handler.join(timeout=max(0, deadline - time.monotonic()))
        with self.lock:
            active_handlers = [handler.name for handler in self.request_handlers if handler.is_alive()]
        self.flush()
        self.stop_result = {'stopped': not alive and not active_handlers,
                            'thread_alive': alive, 'active_handlers': active_handlers}
        return self.stop_result


def custom_prompt_instructions_stable(bodies):
    if len(bodies) != 2:
        return False
    instructions = [body.get('instructions') for body in bodies]
    return (
        all(isinstance(value, str) for value in instructions)
        and instructions[0] == instructions[1]
        and all(
            value.count(CUSTOM_SYSTEM_PROMPT_MARKER) == 1
            for value in instructions
        )
    )


def analyze_openai_wire_debug(debug_text, requests):
    # Compare product diagnostics with captured HTTP bodies; never synthesize logs.
    marker = '[OpenAI Compat] Wire prefix '
    pattern = re.compile(
        r'kind=(create|compact) instructions=([0-9a-f]{16})/(\d+)B '
        r'tools=([0-9a-f]{16})/(\d+)B/(\d+) '
        r'input=([0-9a-f]{16})/(\d+)B/(\d+) '
        r'commonPrefixItems=(\d+) appendOnly=(true|false)'
    )
    requests = [request for request in requests
                if isinstance(request.get('body'), dict)
                and isinstance(request['body'].get('input'), list)]
    lines = debug_text.splitlines()
    diagnostics = [(index, line.split(marker, 1)[1])
                   for index, line in enumerate(lines) if marker in line]
    checks = []
    previous = {}
    hashes = {}
    crossed_client = False
    kinds = []
    cache_keys = []
    pairing_shapes = set()
    ambiguous_pairing = False
    for (line_index, text), request in zip(diagnostics, requests):
        match = pattern.fullmatch(text)
        body = request.get('body', {})
        kind = 'compact' if request.get('response_kind') == 'compaction' else 'create'
        main_request = body.get('instructions') != TITLE_GENERATION_INSTRUCTION
        if main_request:
            kinds.append(kind)
        cache_keys.append(body.get('prompt_cache_key'))
        if not match or not isinstance(body.get('input'), list):
            checks.append(False)
            continue
        logged_kind, ih, ib, th, tb, tc, nh, nb, nc, prefix, append = match.groups()
        items = body['input']
        # Serial fixtures permit ordered pairing only when the logged shape is
        # unique. Digests cannot identify a body independently here.
        shape = (logged_kind, ib, tb, tc, nb, nc)
        ambiguous_pairing |= shape in pairing_shapes
        pairing_shapes.add(shape)
        scope = (request.get('headers', {}).get('thread-id')
                 or body.get('prompt_cache_key') or request.get('path'))
        prior = previous.get((scope, kind))
        common = 0
        if prior:
            for left, right in zip(prior[0], items):
                if left != right:
                    break
                common += 1
        expected_append = prior is not None and common == len(prior[0])
        checks.append(logged_kind == kind and int(prefix) == common
                      and (append == 'true') == expected_append
                      and int(nc) == len(items)
                      and int(tc) == len(body.get('tools', [])))
        values = (body.get('instructions', ''), body.get('tools', []), items)
        for field, value, digest, size in zip(
            ('instructions', 'tools', 'input'), values, (ih, th, nh), (ib, tb, nb)
        ):
            serialized = value if field == 'instructions' else json.dumps(
                value, ensure_ascii=False, separators=(',', ':')
            )
            checks.append(int(size) == len(serialized.encode('utf-8')))
            key = (field, serialized)
            checks.append(key not in hashes or hashes[key] == digest)
            hashes[key] = digest
        if main_request and prior and prior[2] and kind == 'create' and common > 0 and expected_append:
            crossed_client |= any(
                '[OpenAI Compat] SSE client → ' in line
                for line in lines[prior[1] + 1:line_index]
            )
        previous[(scope, kind)] = (items, line_index, main_request)
    return {
        'pairing_error': 'ambiguous wire shapes; ordered pairing refused' if ambiguous_pairing else None,
        'matched': not ambiguous_pairing and bool(requests) and len(diagnostics) == len(requests)
        and len(checks) > 0 and all(checks)
        and all(cache_keys)
        and 'Wire prefix analysis failed:' not in debug_text,
        'cross_client_append_only': not ambiguous_pairing and crossed_client,
        'create_compact_isolated': not ambiguous_pairing and kinds.count('create') >= 2
        and kinds.count('compact') >= 2 and bool(checks) and all(checks),
        'diagnostic_count': len(diagnostics),
    }


def openai_request_metadata_matches(headers, cache_key):
    return (
        bool(cache_key)
        and headers.get('session-id') == cache_key
        and headers.get('thread-id') == cache_key
        and bool(headers.get('x-client-request-id'))
        and headers.get('x-app') == 'cli'
        and headers.get('x-claude-code-session-id') == cache_key
        and bool(headers.get('user-agent'))
    )


def is_external_source_failure(message):
    normalized = message.casefold()
    if any(marker in normalized for marker in (
        'permission denied',
        'not permitted',
        'policy denied',
        'tool crashed',
        'webfetch crashed',
        'internal server error',
        'internal error',
        'validation error',
        'invalid input',
    )):
        return False
    status = re.search(
        r'\b(?:http(?: response)?(?: status)?|status code)\D{0,12}(\d{3})\b',
        normalized,
    )
    if status:
        return int(status.group(1)) in {401, 403, 404, 410, 423, 429, 451}
    return any(marker in normalized for marker in (
        'paywall',
        'robots.txt',
        'source unavailable',
        'content unavailable',
        'site unavailable',
        'website unavailable',
        'blocked by the site',
        'blocked by robots',
        'connection refused',
        'connection reset',
        'timed out while fetching',
        'timeout of ',
        'dns lookup failed',
        'enotfound',
    ))


class OpenAIStatsServer:
    """Local TLS terminating fixture; never forwards or resolves upstream hosts."""
    activity_path = '/backend-api/wham/profiles/me'
    token = 'release-validation-dummy-oauth'

    def __init__(self, run_dir, home):
        self.run_dir = run_dir
        self.tls_dir = home / 'stats-tls'
        self.tls_dir.mkdir(mode=0o700)
        self.requests = []
        (run_dir / 'openai-stats-http.json').write_text('[]\n')
        self.lock = threading.Lock()
        self.fail = False
        self.server = None
        self.thread = None
        self.ca = self.tls_dir / 'ca.pem'

    def start(self):
        config = self.tls_dir / 'openssl.cnf'
        config.write_text('[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n'
                          '[dn]\nCN=release-validation-local\n[ext]\n'
                          'basicConstraints=critical,CA:TRUE\n'
                          'subjectAltName=DNS:localhost,DNS:chatgpt.com,IP:127.0.0.1\n')
        key = self.tls_dir / 'key.pem'
        try:
            command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                     '-days', '1', '-config', str(config), '-keyout', str(key),
                     '-out', str(self.ca)], check=True)
            key.chmod(0o600)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(self.ca, key)
            fixture = self

            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *_args):
                    pass

                def do_CONNECT(self):
                    if self.path != 'chatgpt.com:443':
                        self.respond(403, {}, False, 'rejected-connect')
                        return
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.flush()
                    self.close_connection = True
                    # SSLSocket cannot wrap another SSLSocket (it would bypass
                    # outer TLS). Relay only to an in-process socketpair, never upstream.
                    relay, endpoint = socket.socketpair()
                    def serve_inner():
                        try:
                            with context.wrap_socket(endpoint, server_side=True) as inner:
                                Handler(inner, self.client_address, self.server)
                        except (ssl.SSLError, OSError):
                            endpoint.close()
                    worker = threading.Thread(target=serve_inner, daemon=True)
                    worker.start()
                    try:
                        while True:
                            readable, _, _ = select.select([self.connection, relay], [], [], 5)
                            if not readable:
                                break
                            for source in readable:
                                data = source.recv(65536)
                                if not data:
                                    return
                                (relay if source is self.connection else self.connection).sendall(data)
                    except (ssl.SSLError, OSError):
                        pass
                    finally:
                        relay.close()
                        worker.join(timeout=5)

                def respond(self, status, body, auth, route):
                    with fixture.lock:
                        fixture.requests.append({'method': self.command, 'route': route,
                                                 'status': status, 'matches_dummy': auth})
                        (fixture.run_dir / 'openai-stats-http.json').write_text(
                            json.dumps(fixture.requests, indent=2) + '\n')
                    payload = json.dumps(body).encode()
                    self.send_response(status)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)

                def do_GET(self):
                    url = urlsplit(self.path)
                    valid_host = not url.fragment and ((url.scheme == 'https' and url.netloc == 'chatgpt.com') or (
                        not url.scheme and not url.netloc and self.headers.get('Host') in
                        ('chatgpt.com', 'chatgpt.com:443')))
                    auth = self.headers.get('Authorization') == f'Bearer {fixture.token}'
                    if not valid_host or not auth:
                        self.respond(403, {}, auth, 'rejected')
                    elif url.path == fixture.activity_path and not url.query:
                        self.respond(503 if fixture.fail else 200,
                                     {} if fixture.fail else {'stats': {
                                         'lifetime_tokens': 42, 'daily_usage_buckets': []}},
                                     auth, 'activity')
                    elif url.path == '/backend-api/wham/usage' and not url.query:
                        self.respond(200, {'plan_type': 'plus'}, auth, 'usage')
                    elif url.path == '/backend-api/codex/models':
                        self.respond(200, {'models': []}, auth, 'models')
                    else:
                        self.respond(403, {}, auth, 'rejected')

                def do_POST(self):
                    self.respond(403, {}, False, 'rejected')

            class Server(ThreadingHTTPServer):
                def get_request(self):
                    connection, address = super().get_request()
                    connection.settimeout(5)
                    try:
                        connection = context.wrap_socket(connection, server_side=True)
                    except ssl.SSLError:
                        connection.close()
                        raise
                    return connection, address

            self.server = Server(('127.0.0.1', 0), Handler)
            self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
            self.thread.start()
            return f'https://127.0.0.1:{self.server.server_port}'
        except BaseException:
            self.stop()
            raise

    def snapshot(self):
        with self.lock:
            return list(self.requests)

    def stop(self):
        if self.server is not None:
            if self.thread is not None and self.thread.is_alive():
                self.server.shutdown()
                self.thread.join(timeout=5)
            self.server.server_close()
            self.server = None
        if self.tls_dir.exists():
            shutil.rmtree(self.tls_dir)
        return {'stopped': True, 'tls_removed': not self.tls_dir.exists()}


class BinaryGate:
    def __init__(self, repo, evidence_root, auth_source, baseline_path, *, base_ref=None):
        self.repo = repo.resolve()
        self.evidence_root = evidence_root.resolve()
        self.lease_file = None
        self.lease_path = None
        self.lease_metadata = None
        self.auth_source = auth_source.expanduser().resolve()
        self.baseline_path = baseline_path.resolve()
        if is_relative_to(self.evidence_root, self.repo):
            raise RuntimeError('--evidence-root must be outside the repository')
        if is_relative_to(self.auth_source, self.evidence_root):
            raise RuntimeError('--auth-source must be outside the evidence root')
        if is_relative_to(self.auth_source, self.repo):
            raise RuntimeError('--auth-source must be outside the repository')
        self.launcher = (
            self.repo
            / '.claude/skills/claude-agent-workflow-validation/scripts/launch-built-claude.sh'
        )
        self.binary = self.repo / 'built-claude'
        self.stamp = time.strftime('%Y%m%dT%H%M%S')
        self.pid = os.getpid()
        self.session_index = 0
        self.active_runs = {}
        self.terminal_capture = None
        self.code_review_mock_servers = {}
        self.registered_runs = {}
        self.auth_homes = set()
        self.mock_servers = {}
        self.cleanup_started = False
        self.workflow_task_ids = set()
        self.workflow_run_ids = set()
        self.workflow_runs = self.repo / '.claude' / 'workflow-runs'
        self.workflow_runs_initial_manifest = tree_manifest(self.workflow_runs)
        self.baseline = json.loads(self.baseline_path.read_text())
        current_state = self.repository_state()
        if self.baseline.get('repo') != str(self.repo):
            raise RuntimeError('baseline repository does not match --repo')
        for key in (
            'head',
            'branch',
            'status_porcelain',
            'unstaged_diff_sha256',
            'staged_diff_sha256',
            'untracked_files_sha256',
            'ignored_files_excluded_roots',
            'ignored_files_sha256',
            'binary',
        ):
            if self.baseline.get(key) != current_state[key]:
                raise RuntimeError(
                    f'baseline {key} does not match current repository state'
                )
        required_target_inputs = collect_required_target_inputs(
            self.repo,
            self.baseline,
            explicit_base_ref=base_ref,
        )
        self.manifest = {
            'started': time.time(),
            'repo': str(self.repo),
            'head': current_state['head'],
            'branch': current_state['branch'],
            'git_status_start': current_state['status_porcelain'],
            'repository_state_start': current_state,
            'baseline': str(self.baseline_path),
            'baseline_captured_at': self.baseline.get('captured_at'),
            'binary': str(self.binary),
            'binary_sha256': current_state['binary']['sha256'],
            'driver_sha256': sha256(Path(__file__).resolve()),
            'required_target_inputs': required_target_inputs,
            'required_targets': sorted(
                required_targets_for_paths(required_target_inputs['all_paths'])
            ),
            'runs': [],
        }
        atexit.register(self.remove_auth_homes)
        for signum in (signal.SIGINT, signal.SIGTERM):
            signal.signal(signum, self.handle_signal)

    def acquire_lease(self):
        self.repo = self.repo.resolve()
        repo_key = hashlib.sha256(str(self.repo).encode()).hexdigest()
        self.lease_path = Path(tempfile.gettempdir()) / f'claude-release-gate-{repo_key}.lock'
        self.lease_file = self.lease_path.open('a+')
        try:
            fcntl.flock(self.lease_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lease_file.seek(0)
            owner = self.lease_file.read()
            self.lease_file.close()
            self.lease_file = None
            raise RuntimeError(f'release binary gate is already running for {self.repo}: {owner}')
        try:
            self.lease_metadata = {
                'pid': self.pid,
                'started': time.time(),
                'repo': str(self.repo),
                'binary': str(self.binary),
                'evidence_root': str(self.evidence_root),
            }
            self.lease_file.seek(0)
            self.lease_file.truncate()
            self.lease_file.write(json.dumps(self.lease_metadata) + '\n')
            self.lease_file.flush()
            self.manifest['ownership_lease'] = {
                'path': str(self.lease_path),
                'metadata': self.lease_metadata,
            }
        except BaseException:
            self.release_lease()
            raise

    def release_lease(self):
        previous = getattr(self, 'lease_release', None)
        if previous is not None:
            return previous
        if getattr(self, 'lease_file', None) is None:
            lease_path = getattr(self, 'lease_path', None)
            result = {'released': False, 'path': str(lease_path) if lease_path else None}
            self.lease_release = result
            return result
        try:
            fcntl.flock(self.lease_file.fileno(), fcntl.LOCK_UN)
            result = {'released': True, 'path': str(self.lease_path)}
        finally:
            self.lease_file.close()
            self.lease_file = None
        self.lease_release = result
        return result

    def git(self, *args):
        return command(['git', '-C', str(self.repo), *args], check=True).stdout

    def workflow_runs_state(self):
        manifest = tree_manifest(self.workflow_runs)
        baseline_manifest = self.workflow_runs_initial_manifest
        added_paths = sorted(set(manifest) - set(baseline_manifest))
        modified_paths = sorted(
            path
            for path in set(manifest) & set(baseline_manifest)
            if manifest[path] != baseline_manifest[path]
        )
        removed_paths = sorted(set(baseline_manifest) - set(manifest))
        return {
            'exists': self.workflow_runs.is_dir(),
            'manifest': manifest,
            'sha256': tree_sha256(manifest),
            'added_paths': added_paths,
            'modified_paths': modified_paths,
            'removed_paths': removed_paths,
        }

    def workflow_run_ownership(self):
        return {
            'task_ids': sorted(self.workflow_task_ids),
            'run_ids': sorted(self.workflow_run_ids),
        }

    def archive_and_remove_workflow_runs(self):
        state = self.workflow_runs_state()
        ownership = self.workflow_run_ownership()
        task_paths = {f'{task_id}.json' for task_id in ownership['task_ids']}

        def is_owned(path):
            return path in task_paths or any(
                path == run_id or path.startswith(f'{run_id}/')
                for run_id in ownership['run_ids']
            )

        owned_paths = [path for path in state['added_paths'] if is_owned(path)]
        unowned_paths = [path for path in state['added_paths'] if not is_owned(path)]
        archive_root = self.evidence_root / 'workflow-runs-artifacts'
        archive_errors = []
        for relative in owned_paths:
            source = self.workflow_runs / relative
            target = archive_root / relative
            try:
                if source.is_symlink():
                    raise RuntimeError('symlink artifact is not allowed')
                if source.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                elif source.is_file():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, target)
                else:
                    raise RuntimeError('artifact disappeared before archive')
            except OSError as error:
                archive_errors.append({'path': relative, 'error': repr(error)})
            except RuntimeError as error:
                archive_errors.append({'path': relative, 'error': str(error)})

        added_paths = set(state['added_paths'])
        cleanup_roots = sorted(
            {path for path in task_paths if path in added_paths}
            | {run_id for run_id in ownership['run_ids'] if run_id in added_paths}
        )
        cleanup_errors = []
        if not archive_errors:
            for relative in cleanup_roots:
                path = self.workflow_runs / relative
                try:
                    if path.is_dir() and not path.is_symlink():
                        shutil.rmtree(path)
                    else:
                        path.unlink(missing_ok=True)
                except OSError as error:
                    cleanup_errors.append({'path': relative, 'error': repr(error)})

        after = self.workflow_runs_state()
        owned_paths_remaining = [
            path
            for path in after['manifest']
            if any(
                path == root or path.startswith(f'{root}/')
                for root in cleanup_roots
            )
        ]
        passed = (
            not archive_errors
            and not cleanup_errors
            and not owned_paths_remaining
        )
        return {
            'passed': passed,
            'ownership': ownership,
            'state_before_cleanup': state,
            'owned_added_paths': owned_paths,
            'cleanup_roots': cleanup_roots,
            'external_paths_ignored': unowned_paths,
            'owned_paths_remaining': owned_paths_remaining,
            'archive_root': str(archive_root),
            'archive_manifest': tree_manifest(archive_root),
            'archive_errors': archive_errors,
            'cleanup_errors': cleanup_errors,
            'state_after_cleanup': after,
        }

    def repository_state(self):
        binary = {
            'path': str(self.binary),
            'exists': self.binary.is_file(),
            'size': self.binary.stat().st_size if self.binary.is_file() else None,
            'sha256': sha256(self.binary) if self.binary.is_file() else None,
        }
        untracked_files_manifest = untracked_manifest(self.repo)
        ignored_files_manifest = ignored_manifest(self.repo)
        return {
            'head': self.git('rev-parse', 'HEAD').strip(),
            'branch': self.git('branch', '--show-current').strip(),
            'status_porcelain': self.git('status', '--short'),
            'unstaged_diff_sha256': text_sha256(self.git('diff', '--binary')),
            'staged_diff_sha256': text_sha256(
                self.git('diff', '--cached', '--binary')
            ),
            'untracked_files_manifest': untracked_files_manifest,
            'untracked_files_sha256': tree_sha256(untracked_files_manifest),
            'ignored_files_excluded_roots': list(IGNORED_FILES_EXCLUDED_ROOTS),
            'ignored_files_manifest': ignored_files_manifest,
            'ignored_files_sha256': tree_sha256(ignored_files_manifest),
            'binary': binary,
        }

    def tmux(self, *args, check=False, timeout=30):
        capture = getattr(self, 'terminal_capture', None)
        if capture is None:
            return command(['tmux', *args], check=check, timeout=timeout)
        run = Path(capture['run'])
        before = self.terminal_capture_boundary(run)
        kind = args[0]
        action = None
        if kind == 'send-keys':
            keys = {'Enter': b'\r', 'Escape': b'\x1b', 'C-c': b'\x03',
                    'Tab': b'\t', 'Down': b'\x1b[B', 'Up': b'\x1b[A'}
            rest = list(args[args.index('-t') + 2:])
            data = (''.join(rest[1:]).encode() if rest[:1] == ['-l'] else
                    b''.join(keys[key] for key in rest))
            action = self.terminal_input_begin(run, {
                'transport': 'tmux-send-keys', 'args': list(args),
                'hex': data.hex(), 'target': capture['target'],
            })
        elif kind == 'resize-window':
            rows = self.terminal_jsonl(run / 'geometry.jsonl')
            action = sum(row.get('phase') == 'resize-send' for row in rows) + 1
            geometry = {
                'actionId': action, 'columns': int(args[args.index('-x') + 1]),
                'rows': int(args[args.index('-y') + 1]),
                'actualArgs': list(args), 'target': capture['target'],
            }
        if kind == 'resize-window':
            sent = {**geometry, 'phase': 'resize-send', **before}
            native = capture.get('capture', {}).get('nativeJournal') is True
            if native:
                sent['nativeDriverClock'] = _driver_clock.read_native_driver_clock(capture)
            result = execution_error = clock_error = returned_clock = None
            try:
                result = command(['tmux', '-S', capture['socket'], *args], check=False, timeout=timeout)
            except BaseException as error:
                execution_error = error
            try:
                if native:
                    returned_clock = _driver_clock.read_native_driver_clock(capture)
            except Exception as error:
                clock_error = error
            # Samples precede publication; an observation failure never replaces
            # the original command failure or invents an exit status.
            try:
                self.terminal_append(run / 'geometry.jsonl', sent)
                self.terminal_append(run / 'geometry.jsonl', {
                    **geometry, 'phase': 'resize-return',
                    'exitCode': result.returncode if result is not None else None,
                    **self.terminal_capture_boundary(run),
                    **({'nativeDriverClock': returned_clock} if returned_clock else {}),
                    **({'commandError': type(execution_error).__name__} if execution_error else {}),
                    **({'clockError': str(clock_error)} if clock_error else {}),
                })
            except Exception as publication_error:
                if execution_error is None and clock_error is None:
                    raise
                try:
                    print(json.dumps({'phase':'resize-evidence-publication-failed',
                        'captureId':capture.get('capture',{}).get('captureId'),'actionId':action,
                        'errno':getattr(publication_error,'errno',None),
                        'errorType':type(publication_error).__name__}),file=sys.stderr)
                except Exception:
                    pass  # Preserve the original failure even when diagnostics are unavailable.
                raise execution_error if execution_error is not None else clock_error
            if execution_error:
                raise execution_error
            if clock_error:
                raise clock_error
        else:
            result = command(['tmux', '-S', capture['socket'], *args], check=False, timeout=timeout)
        if kind == 'send-keys':
            self.terminal_append(run / 'inputs.jsonl', {
                'actionId': action, 'phase': 'sent' if result.returncode == 0 else 'failed',
                'exitCodes': [result.returncode], **self.terminal_capture_boundary(run),
            })
        elif kind == 'capture-pane':
            self.terminal_append(run / 'observations.jsonl', {
                'args': list(args), 'exitCode': result.returncode,
                'textSHA256': text_sha256(result.stdout), **before,
            })
        if check and result.returncode:
            raise RuntimeError(f'owned tmux {args!r}: {result.stderr}')
        return result

    @staticmethod
    def terminal_jsonl(path):
        if not path.exists():
            return []
        text = path.read_text()
        lines = text.split('\n')
        if not text.endswith('\n'):
            lines.pop()
        return [json.loads(line) for line in lines if line]

    @staticmethod
    def terminal_append(path, row):
        with path.open('a') as stream:
            stream.write(json.dumps(row) + '\n')

    def terminal_capture_boundary(self, run):
        frames = self.terminal_jsonl(run / 'frames.jsonl')
        io = self.terminal_jsonl(run / 'pty-io.jsonl')
        return {
            'lastObservedFrameId': frames[-1]['frameId'] if frames else None,
            'lastObservedIoId': io[-1]['ioId'] if io else None,
            'observedRawBytes': (run / 'pty.raw').stat().st_size,
        }

    def terminal_input_begin(self, run, row):
        action = sum(value.get('phase') == 'send'
                     for value in self.terminal_jsonl(run / 'inputs.jsonl')) + 1
        self.terminal_append(run / 'inputs.jsonl', {
            **row, 'actionId': action, 'phase': 'send',
            'chunkClaim': 'one transport command; native read grouping unknown',
            **self.terminal_capture_boundary(run),
        })
        return action

    def terminal_capture_command(self, action, descriptor):
        result = command([
            'bun', str(self.repo / 'scripts/terminal-capture-driver.mjs'),
            action, str(descriptor),
        ], timeout=90)
        run = descriptor.parent
        (run / f'capture-{action}-stdout.txt').write_text(result.stdout)
        (run / f'capture-{action}-stderr.txt').write_text(result.stderr)
        return result

    def capture(self, target, path, *, history=True):
        args = ['capture-pane', '-p', '-e', '-J']
        if history:
            args.extend(['-S', '-'])
        args.extend(['-t', target])
        result = self.tmux(*args)
        path.write_text(result.stdout)
        return result.stdout

    def wait_until(self, predicate, timeout, interval=0.5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(interval)
        return False

    def pane_exists(self, target):
        result = self.tmux(
            'display-message', '-p', '-t', target,
            '#{pane_pid} #{pane_current_command} #{pane_dead}',
        )
        return result.returncode == 0, result.stdout.strip(), result.stderr.strip()

    def make_ssh_transport_fixture(self, run_dir):
        bin_dir = run_dir / 'fake-ssh-bin'
        bin_dir.mkdir()
        io_path = run_dir / 'fake-ssh-io.jsonl'
        fixture = {**SSH_LIFECYCLE_IDS, 'bin_dir': str(bin_dir), 'io_path': str(io_path)}
        # The gate owns this executable and prepends only this per-run directory to
        # PATH. No product setting or user-facing executable override is introduced.
        executable = bin_dir / 'ssh'
        remote_version = repr(str(self.baseline['makefile_version']))
        executable.write_text('''#!/usr/bin/env python3
import atexit, json, os, re, signal, sys
io = os.environ["CC_VALIDATION_SSH_IO"]
def redact(value):
    if not isinstance(value, str): return value
    normalized = value.replace("\\\\=", "=")
    return re.sub(r"(CLAUDE_CODE_(?:SSH_REMOTE_TOKEN|SSH_PERMISSION_BOOTSTRAP|OAUTH_TOKEN)=)[^ ]+", r"\\1[REDACTED]", normalized)
def event(name, **extra):
    safe = {key: [redact(item) for item in value] if isinstance(value, list) else redact(value) for key, value in extra.items()}
    with open(io, "a") as stream:
        stream.write(json.dumps({"event": name, **safe}, sort_keys=True) + "\\n")
def exit_on_signal(_signum, _frame):
    atexit.unregister(event)
    event("remote-process-exit")
    os._exit(0)
args = sys.argv[1:]
command = args[-1] if args else ""
remote_process = False
event("ssh-invocation", args=args)
if len(args) == 6 and args[0] == "-S" and args[2:5] == ["-O", "exit", "--"]:
    if args[5] != "release-ssh-host":
        event("invalid-invocation", reason="unexpected host")
        sys.exit(64)
    event("control-master-stop", host=args[5], control_path=args[1])
elif "--" not in args:
    event("invalid-invocation", reason="missing host separator")
    sys.exit(64)
else:
    separator = args.index("--")
    if separator + 3 != len(args) or args[separator + 1] != "release-ssh-host":
        event("invalid-invocation", reason="unexpected host or command count")
        sys.exit(64)
    host = args[separator + 1]
    if command.startswith("set -eu;") and "$(uname -s)" in command:
        print("Linux\\nx86_64\\n/release-home\\n/release-work")
    elif command.startswith("test -x ") and command.endswith(" --version"):
        print(__REMOTE_VERSION__)
    elif command.startswith("mkdir -m 700 -- "):
        event("socket-directory-prepared", host=host)
    elif command.startswith("rm -rf -- "):
        event("cleanup-command", host=host)
    elif command.startswith("set -eu; trap ") and " --input-format stream-json " in command:
        remote_process = True
        event("remote-process-start", host=host, session_id="release-ssh-session-0001")
    else:
        event("invalid-invocation", reason="unexpected remote command")
        sys.exit(64)
    if not remote_process:
        sys.exit(0)
    atexit.register(event, "remote-process-exit")
    signal.signal(signal.SIGTERM, exit_on_signal)
    signal.signal(signal.SIGINT, exit_on_signal)
    for line in sys.stdin:
        try: message = json.loads(line)
        except json.JSONDecodeError: continue
        if message.get("type") == "control_request" and message.get("request", {}).get("subtype") == "replay_history":
            event("history-bootstrap-request")
            goal_uuid = "11111111-1111-4111-8111-111111111111"
            goal = {"type":"system","subtype":"goal_state_changed","goal":{"type":"goal_status","id":"release-ssh-goal-0001","condition":"validate SSH lifecycle","status":"active","sentinel":True},"uuid":goal_uuid,"session_id":"release-ssh-session-0001"}
            print(json.dumps({"type":"ssh_history_chunk","request_id":message["request_id"],"sequence":0,"messages":[goal]}), flush=True)
            event("goal-bootstrap", goal_id="release-ssh-goal-0001")
            print(json.dumps({"type":"control_response","response":{"subtype":"success","request_id":message["request_id"],"response":{"session_id":"release-ssh-session-0001","count":1,"last_uuid":goal_uuid}}}), flush=True)
            event("history-bootstrap-response")
        elif message.get("type") == "user":
            event("task-start", task_id="release-ssh-task-0001")
            print(json.dumps({"type":"system","subtype":"task_started","task_id":"release-ssh-task-0001","description":"SSH lifecycle task","uuid":"22222222-2222-4222-8222-222222222222","session_id":"release-ssh-session-0001"}), flush=True)
            print(json.dumps({"type":"assistant","parent_tool_use_id":None,"uuid":"33333333-3333-4333-8333-333333333333","session_id":"release-ssh-session-0001","message":{"role":"assistant","content":[{"type":"tool_use","id":"release-ssh-tool-0001","name":"Bash","input":{"command":"pwd"}}]}}), flush=True)
            event("tool-use", tool_use_id="release-ssh-tool-0001")
            print(json.dumps({"type":"control_request","request_id":"release-ssh-permission-0001","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"pwd"},"tool_use_id":"release-ssh-tool-0001"}}), flush=True)
        elif message.get("type") == "control_response":
            response = message.get("response", {})
            decision = response.get("response", {})
            updated_input = decision.get("updatedInput", {})
            tool_use_id = "release-ssh-tool-0001" if updated_input.get("command") == "pwd" else None
            event("permission-response", request_id=response.get("request_id"), behavior=decision.get("behavior"), tool_use_id=tool_use_id)
            if response.get("request_id") != "release-ssh-permission-0001" or decision.get("behavior") != "allow" or tool_use_id is None:
                continue
            print(json.dumps({"type":"system","subtype":"task_notification","task_id":"release-ssh-task-0001","status":"stopped","output_file":"/tmp/release-ssh-task","summary":"RELEASE_SSH_TASK_COMPLETE","uuid":"44444444-4444-4444-8444-444444444444","session_id":"release-ssh-session-0001"}), flush=True)
            event("task-stopped", task_id="release-ssh-task-0001")
            print(json.dumps({"type":"result","subtype":"success","duration_ms":1,"duration_api_ms":1,"is_error":False,"num_turns":1,"result":"RELEASE_SSH_TASK_COMPLETE","stop_reason":"end_turn","total_cost_usd":0,"usage":{},"modelUsage":{},"permission_denials":[],"uuid":"55555555-5555-4555-8555-555555555555","session_id":"release-ssh-session-0001"}), flush=True)
            event("task-result", task_id="release-ssh-task-0001")
            break
'''.replace('__REMOTE_VERSION__', remote_version))
        executable.chmod(0o700)
        return fixture

    @staticmethod
    def ssh_lifecycle_evidence(fixture, *, require_cleanup=True):
        expected = [
            ('remote-process-start', {}),
            ('history-bootstrap-request', {}),
            ('goal-bootstrap', {'goal_id': 'release-ssh-goal-0001'}),
            ('history-bootstrap-response', {}),
            ('task-start', {'task_id': SSH_LIFECYCLE_IDS['task_id']}),
            ('tool-use', {'tool_use_id': SSH_LIFECYCLE_IDS['tool_use_id']}),
            ('permission-response', {
                'request_id': SSH_LIFECYCLE_IDS['permission_request_id'],
                'behavior': 'allow',
                'tool_use_id': SSH_LIFECYCLE_IDS['tool_use_id'],
            }),
            ('task-stopped', {'task_id': SSH_LIFECYCLE_IDS['task_id']}),
            ('task-result', {'task_id': SSH_LIFECYCLE_IDS['task_id']}),
            ('remote-process-exit', {}),
        ]
        cleanup_names = ['cleanup-command', 'control-master-stop']
        if require_cleanup:
            expected.extend((name, {}) for name in cleanup_names)
        events = fixture.get('events', [])
        observed_names = [event.get('event') for event in events]
        required_names = [name for name, _ in expected]
        missing_events = sorted(set(required_names) - set(observed_names))
        unique = all(observed_names.count(name) == 1 for name in required_names)
        ordered_events = [
            event for event in events if event.get('event') in set(required_names)
        ]
        ordered = [event.get('event') for event in ordered_events] == required_names
        event_fields_match = ordered and all(
            all(event.get(key) == value for key, value in fields.items())
            for event, (_, fields) in zip(ordered_events, expected)
        )
        ids_match = all(
            fixture.get(key) == value for key, value in SSH_LIFECYCLE_IDS.items()
        )
        cleanup_requirement_met = (
            all(name in observed_names for name in cleanup_names)
            if require_cleanup else True
        )
        return {
            'passed': (
                ids_match and not missing_events and unique and ordered
                and event_fields_match and cleanup_requirement_met
            ),
            'missing_events': missing_events,
            'ids_match': ids_match,
            'unique': unique,
            'ordered': ordered,
            'event_fields_match': event_fields_match,
            'cleanup_requirement_met': cleanup_requirement_met,
        }

    @staticmethod
    def write_plugin_version(run_dir, version):
        plugin = run_dir / 'marketplace/fixture'
        for directory in ('.claude-plugin', 'commands', 'skills/standalone'):
            (plugin / directory).mkdir(parents=True, exist_ok=True)
        (plugin / '.claude-plugin/plugin.json').write_text(json.dumps({
            'name': 'fixture', 'version': '1.0.0' if version == 'v1' else '2.0.0'}))
        for name, path in [('version', 'commands/version.md'),
                           ('standalone', 'skills/standalone/SKILL.md')]:
            (plugin / path).write_text(
                f'---\nname: {name}\ndescription: fixture {name} {version}\n---\n'
                f'PLUGIN_CONTENT_{name}_{version}\n')
        for name, path in [('removed-command', 'commands/removed-command.md'),
                           ('removed-skill', 'skills/removed-skill/SKILL.md')]:
            destination = plugin / path
            if version == 'v1':
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text(f'---\nname: {name}\ndescription: removable fixture\n---\nPLUGIN_CONTENT_{name}_v1\n')
            elif destination.exists():
                destination.unlink()
        (plugin / '.mcp.json').write_text(json.dumps({'mcpServers': {'server': {
            'command': sys.executable,
            'args': [str(run_dir / 'plugin-mcp.py'), version],
        }}}))

    def make_plugin_fixture(self, run_dir, config, home):
        marketplace = run_dir / 'marketplace'
        (marketplace / '.claude-plugin').mkdir(parents=True)
        (marketplace / '.claude-plugin/marketplace.json').write_text(json.dumps({
            'name': 'refresh-local', 'owner': {'name': 'fixture'},
            'plugins': [{'name': 'fixture', 'source': './fixture'}],
        }))
        # Real stdio MCP; the log records received requests, not driver claims.
        script = run_dir / 'plugin-mcp.py'
        script.write_text('import json, os, sys\n'
            'version = sys.argv[1]\n'
            f'log = {str(run_dir / "plugin-mcp.jsonl")!r}\n'
            'for line in sys.stdin:\n'
            '    request = json.loads(line)\n'
            '    with open(log, "a") as stream:\n'
            '        stream.write(json.dumps({"pid": os.getpid(), "version": version, "request": request}) + "\\n")\n'
            '    if "id" not in request: continue\n'
            '    method = request.get("method")\n'
            '    if method == "initialize":\n'
            '        result = {"protocolVersion": request["params"]["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "release-plugin", "version": version}}\n'
            '    elif method == "tools/list":\n'
            '        result = {"tools": [{"name": "probe_" + version, "description": "Local plugin reload probe", "inputSchema": {"type": "object", "properties": {"phase": {"type": "string"}}, "required": ["phase"]}}]}\n'
            '    elif method == "tools/call":\n'
            '        result = {"content": [{"type": "text", "text": json.dumps({"version": version, "pid": os.getpid(), "phase": request["params"]["arguments"]["phase"]})}]}\n'
            '    else: result = {}\n'
            '    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)\n')
        self.write_plugin_version(run_dir, 'v1')
        global_path = config / '.claude.json'
        global_config = json.loads(global_path.read_text())
        global_config['mcpServers'] = {'retained': {
            'command': sys.executable, 'args': [str(script), 'other']}}
        global_path.write_text(json.dumps(global_config))
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(home),
               'CLAUDE_CONFIG_DIR': str(config), 'DISABLE_AUTOUPDATER': '1',
               'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
               'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL': '1'}
        for index, arguments in enumerate([
            ['plugin', 'marketplace', 'add', str(marketplace)],
            ['plugin', 'install', 'fixture@refresh-local', '--scope', 'user'],
        ]):
            completed = subprocess.run([str(self.binary), *arguments], env=env,
                cwd=home, capture_output=True, text=True, timeout=60)
            (run_dir / f'plugin-setup-{index}.txt').write_text(completed.stdout + completed.stderr)
            if completed.returncode:
                raise RuntimeError('local plugin fixture installation failed')
        update = run_dir / 'plugin-update.sh'
        update.write_text('#!/bin/sh\nset -eu\nexec ' + shlex.join([
            str(self.binary), 'plugin', 'update', 'fixture@refresh-local', '--scope', 'user']) + '\n')
        update.chmod(0o700)
        (run_dir / 'plugin-phase.txt').write_text('v1')

    def make_fixture(self, run_dir, label):
        config = run_dir / 'config'
        home = Path(tempfile.mkdtemp(prefix='claude-release-home-'))
        self.auth_homes.add(home)
        config.mkdir(parents=True)
        (home / '.codex').mkdir(parents=True)
        auth_target = (home / '.codex/auth.json').resolve()
        if is_relative_to(auth_target, self.evidence_root):
            raise RuntimeError('auth target must be outside the evidence root')
        if is_relative_to(auth_target, self.repo):
            raise RuntimeError('auth target must be outside the repository')
        if label in {'openai-stats', 'openai-stats-api-key'}:
            auth_target.write_text(json.dumps({
                'auth_mode': 'chatgpt',
                'tokens': {'access_token': OpenAIStatsServer.token},
            }) + '\n')
            auth_strategy = 'isolated dummy OAuth without refresh credentials'
            auth_source = None
        elif label in MOCK_OPENAI_TARGETS:
            auth_target.write_text(json.dumps({
                'OPENAI_API_KEY': DUMMY_OPENAI_API_KEY,
            }) + '\n')
            auth_strategy = (
                'write a fixed dummy API key into a private temporary HOME; '
                'the local mock server accepts no real credential'
            )
            auth_source = None
        elif label == 'first-party-bootstrap-picker':
            auth_target.write_text('{}\n')
            auth_strategy = (
                'write an empty Codex auth file and pass a fixed dummy Anthropic '
                'key only to the isolated process'
            )
            auth_source = None
        else:
            if not self.auth_source.is_file():
                raise RuntimeError(
                    f'authenticated Codex source unavailable: {self.auth_source}'
                )
            shutil.copyfile(self.auth_source, auth_target)
            auth_strategy = (
                'copy account auth into a private temporary HOME outside '
                'evidence; remove it after the gate'
            )
            auth_source = str(self.auth_source)
        auth_target.chmod(0o600)
        global_config = {
            'numStartups': 1,
            'installMethod': 'local',
            'hasCompletedOnboarding': True,
            'projects': {
                str(self.repo): {
                    'hasTrustDialogAccepted': True,
                    'hasCompletedProjectOnboarding': True,
                },
            },
        }
        if label == 'first-party-bootstrap-picker':
            global_config['customApiKeyResponses'] = {
                'approved': [DUMMY_ANTHROPIC_API_KEY[-20:]],
                'rejected': [],
            }
        global_config_path = config / (
            '.claude-local-oauth.json'
            if label == 'first-party-bootstrap-picker'
            else '.claude.json'
        )
        global_config_path.write_text(json.dumps(global_config, indent=2) + '\n')
        settings = {
            'enableWorkflows': True,
            'workflowKeywordTriggerEnabled': True,
            'skipWorkflowUsageWarning': True,
            'skipDangerousModePermissionPrompt': True,
        }
        if label not in MOCK_OPENAI_TARGETS and label != 'first-party-bootstrap-picker':
            settings.update({
                'model': 'gpt-5.6-luna',
                'effortLevel': 'xhigh',
            })
        if label == 'deferred-tool-discovery-off':
            settings['enableWorkflows'] = False
        if label in {'code-review', 'prompt-modes-cache-prefix'}:
            settings['planModeAvailable'] = True
        if label == 'prompt-modes-cache-prefix':
            settings.update({
                'skipAutoPermissionPrompt': True,
                'useAutoModeDuringPlan': True,
            })
        if label == 'openai-remote-compaction':
            settings['compact'] = {'mode': 'codex'}
            settings['hooks'] = {
                'PreCompact': [{
                    'matcher': 'manual',
                    'hooks': [{
                        'type': 'command',
                        'command': "printf '%s\\n' RELEASE_PRECOMPACT_HOOK",
                        'timeout': 5,
                    }],
                }],
            }
        if label == 'subagent-stop-failure-lifecycle':
            hook_output = run_dir / 'subagent-stop-hooks.jsonl'
            hook_script = run_dir / 'record-subagent-stop.py'
            hook_script.write_text(
                '#!/usr/bin/env python3\n'
                'import sys\n'
                f'with open({str(hook_output)!r}, "a") as stream:\n'
                '    stream.write(sys.stdin.read().strip() + "\\n")\n'
            )
            hook_script.chmod(0o700)
            settings['hooks'] = {
                'SubagentStop': [{
                    'matcher': '',
                    'hooks': [{
                        'type': 'command',
                        'command': shlex.quote(str(hook_script)),
                        'timeout': 5,
                    }],
                }],
            }
        if label in FOREGROUND_FIXTURES:
            agent_type, tools = FOREGROUND_FIXTURES[label]
            agents = config / 'agents'
            agents.mkdir(parents=True)
            (agents / f'{agent_type}.md').write_text(
                f'---\nname: {agent_type}\n'
                'description: Deterministic foreground lifecycle validation.\n'
                f'tools: {tools}\nmodel: inherit\nbackground: false\n---\n'
                'Follow the requested validation task and return its completion marker.\n'
            )
        if label == 'model-discovery-empty-picker':
            settings['model'] = 'gpt-empty-discovery-current'
        if label == 'first-party-bootstrap-picker':
            settings['model'] = 'release-first-party-bootstrap-model'
        (config / 'settings.json').write_text(
            json.dumps(settings, indent=2) + '\n'
        )
        marketplace = config / 'plugins/marketplaces/Esonhugh-Marketplace'
        (marketplace / '.claude-plugin').mkdir(parents=True)
        (marketplace / '.claude-plugin/marketplace.json').write_text(json.dumps({
            'name': 'Esonhugh-Marketplace',
            'owner': {'name': 'Release validation fixture'},
            'plugins': [],
        }, indent=2) + '\n')
        (config / 'plugins/known_marketplaces.json').write_text(json.dumps({
            'Esonhugh-Marketplace': {
                'source': {
                    'source': 'github',
                    'repo': 'Esonhugh/Marketplace',
                },
                'installLocation': str(marketplace),
                'lastUpdated': '2026-09-29T00:00:00.000Z',
                'autoUpdate': False,
            },
        }, indent=2) + '\n')
        (run_dir / 'auth-source-metadata.json').write_text(json.dumps({
            'source': auth_source,
            'strategy': auth_strategy,
            'source_exists': self.auth_source.exists() if auth_source else None,
            'uses_dummy_credential': (
                label in MOCK_OPENAI_TARGETS
                or label in {'first-party-bootstrap-picker', 'openai-stats', 'openai-stats-api-key'}
            ),
            'target_outside_evidence': not is_relative_to(
                auth_target, self.evidence_root
            ),
            'target_outside_repository': not is_relative_to(auth_target, self.repo),
            'target_mode': oct(auth_target.stat().st_mode & 0o777),
        }, indent=2) + '\n')
        if label == 'plugins-reload':
            self.make_plugin_fixture(run_dir, config, home)
        return config, home

    def wait_ready(self, target, run_dir, timeout=60):
        deadline = time.monotonic() + timeout
        last = ''
        while time.monotonic() < deadline:
            exists, info, error = self.pane_exists(target)
            if not exists:
                (run_dir / 'readiness-error.txt').write_text(
                    f'pane missing\ninfo={info}\nerror={error}\nlast={last}'
                )
                return False
            visible = self.capture(
                target, run_dir / '01-ready-pane-visible.txt', history=False
            )
            self.capture(target, run_dir / '01-ready-pane.txt')
            plain = strip_ansi(visible)
            lowered = plain.lower()
            if 'choose the text style' in lowered or 'select theme' in lowered:
                self.tmux('send-keys', '-t', target, 'Enter')
                time.sleep(0.5)
                continue
            if 'sign in to use openai' in lowered or 'how would you like to authenticate' in lowered:
                (run_dir / 'readiness-error.txt').write_text('authentication prompt\n' + visible)
                return False
            if 'warning: claude code running in bypass permissions mode' in lowered:
                (run_dir / 'readiness-error.txt').write_text('bypass warning was not pre-authorized\n' + visible)
                return False
            if (
                'bypass permissions on' in lowered
                or '? for shortcuts' in lowered
                or any(re.fullmatch(r'\s*❯\s*', line) for line in plain.splitlines())
            ):
                return True
            last = visible
            time.sleep(0.5)
        (run_dir / 'readiness-error.txt').write_text('timeout waiting for prompt\n' + last)
        return False

    def start(self, label):
        self.session_index += 1
        run_key = f'{self.stamp}-{label}-{self.pid}-{self.session_index}'
        run_dir = self.evidence_root / 'runs' / run_key
        run_dir.mkdir(parents=True)
        (run_dir / 'tmp').mkdir(mode=0o700)
        config, home = self.make_fixture(run_dir, label)
        mock_base_url = None
        uses_local_mock = label in MOCK_OPENAI_TARGETS or label == 'first-party-bootstrap-picker'
        session = f'cc-release-{label}-{self.stamp}-{self.pid}-{self.session_index}'[:90]
        if self.tmux('has-session', '-t', session).returncode == 0:
            raise RuntimeError(f'tmux session collision: {session}')
        if uses_local_mock:
            mock_server = MockOpenAIServer(run_dir, label)
            mock_base_url = mock_server.start()
            self.mock_servers[run_key] = mock_server
        target = f'{session}:0.0'
        args = [
            'new-session', '-d', '-s', session, '-c', str(self.repo),
            '-x', '200', '-y', '60',
            '-e', f'CC_VALIDATION_REPO_ROOT={self.repo}',
            '-e', f'CC_VALIDATION_EVIDENCE_DIR={run_dir}',
            '-e', f'CC_VALIDATION_CONFIG_DIR={config}',
            '-e', f'CC_VALIDATION_HOME={home}',
            '-e', f'CC_VALIDATION_TMPDIR={run_dir / "tmp"}',
            '-e', 'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1',
        ]
        for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'):
            value = os.environ.get(f'CC_VALIDATION_{name}') or os.environ.get(name)
            if name == 'NO_PROXY' and uses_local_mock:
                value = merge_no_proxy(value, '127.0.0.1', 'localhost')
            if value:
                args.extend(['-e', f'CC_VALIDATION_{name}={value}'])
        if label in {'team-concurrency', 'transcript-retention'}:
            args.extend([
                '-e', 'CC_VALIDATION_AGENT_TEAMS=1',
                '-e', 'CLAUDE_CODE_TEAMMATE_MODE=in-process',
            ])
            settings_path = config / 'settings.json'
            settings = json.loads(settings_path.read_text())
            settings['teammateMode'] = 'in-process'
            settings_path.write_text(json.dumps(settings, indent=2) + '\n')
        if label in FOREGROUND_FIXTURES:
            args.extend(['-e', 'CC_VALIDATION_FORK_SUBAGENT=0'])
        if label == 'workflow-retry-partial-failure':
            args.extend([
                '-e',
                'CC_VALIDATION_WORKFLOW_FAULT_INJECTION=service_unavailable:transient-worker:attempt:0',
            ])
        if label == 'subagent-stop-failure-lifecycle':
            args.extend([
                '-e',
                'CC_VALIDATION_RUN_AGENT_FAULT_INJECTION=after_query_start',
            ])
        if mock_base_url:
            args.extend([
                '-e', f'CC_VALIDATION_OPENAI_BASE_URL={mock_base_url}',
            ])
        if label in {'goal-lifecycle', 'openai-responses-usage-error'}:
            args.extend([
                '-e', 'CC_VALIDATION_DISABLE_NONSTREAMING_FALLBACK=1',
                '-e', 'CC_VALIDATION_MAX_RETRIES=0',
            ])
        if label == 'first-party-bootstrap-picker':
            args.extend([
                '-e', 'CC_VALIDATION_USE_OPENAI=0',
                '-e', f'CC_VALIDATION_ANTHROPIC_API_KEY={DUMMY_ANTHROPIC_API_KEY}',
                '-e', f'CC_VALIDATION_LOCAL_OAUTH_API_BASE={mock_base_url}',
            ])
        if label == 'prompt-modes-cache-prefix':
            args.extend([
                '-e',
                f'CC_VALIDATION_SYSTEM_PROMPT={CUSTOM_SYSTEM_PROMPT_MARKER}',
            ])
        if label in {'terminal-interaction', 'terminal-canonical-diff'}:
            fixture = run_dir / 'project'
            initialize_terminal_interaction_repository(fixture)
            global_config_path = config / '.claude.json'
            global_config = json.loads(global_config_path.read_text())
            global_config['projects'][str(fixture)] = {
                'hasTrustDialogAccepted': True,
                'hasCompletedProjectOnboarding': True,
            }
            global_config_path.write_text(json.dumps(global_config, indent=2) + '\n')
            args.extend([
                '-e', f'CC_VALIDATION_PATH_PREFIX={(create_terminal_git_wrapper if label == "terminal-interaction" else create_canonical_terminal_git_wrapper)(run_dir)}',
                '-e', f'CC_VALIDATION_CWD={fixture}',
                '-e', f'CC_VALIDATION_FRAME_EVIDENCE_PATH={run_dir / "frames.jsonl"}',
                '-e', 'CC_VALIDATION_NO_FLICKER=1',
            ])
            settings_path = config / 'settings.json'
            settings = json.loads(settings_path.read_text())
            settings['tui'] = 'fullscreen'
            if label == 'terminal-interaction':
                settings['enabledPlugins'] = {
                    'cc-plugin-diff@builtin': False, 'diff@builtin': False,
                }
            settings_path.write_text(json.dumps(settings, indent=2) + '\n')
            clawd = config / 'clawd.txt'
            clawd.write_text('\n'.join([
                'CLAWD_RELEASE_ROW_ONE',
                'CLAWD_RELEASE_ROW_TWO',
                'CLAWD_RELEASE_ROW_THREE',
                'CLAWD_RELEASE_ROW_FOUR',
                'CLAWD_RELEASE_ROW_FIVE',
                'CLAWD_RELEASE_ROW_SIX',
                'CLAWD_RELEASE_ROW_SEVEN',
                'CLAWD_RELEASE_WIDE_' + ('界' * 120),
            ]) + '\n')
        if label == 'ssh-remote-session-lifecycle':
            fixture = self.make_ssh_transport_fixture(run_dir)
            args.extend([
                '-e', f'CC_VALIDATION_SSH_IO={fixture["io_path"]}',
                '-e', f'CC_VALIDATION_SSH_BIN={fixture["bin_dir"]}',
                '-e', 'CC_VALIDATION_SKIP_PERMISSIONS=1',
                '-e', 'CC_VALIDATION_SSH_TARGET=release-ssh-host',
            ])
        if label in {'openai-stats', 'openai-stats-api-key'}:
            stats_server = OpenAIStatsServer(run_dir, home)
            self.mock_servers[run_key] = stats_server
            proxy = stats_server.start()
            env = {
                'HOME': str(home), 'CLAUDE_CONFIG_DIR': str(config),
                'XDG_CONFIG_HOME': str(home / '.config'),
                'XDG_CACHE_HOME': str(home / '.cache'),
                'XDG_DATA_HOME': str(home / '.local/share'),
                'PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
                'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8',
                'CLAUDE_CODE_USE_OPENAI': '1', 'DISABLE_AUTOUPDATER': '1',
                'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
                'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL': '1',
                'NODE_EXTRA_CA_CERTS': str(stats_server.ca),
                **{name: proxy for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
                                            'http_proxy', 'https_proxy', 'all_proxy')},
                'NO_PROXY': '127.0.0.1,localhost', 'no_proxy': '127.0.0.1,localhost',
            }
            if label == 'openai-stats-api-key':
                env['OPENAI_API_KEY'] = DUMMY_OPENAI_API_KEY
            args.append(shlex.join(['env', '-i', *[f'{k}={v}' for k, v in env.items()],
                                    str(self.binary), '--dangerously-skip-permissions',
                                    '--debug', '--debug-file', str(run_dir / 'debug.log')]))
        else:
            args.append(str(self.launcher))
        if label in {'terminal-interaction', 'terminal-canonical-diff'}:
            if self.terminal_capture is not None:
                raise RuntimeError('terminal captures must be serial')
            socket_root = Path(tempfile.mkdtemp(prefix='cc-term-', dir='/private/tmp'))
            binary = run_dir / 'bin/claude'
            binary.parent.mkdir()
            shutil.copy2(self.binary, binary)
            if sha256(binary) != self.manifest['binary_sha256']:
                raise RuntimeError('copied terminal binary differs from baseline')
            descriptor = run_dir / 'capture-launch.json'
            launch = {
                'run': str(run_dir), 'driverPid': os.getpid(), 'socket': str(socket_root / 's'),
                'socketRoot': str(socket_root), 'target': target, 'pane': target,
                'tmux': shutil.which('tmux'), 'argv': [str(self.launcher)],
                'binarySha256': self.manifest['binary_sha256'],
                'env': {'PATH': '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
                        'HOME': str(home), 'TERM': 'xterm-256color'},
            }
            descriptor.write_text(json.dumps(launch, indent=2) + '\n')
            prepared = self.terminal_capture_command('prepare', descriptor)
            if prepared.returncode:
                raise RuntimeError('terminal capture preparation failed')
            self.terminal_capture = json.loads(descriptor.read_text())
            args[-1] = self.terminal_capture['capture']['wrapper']
            for name in ('CC_VALIDATION_FRAME_BROKER_DIR', 'CC_VALIDATION_FRAME_CAPTURE_ID',
                         'CC_VALIDATION_FRAME_BINARY_SHA256', 'CC_VALIDATION_FRAME_NATIVE_JOURNAL'):
                args[-1:-1] = ['-e', f'{name}={self.terminal_capture["env"][name]}']
            args[-1:-1] = ['-e', f'CC_VALIDATION_BINARY={binary}']
        result = self.tmux(*args)
        if label in {'terminal-interaction', 'terminal-canonical-diff'} and result.returncode == 0:
            self.active_runs[session] = (run_dir, target)
            self.tmux('set-option', '-w', '-t', target, 'remain-on-exit', 'on', check=True)
            pane = self.tmux('display-message', '-p', '-t', target, '#{pane_id}',
                             check=True).stdout.strip()
            self.terminal_capture['pane'] = pane
            self.terminal_capture['serverPid'] = int(self.tmux(
                'display-message', '-p', '-t', target, '#{pid}', check=True).stdout.strip())
            self.terminal_capture['socketIdentity'] = terminal_socket_identity(self.terminal_capture)
            descriptor.write_text(json.dumps(self.terminal_capture, indent=2) + '\n')
            installed = self.terminal_capture_command('install', descriptor)
            if installed.returncode:
                raise RuntimeError('terminal capture recorder installation failed')
        (run_dir / 'tmux-start-stdout.txt').write_text(result.stdout)
        (run_dir / 'tmux-start-stderr.txt').write_text(result.stderr)
        (run_dir / 'pane-target.txt').write_text(target + '\n')
        (run_dir / 'run-metadata.json').write_text(json.dumps({
            'driver_run': f'{self.stamp}-{self.pid}',
            'source_run': run_dir.name,
            'evidence_dir': str(run_dir.resolve()),
            'label': label,
            'session': session,
            'target': target,
            'repo': str(self.repo),
            'head': self.manifest['head'],
            'binary': str(self.binary),
            'binary_sha256': self.manifest['binary_sha256'],
            'launcher': (
                'driver env -i with local TLS fixture'
                if label in {'openai-stats', 'openai-stats-api-key'} else str(self.launcher)
            ),
            'config': str(config),
            'home': str(home),
            'fork_subagent': '0' if label in FOREGROUND_FIXTURES else 'product default',
            'mock_openai': {
                'enabled': mock_base_url is not None,
                'base_url': mock_base_url,
                'request_evidence': (
                    str(run_dir / 'mock-openai-requests.json')
                    if mock_base_url else None
                ),
            },
            'terminal': {'cols': 200, 'rows': 60},
            'terminal_capture': self.terminal_capture if label in {'terminal-interaction', 'terminal-canonical-diff'} else None,
            'flags': [
                *(
                    []
                    if label == 'ssh-remote-session-lifecycle'
                    else ['--dangerously-skip-permissions']
                ),
                '--debug',
                '--debug-file',
                '<evidence>/debug.log',
                *(
                    ['--system-prompt', CUSTOM_SYSTEM_PROMPT_MARKER]
                    if label == 'prompt-modes-cache-prefix'
                    else []
                ),
            ],
            'inherited_auth_env': {
                name: 'set' if os.environ.get(name) else 'unset'
                for name in AUTH_ENV_VARS
            },
            'auth_env_policy': (
                'launcher uses env -i and restores only non-secret runtime '
                'variables plus CLAUDE_CODE_USE_OPENAI=1'
            ),
        }, indent=2) + '\n')
        self.registered_runs[str(run_dir.resolve())] = (
            run_dir / 'run-metadata.json').read_text()
        if label == 'code-review':
            self.code_review_mock_servers[run_dir.name] = mock_server
        if result.returncode == 0:
            self.active_runs[session] = (run_dir, target)
        ready = result.returncode == 0 and self.wait_ready(target, run_dir)
        return run_dir, session, target, ready

    def process_snapshot(self):
        result = command(['ps', '-axo', 'pid=,ppid=,command='])
        processes = {}
        children = {}
        for line in result.stdout.splitlines():
            match = re.match(r'\s*(\d+)\s+(\d+)\s+.*', line)
            if not match:
                continue
            pid, ppid = match.groups()
            processes[pid] = line.strip()
            children.setdefault(ppid, []).append(pid)
        return processes, children

    def process_tree(self, root_pid):
        if not root_pid:
            return {}
        processes, children = self.process_snapshot()
        pending = [root_pid]
        selected = {}
        while pending:
            pid = pending.pop()
            if pid in selected:
                continue
            if pid in processes:
                selected[pid] = processes[pid]
            pending.extend(children.get(pid, []))
        return selected

    def run_processes(self, run_dir, tracked=None):
        processes, _ = self.process_snapshot()
        selected = {
            pid: line
            for pid, line in processes.items()
            if pid in (tracked or {})
            or (
                str(self.binary) in line
                and str(run_dir / 'debug.log') in line
            )
        }
        return selected

    def terminate_processes(self, processes):
        terminated = []
        for signum in (signal.SIGTERM, signal.SIGKILL):
            for pid in processes:
                try:
                    os.kill(int(pid), signum)
                    terminated.append({'pid': pid, 'signal': signal.Signals(signum).name})
                except ProcessLookupError:
                    pass
            def processes_stopped():
                current, _ = self.process_snapshot()
                return not any(pid in current for pid in processes)

            if self.wait_until(processes_stopped, 5, 0.25):
                break
            current, _ = self.process_snapshot()
            processes = {pid: current[pid] for pid in processes if pid in current}
        return terminated

    def close(self, run_dir, session, target):
        pid_result = self.tmux('display-message', '-p', '-t', target, '#{pane_pid}')
        pane_pid = pid_result.stdout.strip() if pid_result.returncode == 0 else ''
        tracked = self.process_tree(pane_pid)
        before = self.run_processes(run_dir, tracked)
        (run_dir / 'process-before-close.txt').write_text(
            '\n'.join(before.values()) + ('\n' if before else '')
        )
        close_result = self.tmux('kill-session', '-t', session)
        session_exists_after = self.tmux('has-session', '-t', session).returncode == 0
        self.wait_until(lambda: not self.run_processes(run_dir, before), 5, 0.25)
        remaining = self.run_processes(run_dir, before)
        terminated = self.terminate_processes(remaining) if remaining else []
        remaining = self.run_processes(run_dir, before)
        (run_dir / 'process-after-close.txt').write_text(
            '\n'.join(remaining.values()) + ('\n' if remaining else '')
        )
        self.active_runs.pop(session, None)
        mock_server = self.mock_servers.pop(run_dir.name, None)
        mock_cleanup = (
            mock_server.stop()
            if mock_server is not None
            else {'stopped': True, 'thread_alive': False}
        )
        captured = getattr(self, 'terminal_capture', None)
        capture_cleanup = None
        if captured and captured['run'] == str(run_dir):
            killed = None
            try:
                if terminal_socket_identity(captured) == captured.get('socketIdentity'):
                    server = self.tmux('display-message', '-p', '#{pid}')
                    if server.returncode == 0 and server.stdout.strip() == str(captured['serverPid']):
                        killed = self.tmux('kill-server')
            except (OSError, ValueError):
                pass
            sealed = self.terminal_capture_command('seal', run_dir / 'capture-launch.json')
            def server_gone():
                try:
                    os.kill(captured['serverPid'], 0)
                    return False
                except ProcessLookupError:
                    return True
                except PermissionError:
                    return False
            self.wait_until(server_gone, 5, 0.1)
            socket_cleanup = release_owned_terminal_socket(captured)
            capture_cleanup = {
                'kill_server_exit': killed.returncode if killed is not None else None,
                'seal_exit': sealed.returncode,
                **socket_cleanup,
                'descriptor': str(run_dir / 'capture-launch.json'),
            }
            self.terminal_capture = None
            socket_root = Path(captured['socketRoot'])
            if socket_cleanup['socket_released']:
                try:
                    socket_root.rmdir()
                    capture_cleanup['socket_root_released'] = True
                except OSError as error:
                    capture_cleanup['socket_root_released'] = False
                    capture_cleanup['socket_root_error'] = str(error)
        return {
            'kill_exit': close_result.returncode,
            'session_exists_after': session_exists_after,
            'pane_pid': pane_pid,
            'process_remaining': bool(remaining),
            'remaining_processes': list(remaining.values()),
            'forced_termination': terminated,
            'mock_server': mock_cleanup,
            'terminal_capture': capture_cleanup,
        }

    def close_active_runs(self):
        cleanup = []
        for session, (run_dir, target) in list(self.active_runs.items()):
            cleanup.append({
                'session': session,
                'evidence_dir': str(run_dir),
                **self.close(run_dir, session, target),
            })
        for run_key, mock_server in list(self.mock_servers.items()):
            self.mock_servers.pop(run_key, None)
            cleanup.append({
                'session': None,
                'evidence_dir': str(self.evidence_root / 'runs' / run_key),
                'kill_exit': 0,
                'pane_pid': '',
                'process_remaining': False,
                'remaining_processes': [],
                'forced_termination': [],
                'mock_server': mock_server.stop(),
            })
        return cleanup

    def cleanup_passed(self, cleanup):
        return (
            not cleanup.get('session_exists_after', False)
            and not cleanup['process_remaining']
            and not cleanup['forced_termination']
            and cleanup.get('mock_server', {}).get('stopped', True)
            and not cleanup.get('mock_server', {}).get('thread_alive', False)
            and (cleanup.get('terminal_capture') is None
                 or (cleanup['terminal_capture'].get('socket_released') is True
                     and cleanup['terminal_capture'].get('server_exited') is True
                     and cleanup['terminal_capture'].get('socket_root_released') is True))
        )

    def remove_auth_homes(self):
        removed = []
        errors = []
        for home in sorted(self.auth_homes):
            try:
                shutil.rmtree(home)
                removed.append(str(home))
                self.auth_homes.discard(home)
            except FileNotFoundError:
                removed.append(str(home))
                self.auth_homes.discard(home)
            except OSError as error:
                errors.append({'path': str(home), 'error': repr(error)})
        return {'removed': removed, 'errors': errors}

    def handle_signal(self, signum, _frame):
        if self.cleanup_started:
            raise SystemExit(128 + signum)
        self.cleanup_started = True
        if hasattr(self, 'manifest'):
            self.manifest['completion_state'] = 'interrupted'
            self.manifest['normal_exit'] = False
            self.manifest['completion_reason'] = signal.Signals(signum).name
        signal.signal(signum, signal.SIG_IGN)
        lease_release = self.release_lease()
        cleanup = {
            'signal': signal.Signals(signum).name,
            'active_runs': self.close_active_runs(),
            'auth_homes': self.remove_auth_homes(),
            'ownership_lease_release': lease_release,
        }
        if self.evidence_root.is_dir():
            (self.evidence_root / 'signal-cleanup.json').write_text(
                json.dumps(cleanup, indent=2) + '\n'
            )
        raise SystemExit(128 + signum)

    def record(self, result):
        if result.get('label') in TERMINAL_ACCEPTANCE or result.get('label') == 'mods-process-spawn':
            root = Path(result['evidence_dir']).resolve()
            metadata_path = root / 'run-metadata.json'
            registered = self.registered_runs[str(root)]
            if metadata_path.read_text() != registered:
                raise RuntimeError('terminal producer metadata changed before acceptance registration')
            process_spawn = result['label'] == 'mods-process-spawn'
            required_id = 'mods-process-spawn-real-author' if process_spawn else TERMINAL_ACCEPTANCE[result['label']][0]
            matching = [item for item in result.get('assertions', []) if item.get('assertion_id') == required_id]
            if len(matching) != 1 or str(metadata_path) in matching[0].get('evidence_sha256', {}):
                raise RuntimeError('terminal producer has no unique sealed business assertion')
            metadata = json.loads(registered)
            anchor = 'process_spawn_evidence_sha256' if process_spawn else 'terminal_evidence_sha256'
            metadata[anchor] = dict(matching[0]['evidence_sha256'])
            metadata_path.write_text(json.dumps(metadata, indent=2) + '\n')
            self.registered_runs[str(root)] = metadata_path.read_text()
        assertions = result.get('assertions')
        if result.get('validation_verdict') == 'passed' and isinstance(assertions, list) and any(
            assertion.get('validation_verdict') != 'passed'
            for assertion in assertions
        ):
            result['validation_verdict'] = 'failed'
            result['reason'] = 'one or more target assertions failed'
        result['driver_run'] = f'{self.stamp}-{self.pid}'
        self.manifest['runs'].append(result)
        (self.evidence_root / 'driver-progress.json').write_text(
            json.dumps(self.manifest, indent=2) + '\n'
        )

    def run_target(self, label, action):
        state_before = self.repository_state()
        workflow_before = self.workflow_runs_state()
        task_ids_before = set(self.workflow_task_ids)
        run_ids_before = set(self.workflow_run_ids)
        run_count_before = len(self.manifest['runs'])
        try:
            action()
        finally:
            state_after = self.repository_state()
            workflow_after = self.workflow_runs_state()
            if len(self.manifest['runs']) > run_count_before:
                result = self.manifest['runs'][-1]
                if result.get('label') != label:
                    raise RuntimeError(
                        f'target {label} recorded unexpected result {result.get("label")}'
                    )
                new_task_ids = self.workflow_task_ids - task_ids_before
                new_run_ids = self.workflow_run_ids - run_ids_before
                expected_task_paths = {
                    f'{task_id}.json' for task_id in new_task_ids
                }

                def is_expected_workflow_path(path):
                    return path in expected_task_paths or any(
                        path == run_id or path.startswith(f'{run_id}/')
                        for run_id in new_run_ids
                    )

                workflow_added = sorted(
                    set(workflow_after['manifest']) - set(workflow_before['manifest'])
                )
                workflow_modified = sorted(
                    path
                    for path in (
                        set(workflow_after['manifest'])
                        & set(workflow_before['manifest'])
                    )
                    if (
                        workflow_after['manifest'][path]
                        != workflow_before['manifest'][path]
                    )
                )
                workflow_removed = sorted(
                    set(workflow_before['manifest']) - set(workflow_after['manifest'])
                )
                unexpected_workflow_paths = [
                    path for path in workflow_added
                    if not is_expected_workflow_path(path)
                ]
                ordinary_state_keys = set(state_before)
                ordinary_state_unchanged = all(
                    state_before[key] == state_after[key]
                    for key in ordinary_state_keys
                )
                result['repository_state_before'] = state_before
                result['repository_state_after'] = state_after
                result['repository_state_unchanged'] = ordinary_state_unchanged
                result['repository_state_expected_workflow_artifacts'] = {
                    'task_ids': sorted(new_task_ids),
                    'run_ids': sorted(new_run_ids),
                    'added_paths': workflow_added,
                    'unexpected_added_paths': unexpected_workflow_paths,
                    'modified_paths': workflow_modified,
                    'removed_paths': workflow_removed,
                }
                (self.evidence_root / 'driver-progress.json').write_text(
                    json.dumps(self.manifest, indent=2) + '\n'
                )

    def readiness_smoke(self):
        run_dir, session, target, ready = self.start('readiness-smoke')
        cleanup = self.close(run_dir, session, target)
        result = {
            'label': 'readiness-smoke',
            'validation_verdict': 'passed' if ready and self.cleanup_passed(cleanup) else 'failed',
            'evidence_dir': str(run_dir),
            'cleanup': cleanup,
        }
        self.record(result)
        if result['validation_verdict'] != 'passed':
            raise RuntimeError(f'readiness smoke failed: {run_dir}')

    def terminal_interaction(self):
        run_dir, session, target, ready = self.start('terminal-interaction')
        result = {'label': 'terminal-interaction', 'evidence_dir': str(run_dir)}
        input_chunks = []
        checks = dict.fromkeys((
            'ready', 'custom_clawd_layout', 'same_chunk_utf8_submit',
            'csi_u_submit', 'raw_backspace_submit', 'raw_del_submit',
            'forward_delete_submit', 'cursor_combination_submit',
            'paste_head_visible', 'paste_continuation_visible', 'paste_recovery_submit',
            'diff_alpha_ready', 'diff_partial_loading', 'diff_same_chunk_navigation',
            'resize_intent', 'resize_keyboard_ownership', 'diff_closed', 'diff_reopened',
            'frame_physical', 'frame_resize_sequence', 'frame_semantics', 'cleanup',
            'independent_pty_capture_identity', 'independent_pty_resize_sequence',
            'normal_native_exit',
        ), False)
        checks['ready'] = ready
        evidence = []

        def pane(name):
            path = run_dir / f'{name}-pane.txt'
            if path not in evidence:
                evidence.append(path)
            return strip_ansi(self.capture(target, path, history=False))

        def observe(name, predicate, timeout=30):
            return self.wait_until(lambda: predicate(pane(name)), timeout, 0.1)

        def require(name, value):
            checks[name] = bool(value)
            if not value:
                raise RuntimeError(f'terminal interaction failed: {name}')

        def raw(name, chunk):
            input_chunks.append({'scenario': name, 'hex': chunk.hex()})
            self.paste_bytes(target, run_dir, chunk, f'raw-{name}.bin')

        def requests():
            return self.mock_servers[run_dir.name].snapshot()

        def submitted(name, offset, expected):
            require(name, self.wait_until(
                lambda: terminal_request_submitted(requests(), offset, expected), 30, 0.1))
            require(name + '_prompt_restored', observe(name, input_prompt_ready))
            require(name + '_exact_request', terminal_request_submitted(requests(), offset, expected))

        try:
            if not ready:
                raise RuntimeError('terminal interaction did not reach readiness')
            plain = pane('03-startup')
            rows = [f'CLAWD_RELEASE_ROW_{name}' for name in (
                'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN')]
            require('custom_clawd_layout', all(marker in plain for marker in rows)
                    and plain.count('CLAWD_RELEASE_WIDE_') == 1
                    and 'bypass permissions on' in plain.lower())
            cases = [
                ('same_chunk_utf8_submit', '中文\r'.encode(), '中文'),
                ('csi_u_submit', b'\x1b[20013u\x1b[25991u\x1b[13u', '中文'),
                ('raw_backspace_submit', '中文'.encode() + b'\x08\r', '中'),
                ('raw_del_submit', '中文'.encode() + b'\x7f\r', '中'),
                ('forward_delete_submit', '中文'.encode() + b'\x1b[D\x1b[3~\r', '中'),
                ('cursor_combination_submit', '中文'.encode()
                 + b'\x1b[D' + '甲'.encode() + b'\x1b[C' + '乙'.encode()
                 + b'\x1b[H' + '首'.encode()
                 + b'\x1b[F' + '尾'.encode() + b'\r', '首中甲文乙尾'),
            ]
            for name, chunk, expected in cases:
                offset = len(requests())
                raw(name, chunk)
                submitted(name, offset, expected)

            offset = len(requests())
            raw('delayed-paste-head', b'\x1b[200~RECOVERY_LITERAL')
            require('paste_head_visible', observe('05a-paste-head',
                    lambda text: 'RECOVERY_LITERAL' in text))
            require('paste_head_not_submitted', len(requests()) == offset)
            raw('delayed-paste-continuation', b'_CONTINUATION\x1b[201~')
            require('paste_continuation_visible', observe('05b-paste-continuation',
                    lambda text: 'RECOVERY_LITERAL_CONTINUATION' in text))
            require('paste_continuation_not_submitted', len(requests()) == offset)
            raw('delayed-paste-enter', b'\r')
            submitted('paste_recovery_submit', offset, 'RECOVERY_LITERAL_CONTINUATION')

            # Enter the reachable keyboard dialog at 109 columns. At 110 the
            # native command opens a mouse-only sidebar instead.
            self.tmux('resize-window', '-t', target, '-x', '109', '-y', '34', check=True)
            fixture = run_dir / 'project'
            (fixture / 'alpha.txt').write_text('alpha before\nALPHA_RELEASE_BODY\n')
            raw('diff-open', b'/diff\r')
            require('diff_dialog_entry', observe('06-dialog-entry', lambda text:
                    'Diff · files' in text and 'alpha.txt' in text and 'ALPHA_RELEASE_BODY' in text
                    and 'omega.txt' not in text))
            self.tmux('resize-window', '-t', target, '-x', '110', '-y', '34', check=True)
            require('diff_alpha_ready', observe('06-alpha-ready', lambda text:
                    'Diff · files' in text and 'alpha.txt' in text and 'ALPHA_RELEASE_BODY' in text
                    and 'omega.txt' not in text))
            (fixture / 'omega.txt').write_text('omega before\nOMEGA_RELEASE_BODY\n')
            require('omega_body_blocked', self.wait_until(
                lambda: (run_dir / 'omega-body-blocked.json').exists(), 30, 0.1))
            require('diff_partial_publish', observe('06a-partial-publish', lambda text:
                    all(marker in text for marker in ('alpha.txt', 'omega.txt', 'ALPHA_RELEASE_BODY'))
                    and 'OMEGA_RELEASE_BODY' not in text))
            navigation_offset = len(requests())
            nav_chunk = b'\x1b[B\r'
            input_chunks.append({'scenario': 'diff Down plus Enter in one chunk', 'hex': nav_chunk.hex()})
            self.paste_bytes(target, run_dir, nav_chunk, 'raw-diff-down-enter.bin')
            require('diff_partial_loading', observe('07-omega-loading', lambda text:
                    all(marker in text for marker in ('Diff · detail', 'omega.txt', 'Loading diff body'))
                    and 'OMEGA_RELEASE_BODY' not in text and 'ALPHA_RELEASE_BODY' not in text))
            require('loading_keyboard_ownership', len(requests()) == navigation_offset)
            release_terminal_git_wrapper(run_dir)
            require('diff_same_chunk_navigation', observe('07a-omega-ready', lambda text:
                    all(marker in text for marker in ('Diff · detail', 'omega.txt', 'OMEGA_RELEASE_BODY'))
                    and 'Loading diff body' not in text and 'ALPHA_RELEASE_BODY' not in text))

            before_resize = self.debug(run_dir).count('[diff] close')
            self.tmux('resize-window', '-t', target, '-x', '109', '-y', '34', check=True)
            require('resize_detail_preserved', observe('08-resize-109', lambda text:
                    all(marker in text for marker in ('Diff · detail', 'omega.txt', 'OMEGA_RELEASE_BODY'))
                    and 'ALPHA_RELEASE_BODY' not in text
                    and self.tmux('display-message', '-p', '-t', target,
                                  '#{window_width}x#{window_height}').stdout.strip() == '109x34'))
            self.tmux('resize-window', '-t', target, '-x', '110', '-y', '34', check=True)
            require('resize_intent', observe('08a-resize-110', lambda text:
                    all(marker in text for marker in ('Diff · detail', 'omega.txt', 'OMEGA_RELEASE_BODY'))
                    and 'ALPHA_RELEASE_BODY' not in text
                    and self.tmux('display-message', '-p', '-t', target,
                                  '#{window_width}x#{window_height}').stdout.strip() == '110x34')
                    and self.debug(run_dir).count('[diff] close') == before_resize)
            raw('resize-detail-back', b'\x1b')
            require('resize_files_after_explicit_back', observe('08b-files-after-back', lambda text:
                    'Diff · files' in text and all(name in text for name in ('alpha.txt', 'omega.txt'))))
            raw('resize-up-enter', b'\x1b[A\r')
            require('resize_keyboard_ownership', observe('08c-alpha-detail', lambda text:
                    all(marker in text for marker in ('Diff · detail', 'alpha.txt', 'ALPHA_RELEASE_BODY'))
                    and 'OMEGA_RELEASE_BODY' not in text)
                    and len(requests()) == navigation_offset
                    and self.debug(run_dir).count('[diff] close') == before_resize)
            raw('detail-back', b'\x1b')
            require('diff_files_before_close', observe('09-files', lambda text:
                    'Diff · detail' not in text and all(name in text for name in ('alpha.txt', 'omega.txt'))))
            raw('diff-close', b'\x1b')
            require('diff_closed', observe('09a-closed', lambda text:
                    not any(name in text for name in ('alpha.txt', 'omega.txt'))
                    and input_prompt_ready(text)
                    and '[diff] dialog close user' in self.debug(run_dir)))
            self.tmux('resize-window', '-t', target, '-x', '109', '-y', '34', check=True)
            raw('diff-reopen', b'/diff\r')
            require('diff_reopened', observe('10-reopened', lambda text:
                    all(marker in text for marker in ('Diff · files', 'alpha.txt', 'omega.txt', 'ALPHA_RELEASE_BODY'))))
        except Exception as error:
            result['error'] = str(error)
            checks['scenario_completed'] = False
            pane('failure')
        finally:
            try:
                release_terminal_git_wrapper(run_dir)
            finally:
                native_exit_requested = False
                exit_identity = terminal_native_exit_identity(run_dir, getattr(self, 'terminal_capture', None),
                    (getattr(self, 'manifest', None) or {}).get('binary_sha256'))
                try:
                    # Each Escape belongs to an observed dialog state. Sending
                    # a second Escape to an already closed composer opens Rewind.
                    current = pane('11-cleanup-state')
                    if 'Diff · detail' in current:
                        raw('cleanup-detail-back', b'\x1b')
                        observe('11a-cleanup-files', lambda text: 'Diff · files' in text, 5)
                        current = pane('11b-cleanup-state')
                    if 'Diff · files' in current:
                        raw('cleanup-close-dialog', b'\x1b')
                    composer_ready = observe('11-cleanup-composer', lambda text:
                        input_prompt_ready(text) and 'Diff · files' not in text and 'Diff · detail' not in text, 5)
                    if composer_ready:
                        raw('cleanup-native-exit', b'/exit\r')
                        native_exit_requested = True
                    result['native_exit_observation'] = {'producerClosedBeforeCaptureClose':
                        native_exit_requested and exit_identity is not None and self.wait_until(
                            lambda: terminal_native_producer_exit_passed(run_dir, exit_identity['capture'],
                                exit_identity['binarySha256']), 5, 0.1)}
                except Exception as error:
                    result['native_exit_error'] = str(error)
                cleanup = self.close(run_dir, session, target)
                checks['normal_native_exit'] = native_exit_requested and exit_identity is not None and terminal_native_exit_passed(
                    run_dir, exit_identity['capture'], exit_identity['binarySha256'])
        checks['cleanup'] = self.cleanup_passed(cleanup)
        (run_dir / 'input-chunks.json').write_text(json.dumps(input_chunks, indent=2) + '\n')
        checks['bounded_terminal_evidence'] = (cleanup.get('terminal_capture') or {}).get('seal_exit') == 0
        checks['full_terminal_coverage'] = False
        if (run_dir / 'capture-launch.json').is_file():
            try:
                full_verify = self.terminal_capture_command('verify', run_dir / 'capture-launch.json')
                checks['full_terminal_coverage'] = full_verify.returncode == 0
            except (OSError, subprocess.SubprocessError) as error:
                result['full_coverage_error'] = str(error)
        frame_report = run_dir / 'frame-physical-report.json'
        frames = run_dir / 'frames.jsonl'
        if frames.exists() and frames.stat().st_size:
            try:
                report = json.loads(frame_report.read_text())
                logical = terminal_frame_report_checks(report)
                checks['frame_resize_sequence'] = logical['frame_resize_sequence']
                checks['frame_semantics'] = logical['frame_semantics']
                fresh = json.loads((run_dir / 'independent-pty-checks.json').read_text())
                checks['independent_pty_capture_identity'] = fresh['captureIdentityPassed'] is True
                checks['frame_physical'] = fresh['recheck']['verdict'] == 'passed'
                checks['independent_pty_resize_sequence'] = terminal_resize_sizes(report) == [
                    (109, 34), (110, 34), (109, 34), (110, 34), (109, 34)]
            except (OSError, ValueError, TypeError, KeyError) as error:
                result['frame_report_error'] = str(error)
        checks_path = run_dir / 'terminal-interaction-checks.json'
        checks_path.write_text(json.dumps(checks, indent=2) + '\n')
        passed = all(checks.values())
        held_launch = json.loads(getattr(self, 'registered_runs', {}).get(str(run_dir.resolve()), '{}')).get('terminal_capture', {})
        capture_paths = [run_dir / name for name in (
            *sorted(terminal_capture_required_files(held_launch) or ()),
            'terminal-capture.json', 'bin/claude', 'independent-pty-checks.json',
            'capture-launch.json', 'capture-verify-stdout.txt', 'capture-verify-stderr.txt',
        )]
        proofs = [*evidence, run_dir / 'omega-body-blocked.json',
                  run_dir / 'input-chunks.json', frames, frame_report, checks_path,
                  *capture_paths, *[Path(row['inputFile']) for row in self.terminal_jsonl(run_dir / 'inputs.jsonl')
                    if row.get('phase') == 'send' and row.get('transport') == 'tmux-paste-buffer']]
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'checks': checks,
            'input_chunks': input_chunks,
            'assertions': [self.required_assertion(
                run_dir,
                'terminal-interaction-frame-and-input-matrix',
                'Current-binary terminal interaction matrix',
                'Exact incremental requests, raw input, partial loading ownership, open intent resize and physical/semantic frames agree.',
                proofs,
                passed=passed,
                reason='Terminal input, lifecycle, frame replay, or cleanup evidence was incomplete',
                evidence_sha256={str(path.resolve()): sha256(path)
                                 for path in proofs if path.is_file()},
            )],
            'cleanup': cleanup,
            'frame_scope': 'Independent native PTY bytes and declared Ink roots; synchronous capture timing, non-Ink regions and tail semantics remain open.',
            'renderer_write_replay': 'not run in broker capture',
        })
        self.record(result)

    def canonical_pane_states(self, run_dir):
        return canonical_debug_states(self.debug(run_dir))

    def canonical_pane(self, run_dir):
        observation = getattr(self, 'canonical_observation', None)
        if observation is not None:
            return observation['state']['pane']
        states = self.canonical_pane_states(run_dir)
        return states[-1]['pane'] if states else None

    def canonical_dock_text(self, run_dir):
        observation = getattr(self, 'canonical_observation', None) or canonical_frame_snapshot(
            self.canonical_pane_states(run_dir), self.terminal_jsonl(run_dir / 'frames.jsonl'),
            getattr(self, 'canonical_frame_floor', 0) or 0, self.terminal_jsonl(run_dir / 'pty-io.jsonl'),
            getattr(self, 'canonical_native_identity', None), getattr(self, 'canonical_action', None),
            self.terminal_capture_boundary(run_dir))
        return observation['body'] if observation and observation['witness'] and observation['witness']['placement'] == 'dock' else ''

    def terminal_canonical_diff(self):
        run_dir, session, target, ready = self.start('terminal-canonical-diff')
        server = self.mock_servers[run_dir.name]
        result = {'label': 'terminal-canonical-diff', 'evidence_dir': str(run_dir)}
        checks = {'ready': ready}
        checkpoints = []
        wire = []
        self.canonical_frame_floor = 0
        self.canonical_observation = None
        self.canonical_action = None
        self.canonical_native_identity = None
        release_checks = {}
        release_done = threading.Event()
        release_cancelled = threading.Event()
        release_thread = None

        def raw(name, data):
            self.canonical_observation = None
            self.canonical_frame_floor = self.terminal_capture_boundary(run_dir)['lastObservedFrameId']
            self.paste_bytes(target, run_dir, data, f'raw-{name}.bin')
            sent = [row for row in self.terminal_jsonl(run_dir / 'inputs.jsonl') if row.get('phase') == 'send']
            self.canonical_action = {'kind': 'input', 'receipt': sent[-1]} if sent else None

        def resize(columns):
            self.canonical_observation = None
            self.canonical_frame_floor = self.terminal_capture_boundary(run_dir)['lastObservedFrameId']
            self.tmux('resize-window', '-t', target, '-x', str(columns), '-y', '34', check=True)
            resized = [row for row in self.terminal_jsonl(run_dir / 'geometry.jsonl') if row.get('phase') == 'resize-return']
            sent = [row for row in self.terminal_jsonl(run_dir / 'geometry.jsonl')
                    if resized and row.get('phase') == 'resize-send' and row.get('actionId') == resized[-1].get('actionId')]
            self.canonical_action = {'kind': 'resize', 'receipt': resized[-1],
                                     'send': sent[0] if len(sent) == 1 else None} if resized else None

        def release_on_receipt():
            deadline = time.monotonic() + 30
            try:
                marker = run_dir / 'omega-body-blocked.json'
                while not release_cancelled.wait(0.01) and time.monotonic() < deadline:
                    if not marker.exists():
                        continue
                    blocked = json.loads(marker.read_text())
                    release_checks['canonical_exact_git_lane'] = blocked.get('lane') == 'canonical-292'
                    os.kill(blocked['pid'], 0)
                    watcher = {'source': 'owned-blocked-marker-watcher', 'blockedMarker': blocked,
                               'livePidObserved': True, 'signalStartedAt': time.monotonic()}
                    release_terminal_git_wrapper(run_dir)
                    watcher['signalCompletedAt'] = time.monotonic()
                    (run_dir / 'canonical-release.json').write_text(json.dumps(watcher, indent=2) + '\n')
                    release_checks['canonical_batch_blocked'] = True
                    release_checks['releaseObservedAt'] = time.monotonic()
                    return
                release_checks['canonical_batch_blocked'] = False
            except (OSError, ValueError, KeyError) as error:
                release_checks['error'] = str(error)
            finally:
                release_done.set()

        def require(name, predicate, timeout=30):
            pane_checkpoint = name in CANONICAL_PANE_CHECKPOINTS or name.startswith('canonical_tab_landing_')
            observation = None
            def probe():
                nonlocal observation
                if pane_checkpoint:
                    if self.canonical_native_identity is None:
                        self.canonical_native_identity = canonical_native_context(run_dir,
                            getattr(self, 'terminal_capture', None), (getattr(self, 'manifest', None) or {}).get('binary_sha256'))
                    observation = canonical_frame_snapshot(self.canonical_pane_states(run_dir),
                        self.terminal_jsonl(run_dir / 'frames.jsonl'), self.canonical_frame_floor,
                        self.terminal_jsonl(run_dir / 'pty-io.jsonl'), self.canonical_native_identity,
                        self.canonical_action, self.terminal_capture_boundary(run_dir))
                    self.canonical_observation = observation
                    if observation is None:
                        return False
                return predicate()
            value = self.wait_until(probe, timeout, 0.1)
            checks[name] = value
            self.capture(target, run_dir / f'{name}-pane.txt', history=False)
            checkpoints.append({'name': name, 'passed': value,
                                'pane': self.canonical_pane(run_dir),
                                'frameFloor': self.canonical_frame_floor,
                                'observation': observation,
                                'action': self.canonical_action,
                                **self.terminal_capture_boundary(run_dir)})
            if not value:
                raise RuntimeError(f'canonical terminal interaction failed: {name}')

        def pane_open():
            pane = self.canonical_pane(run_dir)
            return bool(pane and pane.get('visible') and pane.get('shown') and pane.get('hasTree'))

        def edit(file):
            nonce = hashlib.sha256(str(run_dir.resolve()).encode()).hexdigest()[:24]
            raw(f'{file}-real-read-write', f'RELEASE_CANONICAL_DIFF:{nonce}:{file}\r'.encode())
            require(f'{file}_real_write_receipt', lambda:
                    sum(item.get('response_kind') == f'canonical-{file}-completed'
                        for item in server.snapshot()) == 1
                    and (run_dir / f'project/{file}.txt').read_text() ==
                        canonical_diff_content(file))
            require(f'{file}_prompt_restored', lambda: input_prompt_ready(strip_ansi(
                self.capture(target, run_dir / f'{file}-restored-pane.txt', history=False))))

        try:
            if not ready:
                raise RuntimeError('canonical terminal did not reach readiness')
            resize(110)
            require('canonical_command_owner', lambda:
                    '[Mods:diff] ownership=plugin' in self.debug(run_dir))
            edit('alpha')
            raw('canonical-open', b'/diff\r')
            require('canonical_alpha_dock', lambda: pane_open()
                    and self.canonical_pane(run_dir).get('placement') == 'dock'
                    and 'ALPHA_RELEASE_BODY' in self.canonical_dock_text(run_dir)
                    and 'omega.txt' not in self.canonical_dock_text(run_dir))
            checks['canonical_initial_focus'] = self.canonical_pane(run_dir).get('focused') is False
            (run_dir / 'canonical-omega-arm').touch(mode=0o600)
            release_thread = threading.Thread(target=release_on_receipt, daemon=False)
            release_thread.start()
            edit('omega')
            require('canonical_batch_blocked', lambda: release_done.is_set()
                    and release_checks.get('canonical_batch_blocked') is True)
            checks['canonical_exact_git_lane'] = release_checks.get('canonical_exact_git_lane') is True
            require('canonical_two_files_before_select', lambda: pane_open()
                    and 'alpha.txt' in self.canonical_dock_text(run_dir)
                    and 'omega.txt' in self.canonical_dock_text(run_dir)
                    and 'ALPHA_RELEASE_BODY' in self.canonical_dock_text(run_dir)
                    and 'OMEGA_RELEASE_BODY' not in self.canonical_dock_text(run_dir))
            provider_offset = len(server.snapshot())
            raw('canonical-focus-chord', b'\x18\t')
            require('canonical_focus_landing', lambda:
                    self.canonical_pane(run_dir).get('focused') is True)
            for index in range(32):
                if self.canonical_pane(run_dir).get('focusedElement') == 'file:omega.txt':
                    break
                previous = self.canonical_pane(run_dir).get('focusedElement')
                raw(f'canonical-tab-{index}', b'\t')
                require(f'canonical_tab_landing_{index}', lambda:
                        self.canonical_pane(run_dir).get('focusedElement') != previous, 5)
            require('canonical_omega_control', lambda:
                    self.canonical_pane(run_dir).get('focusedElement') == 'file:omega.txt', 5)
            checks['canonical_before_press_alpha_body'] = (
                'ALPHA_RELEASE_BODY' in self.canonical_dock_text(run_dir)
                and 'OMEGA_RELEASE_BODY' not in self.canonical_dock_text(run_dir))
            raw('canonical-file-press', b'\r')
            require('canonical_file_body', lambda:
                    'OMEGA_RELEASE_BODY' in self.canonical_dock_text(run_dir)
                    and 'ALPHA_RELEASE_BODY' not in self.canonical_dock_text(run_dir))
            raw('canonical-leave-focus', b'\x1b')
            require('canonical_escape_keeps_open', lambda:
                    pane_open() and self.canonical_pane(run_dir).get('focused') is False)
            resize(109)
            require('canonical_inline_same_identity', lambda:
                    pane_open() and self.canonical_pane(run_dir).get('placement') == 'inline'
                    and 'Resize' in self.canonical_observation['screen'])
            resize(110)
            require('canonical_redocked', lambda:
                    pane_open() and self.canonical_pane(run_dir).get('placement') == 'dock'
                    and 'OMEGA_RELEASE_BODY' in self.canonical_dock_text(run_dir))
            raw('canonical-refocus', b'\x18\t')
            require('canonical_refocus_landing', lambda:
                    self.canonical_pane(run_dir).get('focused') is True)
            raw('canonical-close-chord', b'\x18x')
            require('canonical_person_closed', lambda: self.canonical_pane(run_dir) is None)
            raw('canonical-reopen', b'/diff\r')
            require('canonical_reopened', lambda:
                    pane_open() and 'ALPHA_RELEASE_BODY' in self.canonical_dock_text(run_dir)
                    and 'OMEGA_RELEASE_BODY' not in self.canonical_dock_text(run_dir))
            checks['canonical_reopen_scroll_reset'] = (
                'ALPHA_RELEASE_LINE_000' in self.canonical_dock_text(run_dir))
            raw('canonical-command-close', b'/diff\r')
            require('canonical_command_closed', lambda: self.canonical_pane(run_dir) is None)
            resize(109)
            raw('canonical-too-narrow', b'/diff\r')
            require('canonical_narrow_refused', lambda: self.canonical_pane(run_dir) is None
                    and 'Resize your terminal to at least 110 columns to show the diff panel'
                    in self.canonical_observation['screen'])
            checks['canonical_no_native_fallback'] = '[diff] open' not in self.debug(run_dir)
            checks['canonical_keyboard_owner'] = (
                len(server.snapshot()) == provider_offset)
            checks['scenario_completed'] = True
        except Exception as error:
            result['error'] = str(error)
            checks['scenario_completed'] = False
        finally:
            release_cancelled.set()
            if release_thread is not None:
                release_thread.join(timeout=2)
                checks['canonical_release_watcher_stopped'] = not release_thread.is_alive()
            release_terminal_git_wrapper(run_dir)
            wire = server.snapshot()
            native_exit_requested = False
            exit_identity = terminal_native_exit_identity(run_dir, getattr(self, 'terminal_capture', None),
                (getattr(self, 'manifest', None) or {}).get('binary_sha256'))
            try:
                raw('canonical-cleanup-leave-focus', b'\x1b')
                if self.canonical_pane(run_dir) is not None:
                    raw('canonical-cleanup-close', b'/diff\r')
                    self.wait_until(lambda: self.canonical_pane(run_dir) is None, 5, 0.1)
                raw('canonical-cleanup-native-exit', b'/exit\r')
                native_exit_requested = True
                result['native_exit_observation'] = {'producerClosedBeforeCaptureClose': exit_identity is not None and self.wait_until(lambda:
                    terminal_native_producer_exit_passed(run_dir, exit_identity['capture'], exit_identity['binarySha256']),
                    5, 0.1)}
            except Exception as error:
                result['native_exit_error'] = str(error)
            cleanup = self.close(run_dir, session, target)
            checks['normal_native_exit'] = native_exit_requested and exit_identity is not None and terminal_native_exit_passed(
                run_dir, exit_identity['capture'], exit_identity['binarySha256'])
        checks['cleanup'] = self.cleanup_passed(cleanup)
        checks['bounded_terminal_evidence'] = (cleanup.get('terminal_capture') or {}).get('seal_exit') == 0
        checks['full_terminal_coverage'] = False
        if (run_dir / 'capture-launch.json').is_file():
            try:
                full_verify = self.terminal_capture_command('verify', run_dir / 'capture-launch.json')
                checks['full_terminal_coverage'] = full_verify.returncode == 0
            except (OSError, subprocess.SubprocessError) as error:
                result['full_coverage_error'] = str(error)
        try:
            fresh = json.loads((run_dir / 'independent-pty-checks.json').read_text())
            physical = fresh['recheck'].get('replay', {})
            checks['independent_pty_capture_identity'] = fresh['captureIdentityPassed'] is True
            checks['independent_pty_ink_frames'] = fresh['recheck']['verdict'] == 'passed'
            checks['independent_pty_resize_sequence'] = terminal_resize_sizes(physical) == [
                (110, 34), (109, 34), (110, 34), (109, 34)]
        except (OSError, ValueError, KeyError) as error:
            result['physical_error'] = str(error)
            checks['independent_pty_ink_frames'] = False
        wire = server.snapshot()
        host = urlsplit(json.loads((run_dir / 'run-metadata.json').read_text())['mock_openai']['base_url']).netloc
        checks.update(canonical_wire_checks(run_dir, wire, self.debug(run_dir), host))
        watcher_path = run_dir / 'canonical-release.json'
        watcher = json.loads(watcher_path.read_text()) if watcher_path.exists() else {}
        try:
            output, raw_output = canonical_git_output(run_dir, watcher['blockedMarker']['argv'])
            (run_dir / 'canonical-git-output.json').write_text(json.dumps(output, indent=2) + '\n')
            (run_dir / 'canonical-git-output.raw').write_bytes(raw_output)
        except (OSError, KeyError, ValueError, subprocess.SubprocessError) as error:
            result['git_output_error'] = str(error)
        checks.update(canonical_git_checks(run_dir, self.terminal_jsonl(run_dir / 'canonical-git.jsonl'),
                                          watcher, self.debug(run_dir)))
        states = self.canonical_pane_states(run_dir)
        (run_dir / 'canonical-checkpoints.json').write_text(json.dumps(checkpoints, indent=2) + '\n')
        (run_dir / 'canonical-ui-states.json').write_text(json.dumps(states, indent=2) + '\n')
        (run_dir / 'canonical-wire.json').write_text(json.dumps(wire, indent=2) + '\n')
        checks.update(canonical_ui_checks(run_dir, self.canonical_native_identity))
        result['native_association_scope'] = 'Bounded native span, transport and Mach geometry; child read/parser/owner and timing remain uncovered.' if self.canonical_native_identity else None
        checks_path = run_dir / 'canonical-checks.json'
        checks_path.write_text(json.dumps(checks, indent=2) + '\n')
        proofs = [run_dir / name for name in (
            'canonical-checkpoints.json', 'canonical-ui-states.json', 'canonical-wire.json',
            'canonical-git.jsonl', 'omega-body-blocked.json', 'canonical-release.json',
            'canonical-git-output.json', 'canonical-git-output.raw',
            'canonical-checks.json', 'debug.log',
            'capture-launch.json', 'bin/claude',
            'terminal-capture.json', 'frame-physical-report.json', 'independent-pty-checks.json',
            'capture-verify-stdout.txt', 'capture-verify-stderr.txt',
        )]
        held_launch = json.loads(getattr(self, 'registered_runs', {}).get(str(run_dir.resolve()), '{}')).get('terminal_capture', {})
        proofs.extend(run_dir / name for name in sorted(terminal_capture_required_files(held_launch) or ()))
        proofs.extend(Path(row['inputFile']) for row in self.terminal_jsonl(run_dir / 'inputs.jsonl')
                      if row.get('phase') == 'send' and row.get('transport') == 'tmux-paste-buffer')
        passed = all(checks.values())
        result.update({
            'validation_verdict': 'passed' if passed else 'failed', 'checks': checks,
            'cleanup': cleanup,
            'frame_scope': 'Independent native PTY and declared Ink roots; synchronous capture timing and non-Ink/tail semantics remain open.',
            'assertions': [self.required_assertion(
                run_dir, 'terminal-canonical-diff-real-tools-and-pty',
                'Official shipped Mods Diff through the real CLI',
                'Real Read/Write receipts trigger the canonical Git batch; actual pane identity, focus, keyboard, resize, close/reopen and independent PTY frames agree.',
                proofs, passed=passed,
                reason=result.get('error', 'canonical tool, UI, PTY or cleanup evidence incomplete'),
                evidence_sha256={str(path.resolve()): sha256(path)
                                 for path in proofs if path.is_file()},
            )],
        })
        self.record(result)

    def mods_process_spawn(self):
        import importlib.util
        run_dir = self.evidence_root / 'mods-process-spawn'
        run_dir.mkdir()
        metadata_path = run_dir / 'run-metadata.json'
        metadata_path.write_text(json.dumps({
            'label': 'mods-process-spawn', 'source_run': run_dir.name,
            'driver_run': f'{self.stamp}-{self.pid}',
            'evidence_dir': str(run_dir.resolve()), 'binary': str(self.binary),
            'binary_sha256': self.manifest['binary_sha256'],
        }, indent=2) + '\n')
        self.registered_runs[str(run_dir.resolve())] = metadata_path.read_text()
        script = self.repo / 'scripts/validate-mods-process-spawn.py'
        command = [sys.executable, str(script), '--binary', str(self.binary),
                   '--binary-sha256', self.manifest['binary_sha256'],
                   '--evidence-root', str(run_dir / 'native')]
        completed = subprocess.run(command, cwd=self.repo, capture_output=True,
                                   text=True, check=False)
        (run_dir / 'stdout.txt').write_text(completed.stdout)
        (run_dir / 'stderr.txt').write_text(completed.stderr)
        checks = {'foreground_native_exit': completed.returncode == 0}
        error = None
        held_sha = None
        try:
            receipt = json.loads(completed.stdout)
            held_sha = receipt['reportSHA256']
            spec = importlib.util.spec_from_file_location('mods_spawn_probe', script)
            probe = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(probe)
            checks.update(probe.recheck_process_spawn_report(
                run_dir / 'native', held_sha, self.manifest['binary_sha256']))
        except (OSError, ValueError, KeyError, TypeError) as failure:
            error = str(failure)
            checks['closed_originals_rechecked'] = False
        else:
            checks['closed_originals_rechecked'] = True
        checks_path = run_dir / 'process-spawn-checks.json'
        checks_path.write_text(json.dumps({
            'checks': checks, 'held_report_sha256': held_sha,
            'error': error, 'command': command,
            'coverage': 'eight actual author CLI contracts; no complete UI/Mods claim',
        }, indent=2) + '\n')
        proofs = [checks_path, run_dir / 'stdout.txt', run_dir / 'stderr.txt',
                  run_dir / 'native/evidence/result.json',
                  run_dir / 'native/evidence/debug.log',
                  run_dir / 'native/evidence/pty.raw',
                  run_dir / 'native/evidence/inputs.jsonl',
                  run_dir / 'native/evidence/driver-used.py',
                  run_dir / 'native/cwd/children.jsonl']
        passed = all(checks.values())
        if passed:
            report = json.loads((run_dir / 'native/evidence/result.json').read_bytes())
            proofs = list(dict.fromkeys([*proofs, *(run_dir / 'native' / name
                        for name in report['artifactsSHA256'])]))
            metadata = json.loads(self.registered_runs[str(run_dir.resolve())])
            metadata.update(process_spawn_root=str(run_dir / 'native'),
                            process_spawn_report_sha256=held_sha,
                            process_spawn_probe_sha256=sha256(script))
            metadata_path.write_text(json.dumps(metadata, indent=2) + '\n')
            self.registered_runs[str(run_dir.resolve())] = metadata_path.read_text()
        self.record({
            'label': 'mods-process-spawn', 'evidence_dir': str(run_dir),
            'validation_verdict': 'passed' if passed else 'failed',
            'checks': checks,
            'assertions': [self.required_assertion(
                run_dir, 'mods-process-spawn-real-author',
                'Process stream through actual author CLI',
                'Eight real author calls preserve pipes, raw/wrapped receipts, origin, repeat, deny and close semantics; owned children and socket close, with held report and originals rechecked.',
                proofs, passed=passed,
                reason=error or 'process.spawn actual entry contract failed',
                evidence_sha256={str(path.resolve()): sha256(path)
                                 for path in proofs if path.is_file()},
            )],
        })

    def builtin_mods(self):
        run_dir = self.evidence_root / 'builtin-mods'
        run_dir.mkdir()
        cache = Path(tempfile.mkdtemp(prefix='mods-release-', dir='/private/tmp'))
        metadata_path = run_dir / 'run-metadata.json'
        metadata_path.write_text(json.dumps({
            'label': 'builtin-mods',
            'source_run': 'builtin-mods',
            'driver_run': f'{self.stamp}-{self.pid}',
            'evidence_dir': str(run_dir.resolve()),
            'binary': str(self.binary),
            'binary_sha256': self.manifest['binary_sha256'],
            'builtin_archive_source': str(cache),
            'builtin_archive_root': str(run_dir / 'acceptance-cache'),
        }, indent=2) + '\n')
        self.registered_runs[str(run_dir.resolve())] = metadata_path.read_text()
        completed = subprocess.run(
            [
                'bun', str(self.repo / 'scripts/mods-test-lab.mjs'),
                'accept-builtin', '--binary', str(self.binary),
                '--cache', str(cache),
            ],
            cwd=self.repo,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        (run_dir / 'stdout.txt').write_text(completed.stdout)
        (run_dir / 'stderr.txt').write_text(completed.stderr)
        reports = list((cache / 'runs').glob('r-*/acceptance.json'))
        report = None
        report_error = None
        archived_report = None
        original_report = None
        archive_receipt = run_dir / 'builtin-cache-archive.json'
        cache_removed = False
        archive_verified = False
        producers_closed = False
        archive_current = False
        archived_snapshot = None
        archive_receipt_sha256 = None
        archive = run_dir / 'acceptance-cache'
        try:
            if len(reports) == 1:
                relative_report = reports[0].relative_to(cache)
                archive = run_dir / 'acceptance-cache'
                archived_snapshot = archive_builtin_cache(cache, archive, archive_receipt)
                # Pin the parent-produced receipt before any consumer or cleanup.
                # It binds the original launch bytes, not a later coupled rewrite.
                archive_receipt_sha256 = sha256(archive_receipt)
                archive_verified = True
                original_report = archive / relative_report
                report = remap_path_strings(
                    json.loads(original_report.read_text()),
                    cache.resolve(),
                    archive.resolve(),
                )
                archived_report = run_dir / 'acceptance-remapped.json'
                archived_report.write_text(json.dumps(report, indent=2) + '\n')
                # Preserve malformed originals, then settle them as failed evidence.
                if not isinstance(report, dict):
                    raise ValueError('Builtin acceptance report must be an object')
                pair, assertions = report.get('pair', {}), report.get('assertions', {})
                if (not isinstance(pair, dict) or not isinstance(assertions, dict)
                        or any(not isinstance(value, dict) for value in assertions.values())
                        or not isinstance(report.get('evidence', ''), str)):
                    raise ValueError('Builtin acceptance pair/assertions/evidence have invalid types')
                for name, side in pair.items():
                    if not isinstance(side, dict):
                        raise ValueError(f'Builtin side {name} must be an object')
                    if any(key in side and not isinstance(side[key], str) for key in ('run', 'socket')):
                        raise ValueError(f'Builtin side {name} paths must be strings')
                    captures, cleanup = side.get('captures', {}), side.get('cleanup', {})
                    if (not isinstance(captures, dict) or not isinstance(cleanup, dict)
                            or any(not isinstance(value, str) for value in captures.values())):
                        raise ValueError(f'Builtin side {name} captures/cleanup have invalid types')
                    terminal = cleanup.get('terminalCapture', {})
                    files = terminal.get('files', {}) if isinstance(terminal, dict) else None
                    if (not isinstance(files, dict)
                            or any(not isinstance(info, dict)
                                   or ('path' in info and not isinstance(info['path'], str))
                                   for info in files.values())):
                        raise ValueError(f'Builtin side {name} terminal files have invalid types')
            else:
                report_error = f'expected exactly one acceptance.json, found {len(reports)}'
        except (OSError, ValueError, TypeError) as error:
            report_error = str(error)
            report = None
        finally:
            # Failed or incomplete archives must retain the actual producer bytes.
            producers_closed = archive_verified and builtin_cache_producers_closed(
                cache, self.manifest['binary_sha256'])
            archive_current = producers_closed and builtin_cache_archive_matches(
                cache, archive, archive_receipt, archived_snapshot)
            if archive_current:
                try:
                    shutil.rmtree(cache)
                    cache_removed = not cache.exists()
                except OSError as error:
                    report_error = report_error or f'cache cleanup failed: {error}'

        expected_assertions = BUILTIN_ASSERTIONS
        checks = {
            'subprocess': completed.returncode == 0,
            'report': report is not None,
            'assertions': False,
            'binary': False,
            'sides': False,
            'evidence_ownership': False,
            'cache_cleanup': cache_removed,
            'independent_frame_replay': False,
        }
        recheck_path = run_dir / 'builtin-terminal-recheck.json'
        if report is not None and archived_report is not None:
            assertions = report.get('assertions', {})
            pair = report.get('pair', {})
            sides = [pair.get(name) for name in (
                'privacyOff', 'privacyOn', 'enabled', 'disabled',
                'securityOrdinary', 'securityTeam', 'securityEnterprise',
            )]
            checks['assertions'] = (
                set(assertions) == expected_assertions
                and all(assertions[name].get('verdict') == 'passed' for name in expected_assertions)
            )
            checks['sides'] = all(isinstance(side, dict) for side in sides)
            checks['binary'] = checks['sides'] and all(
                side.get('binarySha256') == self.manifest['binary_sha256']
                for side in sides
            )
            target_root = run_dir.resolve()
            evidence_paths = [archived_report, Path(report.get('evidence', ''))]
            durable_paths = list(evidence_paths)
            for side in sides:
                if not isinstance(side, dict):
                    continue
                run_path = side.get('run')
                if isinstance(run_path, str) and run_path.startswith('/'):
                    path = Path(run_path)
                    evidence_paths.append(path)
                    durable_paths.append(path)
                socket_path = side.get('socket')
                if isinstance(socket_path, str) and socket_path.startswith('/'):
                    evidence_paths.append(Path(socket_path))
                captures = [
                    Path(value) for value in side.get('captures', {}).values()
                    if isinstance(value, str)
                ]
                evidence_paths.extend(captures)
                durable_paths.extend(captures)
            checks['evidence_ownership'] = (
                all(
                    is_relative_to(path.resolve(strict=False), target_root)
                    for path in evidence_paths
                )
                and all(path.exists() for path in durable_paths)
            )
            rechecked = subprocess.run([
                'bun', '--no-env-file', str(self.repo / 'scripts/recheck-builtin-terminal-evidence.mjs'),
                str(archived_report), self.manifest['binary_sha256'], str(recheck_path), str(archive_receipt),
            ], cwd=self.repo, text=True, capture_output=True, check=False, timeout=120)
            (run_dir / 'terminal-recheck-stdout.txt').write_text(rechecked.stdout)
            (run_dir / 'terminal-recheck-stderr.txt').write_text(rechecked.stderr)
            try:
                recheck = json.loads(recheck_path.read_text())
                checks['independent_frame_replay'] = (
                    rechecked.returncode == 0 and recheck.get('verdict') == 'passed'
                    and len(recheck.get('sides', {})) == 7
                )
            except (OSError, json.JSONDecodeError) as error:
                report_error = report_error or f'independent terminal recheck failed: {error}'
        checks_path = run_dir / 'builtin-mods-checks.json'
        checks_path.write_text(json.dumps({
            'checks': checks,
            'report_error': report_error,
            'temporary_cache': str(cache),
            'retained_cache': str(cache) if cache.exists() else None,
            'cache_producers_closed': producers_closed,
            'cache_archive_current': archive_current,
        }, indent=2) + '\n')
        proofs = [checks_path, run_dir / 'stdout.txt', run_dir / 'stderr.txt']
        if archive_receipt.exists():
            proofs.append(archive_receipt)
        if original_report is not None:
            proofs.append(original_report)
        if archived_report is not None:
            proofs.append(archived_report)
        if recheck_path.exists():
            proofs.append(recheck_path)
        if report is not None and archived_report is not None:
            metadata = json.loads(metadata_path.read_text())
            metadata.update(acceptance_report=str(archived_report.resolve()),
                            acceptance_sha256=sha256(archived_report),
                            builtin_archive_receipt_sha256=archive_receipt_sha256,
                            builtin_capture_registry={name: {
                                key: report.get('pair', {}).get(name, {}).get(key)
                                for key in ('run', 'target', 'pane', 'captureId', 'binarySha256')}
                                for name in BUILTIN_SIDE_NAMES})
            for name in BUILTIN_SIDE_NAMES:
                side = report.get('pair', {}).get(name, {})
                if not isinstance(side, dict) or not isinstance(side.get('run'), str):
                    continue  # Incomplete business reports remain failed, not a driver exception.
                root = Path(side['run'])
                try:
                    if (not root.is_absolute() or root.is_symlink() or root.resolve() != root
                            or not is_relative_to(root, run_dir / 'acceptance-cache')):
                        raise ValueError('Capture launch is outside the owned archived run')
                    path = root / 'capture-launch.json'
                    info = path.lstat()
                    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                            or info.st_uid != os.getuid()):
                        raise ValueError('Capture launch file is not an owned regular original')
                    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as source:
                        actual = os.fstat(source.fileno())
                        if (actual.st_dev, actual.st_ino) != (info.st_dev, info.st_ino):
                            raise ValueError('Capture launch identity changed during read')
                        launch = json.loads(source.read())
                    metadata['builtin_capture_registry'][name].update(
                        originalRun=str(cache / root.relative_to(archive)),
                        driverPid=launch.get('driverPid'), capture=launch.get('capture'))
                except (OSError, ValueError, TypeError, AttributeError) as error:
                    metadata['builtin_capture_registry'][name]['capture_launch_error'] = str(error)
            metadata_path.write_text(json.dumps(metadata, indent=2) + '\n')
            self.registered_runs[str(run_dir.resolve())] = metadata_path.read_text()
            for side in report.get('pair', {}).values():
                if not isinstance(side, dict):
                    continue
                files = side.get('cleanup', {}).get('terminalCapture', {}).get('files', {})
                proofs.extend(Path(info['path']) for info in files.values() if isinstance(info, dict) and 'path' in info)
                if side.get('run'):
                    root = Path(side['run'])
                    proofs.append(root / 'capture-launch.json')
                    proofs.append(root / 'bin/claude')
                    for sent in self.terminal_jsonl(root / 'inputs.jsonl'):
                        if sent.get('phase') == 'send' and sent.get('transport') == 'tmux-paste-buffer':
                            proofs.append(Path(sent['inputFile']))
                proofs.extend(Path(path) for path in side.get('captures', {}).values())
        proofs = sorted(set(proofs))
        passed = all(checks.values())
        result = {
            'label': 'builtin-mods',
            'evidence_dir': str(run_dir),
            'validation_verdict': 'passed' if passed else 'failed',
            'checks': checks,
            'acceptance_report': str(archived_report) if archived_report else None,
            'assertions': [self.required_assertion(
                run_dir,
                'builtin-mods-compiled-acceptance',
                'Compiled builtin Mods acceptance',
                'The current binary passes agents-md, diff, telemetry, compiled native sec-default policy and ModsPane interaction, dynamic tools, suggestion reload, independent raw-backed physical terminal replay for every side, completeness, cleanup, identity and evidence ownership checks.',
                proofs,
                passed=passed,
                reason=report_error or 'builtin Mods compiled acceptance checks failed',
                evidence_sha256={str(path.resolve()): sha256(path)
                                 for path in proofs if path.is_file()},
            )],
        }
        self.record(result)

    def paste_bytes(self, target, run_dir, data, filename):
        input_path = run_dir / filename
        with os.fdopen(os.open(input_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                               0o600), 'wb') as input_file:
            input_file.write(data)
        buffer_name = f'cc-release-{self.pid}-{self.session_index}'
        commands = [
            ['load-buffer', '-b', buffer_name, str(input_path)],
            ['paste-buffer', '-b', buffer_name, '-t', target],
        ]
        capture = getattr(self, 'terminal_capture', None)
        if not capture or capture['run'] != str(run_dir):
            for args in commands:
                self.tmux(*args, check=True)
            return
        action = self.terminal_input_begin(run_dir, {
            'transport': 'tmux-paste-buffer', 'target': target,
            'buffer': buffer_name, 'inputFile': str(input_path),
            'hex': data.hex(), 'bytesSHA256': hashlib.sha256(data).hexdigest(),
            'actualCommands': commands,
        }) if capture and capture['run'] == str(run_dir) else None
        exits = []
        try:
            for args in commands:
                completed = self.tmux(*args, check=False)
                exits.append(completed.returncode)
                if completed.returncode:
                    raise RuntimeError(f'raw terminal input failed: {completed.stderr}')
        finally:
            if action is not None:
                self.terminal_append(run_dir / 'inputs.jsonl', {
                    'actionId': action,
                    'phase': 'sent' if exits == [0, 0] else 'failed',
                    'exitCodes': exits, **self.terminal_capture_boundary(run_dir),
                })

    def send(self, target, run_dir, text, filename, *, confirm_pending=True):
        self.paste_bytes(
            target,
            run_dir,
            b'\x1b[200~' + text.encode() + b'\x1b[201~',
            filename,
        )
        submitted_path = run_dir / f'02-submitted-{Path(filename).stem}-pane.txt'

        def capture_pending():
            pane = self.capture(target, submitted_path)
            return pane, (
                submitted_input_visible(pane, text)
                and submitted_input_pending(pane)
            )

        paste_ready = self.wait_until(
            lambda: submitted_input_visible(
                capture_pending()[0],
                text,
            ),
            5,
            0.1,
        )
        if not paste_ready:
            raise RuntimeError(
                f'pasted input did not become ready for submission: {submitted_path}'
            )

        self.tmux('send-keys', '-t', target, 'Enter', check=True)
        time.sleep(0.5)
        submitted, is_pending = capture_pending()

        if confirm_pending and is_pending:
            plain = strip_ansi(submitted)
            if re.search(r'\bEsc to (?:cancel|close)\b', plain):
                is_pending = False

        if confirm_pending and is_pending:
            self.tmux('send-keys', '-t', target, 'Enter', check=True)
            cleared = self.wait_until(lambda: not capture_pending()[1], 5, 0.1)
            if not cleared:
                raise RuntimeError(
                    f'input remained pending after confirmation: {submitted_path}'
                )

    def debug(self, run_dir):
        path = run_dir / 'debug.log'
        return path.read_text(errors='replace') if path.exists() else ''

    def ssh_fixture_events(self, run_dir):
        path = run_dir / 'fake-ssh-io.jsonl'
        if not path.exists():
            return []
        events = []
        for line in path.read_text(errors='replace').splitlines():
            try:
                events.append(json.loads(line).get('event'))
            except json.JSONDecodeError:
                continue
        return events

    def transcript_paths(self, run_dir, *, include_subagents=False):
        paths = (run_dir / 'config').glob('projects/**/*.jsonl')
        if include_subagents:
            return list(paths)
        return [path for path in paths if 'subagents' not in path.parts]

    def transcript(self, run_dir):
        return '\n'.join(
            path.read_text(errors='replace') for path in self.transcript_paths(run_dir)
        )

    def compact_boundaries(self, run_dir):
        boundaries = []
        for path in self.transcript_paths(run_dir):
            for entry in self.path_entries(path):
                if (
                    entry.get('type') == 'system'
                    and entry.get('subtype') == 'compact_boundary'
                ):
                    boundaries.append({
                        'openAICompaction': entry.get('openAICompaction'),
                        'compactMetadata': entry.get('compactMetadata'),
                    })
        return boundaries

    def assistant_text(self, run_dir, *, subagents=False):
        text = []
        paths = self.transcript_paths(run_dir, include_subagents=subagents)
        if subagents:
            paths = [path for path in paths if 'subagents' in path.parts]
        for path in paths:
            for entry in self.path_entries(path):
                if entry.get('type') != 'assistant':
                    continue
                message = entry.get('message')
                if not isinstance(message, dict) or message.get('role') != 'assistant':
                    continue
                content = message.get('content')
                if isinstance(content, str):
                    text.append(content)
                    continue
                if not isinstance(content, list):
                    continue
                text.extend(
                    block['text']
                    for block in content
                    if isinstance(block, dict)
                    and block.get('type') == 'text'
                    and isinstance(block.get('text'), str)
                )
        return '\n'.join(text)

    def path_entries(self, path):
        for line in path.read_text(errors='replace').splitlines():
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue

    def transcript_entries(self, run_dir, *, include_subagents=False):
        for path in self.transcript_paths(
            run_dir, include_subagents=include_subagents
        ):
            for entry in self.path_entries(path):
                yield path, entry

    def notification_count(self, run_dir):
        return sum(
            1
            for _, entry in self.transcript_entries(run_dir)
            if entry.get('type') == 'user'
            and entry.get('origin', {}).get('kind') == 'task-notification'
        )

    def wait_for_notification_count(
        self, run_dir, expected, timeout=10, interval=0.1
    ):
        return self.wait_until(
            lambda: self.notification_count(run_dir) == expected,
            timeout,
            interval,
        )

    def tool_evidence(self, run_dir, names, paths=None, allowed_names=None):
        ids = {name: set() for name in names}
        unexpected_tool_names = set()
        tool_use_counts = {}
        tool_inputs = {}
        results = {}

        def visit(value):
            if isinstance(value, dict):
                name = value.get('name')
                tool_id = value.get('id')
                if value.get('type') == 'tool_use' and isinstance(name, str):
                    if (
                        allowed_names is not None
                        and name not in names
                        and name not in allowed_names
                    ):
                        unexpected_tool_names.add(name)
                    if name in ids and isinstance(tool_id, str):
                        ids[name].add(tool_id)
                        tool_use_counts[tool_id] = tool_use_counts.get(tool_id, 0) + 1
                        tool_inputs.setdefault(tool_id, []).append(value.get('input'))
                result_id = value.get('tool_use_id')
                if (
                    value.get('type') == 'tool_result'
                    and isinstance(result_id, str)
                ):
                    results.setdefault(result_id, []).append(value)
                for child in value.values():
                    visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)

        entries = (
            (entry for path in paths for entry in self.path_entries(path))
            if paths is not None
            else (
                entry
                for _, entry in self.transcript_entries(
                    run_dir, include_subagents=True
                )
            )
        )
        for entry in entries:
            visit(entry)
        evidence = {
            name: {
                'tool_use_ids': sorted(tool_ids),
                'tool_use_counts': {
                    tool_id: tool_use_counts[tool_id]
                    for tool_id in sorted(tool_ids)
                },
                'tool_inputs': {
                    tool_id: tool_inputs.get(tool_id, [])
                    for tool_id in sorted(tool_ids)
                },
                'result_counts': {
                    tool_id: len(results.get(tool_id, []))
                    for tool_id in sorted(tool_ids)
                },
                'successful_result_ids': sorted(
                    tool_id
                    for tool_id in tool_ids
                    if len(results.get(tool_id, [])) == 1
                    and results[tool_id][0].get('is_error') is not True
                ),
                'failed_result_ids': sorted(
                    tool_id
                    for tool_id in tool_ids
                    if len(results.get(tool_id, [])) == 1
                    and results[tool_id][0].get('is_error') is True
                ),
                'invalid_result_ids': sorted(
                    tool_id
                    for tool_id in tool_ids
                    if len(results.get(tool_id, [])) != 1
                ),
                'failed_result_messages': {
                    tool_id: [tool_result_text(results[tool_id][0].get('content'))]
                    for tool_id in sorted(tool_ids)
                    if len(results.get(tool_id, [])) == 1
                    and results[tool_id][0].get('is_error') is True
                },
            }
            for name, tool_ids in ids.items()
        }
        if allowed_names is not None:
            evidence['unexpected_tool_names'] = sorted(unexpected_tool_names)
        return evidence

    def deep_research_web_tools_complete(self, web_tools, phase_evidence):
        selected_sources = phase_evidence['select-sources'].get('selected_sources')
        if selected_sources is None:
            return False
        expected_fetches = len(selected_sources)
        return (
            tool_occurrence_count(web_tools['WebSearch']) == 5
            and len(web_tools['WebSearch']['successful_result_ids']) == 5
            and not web_tools['WebSearch']['failed_result_ids']
            and not web_tools['WebSearch']['invalid_result_ids']
            and tool_occurrence_count(web_tools['WebFetch']) == expected_fetches
            and not web_tools['WebFetch']['invalid_result_ids']
            and (
                len(web_tools['WebFetch']['successful_result_ids'])
                + len(web_tools['WebFetch']['failed_result_ids'])
                == expected_fetches
            )
        )

    def deep_research_phase_evidence(self, run_dir):
        attempts = {'search': {}, 'fetch': {}}
        passive_workers = {
            'select-sources': {},
            'verify': {},
            'synthesize': {},
        }
        for meta_path in (run_dir / 'config').glob(
            'projects/**/subagents/*.meta.json'
        ):
            try:
                metadata = json.loads(meta_path.read_text())
            except json.JSONDecodeError:
                continue
            description = metadata.get('description', '')
            transcript_path = meta_path.with_name(
                meta_path.name.removesuffix('.meta.json') + '.jsonl'
            )
            entries = (
                list(self.path_entries(transcript_path))
                if transcript_path.is_file()
                else []
            )
            match = re.fullmatch(
                r'deep-research: (search|fetch) (\d+)/(\d+)(?: retry \d+(?:/\d+)?)?',
                description,
            )
            if not match:
                passive_match = re.fullmatch(
                    r'(?:deep-research: (select-sources)'
                    r'|deep-research: (verify)(?: (\d+)/(\d+))?'
                    r'|deep-research: (synthesize))'
                    r'(?: retry \d+(?:/\d+)?)?',
                    description,
                )
                if not passive_match:
                    continue
                phase = (
                    passive_match.group(1)
                    or passive_match.group(2)
                    or passive_match.group(5)
                )
                index = passive_match.group(3) or '1'
                all_tools = self.tool_evidence(
                    run_dir,
                    set(),
                    [transcript_path] if transcript_path.is_file() else [],
                    allowed_names=set(),
                )
                passive_workers[phase].setdefault(index, []).append({
                    'agent_id': metadata.get('agentId') or meta_path.name[6:-10],
                    'expected_total': int(passive_match.group(4) or 1),
                    'retry': ' retry ' in description,
                    'transcript': str(transcript_path),
                    'tool_names': all_tools['unexpected_tool_names'],
                    'structured_output': assistant_structured_output(entries),
                    'selected_sources': assistant_selected_sources(entries),
                })
                continue
            phase, index, total = match.groups()
            tool = 'WebSearch' if phase == 'search' else 'WebFetch'
            tool_evidence = self.tool_evidence(
                run_dir,
                {tool, 'ToolSearch'},
                [transcript_path] if transcript_path.is_file() else [],
                allowed_names=set(),
            )
            discovery = tool_evidence['ToolSearch']
            discovery_valid = (
                tool_occurrence_count(discovery) <= 1
                and not discovery['failed_result_ids']
                and not discovery['invalid_result_ids']
                and all(
                    tool_input in (
                        {'query': f'select:{tool}'},
                        {'query': f'select:{tool}', 'max_results': 1},
                    )
                    for tool_inputs in discovery['tool_inputs'].values()
                    for tool_input in tool_inputs
                )
            )
            tool_result = tool_evidence[tool]
            prompt = next(
                (
                    entry.get('message', {}).get('content')
                    for entry in entries
                    if entry.get('type') == 'user'
                    and isinstance(entry.get('message'), dict)
                    and isinstance(entry['message'].get('content'), str)
                ),
                '',
            )
            attempts[phase].setdefault(index, []).append({
                'agent_id': metadata.get('agentId') or meta_path.name[6:-10],
                'expected_total': int(total),
                'retry': ' retry ' in description,
                'prompt': prompt,
                'selected_source': (
                    assistant_selected_source(entries)
                    if phase == 'fetch'
                    else None
                ),
                'structured_output': (
                    assistant_structured_output(entries)
                    if phase == 'fetch'
                    else None
                ),
                'transcript': str(transcript_path),
                'tool': tool,
                'discovery_tool_occurrences': tool_occurrence_count(discovery),
                'unexpected_tool_names': (
                    tool_evidence['unexpected_tool_names']
                    if discovery_valid
                    else [
                        *tool_evidence['unexpected_tool_names'],
                        'ToolSearch',
                    ]
                ),
                **tool_result,
            })

        required = {'search': 5, 'fetch': 15}
        result = {}
        for phase, count in required.items():
            expected_indexes = {str(index) for index in range(1, count + 1)}
            attempt_counts = {
                index: len(phase_attempts)
                for index, phase_attempts in attempts[phase].items()
            }
            tool_counts = {
                index: {
                    'tool_uses': sum(
                        len(attempt['tool_use_ids']) for attempt in phase_attempts
                    ),
                    'tool_use_occurrences': sum(
                        sum(attempt['tool_use_counts'].values())
                        for attempt in phase_attempts
                    ),
                    'successful_results': sum(
                        len(attempt['successful_result_ids'])
                        for attempt in phase_attempts
                    ),
                    'failed_results': sum(
                        len(attempt['failed_result_ids'])
                        for attempt in phase_attempts
                    ),
                    'invalid_results': sum(
                        len(attempt['invalid_result_ids'])
                        for attempt in phase_attempts
                    ),
                }
                for index, phase_attempts in attempts[phase].items()
            }
            failed_messages = {
                index: [
                    message
                    for attempt in phase_attempts
                    for messages in attempt['failed_result_messages'].values()
                    for message in messages
                ]
                for index, phase_attempts in attempts[phase].items()
            }
            failed_output_mismatch_indexes = sorted(
                index
                for index, phase_attempts in attempts[phase].items()
                if phase == 'fetch'
                and failed_messages[index]
                and any(
                    attempt['structured_output'] is None
                    or attempt['structured_output'].get('claims') != []
                    or attempt['structured_output'].get('sourceQuality') != 'unreliable'
                    for attempt in phase_attempts
                )
            )
            failed_output_mismatches = set(failed_output_mismatch_indexes)
            retry_indexes = sorted(
                index
                for index, phase_attempts in attempts[phase].items()
                if len(phase_attempts) != 1
                or any(attempt['retry'] for attempt in phase_attempts)
            )
            unexpected_tool_indexes = sorted(
                index
                for index, phase_attempts in attempts[phase].items()
                if any(
                    attempt['unexpected_tool_names']
                    for attempt in phase_attempts
                )
            )
            source_mismatch_indexes = sorted(
                index
                for index, phase_attempts in attempts[phase].items()
                if phase == 'fetch'
                and len(phase_attempts) == 1
                and (
                    phase_attempts[0]['selected_source'] is None
                    or phase_attempts[0]['selected_source']['rank'] != int(index)
                    or any(
                        normalize_source_url(tool_input.get('url'))
                        != phase_attempts[0]['selected_source']['url']
                        for tool_inputs in phase_attempts[0]['tool_inputs'].values()
                        for tool_input in tool_inputs
                        if isinstance(tool_input, dict)
                    )
                )
            )
            source_mismatches = set(source_mismatch_indexes)
            duplicate_source_indexes = []
            if phase == 'fetch':
                indexes_by_source = {}
                for index, phase_attempts in attempts[phase].items():
                    if len(phase_attempts) != 1:
                        continue
                    selected_source = phase_attempts[0]['selected_source']
                    if selected_source is None or selected_source['url'] is None:
                        continue
                    indexes_by_source.setdefault(
                        selected_source['url'], []
                    ).append(index)
                duplicate_source_indexes = sorted(
                    index
                    for indexes in indexes_by_source.values()
                    if len(indexes) > 1
                    for index in indexes
                )
            duplicate_sources = set(duplicate_source_indexes)
            external_failure_indexes = sorted(
                index
                for index, counts in tool_counts.items()
                if phase == 'fetch'
                and counts['tool_use_occurrences'] == 1
                and counts['successful_results'] == 0
                and counts['failed_results'] == 1
                and counts['invalid_results'] == 0
                and index not in source_mismatches
                and index not in duplicate_sources
                and index not in failed_output_mismatches
                and failed_messages[index]
                and all(
                    is_external_source_failure(message)
                    for message in failed_messages[index]
                )
            )
            external_failures = set(external_failure_indexes)
            non_external_failure_indexes = sorted(
                index
                for index, counts in tool_counts.items()
                if counts['failed_results'] > 0
                and index not in external_failures
            )
            successful_indexes = sorted(
                index
                for index, counts in tool_counts.items()
                if counts['tool_use_occurrences'] == 1
                and counts['successful_results'] == 1
                and counts['failed_results'] == 0
                and counts['invalid_results'] == 0
                and index not in source_mismatches
                and index not in duplicate_sources
            )
            successes = set(successful_indexes)
            retries = set(retry_indexes)
            unexpected_tools = set(unexpected_tool_indexes)
            exact_once_indexes = sorted(
                index
                for index, counts in tool_counts.items()
                if attempt_counts[index] == 1
                and index not in retries
                and index not in unexpected_tools
                and counts['tool_uses'] == 1
                and counts['tool_use_occurrences'] == 1
                and counts['invalid_results'] == 0
                and (
                    index in successes
                    if phase == 'search'
                    else index in successes or index in external_failures
                )
            )
            result[phase] = {
                'expected_logical_workers': count,
                'observed_logical_indexes': sorted(attempts[phase]),
                'exact_once_logical_indexes': exact_once_indexes,
                'successful_logical_indexes': successful_indexes,
                'external_failure_logical_indexes': external_failure_indexes,
                'non_external_failure_logical_indexes': non_external_failure_indexes,
                'logical_worker_attempt_counts': attempt_counts,
                'logical_worker_tool_counts': tool_counts,
                'retry_logical_indexes': retry_indexes,
                'unexpected_tool_logical_indexes': unexpected_tool_indexes,
                'source_mismatch_logical_indexes': source_mismatch_indexes,
                'duplicate_source_logical_indexes': duplicate_source_indexes,
                'failed_output_mismatch_logical_indexes': failed_output_mismatch_indexes,
                'complete': (
                    set(attempts[phase]) == expected_indexes
                    and (
                        phase == 'fetch'
                        or set(exact_once_indexes) == expected_indexes
                    )
                    and all(
                        attempt['expected_total'] == count
                        for phase_attempts in attempts[phase].values()
                        for attempt in phase_attempts
                    )
                ),
                'attempts': attempts[phase],
            }
        passive_required = {'select-sources': 1, 'verify': 3, 'synthesize': 1}
        for phase, count in passive_required.items():
            expected_indexes = {str(index) for index in range(1, count + 1)}
            worker_attempts = passive_workers[phase]
            violating_indexes = sorted(
                index
                for index, phase_attempts in worker_attempts.items()
                if len(phase_attempts) != 1
                or any(
                    attempt['retry']
                    or attempt['expected_total'] != count
                    or attempt['tool_names']
                    or (
                        phase == 'select-sources'
                        and (
                            attempt['structured_output'] is None
                            or attempt['selected_sources'] is None
                        )
                    )
                    for attempt in phase_attempts
                )
            )
            phase_result = {
                'expected_logical_workers': count,
                'observed_logical_indexes': sorted(worker_attempts),
                'violating_logical_indexes': violating_indexes,
                'complete': (
                    set(worker_attempts) == expected_indexes
                    and not violating_indexes
                ),
                'attempts': worker_attempts,
            }
            if phase == 'select-sources':
                selected_attempt = (
                    worker_attempts.get('1', [{}])[0]
                    if len(worker_attempts.get('1', [])) == 1
                    else {}
                )
                selected_sources = selected_attempt.get('selected_sources')
                selected_output = selected_attempt.get('structured_output')
                selected_count = (
                    len(selected_sources) if selected_sources is not None else 0
                )
                selected_urls = (
                    [source['url'] for source in selected_sources]
                    if selected_sources is not None
                    else []
                )
                shortfall = (
                    selected_output.get('shortfall')
                    if isinstance(selected_output, dict)
                    else None
                )
                shortfall_complete = (
                    shortfall is None
                    if selected_count == 15
                    else (
                        isinstance(shortfall, dict)
                        and shortfall.get('missingCount') == 15 - selected_count
                    )
                )
                sources_complete = (
                    selected_sources is not None
                    and selected_count <= 15
                    and [source['rank'] for source in selected_sources]
                    == list(range(1, selected_count + 1))
                    and all(selected_urls)
                    and len(set(selected_urls)) == selected_count
                    and shortfall_complete
                )
                phase_result.update({
                    'selected_sources': selected_sources,
                    'shortfall': shortfall,
                    'sources_complete': sources_complete,
                    'complete': phase_result['complete'] and sources_complete,
                })
            result[phase] = phase_result
        selected_sources = result['select-sources'].get('selected_sources')
        selected_count = len(selected_sources) if selected_sources is not None else 0
        selected_source_by_index = {
            str(source['rank']): source['url']
            for source in selected_sources or []
        }
        selected_indexes = {
            str(index) for index in range(1, selected_count + 1)
        }
        expected_shortfall_indexes = {
            str(index) for index in range(selected_count + 1, 16)
        }
        shortfall_indexes = sorted(
            index
            for index, phase_attempts in attempts['fetch'].items()
            if len(phase_attempts) == 1
            and not phase_attempts[0]['retry']
            and phase_attempts[0]['expected_total'] == 15
            and not phase_attempts[0]['unexpected_tool_names']
            and phase_attempts[0]['discovery_tool_occurrences'] == 0
            and phase_attempts[0]['selected_source'] == {
                'rank': int(index),
                'url': None,
            }
            and phase_attempts[0]['structured_output'] is not None
            and phase_attempts[0]['structured_output'].get('sourceQuality')
            == 'unreliable'
            and phase_attempts[0]['structured_output'].get('claims') == []
            and phase_attempts[0]['structured_output'].get('missingReason')
            == 'source list shortfall'
            and result['fetch']['logical_worker_tool_counts'][index] == {
                'tool_uses': 0,
                'tool_use_occurrences': 0,
                'successful_results': 0,
                'failed_results': 0,
                'invalid_results': 0,
            }
        )
        fetch_sources_match = (
            result['select-sources']['complete']
            and set(attempts['fetch'])
            == selected_indexes | expected_shortfall_indexes
            and all(
                len(attempts['fetch'][index]) == 1
                and attempts['fetch'][index][0]['selected_source'] is not None
                and attempts['fetch'][index][0]['selected_source']['url']
                == selected_source_by_index[index]
                for index in selected_indexes
            )
        )
        result['fetch']['selected_sources_match'] = fetch_sources_match
        result['fetch']['shortfall_logical_indexes'] = shortfall_indexes
        result['fetch']['invalid_shortfall_logical_indexes'] = sorted(
            expected_shortfall_indexes - set(shortfall_indexes)
        )
        result['fetch']['complete'] = (
            result['fetch']['complete']
            and fetch_sources_match
            and set(result['fetch']['exact_once_logical_indexes'])
            == selected_indexes
            and set(shortfall_indexes) == expected_shortfall_indexes
        )
        return result

    def workflow_status(self, run_dir, task_id):
        if not task_id:
            return None
        text = self.transcript(run_dir)
        for match in re.finditer(re.escape(f'<task-id>{task_id}</task-id>'), text):
            nearby = text[match.start():match.start() + 3000]
            status = re.search(r'<status>(completed|failed|stopped)</status>', nearby)
            if status:
                return status.group(1)
        return None

    def workflow_completion_proof(
        self,
        run_dir,
        task_id,
        run_id,
        *,
        expected_status='completed',
    ):
        status = self.workflow_status(run_dir, task_id)
        log = self.debug(run_dir)
        scope = f'task={task_id} run={run_id}'
        phase_lines = [
            line for line in log.splitlines()
            if 'workflow_phase_terminal' in line and scope in line
        ]
        worker_start_lines = [
            line for line in log.splitlines()
            if 'workflow_worker_start' in line and scope in line
        ]
        worker_terminal_lines = [
            line for line in log.splitlines()
            if 'workflow_worker_terminal' in line and scope in line
        ]
        started_logical = set()
        terminal_logical = set()
        terminal_statuses = set()
        for line in worker_start_lines:
            match = re.search(r'\blogical=([^ ]+)', line)
            if match:
                started_logical.add(match.group(1))
        for line in worker_terminal_lines:
            logical = re.search(r'\blogical=([^ ]+)', line)
            terminal = re.search(r'\bstatus=([^ ]+)', line)
            if logical:
                terminal_logical.add(logical.group(1))
            if terminal:
                terminal_statuses.add(terminal.group(1))
        phase_statuses = {
            match.group(1)
            for line in phase_lines
            for match in [re.search(r'\bstatus=([^ ]+)', line)]
            if match
        }
        worker_terminal_complete = (
            started_logical <= terminal_logical
            and (
                terminal_statuses == {expected_status}
                if expected_status == 'completed'
                else expected_status in terminal_statuses
            )
        )
        notification_count = self.notification_count(run_dir)
        complete = (
            bool(task_id)
            and bool(run_id)
            and status == expected_status
            and notification_count == 1
            and bool(phase_lines)
            and bool(worker_start_lines)
            and worker_terminal_complete
            and expected_status in phase_statuses
        )
        return {
            'complete': complete,
            'status': status,
            'expected_status': expected_status,
            'task_id': task_id,
            'run_id': run_id,
            'notification_count': notification_count,
            'phase_terminal_count': len(phase_lines),
            'worker_start_count': len(worker_start_lines),
            'worker_terminal_count': len(worker_terminal_lines),
            'started_logical_workers': sorted(started_logical),
            'terminal_logical_workers': sorted(terminal_logical),
            'phase_statuses': sorted(phase_statuses),
            'worker_terminal_statuses': sorted(terminal_statuses),
        }

    def agent_completion_proof(
        self,
        run_dir,
        *,
        agent_id,
        task_id,
        expected_output,
    ):
        log = self.debug(run_dir)
        marker = re.search(
            r'\[AgentLifecycle\] background_terminal '
            rf'agent_id={re.escape(agent_id)} '
            rf'task_id={re.escape(task_id)} status=([^ ]+)',
            log,
        )
        child_output = self.assistant_text(run_dir, subagents=True)
        return {
            'complete': bool(
                marker
                and marker.group(1) == 'completed'
                and expected_output in child_output
            ),
            'agent_id': agent_id,
            'task_id': task_id,
            'status': marker.group(1) if marker else None,
            'child_output_observed': expected_output in child_output,
        }

    def workflow_ids(self, run_dir):
        text = self.transcript(run_dir)
        task = re.search(r'Workflow launched in background\. Task ID: ([A-Za-z0-9_-]+)', text)
        run = re.search(r'Run ID: (wf_[A-Za-z0-9_-]+)', text)
        task_id = task.group(1) if task else None
        run_id = run.group(1) if run else None
        if task_id:
            self.workflow_task_ids.add(task_id)
        if run_id:
            self.workflow_run_ids.add(run_id)
        return task_id, run_id

    def agent_ids(self, log):
        return sorted(set(re.findall(r'AgentLifecycle\] foreground_registered agent_id=([^ ]+)', log)))

    def agent_launches(self, log):
        launches = []
        for payload in re.findall(r'AgentTool launch params (\{[^\n]+\})', log):
            try:
                launches.append(json.loads(payload))
            except json.JSONDecodeError:
                continue
        return launches

    def write_markers(self, run_dir, log):
        keys = [
            'AgentTool launch params',
            '[AgentLifecycle] foreground_registered',
            '[AgentLifecycle] foreground_to_background',
            '[AgentLifecycle] background_terminal',
            'executePermissionRequestHooks called for tool: WebFetch',
            'WebFetch tool error',
        ]
        markers = {key: log.count(key) for key in keys}
        (run_dir / 'debug-marker-search.txt').write_text(
            '\n'.join(f'{key}\t{value}' for key, value in markers.items()) + '\n'
        )
        return markers

    def goal_lifecycle(self):
        run_dir, session, target, ready = self.start('goal-lifecycle')
        result = {'label': 'goal-lifecycle', 'evidence_dir': str(run_dir)}
        condition = 'wait for the release validation token before completing'
        active = prompt_restored = status_visible = status_dismissed = cleared = no_goal = False
        if ready:
            self.send(
                target,
                run_dir,
                f'/goal {condition}',
                'input-goal-set.txt',
            )
            active = self.wait_until(
                lambda: 'Goal is set' in strip_ansi(
                    self.capture(target, run_dir / '03-goal-active-pane.txt')
                ),
                60,
            )
            if active:
                self.tmux('send-keys', '-t', target, 'Escape')
                prompt_restored = self.wait_until(
                    lambda: input_prompt_ready(
                        self.capture(target, run_dir / '04-goal-cancelled-pane.txt')
                    ),
                    60,
                )
            if prompt_restored:
                self.send(target, run_dir, '/goal', 'input-goal-status.txt')
                status_visible = self.wait_until(
                    lambda: (
                        'Goal active' in strip_ansi(
                            pane := self.capture(
                                target, run_dir / '05-goal-status-pane.txt'
                            )
                        )
                        and f'Goal: {condition}' in strip_ansi(pane)
                    ),
                    30,
                )
            if status_visible:
                self.tmux('send-keys', '-t', target, 'Escape')
                status_dismissed = self.wait_until(
                    lambda: input_prompt_ready(
                        self.capture(
                            target, run_dir / '05b-goal-status-dismissed-pane.txt'
                        )
                    ),
                    30,
                )
            if status_dismissed:
                self.send(target, run_dir, '/goal clear', 'input-goal-clear.txt')
                cleared = self.wait_until(
                    lambda: (
                        f'Goal cleared: {condition}' in strip_ansi(
                            pane := self.capture(
                                target, run_dir / '06-goal-cleared-pane.txt'
                            )
                        )
                        and 'Goal is set' not in strip_ansi(pane)
                        and input_prompt_ready(pane)
                    ),
                    30,
                )
            if cleared:
                self.send(target, run_dir, '/goal clear', 'input-goal-clear-empty.txt')
                no_goal = self.wait_until(
                    lambda: (
                        'No goal set' in strip_ansi(
                            pane := self.capture(target, run_dir / '07-no-goal-pane.txt')
                        )
                        and input_prompt_ready(pane)
                    ),
                    30,
                )
        log = self.debug(run_dir)
        hook_added = log.count('Added session hook for event Stop')
        hook_removed = log.count('Removed session hooks for event Stop and source ')
        cleanup = self.close(run_dir, session, target)
        passed = (
            ready
            and active
            and prompt_restored
            and status_visible
            and status_dismissed
            and cleared
            and no_goal
            and hook_added == 1
            and hook_removed >= 2
            and self.cleanup_passed(cleanup)
        )
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'goal_active': active,
            'parent_prompt_restored_after_cancel': prompt_restored,
            'goal_status_visible': status_visible,
            'goal_status_dismissed': status_dismissed,
            'goal_cleared': cleared,
            'empty_clear_observed': no_goal,
            'stop_hook_added_count': hook_added,
            'stop_hook_removed_count': hook_removed,
            'assertions': [
                self.required_assertion(
                    run_dir,
                    'goal-lifecycle-set-status-clear',
                    'Goal lifecycle',
                    'Goal becomes active, remains queryable after cancelling its turn, clears explicitly, and removes its Stop hook.',
                    [
                        run_dir / '03-goal-active-pane.txt',
                        run_dir / '04-goal-cancelled-pane.txt',
                        run_dir / '05-goal-status-pane.txt',
                        run_dir / '05b-goal-status-dismissed-pane.txt',
                        run_dir / '06-goal-cleared-pane.txt',
                        run_dir / '07-no-goal-pane.txt',
                        run_dir / 'debug.log',
                    ],
                    passed=passed,
                    reason='Goal state, Stop hook, or cleanup evidence was incomplete',
                ),
            ],
            'cleanup': cleanup,
        })
        self.record(result)

    def direct_agent(self):
        run_dir, session, target, ready = self.start('agent-fg-bg')
        result = {'label': 'agent-fg-bg', 'evidence_dir': str(run_dir)}
        if not ready:
            result['validation_verdict'] = 'failed'
            result['reason'] = 'readiness failed'
            result['cleanup'] = self.close(run_dir, session, target)
            self.record(result)
            return
        prompt = (
            'Run the deterministic foreground/background Agent lifecycle release fixture. '
            'Do not modify files.'
        )
        self.send(target, run_dir, prompt, 'input-agent.txt')
        registered = self.wait_until(
            lambda: '[AgentLifecycle] foreground_registered' in self.debug(run_dir), 90
        )
        server = self.mock_servers.get(run_dir.name)
        child_waiting = (
            registered
            and server is not None
            and server.agent_fgbg_child_waiting.wait(timeout=30)
        )
        self.capture(target, run_dir / '03-foreground-running-pane.txt')
        if child_waiting:
            self.tmux('send-keys', '-t', target, 'C-b')
        transitioned = child_waiting and self.wait_until(
            lambda: '[AgentLifecycle] foreground_to_background' in self.debug(run_dir), 30
        )
        if transitioned:
            server.agent_fgbg_release.set()
        self.capture(target, run_dir / '04-backgrounded-pane.txt')
        terminal = transitioned and self.wait_until(
            lambda: (
                '[AgentLifecycle] background_terminal' in self.debug(run_dir)
                and 'RELEASE_FGBG_PARENT_RESTORED'
                in strip_ansi(self.capture(target, run_dir / '05-terminal-pane.txt'))
            ),
            240,
        )
        log = self.debug(run_dir)
        ids = self.agent_ids(log)
        task_match = re.search(
            r'foreground_to_background agent_id=([^ ]+) task_id=([^ ]+)',
            log,
        )
        agent_proof = {'complete': False}
        if terminal and task_match:
            self.wait_until(
                lambda: self.agent_completion_proof(
                    run_dir,
                    agent_id=task_match.group(1),
                    task_id=task_match.group(2),
                    expected_output='RELEASE_FGBG_CHILD_DONE',
                )['complete'],
                30,
                0.5,
            )
            agent_proof = self.agent_completion_proof(
                run_dir,
                agent_id=task_match.group(1),
                task_id=task_match.group(2),
                expected_output='RELEASE_FGBG_CHILD_DONE',
            )
        (run_dir / 'agent-completion-proof.json').write_text(
            json.dumps(agent_proof, indent=2) + '\n'
        )
        notification_ready = terminal and self.wait_for_notification_count(
            run_dir, 1
        )
        final = self.capture(target, run_dir / '06-final-pane.txt')
        log = self.debug(run_dir)
        markers = self.write_markers(run_dir, log)
        notifications = self.notification_count(run_dir)
        cleanup = self.close(run_dir, session, target)
        launches = [json.loads(line.split('AgentTool launch params ', 1)[1]) for line in log.splitlines() if 'AgentTool launch params ' in line]
        foreground_mode = (len(launches) == 1 and launches[0].get('selectedAgentType') == 'release-foreground' and launches[0].get('runInBackground') is False and launches[0].get('isAsync') is False and '[ForkMode] enabled' not in log)
        passed = (
            terminal
            and foreground_mode
            and agent_proof['complete']
            and notification_ready
            and len(ids) == 1
            and notifications == 1
            and markers['[AgentLifecycle] foreground_registered'] == 1
            and markers['[AgentLifecycle] foreground_to_background'] == 1
            and markers['[AgentLifecycle] background_terminal'] == 1
            and 'RELEASE_FGBG_PARENT_RESTORED' in strip_ansi(final)
            and self.cleanup_passed(cleanup)
        )
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'agent_ids': ids,
            'foreground_mode': foreground_mode,
            'notification_ready': notification_ready,
            'notification_count': notifications,
            'marker_counts': markers,
            'parent_prompt_restored': 'RELEASE_FGBG_PARENT_RESTORED' in strip_ansi(final),
            'assertions': [
                self.required_assertion(
                    run_dir,
                    'agent-foreground-background-lifecycle',
                    'Agent foreground/background lifecycle',
                    'A foreground Agent transitions to background, completes once, notifies once, and restores the parent prompt.',
                    [
                        run_dir / '03-foreground-running-pane.txt',
                        run_dir / '04-backgrounded-pane.txt',
                        run_dir / '05-terminal-pane.txt',
                        run_dir / '06-final-pane.txt',
                        run_dir / 'agent-completion-proof.json',
                        run_dir / 'debug.log',
                    ],
                    passed=passed,
                    reason='Agent lifecycle or cleanup evidence was incomplete',
                ),
            ],
            'cleanup': cleanup,
        })
        self.record(result)

    def nested_agent(self):
        run_dir, session, target, ready = self.start('nested-agent')
        result = {'label': 'nested-agent', 'evidence_dir': str(run_dir)}
        if ready:
            prompt = (
                'Release gate read-only nested Agent validation. Use Agent exactly once to launch a foreground '
                'general-purpose parent with description "release nested parent". The parent must use Agent exactly '
                'once to launch a general-purpose child with description "release nested child". The child answers '
                'exactly RELEASE_NESTED_CHILD_DONE; the parent then answers exactly RELEASE_NESTED_PARENT_DONE. '
                'Do not modify files or use other parent tools.'
            )
            self.send(target, run_dir, prompt, 'input-nested.txt')
            terminal = self.wait_until(
                lambda: (
                    'RELEASE_NESTED_PARENT_DONE'
                    in self.assistant_text(run_dir, subagents=True)
                    and 'RELEASE_NESTED_CHILD_DONE'
                    in self.assistant_text(run_dir, subagents=True)
                    and 'RELEASE_NESTED_ROOT_DONE' in self.assistant_text(run_dir)
                ),
                360,
                1,
            )
            final = self.capture(target, run_dir / '03-terminal-pane.txt')
            prompt_restored = self.wait_until(
                lambda: input_prompt_ready(
                    self.capture(target, run_dir / '04-final-pane.txt')
                ),
                30,
                0.5,
            )
            final = self.capture(target, run_dir / '04-final-pane.txt')
        else:
            terminal = False
            prompt_restored = False
            final = ''
        log = self.debug(run_dir)
        markers = self.write_markers(run_dir, log)
        ids = self.agent_ids(log)
        launches = self.agent_launches(log)
        root_launches = [launch for launch in launches if launch.get('spawnDepth') == 1]
        child_launches = [launch for launch in launches if launch.get('spawnDepth') == 2]
        parentage_ok = (
            len(root_launches) == 1
            and root_launches[0].get('parentAgentId') in {None, ''}
            and len(child_launches) == 1
            and child_launches[0].get('parentAgentId') in ids
        )
        (run_dir / 'nested-agent-launches.json').write_text(json.dumps({
            'agent_ids': ids,
            'launches': launches,
            'parentage_ok': parentage_ok,
        }, indent=2) + '\n')
        notifications = self.notification_count(run_dir)
        parent_result = 'RELEASE_NESTED_PARENT_DONE' in self.assistant_text(
            run_dir, subagents=True
        )
        child_result = 'RELEASE_NESTED_CHILD_DONE' in self.assistant_text(
            run_dir, subagents=True
        )
        wire_assertion = self.workflow_mock_wire(run_dir, 'nested-agent')
        cleanup = self.close(run_dir, session, target)
        passed = (
            terminal
            and wire_assertion['validation_verdict'] == 'passed'
            and parent_result
            and child_result
            and prompt_restored
            and len(ids) == 2
            and parentage_ok
            and markers['[AgentLifecycle] foreground_registered'] == 2
            and notifications == 0
            and self.cleanup_passed(cleanup)
        )
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'agent_ids': ids,
            'notification_count': notifications,
            'marker_counts': markers,
            'agent_launches': launches,
            'parentage_ok': parentage_ok,
            'child_result_observed': child_result,
            'parent_result_observed': parent_result,
            'parent_prompt_restored': prompt_restored,
            'assertions': [
                wire_assertion,
                self.required_assertion(
                    run_dir,
                    'nested-agent-lifecycle',
                    'Nested Agent lifecycle',
                    'A foreground parent launches one child, both return their expected result, and the parent prompt is restored.',
                    [
                        run_dir / '03-terminal-pane.txt',
                        run_dir / '04-final-pane.txt',
                        run_dir / 'nested-agent-launches.json',
                        run_dir / 'debug.log',
                    ],
                    passed=passed,
                    reason='Nested Agent lifecycle or cleanup evidence was incomplete',
                ),
            ],
            'cleanup': cleanup,
        })
        self.record(result)

    def workflow(self):
        run_dir, session, target, ready = self.start('workflow')
        result = {'label': 'workflow', 'evidence_dir': str(run_dir)}
        completion_proof = {'complete': False, 'status': None}
        if ready:
            script = INLINE_WORKFLOW_SCRIPT
            prompt = 'Use Workflow with this exact inline script. Do not modify files.\n```js\n' + script + '```'
            self.send(target, run_dir, prompt, 'input-workflow.txt')
            launched = self.wait_until(
                lambda: 'Workflow launched in background. Task ID:' in self.transcript(run_dir), 120
            )
            self.capture(target, run_dir / '03-running-pane.txt')
            task_id, run_id = self.workflow_ids(run_dir)
            completion_proof = {'complete': False}
            completed = launched and self.wait_until(
                lambda: (
                    self.workflow_completion_proof(
                        run_dir,
                        task_id,
                        run_id,
                    )['complete']
                    or self.workflow_status(run_dir, task_id) in {'failed', 'stopped'}
                ),
                420,
                1,
            )
            completion_proof = self.workflow_completion_proof(
                run_dir,
                task_id,
                run_id,
            )
            status = completion_proof['status']
            terminal = self.capture(target, run_dir / '04-terminal-pane.txt')
            page_ok = detail_ok = agent_ok = None
            ui_skipped_reason = 'workflow did not complete'
            if completed and status == 'completed':
                page_ok = detail_ok = agent_ok = False
                ui_skipped_reason = None
                self.send(target, run_dir, '/workflows', 'input-workflows-page.txt')
                page_ok = self.wait_until(
                    lambda: (
                        'release-inline-workflow'
                        in strip_ansi(self.capture(target, run_dir / '05-workflows-page-pane.txt'))
                        and '2/2' in strip_ansi(self.capture(target, run_dir / '05-workflows-page-pane.txt'))
                    ),
                    60,
                )
                if page_ok:
                    self.tmux('send-keys', '-t', target, 'Enter')
                    detail_ok = self.wait_until(
                        lambda: 'probe-a' in strip_ansi(
                            self.capture(target, run_dir / '06-workflows-detail-pane.txt')
                        ),
                        30,
                    )
                if detail_ok:
                    self.tmux('send-keys', '-t', target, 'Right')
                    agent_ok = self.wait_until(
                        lambda: 'Completed' in strip_ansi(
                            self.capture(target, run_dir / '07-workflows-agent-pane.txt')
                        ),
                        30,
                    )
                    for _ in range(3):
                        self.tmux('send-keys', '-t', target, 'Escape')
            self.wait_until(
                lambda: 'RELEASE_WORKFLOW_PARENT_DONE' in self.assistant_text(run_dir), 30, 0.1)
            final = self.capture(target, run_dir / '08-final-pane.txt')
        else:
            task_id = run_id = status = None
            page_ok = detail_ok = agent_ok = None
            ui_skipped_reason = 'readiness failed'
            terminal = final = ''
        log = self.debug(run_dir)
        markers = self.write_markers(run_dir, log)
        ids = self.agent_ids(log)
        notifications = self.notification_count(run_dir)
        wire_assertion = self.workflow_mock_wire(run_dir, 'workflow')
        cleanup = self.close(run_dir, session, target)
        logical_workers = sorted(set(re.findall(
            r'workflow_worker_start[^\n]*\blogical=([^ ]+)',
            log,
        )))
        completed_logical_workers = sorted(set(re.findall(
            r'workflow_worker_terminal[^\n]*\blogical=([^ ]+)[^\n]*\bstatus=completed',
            log,
        )))
        passed = (
            status == 'completed'
            and wire_assertion['validation_verdict'] == 'passed'
            and completion_proof['complete']
            and 'RELEASE_WORKFLOW_PARENT_DONE' in self.assistant_text(run_dir)
            and logical_workers == ['probe-a', 'probe-b']
            and completed_logical_workers == logical_workers
            and notifications == 1
            and page_ok and detail_ok and agent_ok
            and '❯' in strip_ansi(final or terminal)
            and self.cleanup_passed(cleanup)
        )
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'task_id': task_id,
            'run_id': run_id,
            'agent_ids': ids,
            'logical_workers': logical_workers,
            'completed_logical_workers': completed_logical_workers,
            'workflow_completion_proof': completion_proof,
            'notification_count': notifications,
            'workflow_page': {
                'page': page_ok,
                'detail': detail_ok,
                'agent_terminal': agent_ok,
                'skipped_reason': ui_skipped_reason,
            },
            'parent_prompt_restored': '❯' in strip_ansi(final or terminal),
            'marker_counts': markers,
            'assertions': [
                wire_assertion,
                self.required_assertion(
                    run_dir,
                    'inline-workflow-lifecycle',
                    'Inline Workflow lifecycle',
                    'Two logical workers complete, one notification is emitted, workflow detail UI is readable, and the parent prompt returns.',
                    [
                        run_dir / '03-running-pane.txt',
                        run_dir / '04-terminal-pane.txt',
                        run_dir / '08-final-pane.txt',
                        run_dir / 'debug.log',
                    ],
                    passed=passed,
                    reason='Inline Workflow lifecycle or cleanup evidence was incomplete',
                ),
            ],
            'cleanup': cleanup,
        })
        self.record(result)

    def code_review_scope_identity_proof(self, run_dir, task_id, run_id, expected_prompt):
        proof_path = run_dir / 'workflow-agent-identity-proof.json'
        evidence = [proof_path]
        hashes = {}
        snapshots = {}
        snapshot_root = run_dir / 'workflow-identity-inputs'

        def read_owned(path, root):
            if path.is_symlink() or not path.is_file() or not is_relative_to(path.resolve(), root.resolve()):
                raise ValueError(f'not a regular file in the registered run: {path}')
            key = str(path.resolve())
            if key in snapshots:
                return snapshots[key]['bytes']
            data = path.read_bytes()
            relative = path.relative_to(root)
            copy = snapshot_root / ('workflow-runs' if root == self.workflow_runs else 'case') / relative
            copy.parent.mkdir(parents=True, exist_ok=True)
            with copy.open('xb') as stream:
                stream.write(data)
            copy.chmod(0o600)
            digest = hashlib.sha256(data).hexdigest()
            hashes[str(copy.resolve())] = digest
            snapshots[key] = {'bytes': data, 'snapshot': str(copy.resolve()), 'sha256': digest}
            evidence.append(copy)
            return data

        def json_file(path):
            return json.loads(read_owned(path, run_dir))

        try:
            snapshot_root.mkdir()
            if (task_id not in self.workflow_task_ids or run_id not in self.workflow_run_ids
                    or not re.fullmatch(r'[A-Za-z0-9_-]+', task_id)
                    or not re.fullmatch(r'wf_[A-Za-z0-9_-]+', run_id)):
                raise ValueError('Workflow IDs were not registered by this target')
            metadata_bytes = read_owned(run_dir / 'run-metadata.json', run_dir)
            if metadata_bytes.decode() != self.registered_runs.get(str(run_dir.resolve())):
                raise ValueError('native metadata differs from the immutable start registration')
            metadata = json.loads(metadata_bytes)
            if any(metadata.get(key) != value for key, value in {
                'driver_run': f'{self.stamp}-{self.pid}', 'source_run': run_dir.name,
                'label': 'code-review', 'binary_sha256': self.manifest['binary_sha256'],
            }.items()):
                raise ValueError('native metadata belongs to a different driver/run/binary')
            server = self.code_review_mock_servers.get(run_dir.name)
            if (not isinstance(server, MockOpenAIServer) or server.run_dir.resolve() != run_dir.resolve()
                    or server.label != 'code-review' or not server.stop_result
                    or server.stop_result.get('stopped') is not True
                    or server.stop_result.get('active_handlers') != []):
                raise ValueError('this target has no stopped, registered native provider')
            live_wire = server.snapshot()
            wire = json_file(run_dir / 'mock-openai-requests.json')
            if wire != live_wire or not live_wire or any(request.get('response_kind') is None for request in live_wire):
                raise ValueError('archived requests differ from this case live provider snapshot')
            target = read_owned(run_dir / 'pane-target.txt', run_dir).decode().rstrip('\n')
            if target != metadata.get('target'):
                raise ValueError('pane target differs from registered case')
            pasted = read_owned(run_dir / 'input-code-review.txt', run_dir)
            if pasted != b'\x1b[200~' + expected_prompt.encode() + b'\x1b[201~':
                raise ValueError('native pasted input differs from caller expectation')
            artifact_path = self.workflow_runs / run_id / 'session.json'
            task_path = self.workflow_runs / f'{task_id}.json'
            artifact_bytes = read_owned(artifact_path, self.workflow_runs)
            if artifact_bytes != read_owned(task_path, self.workflow_runs):
                raise ValueError('Workflow task and run mirrors differ')
            parents, children = [], []
            for path in sorted((run_dir / 'config/projects').glob('**/*.jsonl')):
                if 'subagents' in path.parts:
                    continue
                parents.append({'session_id': path.stem,
                                'entries': [json.loads(line) for line in read_owned(path, run_dir).decode().splitlines()]})
            for meta in sorted((run_dir / 'config/projects').glob('**/subagents/agent-*.meta.json')):
                child_path = meta.with_name(meta.name.replace('.meta.json', '.jsonl'))
                children.append({'session_id': meta.parent.parent.name,
                                 'agent_id': meta.name.removeprefix('agent-').removesuffix('.meta.json'),
                                 'meta': json_file(meta),
                                 'entries': [json.loads(line) for line in read_owned(child_path, run_dir).decode().splitlines()]})
            proof = code_review_scope_identity(
                run_args=expected_prompt.removeprefix('/code-review '), task_id=task_id, run_id=run_id,
                artifact=json.loads(artifact_bytes), parents=parents, children=children,
                log=read_owned(run_dir / 'debug.log', run_dir).decode(),
                wire=live_wire)
            proof['native_window_target'] = target
        except (ValueError, KeyError, TypeError, OSError) as error:
            proof = {'complete': False, 'agent_ids': [], 'reason': str(error)}
        proof.update(source_run=run_dir.name, source_hashes=hashes,
                     immutable_inputs={source: {key: value for key, value in snapshot.items() if key != 'bytes'}
                                       for source, snapshot in snapshots.items()},
                     pane_tty_scope='session:window.pane target only; actual %pane_id/TTY requires separate collection')
        proof_bytes = (json.dumps(proof, indent=2) + '\n').encode()
        proof_path.write_bytes(proof_bytes)
        proof['evidence_paths'] = list(dict.fromkeys(evidence))
        proof['evidence_sha256'] = {**hashes, str(proof_path.resolve()): hashlib.sha256(proof_bytes).hexdigest()}
        return proof

    def slash_workflow(self, kind):
        run_dir, session, target, ready = self.start(kind)
        result = {'label': kind, 'evidence_dir': str(run_dir)}
        if kind == 'deep-research':
            prompt = (
                '/deep-research Research current public web evidence about Dynamic Workflows in Claude Code. '
                'Use WebSearch and WebFetch as required by the bundled workflow. Keep it read-only, do not access '
                'private sources, and stop after the normal bounded phases.'
            )
            timeout = 1800
        else:
            prompt = code_review_prompt(
                self.manifest['required_target_inputs']['release_base']['merge_base']
            )
            timeout = 1200
        approvals = 0
        launched = False
        timed_out = False
        if ready:
            self.send(target, run_dir, prompt, f'input-{kind}.txt')
            launched = self.wait_until(
                lambda: 'Workflow launched in background. Task ID:' in self.transcript(run_dir), 120
            )
            self.capture(target, run_dir / '03-running-pane.txt')
            task_id, run_id = self.workflow_ids(run_dir)
            deadline = time.monotonic() + timeout
            status = self.workflow_status(run_dir, task_id)
            completion_proof = {'complete': False, 'status': status}
            while (
                launched
                and not completion_proof['complete']
                and status not in {'failed', 'stopped'}
                and time.monotonic() < deadline
            ):
                pane = self.capture(target, run_dir / '04-live-pane.txt')
                plain = strip_ansi(pane)
                approve = (
                    kind == 'deep-research'
                    and 'Do you want to allow Claude to fetch this content?' in plain
                ) or (
                    kind == 'code-review'
                    and 'Do you want to proceed?' in plain
                    and 'Bash command' in plain
                )
                if approve:
                    approvals += 1
                    self.capture(target, run_dir / f'permission-{approvals:03d}-pane.txt')
                    self.tmux('send-keys', '-t', target, 'Enter')
                    time.sleep(0.75)
                status = self.workflow_status(run_dir, task_id)
                completion_proof = self.workflow_completion_proof(
                    run_dir,
                    task_id,
                    run_id,
                )
                status = completion_proof['status']
                time.sleep(1)
            completion_proof = self.workflow_completion_proof(
                run_dir,
                task_id,
                run_id,
            )
            status = completion_proof['status']
            timed_out = (
                launched
                and status not in {'completed', 'failed', 'stopped'}
                and not completion_proof['complete']
            )
            if kind == 'code-review' and completion_proof['complete']:
                self.wait_until(
                    lambda: 'RELEASE_CODE_REVIEW_PARENT_DONE' in self.assistant_text(run_dir), 30, 0.1)
            terminal = self.capture(target, run_dir / '05-terminal-pane.txt')
        else:
            task_id = run_id = status = None
            terminal = ''
        log = self.debug(run_dir)
        markers = self.write_markers(run_dir, log)
        ids = self.agent_ids(log)
        notifications = self.notification_count(run_dir)
        web_tools = (
            self.tool_evidence(run_dir, {'WebSearch', 'WebFetch'})
            if kind == 'deep-research'
            else None
        )
        phase_evidence = (
            self.deep_research_phase_evidence(run_dir)
            if kind == 'deep-research'
            else None
        )
        workflow_complete = self.workflow_completion_proof(
            run_dir,
            task_id,
            run_id,
        )
        fetch_ok = (
            kind != 'deep-research'
            or (
                workflow_complete['complete']
                and phase_evidence['search']['complete']
                and phase_evidence['select-sources']['complete']
                and phase_evidence['fetch']['complete']
                and phase_evidence['verify']['complete']
                and phase_evidence['synthesize']['complete']
                and self.deep_research_web_tools_complete(
                    web_tools, phase_evidence
                )
            )
        )
        (run_dir / 'workflow-completion-proof.json').write_text(
            json.dumps(workflow_complete, indent=2) + '\n'
        )
        cleanup = self.close(run_dir, session, target)
        identity_proof = self.code_review_scope_identity_proof(run_dir, task_id, run_id, prompt) if kind == 'code-review' else None
        if identity_proof is not None:
            ids = identity_proof['agent_ids']
        wire_assertion = self.workflow_mock_wire(run_dir, kind) if kind == 'code-review' else None
        passed = (
            ready
            and launched
            and status == 'completed'
            and workflow_complete['complete']
            and len(ids) > 0
            and notifications == 1
            and '❯' in strip_ansi(terminal)
            and fetch_ok
            and (identity_proof is None or identity_proof['complete'])
            and (wire_assertion is None or (
                wire_assertion['validation_verdict'] == 'passed'
                and 'RELEASE_CODE_REVIEW_PARENT_DONE' in self.assistant_text(run_dir)
            ))
            and self.cleanup_passed(cleanup)
        )
        if passed:
            verdict = 'passed'
            reason = None
        elif timed_out:
            verdict = 'running'
            reason = 'workflow did not reach a terminal status before timeout'
        elif not ready:
            verdict = 'failed'
            reason = 'readiness failed'
        elif not launched:
            verdict = 'failed'
            reason = 'workflow launch was not observed'
        elif status in {'failed', 'stopped'}:
            verdict = 'failed'
            reason = f'workflow terminal status was {status}'
        else:
            verdict = 'failed'
            reason = 'terminal evidence or required assertions were incomplete'
        result.update({
            'validation_verdict': verdict,
            'reason': reason,
            'task_id': task_id,
            'run_id': run_id,
            'agent_ids': ids,
            'workflow_agent_identity': {key: value for key, value in identity_proof.items() if key != 'evidence_paths'} if identity_proof is not None else None,
            'notification_count': notifications,
            'permission_approvals': approvals,
            'parent_prompt_restored': '❯' in strip_ansi(terminal),
            'web_tool_evidence': web_tools,
            'deep_research_phase_evidence': phase_evidence,
            'marker_counts': markers,
            'assertions': [
                *([self.required_assertion(
                    run_dir, 'code-review-native-scope-identity', 'code-review native Scope identity',
                    'The same task/run, parent tool, CLI session, exact prompt/schema and StructuredOutput receipt resolve one actual native child.',
                    identity_proof['evidence_paths'], passed=identity_proof['complete'],
                    evidence_sha256=identity_proof['evidence_sha256'],
                    reason=identity_proof.get('reason') or 'Native Scope identity was incomplete',
                )] if identity_proof is not None else []),
                *([wire_assertion] if wire_assertion else []),
                self.required_assertion(
                    run_dir,
                    f'{kind}-workflow-lifecycle',
                    f'{kind} Workflow lifecycle',
                    'The bundled workflow launches, reaches a terminal completed state, emits one notification, restores the prompt, and cleans up owned runtime state.',
                    [
                        run_dir / '03-running-pane.txt',
                        run_dir / '05-terminal-pane.txt',
                        run_dir / 'workflow-completion-proof.json',
                        run_dir / 'debug.log',
                    ],
                    passed=passed,
                    reason=reason or 'Bundled Workflow lifecycle evidence was incomplete',
                ),
            ],
            'cleanup': cleanup,
        })
        self.record(result)

    def required_assertion(self, run_dir, assertion_id, subject, predicate,
                           paths, *, runtime_state='done', passed=False,
                           reason=None, evidence_sha256=None):
        missing = [str(path.resolve()) for path in paths if not path.exists()]
        passed = passed and not missing
        if missing:
            reason = 'missing required evidence: ' + ', '.join(missing)
        return {
            'assertion_id': assertion_id,
            'source_run': run_dir.name,
            'subject': subject,
            'predicate': predicate,
            'required_evidence': [str(path) for path in paths],
            'observed_evidence_paths': [str(path.resolve()) for path in paths if path.exists()],
            'missing_evidence_paths': missing,
            'runtime_state': runtime_state,
            'validation_verdict': 'passed' if passed else 'failed',
            'reason_if_not_passed': None if passed else reason,
            **({'evidence_sha256': dict(evidence_sha256)} if evidence_sha256 is not None else {}),
        }

    def mock_response_requests(self, run_dir):
        server = self.mock_servers.get(run_dir.name)
        if server is None:
            return []

        return [
            request
            for request in server.snapshot()
            if is_main_response_request(request)
        ]

    def effort_openai_responses_wire(self):
        run_dir, session, target, ready = self.start(
            'effort-openai-responses-wire'
        )
        result = {
            'label': 'effort-openai-responses-wire',
            'evidence_dir': str(run_dir),
        }
        effort_cases = (
            ('none', 'none'),
            ('minimal', 'minimal'),
            ('low', 'low'),
            ('medium', 'medium'),
            ('high', 'high'),
            ('xhigh', 'xhigh'),
            ('max', 'max'),
            ('ultra', 'ultra'),
            ('ultracode', 'xhigh'),
        )
        effort_paths = {
            effort: run_dir / f'03-effort-{index:02d}-{effort}-pane.txt'
            for index, (effort, _) in enumerate(effort_cases, 1)
        }
        terminal_path = run_dir / '04-terminal-pane.txt'
        thinking_path = run_dir / '05-thinking-transcript-pane.txt'
        analysis_path = run_dir / 'openai-wire-analysis.json'
        effort_visible = {}
        response_ready = {}
        prompt_restored = thinking_visible = False
        if ready:
            for index, (effort, _) in enumerate(effort_cases, 1):
                self.send(
                    target,
                    run_dir,
                    f'/effort {effort}',
                    f'input-effort-{index:02d}-{effort}.txt',
                )
                effort_visible[effort] = self.wait_until(
                    lambda effort=effort: f'Set effort level to {effort}' in strip_ansi(
                        self.capture(target, effort_paths[effort])
                    ),
                    30,
                    0.25,
                )
                self.send(
                    target,
                    run_dir,
                    f'Reply with the release validation marker for {effort}.',
                    f'input-effort-request-{index:02d}-{effort}.txt',
                )
                response_ready[effort] = self.wait_until(
                    lambda index=index: (
                        len(self.mock_response_requests(run_dir)) == index
                        and 'RELEASE_EFFORT_WIRE_OK' in self.assistant_text(run_dir)
                    ),
                    90,
                    0.25,
                )
            prompt_restored = self.wait_until(
                lambda: any(
                    re.fullmatch(r'\s*❯\s*', line)
                    for line in strip_ansi(
                        self.capture(target, terminal_path, history=False)
                    ).splitlines()
                ),
                30,
                0.25,
            )
            self.capture(target, terminal_path)
            if prompt_restored:
                self.tmux('send-keys', '-t', target, 'C-o', check=True)
            thinking_visible = prompt_restored and self.wait_until(
                lambda: 'Release validation reasoning marker.' in strip_ansi(
                    self.capture(target, thinking_path)
                ),
                30,
                0.25,
            )
        for path in (*effort_paths.values(), terminal_path, thinking_path):
            if not path.exists():
                self.capture(target, path)
        responses = self.mock_response_requests(run_dir)
        wire_efforts = {}
        request_checks = []
        cache_keys = []
        for (configured, expected), request in zip(effort_cases, responses):
            body = request.get('body') if isinstance(request.get('body'), dict) else {}
            headers = request.get('headers') if isinstance(request.get('headers'), dict) else {}
            reasoning = body.get('reasoning')
            wire_effort = reasoning.get('effort') if isinstance(reasoning, dict) else None
            wire_efforts[configured] = wire_effort
            cache_key = body.get('prompt_cache_key')
            cache_keys.append(cache_key)
            request_checks.append(
                wire_effort == expected
                and openai_request_metadata_matches(headers, cache_key)
                and request.get('authorization') == {
                    'present': True,
                    'matches_dummy': True,
                }
            )
        request_ids = [
            response.get('headers', {}).get('x-client-request-id')
            for response in responses
        ]
        all_wire_ok = (
            len(responses) == len(effort_cases)
            and len(request_checks) == len(effort_cases)
            and all(request_checks)
            and len(set(cache_keys)) == 1
            and len(set(request_ids)) == len(responses)
        )
        thinking_transcript_shows_marker = (
            thinking_visible
            and 'Release validation reasoning marker.' in strip_ansi(
                thinking_path.read_text(errors='replace')
            )
        )
        transcript_has_thinking = 'Release validation reasoning marker.' in self.transcript(
            run_dir
        )
        settings_path = run_dir / 'config' / 'settings.json'
        try:
            settings = json.loads(settings_path.read_text())
        except (OSError, json.JSONDecodeError):
            settings = {}
        persisted = settings.get('effortLevel') == 'ultracode'
        debug_path = run_dir / 'debug.log'
        wire_debug = analyze_openai_wire_debug(
            debug_path.read_text(errors='replace') if debug_path.exists() else '',
            self.mock_servers[run_dir.name].snapshot(),
        )
        analysis_path.write_text(json.dumps({
            'wire_debug': wire_debug,
            'request_count': len(responses),
            'wire_efforts': wire_efforts,
            'cache_key_present': all(bool(key) for key in cache_keys),
            'cache_routing_and_metadata_headers_match': all(request_checks),
            'cache_key_stable': len(set(cache_keys)) == 1,
            'request_ids_unique': len(set(request_ids)) == len(responses),
            'effort_commands_visible': effort_visible,
            'responses_ready': response_ready,
            'settings_effort_level': settings.get('effortLevel'),
            'prompt_restored_before_transcript': prompt_restored,
            'thinking_transcript_shows_marker': thinking_transcript_shows_marker,
            'transcript_has_thinking': transcript_has_thinking,
        }, indent=2) + '\n')
        cleanup = self.close(run_dir, session, target)
        passed = (
            ready
            and all(effort_visible.get(effort, False) for effort, _ in effort_cases)
            and all(response_ready.get(effort, False) for effort, _ in effort_cases)
            and all_wire_ok
            and wire_debug['matched'] and wire_debug['cross_client_append_only']
            and persisted
            and prompt_restored
            and thinking_transcript_shows_marker
            and transcript_has_thinking
            and self.cleanup_passed(cleanup)
        )
        evidence = [
            *[
                run_dir / f'input-effort-{index:02d}-{effort}.txt'
                for index, (effort, _) in enumerate(effort_cases, 1)
            ],
            *effort_paths.values(),
            *[
                run_dir / f'input-effort-request-{index:02d}-{effort}.txt'
                for index, (effort, _) in enumerate(effort_cases, 1)
            ],
            terminal_path,
            thinking_path,
            run_dir / 'mock-openai-requests.json',
            analysis_path,
            settings_path,
            run_dir / 'debug.log',
        ]
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'reason': None if passed else 'effort matrix UI, persistence, or wire evidence was incomplete',
            'request_count': len(responses),
            'wire_efforts': wire_efforts,
            'settings_effort_level': settings.get('effortLevel'),
            'thinking_transcript_shows_marker': thinking_transcript_shows_marker,
            'transcript_has_thinking': transcript_has_thinking,
            'assertions': [
                self.required_assertion(
                    run_dir,
                    'openai-wire-cross-client-prefix',
                    'Cross-client wire prefix diagnostics',
                    'Successive CLI turns retain the create baseline across SSE client construction; hashes, byte counts and prefixes match captured requests without diagnostic body text.',
                    evidence,
                    passed=wire_debug['matched'] and wire_debug['cross_client_append_only'],
                    reason='product wire diagnostics are missing, inconsistent or reset across clients',
                ),
                self.required_assertion(
                    run_dir,
                    'effort-all-configured-openai-wire',
                    'Configured effort OpenAI wire matrix',
                    'All configured effort values are accepted and sent unchanged with stable cache routing.',
                    evidence,
                    passed=all_wire_ok and all(effort_visible.values())
                    and len(effort_visible) == len(effort_cases),
                    reason='one or more configured effort values were rejected or remapped',
                ),
                self.required_assertion(
                    run_dir,
                    'effort-ultracode-openai-wire',
                    'Ultracode local orchestration mapping',
                    'Ultracode persists locally and is the only configured value mapped to xhigh on the API wire.',
                    evidence,
                    passed=persisted and wire_efforts.get('ultracode') == 'xhigh',
                    reason='ultracode did not persist or map to xhigh',
                ),
            ],
            'cleanup': cleanup,
        })
        self.record(result)

    @staticmethod
    def deferred_terminal_notifications(body):
        notifications = []
        for item in body.get('input', []):
            if not isinstance(item, dict) or item.get('role') != 'user':
                continue
            content = item.get('content', [])
            texts = [content] if isinstance(content, str) else [
                block.get('text', '') for block in content if isinstance(block, dict)
                and block.get('type') == 'input_text']
            for text in texts:
                notifications.extend(re.findall(
                    r'<task-notification>(.*?)</task-notification>', text, re.S))
        return notifications

    @staticmethod
    def deferred_discovery_evidence(requests, enabled):
        bodies = [request.get('body', {}) for request in requests]
        checks = {}
        outputs = {}
        for body in bodies:
            for item in body.get('input', []):
                if isinstance(item, dict) and item.get('type') == 'function_call_output':
                    outputs[item.get('call_id')] = item.get('output')
        tools = [{tool.get('name'): tool for tool in body.get('tools', [])}
                 for body in bodies]
        checks['initially_deferred'] = bool(tools) and (
            'ToolSearch' in tools[0] and 'Terminal' not in tools[0]
            and 'Workflow' not in tools[0])
        next_tools = tools[1] if len(tools) > 1 else {}
        terminal = next_tools.get('Terminal', {}).get('parameters', {})
        properties = terminal.get('properties', {})
        checks['terminal_schema'] = (
            terminal.get('type') == 'object' and 'action' in terminal.get('required', [])
            and set(properties.get('action', {}).get('enum', [])) == {
                'new-session', 'list-panes', 'send-keys', 'capture-pane',
                'resize-pane', 'send-signal', 'display-message', 'kill-pane'}
            and all(properties.get(name, {}).get('type') == kind for name, kind in
                    [('target', 'string'), ('text', 'string'), ('cols', 'integer'),
                     ('rows', 'integer'), ('enter', 'boolean')]))
        search = str(outputs.get('fc_deferred-search', ''))
        checks['search_result'] = 'Terminal' in search
        workflow = next_tools.get('Workflow', {}).get('parameters', {})
        if enabled:
            checks['workflow_opt_in'] = ('Workflow' in search
                and workflow.get('type') == 'object'
                and all(workflow.get('properties', {}).get(name, {}).get('type') == 'string'
                        for name in ('name', 'script', 'scriptPath')))
            parsed = {}
            for step in ('open', 'write', 'resize', 'read', 'status', 'signal', 'close', 'closed-status'):
                try:
                    value = json.loads(outputs.get(f'fc_deferred-{step}', ''))
                    parsed[step] = value if isinstance(value, dict) else {}
                except (TypeError, ValueError):
                    parsed[step] = {}
            session_id = parsed['open'].get('target')
            checks['lifecycle_results'] = all(value and 'error' not in value for value in parsed.values())
            checks['session_identity'] = isinstance(session_id, str) and bool(session_id) and all(
                value.get('target') == session_id for value in parsed.values())
            checks['accepted'] = all(parsed[step].get('accepted') is True for step in ('write', 'signal'))
            checks['open_write_running'] = all(
                parsed[step].get('isRunning') is True for step in ('open', 'write'))
            checks['roundtrip'] = (isinstance(parsed['read'].get('text'), str)
                and 'RELEASE_TERMINAL_ROUNDTRIP' in parsed['read']['text'])
            checks['resize_running'] = all(parsed[step].get('isRunning') is True
                and parsed[step].get('cols') == 91 and parsed[step].get('rows') == 31
                for step in ('resize', 'status'))
            checks['terminal_cleanup'] = (parsed['close'].get('closed') is True
                and parsed['closed-status'].get('isRunning') is False)
        else:
            session_id = None
            checks['workflow_opt_out'] = (
                all('Workflow' not in names for names in tools)
                and 'Workflow' not in search
                and outputs.get('fc_deferred-workflow-off') == 'No matching deferred tools found')
        checks['dummy_auth'] = bool(requests) and all(request.get('authorization') == {
            'present': True, 'matches_dummy': True} for request in requests)
        expected = (['search', 'open', 'write', 'resize', 'read', 'status', 'signal', 'close', 'closed-status']
                    if enabled else ['search', 'workflow-off'])
        ending = ['deferred-completed'] + (['deferred-notification-ack'] if enabled else [])
        checks['ordered_roundtrips'] = (
            [request.get('response_kind') for request in requests]
            == [f'deferred-{step}' for step in expected] + ending)
        # Inputs are cumulative: each round must contain exactly the prior calls
        # and results, not merely some historical result with a matching ID.
        checks['call_result_sequence'] = True
        for index, body in enumerate(bodies):
            prior = [f'fc_deferred-{step}' for step in expected[:index]]
            items = [item for item in body.get('input', []) if isinstance(item, dict)]
            for kind in ('function_call', 'function_call_output'):
                checks['call_result_sequence'] &= [item.get('call_id') for item in items
                    if item.get('type') == kind] == prior
            checks['call_result_sequence'] &= [item.get('type') for item in items
                if item.get('type') in ('function_call', 'function_call_output')] == [
                    kind for _ in prior for kind in ('function_call', 'function_call_output')]
            checks['call_result_sequence'] &= all(item.get('output') == outputs.get(item.get('call_id'))
                for item in items if item.get('type') == 'function_call_output')
            checks['call_result_sequence'] &= all(item.get('name') == (
                'ToolSearch' if item.get('call_id') in ('fc_deferred-search', 'fc_deferred-workflow-off')
                else 'Terminal') for item in items if item.get('type') == 'function_call')
        notifications = [BinaryGate.deferred_terminal_notifications(body) for body in bodies]
        task_id = None
        checks['notification_phase'] = not any(notifications)
        if enabled:
            final = notifications[-1] if notifications else []
            fields = {}
            if len(final) == 1:
                for tag in ('task-id', 'tool-use-id', 'task-type', 'output-file', 'status', 'summary'):
                    values = re.findall(fr'<{tag}>(.*?)</{tag}>', final[0], re.S)
                    fields[tag] = values[0] if len(values) == 1 else None
            task_id = fields.get('task-id')
            checks['notification_phase'] = bool(
                task_id and re.fullmatch(r'[\w-]+', task_id)
                and not any(notifications[:-1]) and len(final) == 1
                and fields.get('tool-use-id') == 'fc_deferred-open'
                and fields.get('task-type') == 'interactive_terminal'
                and fields.get('status') == 'killed'
                and fields.get('summary') == f'Terminal {session_id} was stopped'
                and str(fields.get('output-file', '')).endswith(f'/tasks/{task_id}.output'))
        checks['completed'] = bool(requests) and requests[-1].get('response_kind') == ending[-1]
        return {'passed': all(checks.values()), 'checks': checks,
                'session_id': session_id, 'task_id': task_id,
                'call_ids': sorted(outputs), 'request_count': len(requests)}

    @staticmethod
    def plugins_reload_evidence(requests, events):
        checks = {}
        pids = {}
        for phase in ('v1', 'v2', 'repeat'):
            rows = [row for row in requests if str(row.get('response_kind', '')).startswith(f'plugins-{phase}-')]
            outputs = {item.get('call_id'): item.get('output') for row in rows
                       for item in row.get('body', {}).get('input', [])
                       if isinstance(item, dict) and item.get('type') == 'function_call_output'}
            version = 'v1' if phase == 'v1' else 'v2'
            checks[f'{phase}-completed'] = bool(rows) and rows[-1].get('response_kind') == f'plugins-{phase}-completed'
            for step, server_version in [('plugin', version), ('other', 'other')]:
                matching = [event for event in events
                            if event.get('version') == server_version
                            and event.get('request', {}).get('method') == 'tools/call'
                            and event['request'].get('params', {}).get('name') == f'probe_{server_version}'
                            and event['request']['params'].get('arguments') == {'phase': phase}]
                output = str(outputs.get(f'fc_plugins-{phase}-{step}', ''))
                checks[f'{phase}-{step}-call'] = len(matching) == 1 and all(
                    str(matching[0].get(key)) in output for key in ('pid', 'version')) and phase in output
                pids[f'{phase}-{step}'] = matching[0].get('pid') if len(matching) == 1 else None
            for name in ('version', 'standalone', 'removed-command', 'removed-skill'):
                call_id = f'fc_plugins-{phase}-{name}'
                output = str(outputs.get(call_id, ''))
                # Skill content is an additional user message, not the Skill tool's acknowledgement.
                injected = []
                for row in rows:
                    items = row.get('body', {}).get('input', [])
                    for index, item in enumerate(items):
                        if isinstance(item, dict) and item.get('call_id') == call_id and item.get('type') == 'function_call_output':
                            injected.extend(following.get('content') for following in items[index + 1:]
                                            if isinstance(following, dict) and following.get('role') == 'user')
                if phase != 'v1' and name.startswith('removed-'):
                    checks[f'{phase}-{name}'] = f'Unknown skill: fixture:{name}' in output
                else:
                    checks[f'{phase}-{name}'] = call_id in outputs and f'PLUGIN_CONTENT_{name}_{version}' in json.dumps(injected)
            schemas = [tool for row in rows for tool in row.get('body', {}).get('tools', [])]
            checks[f'{phase}-schema'] = any(
                tool.get('name') == f'mcp__plugin_fixture_server__probe_{version}'
                and tool.get('parameters', {}).get('properties', {}).get('phase', {}).get('type') == 'string'
                for tool in schemas)
            if phase != 'v1':
                checks[f'{phase}-old-schema-removed'] = not any(
                    tool.get('name') == 'mcp__plugin_fixture_server__probe_v1' for tool in schemas)
        checks['plugin-reconnected'] = all(pids.values()) and len({pids.get(f'{phase}-plugin') for phase in ('v1', 'v2', 'repeat')}) == 3
        checks['non-plugin-preserved'] = all(pids.values()) and len({pids.get(f'{phase}-other') for phase in ('v1', 'v2', 'repeat')}) == 1
        checks['update-result'] = any(
            item.get('call_id') == 'fc_plugins-update-update' and item.get('type') == 'function_call_output'
            and 'updated from 1.0.0 to 2.0.0' in str(item.get('output'))
            for row in requests for item in row.get('body', {}).get('input', []) if isinstance(item, dict))
        checks['dummy-auth'] = bool(requests) and all(row.get('authorization') == {
            'present': True, 'matches_dummy': True} for row in requests)
        return {'passed': all(checks.values()), 'checks': checks, 'pids': pids}

    def plugins_reload(self):
        run_dir, session, target, ready = self.start('plugins-reload')
        panes = []
        completed = ready
        try:
            for phase in ('v1', 'update', 'v2', 'repeat'):
                if not completed:
                    break
                if phase == 'update':
                    self.write_plugin_version(run_dir, 'v2')
                if phase in ('v2', 'repeat'):
                    pane = run_dir / f'plugins-{phase}-reload-pane.txt'
                    panes.append(pane)
                    before = strip_ansi(self.capture(target, pane)).count('Reloaded:')
                    self.send(target, run_dir, '/reload-plugins', f'input-{phase}-reload.txt')
                    completed = self.wait_until(lambda: strip_ansi(self.capture(target, pane)).count('Reloaded:') > before, 60, 0.25)
                    if not completed:
                        break
                (run_dir / 'plugin-phase.txt').write_text(phase)
                self.send(target, run_dir, f'Run the local plugin probe {phase}.', f'input-plugins-{phase}.txt')
                pane = run_dir / f'plugins-{phase}-pane.txt'
                panes.append(pane)
                completed = self.wait_until(lambda: (
                    any(row.get('response_kind') == f'plugins-{phase}-completed'
                        for row in self.mock_response_requests(run_dir))
                    and f'Plugin probe {phase} complete.' in strip_ansi(self.capture(target, pane))), 120, 0.25)
            log = run_dir / 'plugin-mcp.jsonl'
            events = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            analysis = self.plugins_reload_evidence(self.mock_response_requests(run_dir), events)
            analysis_path = run_dir / 'plugins-reload-analysis.json'
            analysis_path.write_text(json.dumps(analysis, indent=2) + '\n')
        finally:
            if not panes:
                panes.append(run_dir / 'plugins-failed-pane.txt')
            for pane in panes:
                if not pane.exists():
                    self.capture(target, pane)
            cleanup = self.close(run_dir, session, target)
        passed = completed and analysis['passed'] and self.cleanup_passed(cleanup)
        assertion = self.required_assertion(run_dir, 'plugins-reload-lifecycle', 'fixture@refresh-local',
            'Local install/update replaces and removes commands/skills; plugin MCP reconnects and non-plugin MCP survives.',
            [*panes, analysis_path, log, run_dir / 'mock-openai-requests.json'],
            passed=passed, reason='plugin reload lifecycle evidence incomplete')
        self.record({'label': 'plugins-reload', 'evidence_dir': str(run_dir),
                     'validation_verdict': 'passed' if passed else 'failed',
                     'reason': None if passed else 'plugin reload lifecycle incomplete',
                     'assertions': [assertion], 'cleanup': cleanup})

    def deferred_tool_discovery(self):
        cases = []
        assertions = []
        for enabled in (False, True):
            label = 'deferred-tool-discovery' if enabled else 'deferred-tool-discovery-off'
            run_dir, session, target, ready = self.start(label)
            pane = run_dir / '03-deferred-terminal-pane.txt'
            visible = False
            try:
                if ready:
                    self.send(target, run_dir, 'Run the deferred tool discovery validation.', 'input-deferred.txt')
                    marker = 'RELEASE_DEFERRED_NOTIFICATION_ACK' if enabled else 'RELEASE_DEFERRED_DONE'
                    visible = self.wait_until(lambda: (
                        marker in strip_ansi(self.capture(target, pane))
                        and self.deferred_discovery_evidence(
                            self.mock_response_requests(run_dir), enabled)['passed']), 120, 0.25)
                analysis = self.deferred_discovery_evidence(self.mock_response_requests(run_dir), enabled)
                analysis_path = run_dir / 'deferred-discovery-analysis.json'
                analysis_path.write_text(json.dumps(analysis, indent=2) + '\n')
            finally:
                if not pane.exists():
                    self.capture(target, pane)
                cleanup = self.close(run_dir, session, target)
            passed = ready and visible and analysis['passed'] and self.cleanup_passed(cleanup)
            cases.append({**analysis, 'label': label, 'enabled': enabled, 'passed': passed, 'cleanup': cleanup,
                          'evidence_dir': str(run_dir)})
            assertions.append(self.required_assertion(
                run_dir, f'deferred-discovery-{enabled}', label,
                ('ToolSearch expands Terminal/Workflow schemas; Terminal completes its lifecycle and its own notification is acknowledged.'
                 if enabled else 'ToolSearch expands the Terminal schema and rejects Workflow discovery while opted out; no Terminal lifecycle runs.'),
                [pane, analysis_path, run_dir / 'mock-openai-requests.json',
                 run_dir / 'config/settings.json', run_dir / 'debug.log'],
                passed=passed, reason='deferred discovery wire, lifecycle, or cleanup evidence incomplete'))
        passed = all(assertion['validation_verdict'] == 'passed' for assertion in assertions)
        self.record({'label': 'deferred-tool-discovery', 'evidence_dir': str(run_dir),
                     'validation_verdict': 'passed' if passed else 'failed',
                     'reason': None if passed else 'deferred tool discovery incomplete',
                     'assertions': assertions, 'cases': cases, 'cleanup': cleanup})

    def fast_openai_responses_wire(self):
        run_dir, session, target, ready = self.start(
            'fast-openai-responses-wire'
        )
        result = {
            'label': 'fast-openai-responses-wire',
            'evidence_dir': str(run_dir),
        }
        enabled_path = run_dir / '03-fast-enabled-pane.txt'
        priority_path = run_dir / '04-fast-priority-response-pane.txt'
        disabled_path = run_dir / '05-fast-disabled-pane.txt'
        standard_path = run_dir / '06-fast-standard-response-pane.txt'
        analysis_path = run_dir / 'fast-openai-wire-analysis.json'
        enabled = priority_response = disabled = standard_response = False
        if ready:
            self.send(target, run_dir, '/fast on', 'input-fast-on.txt')
            enabled = self.wait_until(
                lambda: 'Fast mode ON' in strip_ansi(
                    self.capture(target, enabled_path)
                ),
                30,
                0.25,
            )
            if enabled:
                self.send(
                    target,
                    run_dir,
                    'Reply with the fast-mode release marker.',
                    'input-fast-priority-request.txt',
                )
                priority_response = self.wait_until(
                    lambda: (
                        len(self.mock_response_requests(run_dir)) == 1
                        and 'RELEASE_FAST_WIRE_OK' in self.assistant_text(run_dir)
                    ),
                    90,
                    0.25,
                )
            self.capture(target, priority_path)
            if priority_response:
                self.send(target, run_dir, '/fast off', 'input-fast-off.txt')
                disabled = self.wait_until(
                    lambda: 'Fast mode OFF' in strip_ansi(
                        self.capture(target, disabled_path)
                    ),
                    30,
                    0.25,
                )
            if disabled:
                self.send(
                    target,
                    run_dir,
                    'Reply with the standard-mode release marker.',
                    'input-fast-standard-request.txt',
                )
                standard_response = self.wait_until(
                    lambda: len(self.mock_response_requests(run_dir)) == 2,
                    90,
                    0.25,
                )
            self.capture(target, standard_path)
        for path in (
            enabled_path,
            priority_path,
            disabled_path,
            standard_path,
        ):
            if not path.exists():
                path.write_text('required fast mode state was not reached\n')
        responses = self.mock_response_requests(run_dir)
        bodies = [
            request.get('body')
            if isinstance(request.get('body'), dict)
            else {}
            for request in responses
        ]
        priority_wire = (
            len(bodies) == 2
            and bodies[0].get('service_tier') == 'priority'
            and 'service_tier' not in bodies[1]
        )
        dummy_auth = (
            len(responses) == 2
            and all(
                request.get('authorization') == {
                    'present': True,
                    'matches_dummy': True,
                }
                for request in responses
            )
        )
        settings_path = run_dir / 'config' / 'settings.json'
        try:
            settings = json.loads(settings_path.read_text())
        except (OSError, json.JSONDecodeError):
            settings = {}
        preference_disabled = settings.get('fastMode') is not True
        analysis_path.write_text(json.dumps({
            'request_count': len(responses),
            'service_tiers': [body.get('service_tier') for body in bodies],
            'enabled_visible': enabled,
            'priority_response_visible': priority_response,
            'disabled_visible': disabled,
            'standard_response_visible': standard_response,
            'dummy_authorization': dummy_auth,
            'preference_disabled_at_end': preference_disabled,
        }, indent=2) + '\n')
        cleanup = self.close(run_dir, session, target)
        passed = (
            ready and enabled and priority_response and disabled
            and standard_response and priority_wire and dummy_auth
            and preference_disabled and self.cleanup_passed(cleanup)
        )
        evidence = [
            run_dir / 'input-fast-on.txt',
            enabled_path,
            run_dir / 'input-fast-priority-request.txt',
            priority_path,
            run_dir / 'input-fast-off.txt',
            disabled_path,
            run_dir / 'input-fast-standard-request.txt',
            standard_path,
            run_dir / 'mock-openai-requests.json',
            settings_path,
            analysis_path,
            run_dir / 'debug.log',
        ]
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'reason': None if passed else 'fast mode UI, persistence, or OpenAI wire evidence was incomplete',
            'request_count': len(responses),
            'service_tiers': [body.get('service_tier') for body in bodies],
            'preference_disabled_at_end': preference_disabled,
            'assertions': [
                self.required_assertion(
                    run_dir,
                    'fast-openai-priority-wire',
                    'OpenAI fast mode priority wire',
                    'The built CLI enables Fast mode and sends service_tier=priority on the next OpenAI Responses request.',
                    evidence,
                    passed=passed and priority_wire,
                    reason='Fast mode did not produce a priority OpenAI request',
                ),
                self.required_assertion(
                    run_dir,
                    'fast-openai-disable-wire',
                    'OpenAI fast mode disable lifecycle',
                    'Disabling Fast mode persists the preference and removes service_tier from the next OpenAI Responses request.',
                    evidence,
                    passed=passed and preference_disabled,
                    reason='Fast mode disable did not restore standard OpenAI requests',
                ),
            ],
            'cleanup': cleanup,
        })
        self.record(result)

    def openai_image_input_wire(self):
        label = 'openai-image-input-wire'
        run_dir, session, target, ready = self.start(label)
        result = {'label': label, 'evidence_dir': str(run_dir)}
        fixture_path = run_dir / 'fixture.png'
        fixture_bytes = base64.b64decode(
            'iVBORw0KGgoAAAANSUhEUgAACDQAAAABCAIAAACkbvvnAAAAHUlEQVR4nO3BMQEA'
            'AADCoPVPbQsvoAAAAAAAAI4GGJ0AATXO+8IAAAAASUVORK5CYII='
        )
        fixture_path.write_bytes(fixture_bytes)
        fixture_sha256 = sha256(fixture_path)
        fixture_metadata_path = run_dir / 'image-fixture-metadata.json'
        fixture_metadata_path.write_text(json.dumps({
            'path': str(fixture_path),
            'media_type': 'image/png',
            'dimensions': png_dimensions(fixture_bytes),
            'byte_length': len(fixture_bytes),
            'sha256': fixture_sha256,
        }, indent=2) + '\n')
        running_path = run_dir / '03-read-image-running-pane.txt'
        terminal_path = run_dir / '04-terminal-pane.txt'
        analysis_path = run_dir / 'openai-image-wire-analysis.json'
        read_started = response_ready = prompt_restored = False
        if ready:
            self.send(
                target,
                run_dir,
                'Read the release validation image and report the completion marker.',
                'input-openai-image.txt',
            )
            read_started = self.wait_until(
                lambda: (
                    len(self.mock_response_requests(run_dir)) >= 1
                    and self.mock_response_requests(run_dir)[0].get(
                        'response_kind'
                    ) == 'read-call'
                ),
                90,
                0.25,
            )
            self.capture(target, running_path)
            response_ready = read_started and self.wait_until(
                lambda: (
                    len(self.mock_response_requests(run_dir)) == 2
                    and 'RELEASE_OPENAI_IMAGE_WIRE_OK'
                    in self.assistant_text(run_dir)
                ),
                90,
                0.25,
            )
            prompt_restored = response_ready and self.wait_until(
                lambda: input_prompt_ready(
                    self.capture(target, terminal_path, history=False)
                ),
                30,
                0.25,
            )
            self.capture(target, terminal_path)
        for path in (running_path, terminal_path):
            if not path.exists():
                path.write_text('required OpenAI image state was not reached\n')

        responses = self.mock_response_requests(run_dir)
        response_kinds = [request.get('response_kind') for request in responses]
        second_body = (
            responses[1].get('body')
            if len(responses) == 2 and isinstance(responses[1].get('body'), dict)
            else {}
        )
        second_input = second_body.get('input')
        function_calls = []
        function_outputs = []
        if isinstance(second_input, list):
            function_calls = [
                item for item in second_input
                if isinstance(item, dict) and item.get('type') == 'function_call'
            ]
            function_outputs = [
                item for item in second_input
                if isinstance(item, dict)
                and item.get('type') == 'function_call_output'
            ]
        image_output = None
        if len(function_outputs) == 1:
            output = function_outputs[0].get('output')
            if isinstance(output, list) and len(output) == 1:
                candidate = output[0]
                if isinstance(candidate, dict):
                    image_output = candidate
        processed_bytes = None
        image_url = image_output.get('image_url') if image_output else None
        if isinstance(image_url, str) and image_url.startswith(
            'data:image/png;base64,'
        ):
            try:
                processed_bytes = base64.b64decode(
                    image_url.removeprefix('data:image/png;base64,'),
                    validate=True,
                )
            except ValueError:
                processed_bytes = None
        processed_dimensions = (
            png_dimensions(processed_bytes) if processed_bytes else None
        )
        try:
            call_arguments = json.loads(function_calls[0].get('arguments', '{}'))
        except (IndexError, TypeError, json.JSONDecodeError):
            call_arguments = None
        call_wire = (
            len(function_calls) == 1
            and function_calls[0].get('id') == 'fc_release_read_image'
            and function_calls[0].get('call_id') == 'fc_release_read_image'
            and function_calls[0].get('name') == 'Read'
            and call_arguments == {'file_path': str(fixture_path)}
        )
        output_wire = (
            len(function_outputs) == 1
            and function_outputs[0].get('call_id') == 'fc_release_read_image'
            and image_output is not None
            and image_output.get('type') == 'input_image'
            and image_output.get('detail') == 'high'
            and processed_dimensions == (2000, 1)
            and processed_bytes != fixture_bytes
        )
        exact_requests = response_kinds == ['read-call', 'completed']
        dummy_auth = (
            len(responses) == 2
            and all(
                request.get('authorization') == {
                    'present': True,
                    'matches_dummy': True,
                }
                for request in responses
            )
        )
        analysis_path.write_text(json.dumps({
            'request_count': len(responses),
            'response_kinds': response_kinds,
            'read_function_call_wire': call_wire,
            'function_call_output_image_wire': output_wire,
            'fixture_sha256': fixture_sha256,
            'fixture_dimensions': png_dimensions(fixture_bytes),
            'processed_dimensions': processed_dimensions,
            'processed_differs_from_fixture': processed_bytes != fixture_bytes,
            'read_started': read_started,
            'response_ready': response_ready,
            'prompt_restored': prompt_restored,
            'dummy_authorization': dummy_auth,
        }, indent=2) + '\n')
        cleanup = self.close(run_dir, session, target)
        passed = (
            ready and read_started and response_ready and prompt_restored
            and exact_requests and call_wire and output_wire and dummy_auth
            and self.cleanup_passed(cleanup)
        )
        evidence = [
            run_dir / 'input-openai-image.txt',
            running_path,
            terminal_path,
            fixture_path,
            fixture_metadata_path,
            run_dir / 'mock-openai-requests.json',
            analysis_path,
            run_dir / 'debug.log',
        ]
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'reason': None if passed else 'bundled image Read or OpenAI image wire evidence was incomplete',
            'request_count': len(responses),
            'response_kinds': response_kinds,
            'assertions': [
                self.required_assertion(
                    run_dir,
                    'bundled-file-read-image',
                    'Bundled FileRead image processing',
                    'The built CLI executes Read on a PNG through the bundled image processor fallback and returns to the prompt.',
                    evidence,
                    passed=passed and call_wire,
                    reason='the built CLI did not complete the controlled image Read',
                ),
                self.required_assertion(
                    run_dir,
                    'openai-image-function-output-wire',
                    'OpenAI Responses image tool-result wire',
                    'The Read result is sent once as the exact PNG data URL in a function_call_output input_image item with the stable call ID.',
                    evidence,
                    passed=passed and output_wire,
                    reason='the image tool result was missing or changed on the OpenAI Responses wire',
                ),
            ],
            'cleanup': cleanup,
        })
        self.record(result)

    def openai_remote_compaction(self):
        run_dir, session, target, ready = self.start(
            'openai-remote-compaction'
        )
        result = {
            'label': 'openai-remote-compaction',
            'evidence_dir': str(run_dir),
        }
        seed_path = run_dir / '03-compaction-seed-pane.txt'
        first_path = run_dir / '04-first-compaction-pane.txt'
        continuation_path = run_dir / '05-compaction-continuation-pane.txt'
        second_path = run_dir / '06-second-compaction-pane.txt'
        analysis_path = run_dir / 'openai-remote-compaction-analysis.json'
        seed_ready = first_compact = continuation_ready = second_compact = False
        if ready:
            self.send(
                target,
                run_dir,
                'Reply with the remote compaction seed marker.',
                'input-compaction-seed.txt',
            )
            seed_ready = self.wait_until(
                lambda: (
                    len(self.mock_response_requests(run_dir)) == 1
                    and 'RELEASE_COMPACTION_SEED_OK'
                    in self.assistant_text(run_dir)
                ),
                90,
                0.25,
            )
            self.capture(target, seed_path)
            if seed_ready:
                self.send(target, run_dir, '/compact RELEASE_COMPACT_CALLER', 'input-first-compact.txt')
                first_compact = self.wait_until(
                    lambda: (
                        len(self.mock_response_requests(run_dir)) == 2
                        and self.mock_response_requests(run_dir)[-1].get(
                            'response_kind'
                        ) == 'compaction'
                        and 'Conversation compacted' in self.transcript(run_dir)
                    ),
                    90,
                    0.25,
                )
            self.capture(target, first_path)
            if first_compact:
                self.send(
                    target,
                    run_dir,
                    'Reply with the remote compaction continuation marker.',
                    'input-compaction-continuation.txt',
                )
                continuation_ready = self.wait_until(
                    lambda: (
                        len(self.mock_response_requests(run_dir)) == 3
                        and 'RELEASE_COMPACTION_CONTINUATION_OK'
                        in self.assistant_text(run_dir)
                    ),
                    90,
                    0.25,
                )
            self.capture(target, continuation_path)
            if continuation_ready:
                self.send(target, run_dir, '/compact', 'input-second-compact.txt')
                second_compact = self.wait_until(
                    lambda: (
                        len(self.mock_response_requests(run_dir)) == 4
                        and sum(
                            request.get('response_kind') == 'compaction'
                            for request in self.mock_response_requests(run_dir)
                        ) == 2
                        and len(self.compact_boundaries(run_dir)) == 2
                    ),
                    90,
                    0.25,
                )
            self.capture(target, second_path)
        for path in (seed_path, first_path, continuation_path, second_path):
            if not path.exists():
                self.capture(target, path)
        responses = self.mock_response_requests(run_dir)
        kinds = [request.get('response_kind') for request in responses]
        bodies = [
            request.get('body')
            if isinstance(request.get('body'), dict)
            else {}
            for request in responses
        ]
        first_item = {
            'type': 'compaction',
            'id': 'cmp_release_0',
            'encrypted_content': 'release-opaque-state-0',
        }
        second_item = {
            'type': 'compaction',
            'id': 'cmp_release_1',
            'encrypted_content': 'release-opaque-state-1',
        }
        first_input = bodies[1].get('input') if len(bodies) > 1 else None
        continuation_input = bodies[2].get('input') if len(bodies) > 2 else None
        second_input = bodies[3].get('input') if len(bodies) > 3 else None
        trigger_wire = (
            isinstance(first_input, list)
            and first_input
            and first_input[-1] == {'type': 'compaction_trigger'}
            and isinstance(second_input, list)
            and second_input
            and second_input[-1] == {'type': 'compaction_trigger'}
        )
        continuation_wire = (
            isinstance(continuation_input, list)
            and continuation_input
            and continuation_input[0] == first_item
            and isinstance(second_input, list)
            and second_input
            and second_input[0] == first_item
        )
        compact_instructions = [bodies[index].get('instructions') for index in (1, 3) if len(bodies) > index]
        instruction_wire = (
            len(compact_instructions) == 2
            and all(isinstance(value, str) and value.count('RELEASE_PRECOMPACT_HOOK') == 1
                    for value in compact_instructions)
            and compact_instructions[0].count('RELEASE_COMPACT_CALLER') == 1
            and compact_instructions[0].endswith('RELEASE_COMPACT_CALLER\n\nRELEASE_PRECOMPACT_HOOK')
            and compact_instructions[1].endswith('RELEASE_PRECOMPACT_HOOK')
            and 'RELEASE_COMPACT_CALLER' not in compact_instructions[1]
        )
        boundaries = self.compact_boundaries(run_dir)
        persisted_chain = (
            len(boundaries) == 2
            and boundaries[0].get('openAICompaction') == first_item
            and boundaries[1].get('openAICompaction') == second_item
            and all(
                boundary.get('compactMetadata', {}).get('mode') == 'codex'
                and boundary.get('compactMetadata', {}).get('provider') == 'openai'
                and boundary.get('compactMetadata', {}).get('compactionResponseId')
                == boundary.get('openAICompaction', {}).get('id')
                and all(
                    type(boundary.get('compactMetadata', {}).get(field)) in (int, float)
                    and boundary['compactMetadata'][field] >= 0
                    for field in (
                        'preCompactTokens', 'postCompactTokens', 'compactionCallTokens'
                    )
                )
                for boundary in boundaries
            )
        )
        exact_requests = kinds == [
            'completed',
            'compaction',
            'completed',
            'compaction',
        ]
        dummy_auth = (
            len(responses) == 4
            and all(
                request.get('authorization') == {
                    'present': True,
                    'matches_dummy': True,
                }
                for request in responses
            )
        )
        debug_path = run_dir / 'debug.log'
        wire_debug = analyze_openai_wire_debug(
            debug_path.read_text(errors='replace') if debug_path.exists() else '',
            self.mock_servers[run_dir.name].snapshot(),
        )
        analysis_path.write_text(json.dumps({
            'wire_debug': wire_debug,
            'request_count': len(responses),
            'response_kinds': kinds,
            'instruction_wire': instruction_wire,
            'trigger_wire': trigger_wire,
            'continuation_wire': continuation_wire,
            'compact_boundaries': boundaries,
            'persisted_chain': persisted_chain,
            'dummy_authorization': dummy_auth,
        }, indent=2) + '\n')
        cleanup = self.close(run_dir, session, target)
        passed = (
            ready and seed_ready and first_compact and continuation_ready
            and second_compact and exact_requests and trigger_wire and instruction_wire
            and continuation_wire and persisted_chain and dummy_auth
            and wire_debug['matched'] and wire_debug['create_compact_isolated']
            and self.cleanup_passed(cleanup)
        )
        evidence = [
            run_dir / 'input-compaction-seed.txt',
            seed_path,
            run_dir / 'input-first-compact.txt',
            first_path,
            run_dir / 'input-compaction-continuation.txt',
            continuation_path,
            run_dir / 'input-second-compact.txt',
            second_path,
            run_dir / 'mock-openai-requests.json',
            analysis_path,
            run_dir / 'debug.log',
        ]
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'reason': None if passed else 'OpenAI remote compaction wire or persisted opaque-state chain was incomplete',
            'request_count': len(responses),
            'response_kinds': kinds,
            'persisted_compaction_count': len(boundaries),
            'assertions': [
                self.required_assertion(
                    run_dir,
                    'openai-wire-create-compact-isolation',
                    'Create/compact wire baseline isolation',
                    'Interleaved CLI turns and /compact compare only same-kind inputs; product diagnostics contain only hashes and counts.',
                    evidence,
                    passed=wire_debug['matched'] and wire_debug['create_compact_isolated'],
                    reason='create/compact product diagnostics are missing or share a baseline',
                ),
                self.required_assertion(
                    run_dir,
                    'openai-remote-compaction-instructions',
                    'PreCompact hook instruction wire',
                    'Manual caller instructions precede hook stdout exactly once; the next compact receives fresh hook instructions without stale caller instructions.',
                    evidence,
                    passed=instruction_wire,
                    reason='caller or hook instructions are missing, duplicated, reordered, or stale',
                ),
                self.required_assertion(
                    run_dir,
                    'openai-remote-compaction-trigger',
                    'OpenAI remote compaction trigger',
                    'The built CLI /compact command sends a compaction_trigger and persists exactly one opaque compaction item.',
                    evidence,
                    passed=first_compact and trigger_wire and dummy_auth,
                    reason='remote compaction trigger or first opaque item was missing',
                ),
                self.required_assertion(
                    run_dir,
                    'openai-remote-compaction-continuation',
                    'OpenAI remote compaction continuation',
                    'The next model request and repeated /compact both prepend the previous opaque compaction item, then persist the replacement item.',
                    evidence,
                    passed=continuation_ready and second_compact and continuation_wire
                    and persisted_chain and exact_requests and dummy_auth,
                    reason='previous opaque state was not continued or replaced deterministically',
                ),
            ],
            'cleanup': cleanup,
        })
        self.record(result)

    def subagent_stop_failure_lifecycle(self):
        label = 'subagent-stop-failure-lifecycle'
        run_dir, session, target, ready = self.start(label)
        result = {'label': label, 'evidence_dir': str(run_dir)}
        terminal_path = run_dir / '03-terminal-pane.txt'
        final_path = run_dir / '04-final-pane.txt'
        hook_output = run_dir / 'subagent-stop-hooks.jsonl'
        analysis_path = run_dir / 'subagent-stop-failure-analysis.json'
        terminal = prompt_restored = False
        if ready:
            self.send(
                target,
                run_dir,
                'Run the controlled SubagentStop failure lifecycle validation.',
                'input-subagent-stop-failure.txt',
            )
            terminal = self.wait_until(
                lambda: (
                    len(self.mock_response_requests(run_dir)) == 2
                    and 'RELEASE_SUBAGENT_STOP_PARENT_OK'
                    in self.assistant_text(run_dir)
                ),
                90,
                0.25,
            )
            self.capture(target, terminal_path)
            prompt_restored = self.wait_until(
                lambda: any(
                    re.fullmatch(r'\s*❯\s*', line)
                    for line in strip_ansi(
                        self.capture(target, final_path, history=False)
                    ).splitlines()
                ),
                30,
                0.25,
            )
            self.capture(target, final_path)
        for path in (terminal_path, final_path):
            if not path.exists():
                path.write_text(
                    'required SubagentStop failure state was not reached\n'
                )
        if not hook_output.exists():
            hook_output.write_text('')

        responses = self.mock_response_requests(run_dir)
        response_kinds = [request.get('response_kind') for request in responses]
        request_wire = False
        if len(responses) == 2:
            followup_body = json.dumps(responses[1].get('body', {}))
            request_wire = all(marker in followup_body for marker in (
                'function_call_output',
                'fc_release_subagent_stop',
                'RELEASE_SUBAGENT_QUERY_FAILURE',
            ))
        mock_sequence = response_kinds == ['agent-call', 'parent-completed']

        hook_records = []
        for line in hook_output.read_text(errors='replace').splitlines():
            try:
                hook_records.append(json.loads(line))
            except json.JSONDecodeError:
                hook_records.append({'invalid_json': line})
        hook_record = hook_records[0] if len(hook_records) == 1 else {}
        agent_transcript = hook_record.get('agent_transcript_path')
        agent_transcript_path = (
            Path(agent_transcript)
            if isinstance(agent_transcript, str)
            else None
        )
        hook_once = len(hook_records) == 1
        hook_fields_valid = (
            hook_once
            and hook_record.get('hook_event_name') == 'SubagentStop'
            and hook_record.get('stop_hook_active') is False
            and hook_record.get('agent_type') == 'release-stop-foreground'
            and isinstance(hook_record.get('agent_id'), str)
            and bool(hook_record.get('agent_id'))
            and hook_record.get('cwd') == str(self.repo)
            and not hook_record.get('last_assistant_message')
            and agent_transcript_path is not None
            and agent_transcript_path.is_absolute()
            and agent_transcript_path.is_file()
            and 'subagents' in agent_transcript_path.parts
        )

        agent_tools = self.tool_evidence(
            run_dir,
            {'Agent'},
            paths=self.transcript_paths(run_dir),
        )
        agent_evidence = agent_tools['Agent']
        failed_tool_result = (
            tool_occurrence_count(agent_evidence) == 1
            and len(agent_evidence['failed_result_ids']) == 1
            and not agent_evidence['successful_result_ids']
            and not agent_evidence['invalid_result_ids']
            and 'RELEASE_SUBAGENT_QUERY_FAILURE'
            in tool_result_text(agent_evidence['failed_result_messages'])
        )
        log = self.debug(run_dir)
        debug_failure = (
            'Sync agent error: RELEASE_SUBAGENT_QUERY_FAILURE' in log
            and 'Agent tool error' in log
            and '[runAgent] SubagentStop on interrupted query failed' not in log
        )
        parent_recovered = (
            terminal
            and 'RELEASE_SUBAGENT_STOP_PARENT_OK'
            in self.assistant_text(run_dir)
            and prompt_restored
        )
        analysis_path.write_text(json.dumps({
            'request_count': len(responses),
            'response_kinds': response_kinds,
            'mock_sequence': mock_sequence,
            'failed_tool_result': failed_tool_result,
            'request_wire': request_wire,
            'hook_count': len(hook_records),
            'hook_fields_valid': hook_fields_valid,
            'hook_records': hook_records,
            'agent_tool_evidence': agent_tools,
            'debug_failure': debug_failure,
            'parent_recovered': parent_recovered,
        }, indent=2) + '\n')
        cleanup = self.close(run_dir, session, target)
        failure_passed = (
            ready and mock_sequence and failed_tool_result and request_wire
            and debug_failure and parent_recovered
            and self.cleanup_passed(cleanup)
        )
        hook_passed = (
            failure_passed and hook_once and hook_fields_valid
        )
        passed = failure_passed and hook_passed
        evidence = [
            run_dir / 'input-subagent-stop-failure.txt',
            terminal_path,
            final_path,
            run_dir / 'config' / 'settings.json',
            run_dir / 'record-subagent-stop.py',
            hook_output,
            run_dir / 'mock-openai-requests.json',
            analysis_path,
            run_dir / 'debug.log',
        ]
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'reason': None if passed else (
                'Subagent query fault, fallback hook, parent recovery, or cleanup '
                'evidence was incomplete'
            ),
            'request_count': len(responses),
            'response_kinds': response_kinds,
            'hook_count': len(hook_records),
            'hook_fields_valid': hook_fields_valid,
            'failed_tool_result': failed_tool_result,
            'parent_recovered': parent_recovered,
            'assertions': [
                self.required_assertion(
                    run_dir,
                    'subagent-stop-query-failure-propagation',
                    'Subagent query failure propagation',
                    'A controlled post-start query fault becomes one failed Agent tool result and the parent resumes exactly once.',
                    evidence,
                    passed=failure_passed,
                    reason='query failure, failed tool result, parent recovery, or cleanup was incomplete',
                ),
                self.required_assertion(
                    run_dir,
                    'subagent-stop-fallback-exactly-once',
                    'SubagentStop interrupted-query fallback',
                    'The interrupted child executes one SubagentStop hook with stable agent identity before cleanup.',
                    evidence,
                    passed=hook_passed,
                    reason='SubagentStop fallback hook cardinality or input fields were invalid',
                ),
            ],
            'cleanup': cleanup,
        })
        self.record(result)

    def openai_responses_usage_error(self):
        run_dir, session, target, ready = self.start(
            'openai-responses-usage-error'
        )
        result = {
            'label': 'openai-responses-usage-error',
            'evidence_dir': str(run_dir),
        }
        usage_path = run_dir / '03-usage-pane.txt'
        error_path = run_dir / '04-error-pane.txt'
        terminal_path = run_dir / '05-terminal-pane.txt'
        analysis_path = run_dir / 'openai-usage-error-analysis.json'
        usage_complete = error_visible = prompt_restored = False
        if ready:
            self.send(
                target,
                run_dir,
                'Reply with the OpenAI usage validation marker.',
                'input-openai-usage.txt',
            )
            usage_complete = self.wait_until(
                lambda: (
                    len(self.mock_response_requests(run_dir)) == 1
                    and 'RELEASE_OPENAI_USAGE_OK' in self.assistant_text(run_dir)
                ),
                90,
                0.25,
            )
            self.capture(target, usage_path)
            if usage_complete:
                self.send(
                    target,
                    run_dir,
                    'Trigger the controlled incomplete response.',
                    'input-openai-incomplete.txt',
                )
                error_visible = self.wait_until(
                    lambda: (
                        len(self.mock_response_requests(run_dir)) == 2
                        and 'RELEASE_OPENAI_INCOMPLETE_REASON'
                        in self.assistant_text(run_dir)
                    ),
                    90,
                    0.25,
                )
            self.capture(target, error_path)
            prompt_restored = self.wait_until(
                lambda: any(
                    re.fullmatch(r'\s*❯\s*', line)
                    for line in strip_ansi(
                        self.capture(target, terminal_path, history=False)
                    ).splitlines()
                ),
                30,
                0.25,
            )
            self.capture(target, terminal_path)
        for path in (usage_path, error_path, terminal_path):
            if not path.exists():
                path.write_text('required OpenAI usage/error state was not reached\n')
        responses = self.mock_response_requests(run_dir)
        expected_openai_usage = {
            'input_tokens': 100,
            'output_tokens': 7,
            'cache_read_input_tokens': 60,
            'cache_creation_input_tokens': 15,
        }
        expected_normalized_usage = {
            'input_tokens': 25,
            'output_tokens': expected_openai_usage['output_tokens'],
            'cache_read_input_tokens': expected_openai_usage['cache_read_input_tokens'],
            'cache_creation_input_tokens': expected_openai_usage[
                'cache_creation_input_tokens'
            ],
        }
        usage_observed = None
        error_messages = []
        for path in self.transcript_paths(run_dir):
            for entry in self.path_entries(path):
                if entry.get('type') != 'assistant':
                    continue
                message = entry.get('message')
                if not isinstance(message, dict):
                    continue
                content = message.get('content')
                content_text = tool_result_text(content)
                if 'RELEASE_OPENAI_USAGE_OK' in content_text:
                    usage_observed = message.get('usage')
                if entry.get('isApiErrorMessage'):
                    error_messages.append({
                        'content': content_text,
                        'error': entry.get('error'),
                        'errorDetails': entry.get('errorDetails'),
                        'apiError': entry.get('apiError'),
                    })
        usage_normalized = (
            isinstance(usage_observed, dict)
            and all(
                usage_observed.get(name) == value
                for name, value in expected_normalized_usage.items()
            )
        )
        error_propagated = (
            len(error_messages) == 1
            and 'RELEASE_OPENAI_INCOMPLETE_REASON'
            in tool_result_text(error_messages[0])
        )
        request_kinds = [request.get('response_kind') for request in responses]
        no_fallback_or_retry = request_kinds == [
            'usage-completed',
            'response.incomplete',
        ]
        analysis_path.write_text(json.dumps({
            'request_count': len(responses),
            'response_kinds': request_kinds,
            'expected_openai_usage': expected_openai_usage,
            'expected_normalized_usage': expected_normalized_usage,
            'observed_normalized_usage': usage_observed,
            'usage_normalized': usage_normalized,
            'error_messages': error_messages,
            'error_propagated': error_propagated,
            'prompt_restored': prompt_restored,
            'no_fallback_or_retry': no_fallback_or_retry,
        }, indent=2) + '\n')
        cleanup = self.close(run_dir, session, target)
        usage_passed = (
            ready and usage_complete and usage_normalized
            and self.cleanup_passed(cleanup)
        )
        error_passed = (
            ready and error_visible and error_propagated and prompt_restored
            and no_fallback_or_retry and self.cleanup_passed(cleanup)
        )
        passed = usage_passed and error_passed
        evidence = [
            run_dir / 'input-openai-usage.txt',
            usage_path,
            run_dir / 'input-openai-incomplete.txt',
            error_path,
            terminal_path,
            run_dir / 'mock-openai-requests.json',
            analysis_path,
            run_dir / 'debug.log',
        ]
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'reason': None if passed else 'OpenAI usage normalization or terminal error evidence was incomplete',
            'request_count': len(responses),
            'observed_normalized_usage': usage_observed,
            'error_propagated': error_propagated,
            'prompt_restored': prompt_restored,
            'no_fallback_or_retry': no_fallback_or_retry,
            'assertions': [
                self.required_assertion(
                    run_dir,
                    'openai-responses-usage-normalization',
                    'OpenAI Responses usage normalization',
                    'OpenAI input tokens are normalized to additive Anthropic cache buckets in the persisted assistant message.',
                    evidence,
                    passed=usage_passed,
                    reason='normalized usage did not preserve additive input/cache/output totals',
                ),
                self.required_assertion(
                    run_dir,
                    'openai-responses-error-propagation',
                    'OpenAI Responses terminal error propagation',
                    'A controlled response.incomplete becomes one visible API error and restores the prompt without fallback or retry.',
                    evidence,
                    passed=error_passed,
                    reason='terminal incomplete reason, prompt recovery, or request cardinality was wrong',
                ),
            ],
            'cleanup': cleanup,
        })
        self.record(result)

    def model_discovery_picker(self):
        run_dir, session, target, ready = self.start('model-discovery-picker')
        result = {
            'label': 'model-discovery-picker',
            'evidence_dir': str(run_dir),
        }
        picker_path = run_dir / '03-model-picker-pane.txt'
        selected_path = run_dir / '04-model-selected-pane.txt'
        current_path = run_dir / '05-model-current-pane.txt'
        analysis_path = run_dir / 'model-discovery-analysis.json'
        picker_visible = selected = current = False
        if ready:
            (run_dir / 'input-model-picker.txt').write_text(
                'M-p (default chat:modelPicker keybinding)\n'
            )
            self.tmux('send-keys', '-t', target, 'M-p', check=True)
            picker_visible = self.wait_until(
                lambda: all(
                    marker in strip_ansi(self.capture(target, picker_path))
                    for marker in ('Select model', 'GPT Release Discovered')
                ),
                30,
                0.25,
            )
            if picker_visible:
                self.tmux('send-keys', '-t', target, '1', check=True)
                selected = self.wait_until(
                    lambda: (
                        'Select model' not in strip_ansi(
                            self.capture(target, selected_path)
                        )
                        and 'gpt-release-discovered' in strip_ansi(
                            self.capture(target, selected_path)
                        )
                    ),
                    30,
                    0.25,
                )
            if selected:
                self.send(target, run_dir, '/model current', 'input-model-current.txt')
                current = self.wait_until(
                    lambda: 'Current model: gpt-release-discovered' in strip_ansi(
                        self.capture(target, current_path)
                    ),
                    30,
                    0.25,
                )
        mapping_cases = []
        alias_path = run_dir / '07-alias-selected-pane.txt'
        alias_selected = False
        for case, expected, pane_name in (
            ('EXPLICIT', 'gpt-release-discovered', '06-explicit-model-pane.txt'),
            ('DEFAULT', 'gpt-5.6-terra', '08-default-model-pane.txt'),
        ):
            pane_path = run_dir / pane_name
            input_path = run_dir / f'input-{case.lower()}-model.txt'
            before = len(self.mock_response_requests(run_dir))
            visible = False
            if current:
                if case == 'DEFAULT':
                    self.send(target, run_dir, '/model sonnet', 'input-model-alias.txt')
                    alias_selected = self.wait_until(
                        lambda: 'Set model to gpt-5.6-terra' in strip_ansi(
                            self.capture(target, alias_path)
                        ), 30, 0.25,
                    )
                if case == 'EXPLICIT' or alias_selected:
                    self.send(target, run_dir,
                              f'RELEASE_{case}_MODEL_REQUEST: Reply with the validation marker.',
                              input_path.name)
                    visible = self.wait_until(
                        lambda: f'RELEASE_{case}_MODEL_OK' in strip_ansi(
                            self.capture(target, pane_path)
                        ), 30, 0.25,
                    )
            case_requests = self.mock_response_requests(run_dir)[before:]
            wire_ok = len(case_requests) == 1 and all(
                request.get('body', {}).get('model') == expected
                and request.get('authorization') == {'present': True, 'matches_dummy': True}
                and request.get('response_kind') == 'model-mapping-completed'
                and f'RELEASE_{case}_MODEL_REQUEST' in json.dumps(
                    request.get('body', {}).get('input', [])
                )
                for request in case_requests
            )
            mapping_cases.append({
                'case': case, 'expected_model': expected,
                'request_sequences': [request.get('sequence') for request in case_requests],
                'observed_models': [request.get('body', {}).get('model') for request in case_requests],
                'pane_visible': visible, 'passed': visible and wire_ok,
                'input_path': str(input_path), 'pane_path': str(pane_path),
            })
        for path in (picker_path, selected_path, current_path, alias_path,
                     *(Path(case['pane_path']) for case in mapping_cases)):
            if not path.exists():
                path.write_text('required model picker state was not reached\n')
        server = self.mock_servers.get(run_dir.name)
        requests = server.snapshot() if server is not None else []
        model_requests = [
            request
            for request in requests
            if request['method'] == 'GET'
            and urlsplit(request['path']).path == '/v1/models'
        ]
        discovery_ok = (
            len(model_requests) == 1
            and model_requests[0].get('authorization') == {
                'present': True,
                'matches_dummy': True,
            }
            and len(self.mock_response_requests(run_dir)) == 2
        )
        analysis_path.write_text(json.dumps({
            'mapping_cases': mapping_cases,
            'alias_selected': alias_selected,
            'model_request_count': len(model_requests),
            'responses_request_count': len(self.mock_response_requests(run_dir)),
            'dummy_authorization': (
                model_requests[0].get('authorization') if model_requests else None
            ),
            'picker_visible': picker_visible,
            'selected': selected,
            'current_model_confirmed': current,
        }, indent=2) + '\n')
        cleanup = self.close(run_dir, session, target)
        passed = (
            ready and discovery_ok and picker_visible and selected and current
            and alias_selected and all(case['passed'] for case in mapping_cases)
            and self.cleanup_passed(cleanup)
        )
        evidence = [
            run_dir / 'mock-openai-requests.json',
            analysis_path,
            run_dir / 'input-model-picker.txt',
            picker_path,
            selected_path,
            run_dir / 'input-model-current.txt',
            current_path,
            run_dir / 'debug.log',
        ]
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'reason': None if passed else 'model discovery or picker selection evidence was incomplete',
            'model_request_count': len(model_requests),
            'responses_request_count': len(self.mock_response_requests(run_dir)),
            'assertions': [
                self.required_assertion(
                    run_dir,
                    'model-discovery-picker-selection',
                    'Discovered model picker option',
                    'A model from the configured /v1/models identity is visible, selectable, and current.',
                    evidence,
                    passed=passed,
                    reason='discovered model was not correlated through picker and current model UI',
                ),
                *[
                    self.required_assertion(
                        run_dir,
                        ('openai-explicit-model-preserved' if case['case'] == 'EXPLICIT'
                         else 'openai-default-model-alias'),
                        case['expected_model'],
                        'Interactive model selection reaches the expected Responses API model and completes in the pane.',
                        [*evidence, Path(case['input_path']), Path(case['pane_path']),
                         run_dir / 'input-model-alias.txt', alias_path],
                        passed=passed and case['passed'],
                        reason='model mapping wire or interactive evidence was incomplete',
                    ) for case in mapping_cases
                ],
            ],
            'cleanup': cleanup,
        })
        self.record(result)

    def model_discovery_empty_picker(self):
        run_dir, session, target, ready = self.start(
            'model-discovery-empty-picker'
        )
        result = {
            'label': 'model-discovery-empty-picker',
            'evidence_dir': str(run_dir),
        }
        picker_path = run_dir / '03-empty-model-picker-pane.txt'
        analysis_path = run_dir / 'empty-model-discovery-analysis.json'
        current_model_visible = fallback_visible = False
        if ready:
            (run_dir / 'input-empty-model-picker.txt').write_text(
                'M-p (default chat:modelPicker keybinding)\n'
            )
            self.tmux('send-keys', '-t', target, 'M-p', check=True)
            current_model_visible = self.wait_until(
                lambda: all(
                    marker in strip_ansi(self.capture(target, picker_path))
                    for marker in (
                        'Select model',
                        'gpt-empty-discovery-current ✔',
                    )
                ),
                30,
                0.25,
            )
            picker_text = strip_ansi(picker_path.read_text(errors='replace'))
            fallback_visible = any(
                marker in picker_text
                for marker in ('GPT-5.5', 'GPT-5.4-Mini')
            )
        if not picker_path.exists():
            picker_path.write_text('required empty model picker state was not reached\n')
        server = self.mock_servers.get(run_dir.name)
        requests = server.snapshot() if server is not None else []
        model_requests = [
            request
            for request in requests
            if request['method'] == 'GET'
            and urlsplit(request['path']).path == '/v1/models'
        ]
        discovery_ok = (
            len(model_requests) == 1
            and model_requests[0].get('authorization') == {
                'present': True,
                'matches_dummy': True,
            }
            and not self.mock_response_requests(run_dir)
        )
        empty_discovery_honored = current_model_visible and not fallback_visible
        analysis_path.write_text(json.dumps({
            'model_request_count': len(model_requests),
            'responses_request_count': len(self.mock_response_requests(run_dir)),
            'dummy_authorization': (
                model_requests[0].get('authorization') if model_requests else None
            ),
            'current_model_visible': current_model_visible,
            'fallback_visible': fallback_visible,
            'empty_discovery_honored': empty_discovery_honored,
        }, indent=2) + '\n')
        cleanup = self.close(run_dir, session, target)
        passed = (
            ready and discovery_ok and empty_discovery_honored
            and self.cleanup_passed(cleanup)
        )
        evidence = [
            run_dir / 'mock-openai-requests.json',
            analysis_path,
            run_dir / 'input-empty-model-picker.txt',
            picker_path,
            run_dir / 'debug.log',
        ]
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'reason': None if passed else 'empty model discovery was replaced by fallback picker options',
            'model_request_count': len(model_requests),
            'responses_request_count': len(self.mock_response_requests(run_dir)),
            'empty_discovery_honored': empty_discovery_honored,
            'assertions': [
                self.required_assertion(
                    run_dir,
                    'model-discovery-empty-picker',
                    'Empty discovered model list',
                    'A successful empty /v1/models response does not restore fallback model options.',
                    evidence,
                    passed=passed,
                    reason='the empty model discovery was not preserved in the picker',
                ),
            ],
            'cleanup': cleanup,
        })
        self.record(result)

    def first_party_bootstrap_picker(self):
        run_dir, session, target, ready = self.start(
            'first-party-bootstrap-picker'
        )
        result = {
            'label': 'first-party-bootstrap-picker',
            'evidence_dir': str(run_dir),
        }
        picker_path = run_dir / '03-first-party-model-picker-pane.txt'
        analysis_path = run_dir / 'first-party-bootstrap-analysis.json'
        config_path = run_dir / 'config' / '.claude-local-oauth.json'
        mock_server = getattr(self, 'mock_servers', {}).get(run_dir.name)
        metadata = json.loads((run_dir / 'run-metadata.json').read_text())
        base_url = metadata['mock_openai']['base_url'].rstrip('/')
        normalized_base = base_url if base_url.endswith('/v1') else base_url + '/v1'
        expected_key = f'anthropic:{normalized_base}:api-key:{hashlib.sha256(DUMMY_ANTHROPIC_API_KEY.encode()).hexdigest()[:16]}'

        def bootstrap_ready():
            try:
                global_config = json.loads(config_path.read_text())
            except (OSError, json.JSONDecodeError):
                return False
            requests = mock_server.snapshot() if mock_server else []
            return (
                sum(
                    urlsplit(request['path']).path
                    == '/api/claude_cli/bootstrap'
                    for request in requests
                ) == 1
                and global_config.get('additionalModelOptionsCache') == [{
                    'value': 'release-first-party-bootstrap-model',
                    'label': 'RELEASE_FIRST_PARTY_BOOTSTRAP_MODEL',
                    'description': 'Release validation bootstrap model',
                }]
                and global_config.get('additionalModelOptionsCacheKey') == expected_key
                and global_config.get('bootstrapCacheKey') == expected_key
            )

        bootstrap_completed = ready and self.wait_until(
            bootstrap_ready, 30, 0.25
        )
        picker_visible = current = False
        if bootstrap_completed:
            (run_dir / 'input-first-party-model-picker.txt').write_text(
                'M-p (default chat:modelPicker keybinding)\n'
            )
            self.tmux('send-keys', '-t', target, 'M-p', check=True)
            picker_visible = self.wait_until(
                lambda: all(
                    marker in strip_ansi(self.capture(target, picker_path))
                    for marker in (
                        'Select model',
                        'RELEASE_FIRST_PARTY_BOOTSTRAP_MODEL',
                    )
                ),
                30,
                0.25,
            )
            if picker_visible:
                current = self.wait_until(
                    lambda: 'RELEASE_FIRST_PARTY_BOOTSTRAP_MODEL ✔'
                    in strip_ansi(self.capture(target, picker_path)),
                    30,
                    0.25,
                )
        if not picker_path.exists():
            picker_path.write_text('required first-party bootstrap picker state was not reached\n')
        try:
            global_config = json.loads(config_path.read_text())
        except (OSError, json.JSONDecodeError):
            global_config = {}
        options = global_config.get('additionalModelOptionsCache')
        keyed_cache = (
            isinstance(options, list)
            and options == [{
                'value': 'release-first-party-bootstrap-model',
                'label': 'RELEASE_FIRST_PARTY_BOOTSTRAP_MODEL',
                'description': 'Release validation bootstrap model',
            }]
            and global_config.get('additionalModelOptionsCacheKey') == expected_key
            and global_config.get('bootstrapCacheKey') == expected_key
        )
        mock_server = getattr(self, 'mock_servers', {}).get(run_dir.name)
        bootstrap_requests = [
            request for request in (mock_server.snapshot() if mock_server else [])
            if urlsplit(request['path']).path == '/api/claude_cli/bootstrap'
        ]
        endpoint_once = len(bootstrap_requests) == 1
        analysis_path.write_text(json.dumps({
            'bootstrap_endpoint_contract': '/api/claude_cli/bootstrap',
            'bootstrap_endpoint_request_count': len(bootstrap_requests),
            'keyed_cache': keyed_cache,
            'expected_cache_key': expected_key,
            'observed_cache_key': global_config.get('additionalModelOptionsCacheKey'),
            'picker_visible': picker_visible,
            'current_model_confirmed': current,
        }, indent=2) + '\n')
        cleanup = self.close(run_dir, session, target)
        cache_passed = (
            ready and endpoint_once and keyed_cache
            and self.cleanup_passed(cleanup)
        )
        picker_passed = (
            ready and picker_visible and current and keyed_cache
            and self.cleanup_passed(cleanup)
        )
        passed = cache_passed and picker_passed
        evidence = [
            config_path,
            run_dir / 'input-first-party-model-picker.txt',
            picker_path,
            analysis_path,
            run_dir / 'debug.log',
        ]
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'reason': None if passed else 'first-party bootstrap startup cache or picker evidence was incomplete',
            'keyed_cache': keyed_cache,
            'bootstrap_endpoint_once': endpoint_once,
            'picker_visible': picker_visible,
            'current_model_confirmed': current,
            'assertions': [
                self.required_assertion(
                    run_dir,
                    'first-party-bootstrap-startup-cache',
                    'First-party bootstrap startup cache',
                    'Startup consumes the persisted /api/claude_cli/bootstrap model cache only when both keys match this run endpoint and dummy credential identity.',
                    evidence,
                    passed=cache_passed,
                    reason='the isolated startup did not preserve and consume its exact bootstrap cache identity',
                ),
                self.required_assertion(
                    run_dir,
                    'first-party-bootstrap-picker',
                    'First-party bootstrap model picker',
                    'The cached first-party bootstrap model remains visible and current through the real model picker entrypoint.',
                    evidence,
                    passed=picker_passed,
                    reason='the cached first-party bootstrap model was missing from picker or current model UI',
                ),
            ],
            'cleanup': cleanup,
        })
        self.record(result)

    def model_internal_update_config_skill(self):
        run_dir, session, target, ready = self.start(
            'model-internal-update-config-skill'
        )
        result = {
            'label': 'model-internal-update-config-skill',
            'evidence_dir': str(run_dir),
        }
        running_path = run_dir / '03-skill-running-pane.txt'
        terminal_path = run_dir / '04-skill-terminal-pane.txt'
        analysis_path = run_dir / 'update-config-skill-analysis.json'
        completed = False
        if ready:
            self.send(
                target,
                run_dir,
                'Use the appropriate bundled configuration skill for this read-only validation.',
                'input-update-config-skill.txt',
            )
            self.wait_until(
                lambda: len(self.mock_response_requests(run_dir)) >= 1,
                30,
                0.25,
            )
            self.capture(target, running_path)
            completed = self.wait_until(
                lambda: (
                    len(self.mock_response_requests(run_dir)) == 2
                    and 'RELEASE_UPDATE_CONFIG_SKILL_OK'
                    in self.assistant_text(run_dir)
                ),
                120,
                0.25,
            )
            self.capture(target, terminal_path)
        for path in (running_path, terminal_path):
            if not path.exists():
                path.write_text('required Skill state was not reached\n')
        responses = self.mock_response_requests(run_dir)
        second_body = (
            responses[1].get('body')
            if len(responses) == 2 and isinstance(responses[1].get('body'), dict)
            else {}
        )
        second_text = json.dumps(second_body, sort_keys=True)
        input_items = second_body.get('input', [])
        outputs = [
            item
            for item in input_items
            if isinstance(item, dict) and item.get('type') == 'function_call_output'
        ] if isinstance(input_items, list) else []
        schema_loaded = all(marker in second_text for marker in (
            'Launching skill: update-config',
            '## Full Settings JSON Schema',
            '## User Request',
            'set model to opus',
            'minimal',
        ))
        lifecycle_ok = (
            len(outputs) == 1
            and outputs[0].get('call_id') == 'fc_release_update_config'
            and responses[0].get('response_kind') == 'skill-call'
            and responses[1].get('response_kind') == 'completed'
            and all(
                response.get('authorization') == {
                    'present': True,
                    'matches_dummy': True,
                }
                for response in responses
            )
        )
        analysis_path.write_text(json.dumps({
            'request_count': len(responses),
            'response_kinds': [response.get('response_kind') for response in responses],
            'function_call_output_count': len(outputs),
            'function_call_output_ids': [output.get('call_id') for output in outputs],
            'schema_loaded': schema_loaded,
            'required_markers': {
                marker: marker in second_text
                for marker in (
                    'Launching skill: update-config',
                    '## Full Settings JSON Schema',
                    '## User Request',
                    'set model to opus',
                    'minimal',
                )
            },
        }, indent=2) + '\n')
        cleanup = self.close(run_dir, session, target)
        passed = (
            ready and completed and schema_loaded and lifecycle_ok
            and self.cleanup_passed(cleanup)
        )
        evidence = [
            run_dir / 'input-update-config-skill.txt',
            running_path,
            terminal_path,
            run_dir / 'mock-openai-requests.json',
            analysis_path,
            run_dir / 'debug.log',
        ]
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'reason': None if passed else 'update-config Skill expansion evidence was incomplete',
            'request_count': len(responses),
            'schema_loaded': schema_loaded,
            'assertions': [
                self.required_assertion(
                    run_dir,
                    'update-config-skill-tool-lifecycle',
                    'Model-internal update-config Skill invocation',
                    'The model Skill call resolves once and is returned as one function_call_output.',
                    evidence,
                    passed=passed,
                    reason='Skill function call and tool result lifecycle was incomplete',
                ),
                self.required_assertion(
                    run_dir,
                    'update-config-full-settings-schema',
                    'Update-config generated settings schema',
                    'The follow-up request contains the full generated schema and original user args.',
                    [run_dir / 'mock-openai-requests.json', analysis_path],
                    passed=schema_loaded,
                    reason='expanded Skill prompt did not contain required schema markers',
                ),
            ],
            'cleanup': cleanup,
        })
        self.record(result)

    def prompt_modes_cache_prefix(self):
        run_dir, session, target, ready = self.start('prompt-modes-cache-prefix')
        result = {
            'label': 'prompt-modes-cache-prefix',
            'evidence_dir': str(run_dir),
        }
        first_path = run_dir / '03-custom-prompt-pane.txt'
        plan_path = run_dir / '04-plan-mode-pane.txt'
        help_path = run_dir / 'binary-help.txt'
        analysis_path = run_dir / 'prompt-cache-analysis.json'
        first_complete = plan_complete = False
        if ready:
            self.send(
                target,
                run_dir,
                'Reply with the release validation marker.',
                'input-custom-system-prompt.txt',
            )
            first_complete = self.wait_until(
                lambda: (
                    len(self.mock_response_requests(run_dir)) == 1
                    and 'RELEASE_PROMPT_CACHE_OK' in self.assistant_text(run_dir)
                ),
                90,
                0.25,
            )
            self.capture(target, first_path)
            plan_enabled = False
            mode_cycles = 0
            for mode_cycles in range(1, 5):
                self.tmux('send-keys', '-t', target, 'BTab', check=True)
                plan_enabled = self.wait_until(
                    lambda: 'plan mode on' in strip_ansi(
                        self.capture(target, plan_path)
                    ).lower(),
                    3,
                    0.1,
                )
                if plan_enabled:
                    break
            (run_dir / 'input-plan-mode-command.txt').write_text(
                f'BTab x{mode_cycles}\n'
            )
            if plan_enabled:
                self.send(
                    target,
                    run_dir,
                    'Inspect the prompt cache boundary without implementation.',
                    'input-plan-mode.txt',
                )
            plan_complete = plan_enabled and self.wait_until(
                lambda: len(self.mock_response_requests(run_dir)) == 2,
                90,
                0.25,
            )
            self.capture(target, plan_path)
        for path in (first_path, plan_path):
            if not path.exists():
                path.write_text('required prompt state was not reached\n')
        help_result = command([str(self.binary), '--help'], timeout=30)
        help_path.write_text(help_result.stdout + help_result.stderr)
        responses = self.mock_response_requests(run_dir)
        bodies = [
            response.get('body')
            for response in responses
            if isinstance(response.get('body'), dict)
        ]
        cache_keys = [body.get('prompt_cache_key') for body in bodies]
        routing_ok = (
            len(responses) == 2
            and len(bodies) == 2
            and bool(cache_keys[0])
            and cache_keys[0] == cache_keys[1]
            and all(
                openai_request_metadata_matches(
                    response.get('headers', {}), cache_keys[0]
                )
                for response in responses
            )
            and len({
                response.get('headers', {}).get('x-client-request-id')
                for response in responses
            }) == len(responses)
        )
        custom_prompt_ok = custom_prompt_instructions_stable(bodies)
        second_text = json.dumps(bodies[1], sort_keys=True) if len(bodies) == 2 else ''
        plan_boundary_ok = (
            'Plan mode is active.' in second_text
            and 'MUST NOT make any edits' in second_text
            and 'Execute immediately' not in second_text
            and 'Prefer action over planning' not in second_text
        )
        help_text = help_result.stdout + help_result.stderr
        feature_boundary = {
            'help_exit': help_result.returncode,
            'proactive_exposed': '--proactive' in help_text,
            'auto_mode_exposed': '--enable-auto-mode' in help_text,
        }
        release_feature_boundary_ok = (
            help_result.returncode == 0
            and not feature_boundary['proactive_exposed']
            and not feature_boundary['auto_mode_exposed']
            and '## Auto Permission Classification During Plan Mode' not in second_text
        )
        analysis_path.write_text(json.dumps({
            'request_count': len(responses),
            'cache_keys_equal': len(cache_keys) == 2 and cache_keys[0] == cache_keys[1],
            'cache_key_present': bool(cache_keys and cache_keys[0]),
            'routing_headers_match': routing_ok,
            'custom_prompt_marker_once_and_instructions_stable': custom_prompt_ok,
            'plan_read_only_boundary': plan_boundary_ok,
            'release_feature_boundary': feature_boundary,
            'binary_coverage': {
                'custom_system_prompt': 'covered',
                'stable_prompt_cache_routing': 'covered',
                'plan_read_only_guidance': 'covered',
                'proactive_custom_prompt': 'not executable in this release artifact',
                'plan_auto_scope': 'not executable in this release artifact',
            },
        }, indent=2) + '\n')
        cleanup = self.close(run_dir, session, target)
        passed = (
            ready and first_complete and plan_complete and routing_ok
            and custom_prompt_ok and plan_boundary_ok and release_feature_boundary_ok
            and self.cleanup_passed(cleanup)
        )
        evidence = [
            run_dir / 'input-custom-system-prompt.txt',
            first_path,
            run_dir / 'input-plan-mode-command.txt',
            run_dir / 'input-plan-mode.txt',
            plan_path,
            run_dir / 'mock-openai-requests.json',
            help_path,
            analysis_path,
            run_dir / 'debug.log',
        ]
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'reason': None if passed else 'custom prompt, plan boundary, or cache evidence was incomplete',
            'request_count': len(responses),
            'cache_keys_equal': len(cache_keys) == 2 and cache_keys[0] == cache_keys[1],
            'release_feature_boundary': feature_boundary,
            'binary_coverage': {
                'custom_system_prompt': 'covered',
                'stable_prompt_cache_routing': 'covered',
                'plan_read_only_guidance': 'covered',
                'proactive_custom_prompt': 'not executable in this release artifact',
                'plan_auto_scope': 'not executable in this release artifact',
            },
            'assertions': [
                self.required_assertion(
                    run_dir,
                    'custom-prompt-stable-cache-routing',
                    'Custom system prompt cache identity',
                    'Two turns preserve the exact custom instructions and session routing key.',
                    evidence,
                    passed=passed,
                    reason='custom prompt or cache routing changed between turns',
                ),
                self.required_assertion(
                    run_dir,
                    'plan-release-artifact-read-only-boundary',
                    'Plan mode prompt in the release artifact',
                    'Plan mode remains read-only and unsupported Auto/Proactive flags are absent.',
                    [plan_path, run_dir / 'mock-openai-requests.json', help_path, analysis_path],
                    passed=plan_boundary_ok and release_feature_boundary_ok,
                    reason='release artifact plan or feature boundary was unexpected',
                ),
            ],
            'cleanup': cleanup,
        })
        self.record(result)

    def workflow_mock_wire(self, run_dir, label):
        server = self.mock_servers.get(run_dir.name)
        if label == 'code-review':
            server = getattr(self, 'code_review_mock_servers', {}).get(run_dir.name)
        requests = server.snapshot() if server else []
        responses = [request for request in requests if is_main_response_request(request)]
        kinds = [request.get('response_kind') for request in responses]
        if label in LIFECYCLE_MOCK_KINDS:
            expected = LIFECYCLE_MOCK_KINDS[label]
            # Completion may arrive with the launch result or in a separate root turn.
            notification = label + '-notification-completed'
            optional = {notification} if label != 'nested-agent' else set()
            checks = {
                'exact-requests': sorted(kind for kind in kinds if kind not in optional) == sorted(expected),
                'notification-turn-at-most-once': kinds.count(notification) <= 1,
                'recognized': all(request.get('response_kind') in {*expected, *optional, 'models', 'title'}
                                  for request in requests),
                'dummy-auth': bool(requests) and all(
                    request.get('authorization', {}).get('matches_dummy') for request in requests),
            }
            path = run_dir / 'workflow-mock-wire.json'
            path.write_text(json.dumps({'checks': checks, 'response_kinds': kinds}, indent=2) + '\n')
            return self.required_assertion(
                run_dir, label + '-mock-wire', label,
                'Local mock observes exact lifecycle requests with dummy authentication and no duplicates or unknown requests.',
                [path, run_dir / 'mock-openai-requests.json'], passed=all(checks.values()),
                reason='lifecycle mock protocol or dummy authentication mismatch',
            )
        expected_workers = 1 if label == 'workflow-retry-partial-failure' else 0
        checks = {
            'discovery-once': kinds.count('workflow-search') == 1,
            'launch-once': kinds.count('workflow-launch') == 1,
            'parent-completed': 'workflow-parent-completed' in kinds,
            'stable-worker': kinds.count('workflow-stable-completed') == expected_workers,
            'transient-worker': kinds.count('workflow-transient-completed') == expected_workers,
            'recognized': all(kind in {
                'workflow-search', 'workflow-launch', 'workflow-parent-completed',
                'workflow-stable-completed', 'workflow-transient-completed',
            } for kind in kinds),
            'dummy-auth': bool(responses) and all(
                request.get('authorization', {}).get('matches_dummy') for request in responses),
        }
        path = run_dir / 'workflow-mock-wire.json'
        path.write_text(json.dumps({'checks': checks, 'response_kinds': kinds}, indent=2) + '\n')
        return self.required_assertion(
            run_dir, label + '-mock-wire', label,
            'Local mock observes one discovery/launch and exact successful worker requests.',
            [path, run_dir / 'mock-openai-requests.json'], passed=all(checks.values()),
            reason='workflow mock protocol or dummy authentication mismatch',
        )

    def workflow_failure_detail(self):
        run_dir, session, target, ready = self.start('workflow-failure-detail')
        result = {
            'label': 'workflow-failure-detail',
            'evidence_dir': str(run_dir),
        }
        running_path = run_dir / '03-running-pane.txt'
        detail_path = run_dir / '04-detail-pane.txt'
        terminal_path = run_dir / '05-terminal-pane.txt'
        marker_path = run_dir / 'debug-marker-search.txt'
        task_id = run_id = status = None
        launched = detail_ok = marker_ok = no_retry = False
        if ready:
            script = WORKFLOW_FAULT_SCRIPTS['workflow-failure-detail']
            prompt = (
                'Use Workflow with this exact inline script. Do not modify files.\n'
                '```js\n' + script + '```'
            )
            self.send(target, run_dir, prompt, 'input-workflow-failure-detail.txt')
            launched = self.wait_until(
                lambda: 'Workflow launched in background. Task ID:' in self.transcript(run_dir),
                120,
            )
            self.capture(target, running_path)
            task_id, run_id = self.workflow_ids(run_dir)
            completion_proof = {'complete': False}
            if launched:
                self.wait_until(
                    lambda: self.workflow_completion_proof(
                        run_dir,
                        task_id,
                        run_id,
                        expected_status='failed',
                    )['complete'],
                    180,
                    0.5,
                )
            completion_proof = self.workflow_completion_proof(
                run_dir,
                task_id,
                run_id,
                expected_status='failed',
            )
            status = completion_proof['status']
            (run_dir / 'workflow-completion-proof.json').write_text(
                json.dumps(completion_proof, indent=2) + '\n'
            )
            if task_id:
                self.wait_for_notification_count(run_dir, 1, timeout=60, interval=0.5)
                prompt_ready = self.wait_until(
                    lambda: any(
                        re.fullmatch(r'\s*❯\s*', line)
                        for line in strip_ansi(self.capture(
                            target,
                            run_dir / '04-prompt-after-detail-dialog.txt',
                            history=False,
                        )).splitlines()
                    ),
                    60,
                    0.5,
                )
                if prompt_ready:
                    self.send(
                        target,
                        run_dir,
                        f'/workflows detail {task_id}',
                        'input-workflow-failure-detail-command.txt',
                    )
                detail_ok = prompt_ready and self.wait_until(
                    lambda: all(
                        text in strip_ansi(self.capture(target, detail_path))
                        for text in (
                            'Workflow detail',
                            'Root cause:',
                            'Attempts:',
                            'invalid-schema-worker',
                            'retryable=false',
                        )
                    ),
                    60,
                    0.5,
                )
            self.capture(target, terminal_path)
        else:
            for path in (running_path, detail_path, terminal_path):
                path.write_text('readiness failed\n')
        log = self.debug(run_dir)
        marker_counts = {
            key: log.count(key)
            for key in (
                'workflow_worker_start',
                'workflow_worker_fail',
                'workflow_worker_retry_scheduled',
                'workflow_worker_terminal',
            )
        }
        marker_path.write_text(
            '\n'.join(f'{key}\t{value}' for key, value in marker_counts.items()) + '\n'
        )
        marker_ok = (
            marker_counts['workflow_worker_start'] == 1
            and marker_counts['workflow_worker_fail'] == 1
            and marker_counts['workflow_worker_terminal'] == 1
        )
        no_retry = marker_counts['workflow_worker_retry_scheduled'] == 0
        wire_assertion = self.workflow_mock_wire(run_dir, 'workflow-failure-detail')
        cleanup = self.close(run_dir, session, target)
        passed = (
            ready and launched and completion_proof['complete']
            and status == 'failed' and detail_ok
            and marker_ok and no_retry and self.cleanup_passed(cleanup)
            and wire_assertion['validation_verdict'] == 'passed'
        )
        evidence = [
            run_dir / 'input-workflow-failure-detail.txt',
            running_path,
            run_dir / '04-prompt-after-detail-dialog.txt',
            detail_path,
            terminal_path,
            marker_path,
            run_dir / 'debug.log',
        ]
        assertions = [
            wire_assertion,
            self.required_assertion(
                run_dir,
                'workflow-deterministic-failure-detail',
                'Deterministic workflow worker failure',
                'Failed workflow detail preserves root cause and attempt diagnostics.',
                evidence,
                runtime_state='failed',
                passed=passed,
                reason='workflow failure detail evidence was incomplete',
            ),
            self.required_assertion(
                run_dir,
                'workflow-deterministic-failure-no-retry',
                'Non-retryable workflow worker',
                'Invalid schema fails once with terminal markers and no retry marker.',
                [marker_path, run_dir / 'debug.log'],
                runtime_state='failed',
                passed=marker_ok and no_retry,
                reason='retry marker or terminal marker counts were unexpected',
            ),
        ]
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'reason': None if passed else 'required failure diagnostics were incomplete',
            'task_id': task_id,
            'run_id': run_id,
            'runtime_state': status,
            'marker_counts': marker_counts,
            'assertions': assertions,
            'cleanup': cleanup,
        })
        self.record(result)

    def team_concurrency(self):
        run_dir, session, target, ready = self.start('team-concurrency')
        result = {'label': 'team-concurrency', 'evidence_dir': str(run_dir)}
        running_path = run_dir / '03-running-pane.txt'
        terminal_path = run_dir / '04-terminal-pane.txt'
        tasks_path = run_dir / '05-tasks-pane.txt'
        marker_path = run_dir / 'debug-marker-search.txt'
        config_evidence = run_dir / 'team-config.json'
        artifact_evidence = run_dir / 'team-artifacts.json'
        team_name = 'release-team-concurrency'
        terminal = False
        if ready:
            prompt = (
                f'Binary-side team concurrency validation. Use TeamCreate once with team_name "{team_name}". '
                'Then launch exactly three named general-purpose teammates concurrently in one response using the Agent tool, '
                'with names worker-a, worker-b, and worker-c and the created team. Each teammate must reply exactly with its own '
                'name and must not use tools or modify files. Wait until all three Agent tool calls have returned, then print '
                'RELEASE_TEAM_CONCURRENCY_DONE. Do not create tasks, worktrees, commits, or other tools.'
            )
            self.send(target, run_dir, prompt, 'input-team-concurrency.txt')
            self.wait_until(
                lambda: self.debug(run_dir).count('team_mutation_commit') >= 3,
                180,
                0.5,
            )
            self.capture(target, running_path)
            terminal = self.wait_until(
                lambda: 'RELEASE_TEAM_CONCURRENCY_DONE' in self.assistant_text(run_dir),
                300,
                0.5,
            )
            self.capture(target, terminal_path)
            if terminal:
                self.send(target, run_dir, '/tasks', 'input-team-tasks.txt')
                tasks_visible = self.wait_until(
                    lambda: (
                        'Background tasks' in (
                            text := strip_ansi(self.capture(
                                target, tasks_path, history=False
                            ))
                        )
                        and f'Team: {team_name} (4)' in text
                        and all(name in text for name in (
                            'worker-a', 'worker-b', 'worker-c'
                        ))
                        and not submitted_input_pending(text)
                    ),
                    30,
                    0.25,
                )
            else:
                tasks_visible = False
                tasks_path.write_text(
                    'team completion marker was not reached; /tasks was not sent\n'
                )
        else:
            tasks_visible = False
            running_path.write_text('readiness failed\n')
            terminal_path.write_text('readiness failed\n')
            tasks_path.write_text('readiness failed\n')
        team_files = list((run_dir / 'config' / 'teams').glob('*/config.json'))
        team_config = None
        if len(team_files) == 1:
            try:
                team_config = json.loads(team_files[0].read_text())
                config_evidence.write_text(json.dumps(team_config, indent=2) + '\n')
            except json.JSONDecodeError:
                config_evidence.write_text('invalid team config\n')
        else:
            config_evidence.write_text(
                json.dumps({'team_config_paths': [str(path) for path in team_files]}, indent=2) + '\n'
            )
        log = self.debug(run_dir)
        marker_counts = {
            key: log.count(key)
            for key in ('team_mutation_start', 'team_mutation_commit', 'team_mutation_abort')
        }
        marker_path.write_text(
            '\n'.join(f'{key}\t{value}' for key, value in marker_counts.items()) + '\n'
        )
        members = team_config.get('members', []) if isinstance(team_config, dict) else []
        agent_ids = [member.get('agentId') for member in members if isinstance(member, dict)]
        worker_names = {
            member.get('name')
            for member in members
            if isinstance(member, dict) and member.get('name') in {'worker-a', 'worker-b', 'worker-c'}
        }
        config_ok = (
            len(members) == 4
            and len(agent_ids) == 4
            and len(set(agent_ids)) == 4
            and worker_names == {'worker-a', 'worker-b', 'worker-c'}
        )
        markers_ok = (
            marker_counts['team_mutation_start'] >= 3
            and marker_counts['team_mutation_commit'] >= 3
            and marker_counts['team_mutation_abort'] == 0
        )
        team_dir = team_files[0].parent if len(team_files) == 1 else None
        inbox_paths = sorted(
            str(path)
            for path in (team_dir / 'inboxes').glob('*.json')
        ) if team_dir else []
        task_ids = sorted(set(re.findall(
            r'\[spawnInProcessTeammate\] Spawning [^ ]+ \(taskId: ([^)]+)\)',
            log,
        )))
        leader_inbox_path = team_dir / 'inboxes' / 'team-lead.json' if team_dir else None
        idle_notifications = []
        if leader_inbox_path and leader_inbox_path.exists():
            try:
                messages = json.loads(leader_inbox_path.read_text())
                for message in messages:
                    payload = json.loads(message.get('text', '')) if isinstance(message, dict) else None
                    if isinstance(payload, dict) and payload.get('type') == 'idle_notification':
                        idle_notifications.append(payload)
            except (json.JSONDecodeError, OSError):
                idle_notifications = []
        idle_workers = [item.get('from') for item in idle_notifications]
        artifact_evidence.write_text(json.dumps({
            'inbox_paths': inbox_paths,
            'task_ids': task_ids,
            'idle_notifications': idle_notifications,
        }, indent=2) + '\n')
        artifacts_ok = (
            inbox_paths == ([str(leader_inbox_path)] if leader_inbox_path else [])
            and len(task_ids) == 3
            and len(idle_notifications) == 3
            and set(idle_workers) == {'worker-a', 'worker-b', 'worker-c'}
            and all(item.get('idleReason') == 'available' for item in idle_notifications)
        )
        cleanup = self.close(run_dir, session, target)
        passed = (
            ready and terminal and tasks_visible and config_ok and markers_ok and artifacts_ok
            and self.cleanup_passed(cleanup)
        )
        evidence = [
            run_dir / 'input-team-concurrency.txt',
            running_path,
            terminal_path,
            tasks_path,
            config_evidence,
            artifact_evidence,
            marker_path,
            run_dir / 'debug.log',
        ]
        assertions = [
            self.required_assertion(
                run_dir,
                'team-concurrent-registration',
                'Concurrent teammate registration',
                'Leader plus three uniquely named workers remain in one team config.',
                evidence,
                passed=passed,
                reason='team config, pane, or mutation evidence was incomplete',
            ),
            self.required_assertion(
                run_dir,
                'team-mutation-lock-markers',
                'Team mutation serialization',
                'Three registrations commit without abort or member loss.',
                [config_evidence, artifact_evidence, marker_path, run_dir / 'debug.log'],
                passed=passed and markers_ok and artifacts_ok,
                reason='team mutation, task, or mailbox evidence was incomplete',
            ),
        ]
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'reason': None if passed else 'team concurrency assertions were incomplete',
            'team_name': team_config.get('name') if isinstance(team_config, dict) else None,
            'member_count': len(members),
            'agent_ids': agent_ids,
            'task_ids': task_ids,
            'inbox_paths': inbox_paths,
            'tasks_visible': tasks_visible,
            'marker_counts': marker_counts,
            'assertions': assertions,
            'cleanup': cleanup,
        })
        self.record(result)

    def coordinator_selector(self):
        run_dir, session, target, ready = self.start('coordinator-selector')
        result = {'label': 'coordinator-selector', 'evidence_dir': str(run_dir)}
        background_path = run_dir / '03-background-pane.txt'
        main_path = run_dir / '04-main-pane.txt'
        agent_path = run_dir / '05-agent-pane.txt'
        viewed_path = run_dir / '06-viewed-agent-pane.txt'
        marker_path = run_dir / 'debug-marker-search.txt'
        task_id = None
        selected_background = selected_main = selected_agent = viewed_agent = False
        mock_server = self.mock_servers.get(run_dir.name)
        tools_returned = False
        if ready:
            prompt = (
                'Coordinator selector binary validation. Call the Agent tool exactly once in foreground with description '
                '"release coordinator selector". The general-purpose child must run a harmless Bash marker command, then '
                'read Makefile and report only the VERSION line. Do not modify files or use other parent tools.'
            )
            self.send(target, run_dir, prompt, 'input-coordinator-selector.txt')
            registered = self.wait_until(
                lambda: '[AgentLifecycle] foreground_registered' in self.debug(run_dir),
                90,
            )
            if registered:
                self.tmux('send-keys', '-t', target, 'C-b')
            transitioned = registered and self.wait_until(
                lambda: '[AgentLifecycle] foreground_to_background' in self.debug(run_dir),
                30,
            )
            log = self.debug(run_dir)
            task_match = re.search(
                r'foreground_to_background agent_id=[^ ]+ task_id=([^ ]+)',
                log,
            )
            task_id = task_match.group(1) if task_match else None
            if transitioned:
                self.tmux('send-keys', '-t', target, 'Down')
                selected_background = self.wait_until(
                    lambda: 'after_target=background reason=footer-select' in self.debug(run_dir),
                    30,
                    0.25,
                )
                self.capture(target, background_path)
                self.tmux('send-keys', '-t', target, 'Down')
                selected_main = self.wait_until(
                    lambda: re.search(
                        r'after_index=0 .*after_target=main reason=navigation',
                        self.debug(run_dir),
                    ) is not None,
                    30,
                    0.25,
                )
                self.capture(target, main_path)
                self.tmux('send-keys', '-t', target, 'Down')
                selected_agent = self.wait_until(
                    lambda: bool(
                        task_id and f'after_target={task_id} reason=navigation' in self.debug(run_dir)
                    ),
                    30,
                    0.25,
                )
                self.capture(target, agent_path)
                self.tmux('send-keys', '-t', target, 'Enter')
                viewed_agent = self.wait_until(
                    lambda: bool(
                        task_id and f'after={task_id} type=local_agent' in self.debug(run_dir)
                    ),
                    30,
                    0.25,
                )
                self.capture(target, viewed_path)
            if mock_server is not None:
                tools_returned = mock_server.coordinator_tools_done.wait(timeout=30)
                mock_server.coordinator_release.set()
        requests = mock_server.snapshot() if mock_server else []
        outputs = {
            item.get('call_id'): item.get('output')
            for request in requests
            for item in (request.get('body') or {}).get('input', [])
            if isinstance(item, dict) and item.get('type') == 'function_call_output'
        }
        tools_returned = (
            tools_returned
            and 'RELEASE_COORDINATOR_BASH_OK' in json.dumps(outputs.get('fc_release_coordinator_bash'))
            and 'VERSION' in json.dumps(outputs.get('fc_release_coordinator_read'))
            and 'fc_release_coordinator_agent' in outputs
        )
        for path in (background_path, main_path, agent_path, viewed_path):
            if not path.exists():
                path.write_text('required UI state was not reached\n')
        log = self.debug(run_dir)
        marker_lines = [
            line
            for line in log.splitlines()
            if 'coordinator_selection_changed' in line or 'viewed_agent_changed' in line
        ]
        marker_path.write_text('\n'.join(marker_lines) + ('\n' if marker_lines else ''))
        cleanup = self.close(run_dir, session, target)
        passed = (
            ready and bool(task_id) and selected_background and selected_main
            and selected_agent and viewed_agent and tools_returned
            and self.cleanup_passed(cleanup)
        )
        evidence = [
            run_dir / 'input-coordinator-selector.txt',
            run_dir / 'mock-openai-requests.json',
            background_path,
            main_path,
            agent_path,
            viewed_path,
            marker_path,
            run_dir / 'debug.log',
        ]
        assertions = [
            self.required_assertion(
                run_dir,
                'coordinator-stable-navigation',
                'Coordinator keyboard selection',
                'Background, main, and the same stable agent task are selected in order.',
                evidence,
                runtime_state='running',
                passed=passed,
                reason='coordinator selection markers or pane evidence were incomplete',
            ),
            self.required_assertion(
                run_dir,
                'coordinator-agent-transcript-open',
                'Coordinator transcript routing',
                'Enter opens the selected local agent transcript without changing target identity.',
                [viewed_path, marker_path, run_dir / 'debug.log'],
                runtime_state='running',
                passed=passed and viewed_agent,
                reason='viewed-agent marker was not correlated with the selected task',
            ),
        ]
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'reason': None if passed else 'coordinator selector assertions were incomplete',
            'task_id': task_id,
            'selection': {
                'background': selected_background,
                'main': selected_main,
                'agent': selected_agent,
                'viewed_agent': viewed_agent,
            },
            'assertions': assertions,
            'cleanup': cleanup,
        })
        self.record(result)

    def workflow_retry_partial_failure(self):
        run_dir, session, target, ready = self.start(
            'workflow-retry-partial-failure'
        )
        result = {
            'label': 'workflow-retry-partial-failure',
            'evidence_dir': str(run_dir),
        }
        running_path = run_dir / '03-running-pane.txt'
        terminal_path = run_dir / '04-terminal-pane.txt'
        marker_path = run_dir / 'debug-marker-search.txt'
        task_id = run_id = status = None
        launched = False
        completion_proof = {'complete': False}
        if ready:
            script = WORKFLOW_FAULT_SCRIPTS['workflow-retry-partial-failure']
            prompt = (
                'Use Workflow with this exact inline script. Do not modify files.\n'
                '```js\n' + script + '```'
            )
            self.send(
                target,
                run_dir,
                prompt,
                'input-workflow-retry-partial-failure.txt',
            )
            launched = self.wait_until(
                lambda: 'Workflow launched in background. Task ID:'
                in self.transcript(run_dir),
                120,
            )
            self.capture(target, running_path)
            task_id, run_id = self.workflow_ids(run_dir)
            if launched:
                self.wait_until(
                    lambda: (
                        self.workflow_completion_proof(
                            run_dir,
                            task_id,
                            run_id,
                        )['complete']
                        or self.workflow_status(run_dir, task_id) in {'failed', 'stopped'}
                    ),
                    300,
                    0.5,
                )
            completion_proof = self.workflow_completion_proof(
                run_dir,
                task_id,
                run_id,
            )
            status = completion_proof['status']
            self.capture(target, terminal_path)
        else:
            completion_proof = {'complete': False, 'status': None}
        (run_dir / 'workflow-completion-proof.json').write_text(
            json.dumps(completion_proof, indent=2) + '\n'
        )
        if status in {'failed', 'stopped'} and not completion_proof['complete']:
            completion_proof['terminal_proof_incomplete'] = True
            (run_dir / 'workflow-completion-proof.json').write_text(
                json.dumps(completion_proof, indent=2) + '\n'
            )
            status = completion_proof['status']
        if not ready:
            running_path.write_text('readiness failed\n')
            terminal_path.write_text('readiness failed\n')
        log = self.debug(run_dir)
        marker_lines = [
            line
            for line in log.splitlines()
            if 'workflow_worker_' in line
            and (
                'logical=stable-worker' in line
                or 'logical=transient-worker' in line
            )
        ]
        marker_path.write_text(
            '\n'.join(marker_lines) + ('\n' if marker_lines else '')
        )
        stable_starts = sum(
            'workflow_worker_start' in line
            and 'logical=stable-worker' in line
            for line in marker_lines
        )
        stable_terminals = sum(
            'workflow_worker_terminal' in line
            and 'logical=stable-worker' in line
            and 'status=completed' in line
            for line in marker_lines
        )
        transient_starts = sum(
            'workflow_worker_start' in line
            and 'logical=transient-worker' in line
            for line in marker_lines
        )
        transient_failures = sum(
            'workflow_worker_fail' in line
            and 'logical=transient-worker' in line
            and 'kind=service_unavailable' in line
            and 'retryable=true' in line
            for line in marker_lines
        )
        transient_retries = sum(
            'workflow_worker_retry_scheduled' in line
            and 'logical=transient-worker' in line
            and 'detail=retry=1/2' in line
            for line in marker_lines
        )
        transient_terminals = sum(
            'workflow_worker_terminal' in line
            and 'logical=transient-worker' in line
            and 'attempt=1' in line
            and 'status=completed' in line
            for line in marker_lines
        )
        retry_ok = (
            stable_starts == 1
            and stable_terminals == 1
            and transient_starts == 2
            and transient_failures == 1
            and transient_retries == 1
            and transient_terminals == 1
        )
        wire_assertion = self.workflow_mock_wire(run_dir, 'workflow-retry-partial-failure')
        cleanup = self.close(run_dir, session, target)
        passed = (
            ready and launched and status == 'completed'
            and completion_proof['complete']
            and wire_assertion['validation_verdict'] == 'passed'
            and retry_ok
            and self.cleanup_passed(cleanup)
        )
        evidence = [
            run_dir / 'input-workflow-retry-partial-failure.txt',
            running_path,
            terminal_path,
            marker_path,
            run_dir / 'debug.log',
        ]
        assertions = [
            wire_assertion,
            self.required_assertion(
                run_dir,
                'workflow-partial-transient-retry',
                'Controlled partial workflow retry',
                'Only the transient logical worker retries once; the stable worker runs once.',
                evidence,
                passed=passed,
                reason='logical worker retry markers or terminal evidence were incomplete',
            ),
        ]
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'reason': None if passed else 'partial retry assertions were incomplete',
            'task_id': task_id,
            'run_id': run_id,
            'runtime_state': status,
            'marker_counts': {
                'stable_starts': stable_starts,
                'stable_terminals': stable_terminals,
                'transient_starts': transient_starts,
                'transient_failures': transient_failures,
                'transient_retries': transient_retries,
                'transient_terminals': transient_terminals,
            },
            'assertions': assertions,
            'cleanup': cleanup,
        })
        self.record(result)

    def retention_probe_result(self, server, task_id, phase):
        call_id = f'fc_retention_probe_{phase}'
        for request in server.snapshot():
            body = request.get('body')
            if not isinstance(body, dict):
                continue
            items = body.get('input', [])
            calls = [item for item in items if isinstance(item, dict)
                     and item.get('type') == 'function_call' and item.get('call_id') == call_id
                     and item.get('name') == 'TaskOutput']
            if not calls:
                continue
            try:
                arguments = json.loads(calls[-1].get('arguments', '{}'))
            except (ValueError, TypeError):
                continue
            if arguments.get('task_id') != task_id or arguments.get('block') is not False:
                continue
            for item in items:
                if not isinstance(item, dict) or item.get('type') != 'function_call_output' or item.get('call_id') != call_id:
                    continue
                output = item.get('output', '')
                if not isinstance(output, str):
                    continue
                if phase == 'after':
                    if re.fullmatch(
                        re.escape(f'<tool_use_error>No task found with ID: {task_id}</tool_use_error>')
                        + r'(?:\s*<system-reminder>(?:(?!</?system-reminder>).)*</system-reminder>)*',
                        output.strip(), re.DOTALL,
                    ):
                        return True
                elif (f'<task_id>{task_id}</task_id>' in output
                      and '<task_type>in_process_teammate</task_type>' in output
                      and '<status>completed</status>' in output):
                    return True
        return False

    def retention_active_abort(self, run_dir, target, server, task_id):
        spawn = re.search(
            r'\[spawnInProcessTeammate\] Spawning (retention-worker@\S+) '
            + re.escape(f'(taskId: {task_id})'), self.debug(run_dir))
        evidence = {'task_id': task_id, 'agent_id': spawn.group(1) if spawn else None}
        evidence['request_pending'] = bool(server and self.wait_until(
            server.retention_child_waiting.is_set, 30, 0.05))
        offset = len(self.debug(run_dir))
        if spawn and evidence['request_pending']:
            self.capture(target, run_dir / 'active-before-escape.txt', history=False)
            self.tmux('send-keys', '-t', target, 'Escape', check=True)
            agent_id = spawn.group(1)
            evidence['interrupted'] = self.wait_until(lambda: all(
                f'[inProcessRunner] {agent_id} {suffix}' in self.debug(run_dir)[offset:]
                for suffix in ('current work aborted (Escape pressed)',
                               'work interrupted, returning to idle')), 20, 0.05)
            if evidence['interrupted']:
                server.retention_child_release.set()
                def idle_view():
                    pane = strip_ansi(self.capture(target, run_dir / 'active-idle-pane.txt', history=False))
                    return (
                        'Viewing @retention-worker' in pane
                        and 'Interrupted · What should Claude do instead?' in pane
                        and f'viewed_agent_changed] before={task_id} after=main' not in self.debug(run_dir)[offset:]
                        and f'transcript_retention_decision] task={task_id}' not in self.debug(run_dir)[offset:])
                evidence['view_preserved'] = self.wait_until(idle_view, 5, 0.05)
                if evidence['view_preserved']:
                    self.send(target, run_dir, 'RELEASE_RETENTION_RESUME', 'input-retention-resume.txt')
                    evidence['resumed'] = self.wait_until(lambda:
                        'RELEASE_RETENTION_WORKER_DONE' in self.assistant_text(run_dir, subagents=True)
                        and 'RELEASE_RETENTION_WORKER_DONE' in strip_ansi(self.capture(
                            target, run_dir / 'active-resumed-pane.txt', history=False))
                        and any(request.get('response_kind') == 'retention-worker-marker'
                                for request in server.snapshot()), 30, 0.1)
        (run_dir / 'active-abort-markers.txt').write_text(self.debug(run_dir)[offset:])
        evidence['passed'] = bool(evidence.get('interrupted') and evidence.get('view_preserved')
                                  and evidence.get('resumed'))
        (run_dir / 'active-abort-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
        return evidence['passed']

    def retention_escape_window(self, run_dir, target, task_id, exit_sent):
        evidence = {'task_id': task_id, 'exit_sent': exit_sent, 'samples': []}
        def rewind(path):
            return re.search(r'(?im)^\s*Rewind\s*$', strip_ansi(
                self.capture(target, path, history=False))) is not None
        evidence['main_escape_sent'] = time.monotonic()
        evidence['within_window'] = 0 <= evidence['main_escape_sent'] - exit_sent < 0.8
        if evidence['within_window']:
            self.tmux('send-keys', '-t', target, 'Escape', check=True)
            def observe():
                path = run_dir / f'escape-window-{len(evidence["samples"]):03d}.txt'
                polluted = rewind(path)
                evidence['samples'].append({'time': time.monotonic(), 'path': str(path),
                                            'rewind': polluted})
                # Ink buffers a lone ESC for 50 ms before dispatch. Observe past
                # that delay plus the 800 ms double-press window so this probe's
                # ESC cannot pair with the following intentional double ESC.
                return time.monotonic() > evidence['main_escape_sent'] + 0.9
            observed = self.wait_until(observe, 2, 0.05)
            evidence['isolated'] = observed and not any(sample['rewind'] for sample in evidence['samples'])
            if evidence['isolated']:
                evidence['double_first_sent'] = time.monotonic()
                evidence['double_second_sent'] = evidence['double_first_sent']
                evidence['double_chunk_hex'] = '1b1b'
                self.tmux('send-keys', '-t', target, '-l', '\x1b\x1b', check=True)
                evidence['normal_rewind'] = (
                    evidence['double_second_sent'] - evidence['double_first_sent'] < 0.8
                    and self.wait_until(lambda: rewind(run_dir / 'main-rewind-pane.txt'), 5, 0.05))
                if evidence['normal_rewind']:
                    self.tmux('send-keys', '-t', target, 'Escape', check=True)
                    stable_since = None
                    def composer_ready():
                        nonlocal stable_since
                        pane = strip_ansi(self.capture(
                            target, run_dir / 'main-rewind-closed-pane.txt', history=False))
                        ready = (not re.search(r'(?im)^\s*Rewind\s*$', pane)
                                 and re.search(r'(?m)^\s*❯\s*$', pane) is not None)
                        if not ready:
                            stable_since = None
                            return False
                        if stable_since is None:
                            stable_since = time.monotonic()
                        return time.monotonic() - stable_since >= 0.8
                    evidence['rewind_closed'] = self.wait_until(composer_ready, 5, 0.05)
        evidence['passed'] = bool(evidence.get('isolated') and evidence.get('normal_rewind')
                                  and evidence.get('rewind_closed'))
        (run_dir / 'escape-window-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
        return evidence['passed']

    def retention_gc(self, run_dir, target, server, task_id, grace_deadline, grace_upper_deadline):
        evidence = {'task_id': task_id, 'grace_deadline': grace_deadline,
                    'grace_upper_deadline': grace_upper_deadline}
        def probe(phase):
            self.send(target, run_dir, f'RELEASE_RETENTION_PROBE {task_id} {phase}',
                      f'input-retention-probe-{phase}.txt')
            return self.wait_until(
                lambda: self.retention_probe_result(server, task_id, phase)
                and f'RELEASE_RETENTION_PROBE_{phase.upper()}_DONE' in strip_ansi(
                    self.capture(target, run_dir / f'gc-{phase}-pane.txt', history=False)),
                20, 0.1)
        evidence['before_passed'] = probe('before')
        evidence['before_observed'] = time.monotonic()
        evidence['before_within_grace'] = evidence['before_observed'] < grace_deadline
        if evidence['before_passed'] and evidence['before_within_grace']:
            # Exercise the actual grace interval, then trigger attachment GC with a new turn.
            evidence['grace_elapsed'] = self.wait_until(
                lambda: time.monotonic() >= grace_upper_deadline + 2, 35, 0.25)
            if evidence['grace_elapsed']:
                evidence['tick_sent'] = time.monotonic()
                self.send(target, run_dir, 'RELEASE_RETENTION_GC_TICK', 'input-retention-gc-tick.txt')
                evidence['tick_passed'] = self.wait_until(
                    lambda: 'RELEASE_RETENTION_GC_TICK_DONE' in strip_ansi(
                        self.capture(target, run_dir / 'gc-tick-pane.txt', history=False)), 20, 0.1)
                evidence['after_passed'] = evidence['tick_passed'] and probe('after')
        passed = bool(evidence['before_passed'] and evidence['before_within_grace']
                      and evidence.get('after_passed'))
        evidence['passed'] = passed
        (run_dir / 'gc-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
        return passed

    def transcript_retention(self):
        run_dir, session, target, ready = self.start('transcript-retention')
        result = {'label': 'transcript-retention', 'evidence_dir': str(run_dir)}
        running_path = run_dir / '03-running-pane.txt'
        viewed_path = run_dir / '04-viewed-pane.txt'
        terminal_path = run_dir / '05-terminal-viewed-pane.txt'
        main_path = run_dir / '06-main-pane.txt'
        marker_path = run_dir / 'debug-marker-search.txt'
        reopened_path = run_dir / '07-reopened-pane.txt'
        viewed = retained = exited = terminal_visible = reopened = gc_passed = escape_window_passed = False
        active_abort_passed = False
        mock_server = self.mock_servers.get(run_dir.name)
        task_id = None
        routes = {name: False for name in ('footer', 'shift', 'spinner', 'tasks')}
        route_evidence = {name: [] for name in routes}
        exit_checks = []
        grace_deadline = None
        grace_upper_deadline = None

        def pane_ready(path, predicate):
            return self.wait_until(
                lambda: predicate(self.capture(target, path, history=False)), 5, 0.05,
            )

        def key_state(key, path, predicate):
            before = self.capture(target, path, history=False)
            self.tmux('send-keys', '-t', target, key, check=True)
            if key in ('Down', 'Right') and 'footer' in path.name:
                # Only the pill row may establish footer progress; unrelated
                # spinner/token updates must not satisfy the keyboard barrier.
                def pill_row(text):
                    return [line for line in text.splitlines()
                            if '@main' in line and '@retention-worker' in line]
                return pane_ready(path, lambda text:
                    bool(pill_row(text)) and pill_row(text) != pill_row(before)
                    and predicate(strip_ansi(text)))
            return pane_ready(path, lambda text: text != before and predicate(strip_ansi(text)))

        def footer_open(path):
            # Selection is rendered as a pill highlight, so retain raw pane bytes
            # for the transition check without interpreting ANSI styles.
            return (
                pane_ready(path, lambda text: '@retention-worker' in strip_ansi(text))
                and key_state('Down', path, lambda text: '@main' in text)
                and key_state('Right', path, lambda text: '@retention-worker' in text)
            )

        def exit_view(path):
            nonlocal grace_deadline, grace_upper_deadline
            offset = len(self.debug(run_dir))
            grace_deadline = time.monotonic() + 30
            self.tmux('send-keys', '-t', target, 'Escape', check=True)
            ok = self.wait_until(
                lambda: f'viewed_agent_changed] before={task_id} after=main'
                in self.debug(run_dir)[offset:], 5, 0.05,
            )

            def main_view(text):
                text = strip_ansi(text)
                return (
                    re.search(r'(?im)^\s*Viewing\b', text) is None
                    and 'message @retention-worker' not in text.lower()
                    and 'esc to return' not in text.lower()
                    and re.search(r'(?im)^\s*Rewind\s*$', text) is None
                    and re.search(r'(?m)^\s*─+\s*\n[^\S\n]*❯[^\S\n]*\n[^\S\n]*─+', text) is not None
                )

            grace_upper_deadline = time.monotonic() + 30 if ok else None
            ok = ok and pane_ready(path, main_view)
            exit_checks.append(ok)
            return ok

        def confirm_view(name, key, path):
            offset = len(self.debug(run_dir))
            self.tmux('send-keys', '-t', target, key, check=True)
            ok = self.wait_until(
                lambda: f'viewed_agent_changed] before=main after={task_id} type=in_process_teammate'
                in self.debug(run_dir)[offset:], 5, 0.05,
            )
            ok = ok and pane_ready(path, lambda text:
                'RELEASE_RETENTION_WORKER_DONE' in strip_ansi(text))
            ok = bool(ok and grace_deadline and time.monotonic() < grace_deadline)
            fresh = run_dir / f'{name}-entry-markers.txt'
            fresh.write_text(self.debug(run_dir)[offset:])
            route_evidence[name].extend([path, fresh])
            routes[name] = ok
            return ok

        if ready:
            prompt = (
                'Transcript retention binary validation. Use TeamCreate once with team_name '
                '"release-transcript-retention". Launch exactly one named general-purpose '
                'teammate named retention-worker with run_in_background=true. Its initial task '
                'must reply exactly RELEASE_RETENTION_WORKER_DONE. Tell it that after replying, '
                'if it receives a shutdown request, it must approve that request using '
                'SendMessage. Immediately after launching it, use SendMessage to send '
                'retention-worker a structured shutdown_request, then return. Do not modify files.'
            )
            self.send(target, run_dir, prompt, 'input-transcript-retention.txt')
            registered = self.wait_until(
                lambda: re.search(
                    r'\[spawnInProcessTeammate\] Registered retention-worker@[^\s]+ in AppState',
                    self.debug(run_dir),
                ) is not None,
                120,
                0.5,
            )
            self.capture(target, running_path)
            if registered and footer_open(run_dir / 'initial-footer-selection.txt'):
                initial_offset = len(self.debug(run_dir))
                self.tmux('send-keys', '-t', target, 'Enter', check=True)
                viewed = self.wait_until(
                    lambda: re.search(
                        r'viewed_agent_changed[^\n]*after=([^ ]+)[^\n]*type=in_process_teammate',
                        self.debug(run_dir)[initial_offset:],
                    ) is not None,
                    30,
                    0.25,
                )
                self.capture(target, viewed_path)
                view_match = re.search(
                    r'viewed_agent_changed[^\n]*after=([^ ]+)[^\n]*type=in_process_teammate',
                    self.debug(run_dir),
                )
                task_id = view_match.group(1) if view_match else None
                spawned = re.search(
                    r'\[spawnInProcessTeammate\] Spawning retention-worker@[^\s]+ \(taskId: ([^)]+)\)',
                    self.debug(run_dir),
                )
                viewed = bool(viewed and spawned and task_id == spawned.group(1))
                if viewed:
                    active_abort_passed = self.retention_active_abort(run_dir, target, mock_server, task_id)
                viewed = viewed and active_abort_passed and self.wait_until(
                    lambda: 'RELEASE_RETENTION_WORKER_DONE' in strip_ansi(
                        self.capture(target, viewed_path))
                    and 'RELEASE_RETENTION_WORKER_DONE' in self.assistant_text(run_dir, subagents=True),
                    30, 0.25,
                )
                if viewed and mock_server is not None:
                    mock_server.retention_release.set()
                retained = viewed and bool(task_id) and self.wait_until(
                    lambda: (
                        f'transcript_retention_decision] task={task_id} status=completed retain=keep'
                        in self.debug(run_dir)
                    ),
                    180,
                    0.5,
                )
                terminal = self.capture(target, terminal_path)
                worker_assistant_text = self.assistant_text(
                    run_dir,
                    subagents=True,
                )
                terminal_visible = (
                    retained
                    and 'RELEASE_RETENTION_WORKER_DONE' in worker_assistant_text
                    and 'RELEASE_RETENTION_WORKER_DONE' in strip_ansi(terminal)
                )
                (run_dir / 'worker-assistant-text.txt').write_text(
                    worker_assistant_text + ('\n' if worker_assistant_text else '')
                )
                if retained:
                    exited = exit_view(main_path)
                if exited and footer_open(run_dir / 'footer-selection.txt'):
                    reopened = confirm_view('footer', 'Enter', reopened_path)
                if reopened and exit_view(run_dir / 'shift-main.txt'):
                    selection = run_dir / 'shift-selection.txt'
                    route_evidence['shift'].append(selection)
                    if (key_state('S-Down', selection, lambda text: 'team-lead' in text and 'hide' in text)
                            and key_state('S-Down', selection, lambda text:
                                'retention-worker' in text and 'enter to view' in text)):
                        confirm_view('shift', 'Enter', run_dir / 'shift-viewed.txt')
                if routes['shift'] and exit_view(run_dir / 'spinner-main.txt'):
                    selection = run_dir / 'spinner-selection.txt'
                    route_evidence['spinner'].append(selection)
                    # Selection remains on worker after viewing. Visit hide, then
                    # step back to the worker and use the spinner's f shortcut.
                    if (key_state('S-Down', selection, lambda text: 'enter to collapse' in text)
                            and key_state('S-Up', selection, lambda text:
                                'retention-worker' in text and 'enter to view' in text)):
                        confirm_view('spinner', 'f', run_dir / 'spinner-viewed.txt')
                if routes['spinner'] and exit_view(run_dir / 'tasks-main.txt'):
                    selection = run_dir / 'tasks-collapse.txt'
                    tasks_path = run_dir / 'tasks-list.txt'
                    detail_path = run_dir / 'tasks-detail.txt'
                    route_evidence['tasks'].extend([selection, tasks_path, detail_path])
                    # BackgroundTasksDialog excludes teammates while the spinner
                    # tree is expanded. Collapse via its actual hide row first.
                    if (key_state('S-Down', selection, lambda text: 'enter to collapse' in text)
                            and key_state('Enter', selection, lambda text: 'enter to collapse' not in text)):
                        self.send(target, run_dir, '/tasks', 'input-retention-tasks.txt')
                        if (pane_ready(tasks_path, lambda text:
                                'Background tasks' in strip_ansi(text) and '@retention-worker' in strip_ansi(text))
                                and key_state('Down', tasks_path, lambda text:
                                    re.search(r'[›❯].*@retention-worker', text) is not None)
                                and key_state('Enter', detail_path, lambda text:
                                    '@retention-worker' in text and 'Completed' in text
                                    and 'Prompt' in text and 'foreground' in text)):
                            confirm_view('tasks', 'f', run_dir / 'tasks-viewed.txt')
                if routes['tasks'] and exit_view(run_dir / 'final-main.txt'):
                    escape_window_passed = self.retention_escape_window(
                        run_dir, target, task_id, grace_deadline - 30)
                    gc_passed = self.retention_gc(
                        run_dir, target, mock_server, task_id, grace_deadline, grace_upper_deadline)
        log = self.debug(run_dir)
        marker_lines = [
            line
            for line in log.splitlines()
            if 'viewed_agent_changed' in line
            or 'transcript_retention_decision' in line
            or 'spawnInProcessTeammate' in line
        ]
        marker_path.write_text(
            '\n'.join(marker_lines) + ('\n' if marker_lines else '')
        )
        cleanup = self.close(run_dir, session, target)
        spawn_ids = re.findall(
            r'\[spawnInProcessTeammate\] Spawning [^\n]+ \(taskId: ([^)]+)\)', log,
        )
        same_task = spawn_ids == [task_id]
        passed = (
            ready and bool(task_id) and viewed and retained and terminal_visible
            and exited and reopened and all(routes.values()) and same_task
            and len(exit_checks) == 5 and all(exit_checks) and gc_passed and escape_window_passed
            and self.cleanup_passed(cleanup)
        )
        evidence = [
            run_dir / 'input-transcript-retention.txt',
            run_dir / 'mock-openai-requests.json',
            reopened_path,
            running_path,
            viewed_path,
            terminal_path,
            main_path,
            marker_path,
            run_dir / 'debug.log',
        ]
        assertions = [
            self.required_assertion(
                run_dir,
                'viewed-teammate-terminal-retention',
                'Viewed in-process teammate transcript',
                'A viewed teammate reaches terminal while retaining its complete visible transcript.',
                evidence,
                passed=bool(ready and task_id and viewed and retained and terminal_visible
                            and exited and reopened and same_task),
                reason='view, retention, terminal transcript, or exit evidence was incomplete',
            ),
        ]
        for name, covered in routes.items():
            assertions.append(self.required_assertion(
                run_dir, f'transcript-retention-{name}-reentry',
                f'Transcript reentry via {name}',
                'Same terminal task reopened within grace with a fresh view marker and visible transcript.',
                [*route_evidence[name], marker_path, run_dir / 'debug.log'],
                passed=covered and same_task,
                reason=f'{name} entry, fresh task marker, transcript, or single-spawn evidence missing',
            ))
        assertions.append(self.required_assertion(
            run_dir, 'transcript-retention-single-escape', 'Single Escape exits',
            'Each of five views exits to main using exactly one Escape.',
            [main_path, run_dir / 'final-main.txt', marker_path],
            passed=len(exit_checks) == 5 and all(exit_checks),
            reason='single Escape did not exit every view',
        ))
        assertions.append(self.required_assertion(
            run_dir, 'transcript-retention-active-abort', 'Active teammate turn cancellation and resume',
            'Escape interrupts only the active turn, preserves the view, and the same task processes new input.',
            [run_dir / 'active-abort-evidence.json', run_dir / 'active-abort-markers.txt',
             run_dir / 'active-before-escape.txt', run_dir / 'active-idle-pane.txt',
             run_dir / 'active-resumed-pane.txt', run_dir / 'input-retention-resume.txt',
             run_dir / 'mock-openai-requests.json', marker_path],
            passed=active_abort_passed and same_task,
            reason='active request, same-agent abort markers, preserved view, or resume evidence missing',
        ))
        assertions.append(self.required_assertion(
            run_dir, 'transcript-retention-escape-window', 'Escape isolation and normal Rewind',
            'A main Escape within 800ms of teammate exit does not open Rewind; a fresh main double Escape does.',
            [run_dir / 'escape-window-evidence.json', run_dir / 'main-rewind-pane.txt',
             run_dir / 'main-rewind-closed-pane.txt', *sorted(run_dir.glob('escape-window-*.txt')),
             marker_path],
            passed=escape_window_passed and same_task,
            reason='timed Escape isolation, normal Rewind, or dialog dismissal evidence missing',
        ))
        assertions.append(self.required_assertion(
            run_dir, 'transcript-retention-gc', 'Real attachment GC after grace',
            'TaskOutput finds the same completed task before grace and reports it missing after a new GC turn.',
            [run_dir / 'gc-evidence.json', run_dir / 'gc-before-pane.txt',
             run_dir / 'gc-tick-pane.txt', run_dir / 'gc-after-pane.txt',
             run_dir / 'mock-openai-requests.json'],
            passed=gc_passed and same_task,
            reason='before-grace presence, query GC tick, or after-grace missing tool result absent',
        ))
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'reason': None if passed else 'transcript retention assertions were incomplete',
            'task_id': task_id,
            'runtime_state': 'done' if retained else 'running',
            'viewed': viewed,
            'retained': retained,
            'terminal_visible': terminal_visible,
            'exited': exited,
            'reopened': reopened,
            'entry_paths': routes,
            'same_task_no_duplicate_spawn': same_task,
            'single_escape_exits': exit_checks,
            'gc_passed': gc_passed,
            'assertions': assertions,
            'cleanup': cleanup,
        })
        self.record(result)

    def ssh_remote_session_lifecycle(self):
        run_dir, session, target, ready = self.start('ssh-remote-session-lifecycle')
        result = {'label': 'ssh-remote-session-lifecycle', 'evidence_dir': str(run_dir)}
        task_path = run_dir / '02-ssh-task-pane.txt'
        permission_path = run_dir / '03-ssh-permission-pane.txt'
        terminal_path = run_dir / '04-ssh-terminal-pane.txt'
        fixture = {**SSH_LIFECYCLE_IDS, 'events': []}
        task_visible = permission_visible = terminal_visible = False
        history_ready = ready and self.wait_until(
            lambda: 'history-bootstrap-response' in self.ssh_fixture_events(run_dir),
            30,
            0.25,
        )
        if history_ready:
            self.send(target, run_dir, 'RELEASE_SSH_TASK_START', 'input-ssh-task.txt')
            task_visible = self.wait_until(
                lambda: 'release-ssh-tool-0001' in self.debug(run_dir)
                or 'Bash' in strip_ansi(self.capture(target, task_path)), 30, 0.25,
            )
            permission = self.capture(target, permission_path)
            permission_visible = 'Bash' in strip_ansi(permission)
            if permission_visible:
                self.tmux('send-keys', '-t', target, 'Enter', check=True)
            terminal_visible = self.wait_until(
                lambda: (
                    'RELEASE_SSH_TASK_COMPLETE' in strip_ansi(
                        self.capture(target, terminal_path)
                    )
                    or 'task-result' in self.ssh_fixture_events(run_dir)
                ), 30, 0.25,
            )
            if terminal_visible:
                self.capture(target, terminal_path)
        io_path = run_dir / 'fake-ssh-io.jsonl'
        if io_path.exists():
            for line in io_path.read_text(errors='replace').splitlines():
                try:
                    fixture['events'].append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        pre_cleanup = self.ssh_lifecycle_evidence(
            fixture, require_cleanup=False
        )
        cleanup = self.close(run_dir, session, target)
        if io_path.exists():
            fixture['events'] = []
            for line in io_path.read_text(errors='replace').splitlines():
                try:
                    fixture['events'].append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        lifecycle = self.ssh_lifecycle_evidence(fixture)
        (run_dir / 'ssh-lifecycle-evidence.json').write_text(json.dumps({
            'ids': SSH_LIFECYCLE_IDS, 'events': fixture['events'],
            'before_cleanup': pre_cleanup, 'after_cleanup': lifecycle,
        }, indent=2) + '\n')
        passed = (
            ready and task_visible and permission_visible and terminal_visible
            and pre_cleanup['passed'] and lifecycle['passed']
            and self.cleanup_passed(cleanup)
        )
        assertions = [self.required_assertion(
            run_dir, 'ssh-remote-session-lifecycle',
            'Built CLI remote SSH stream lifecycle',
            'Built Claude starts the isolated fake ssh transport; history bootstrap, task, tool, permission, completion, session end, and cleanup share stable IDs.',
            [run_dir / 'pane-target.txt', task_path, permission_path, terminal_path,
             io_path, run_dir / 'debug.log', run_dir / 'ssh-lifecycle-evidence.json'],
            passed=passed,
            reason='SSH lifecycle pane, transport I/O, IDs, or cleanup evidence was incomplete',
        )]
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'reason': None if passed else 'SSH lifecycle assertions were incomplete',
            **SSH_LIFECYCLE_IDS, 'task_visible': task_visible,
            'permission_visible': permission_visible, 'terminal_visible': terminal_visible,
            'transport_evidence': lifecycle, 'assertions': assertions, 'cleanup': cleanup,
        })
        self.record(result)

    def openai_stats(self):
        scenarios = []
        assertions = []
        for label in ('openai-stats', 'openai-stats-api-key'):
            run_dir, session, target, ready = self.start(label)
            server = self.mock_servers[run_dir.name]
            checks = {'ready': ready}
            panes = []

            def observe(name, text, count, active):
                path = run_dir / f'stats-{name}.txt'
                panes.append(path)

                def matches():
                    raw = self.capture(target, path, history=False)
                    bar = next((line for line in raw.splitlines() if re.fullmatch(
                        r'\s*Overview\s+Models(?:\s+OpenAI)?\s*', strip_ansi(line))), '')
                    # Ink's selected tab is the sole bold label in this row.
                    selected = re.findall(
                        r'\x1b\[1m(?:\x1b\[[0-9;]*m)*\s*(Overview|Models|OpenAI)\b', bar)
                    checks[f'{name}-active-{active.lower()}'] = selected == [active]
                    return text in strip_ansi(raw) and selected == [active]

                matched = self.wait_until(matches, 15, 0.2)
                # Allow queued tab/refresh effects to settle before negative counts.
                time.sleep(0.4)
                current = strip_ansi(self.capture(target, path, history=False))
                rows = [row for row in server.snapshot() if row['route'] == 'activity']
                checks[name] = matched and text in current and len(rows) == count
                tab_bar = next((line.strip() for line in current.splitlines()
                                if re.fullmatch(r'\s*Overview\s+Models(?:\s+OpenAI)?\s*', line)), '')
                checks[f'{name}-tab-bar'] = bool(tab_bar)
                checks[name] = checks[name] and matches()
                if not checks[name]:
                    raise RuntimeError(f'Stats {name}: expected active {active} and matching pane/HTTP state')
                return tab_bar

            try:
                if ready:
                    self.send(target, run_dir, '/stats', 'stats-command.txt')
                    pane = observe('empty', 'No stats available yet', 0, 'Overview')
                    self.tmux('send-keys', '-t', target, 'Down')
                    if label == 'openai-stats':
                        checks['oauth-tab'] = 'OpenAI' in pane
                        self.tmux('send-keys', '-t', target, 'Tab')
                        observe('local', 'No stats available yet', 0, 'Models')
                        self.tmux('send-keys', '-t', target, 'Tab')
                        observe('loaded', 'Lifetime tokens: 42', 1, 'OpenAI')
                        self.tmux('send-keys', '-t', target, 'Tab')
                        observe('away', 'No stats available yet', 1, 'Overview')
                        self.tmux('send-keys', '-t', target, 'Tab')
                        observe('return-local', 'No stats available yet', 1, 'Models')
                        self.tmux('send-keys', '-t', target, 'Tab')
                        observe('cached', 'Lifetime tokens: 42', 1, 'OpenAI')
                        server.fail = True
                        if checks.get('cached-active-openai'):
                            self.tmux('send-keys', '-t', target, 'r')
                        observe('error', 'Failed to load OpenAI activity', 2, 'OpenAI')
                        server.fail = False
                        if checks.get('error-active-openai'):
                            self.tmux('send-keys', '-t', target, 'r')
                        observe('recovered', 'Lifetime tokens: 42', 3, 'OpenAI')
                        rows = [row for row in server.snapshot() if row['route'] == 'activity']
                        checks['http-sequence'] = [row['status'] for row in rows] == [200, 503, 200]
                        checks['http-auth'] = all(row['matches_dummy'] for row in rows)
                    else:
                        checks['no-oauth-tab'] = 'OpenAI' not in pane
                        for index in range(3):
                            self.tmux('send-keys', '-t', target, 'Tab')
                            pane = observe(f'override-{index}', 'No stats available yet', 0,
                                           'Models' if index % 2 == 0 else 'Overview')
                            checks[f'no-tab-{index}'] = 'OpenAI' not in pane
            except RuntimeError as error:
                checks['navigation'] = False
                (run_dir / 'stats-navigation-error.txt').write_text(str(error) + '\n')
            finally:
                cleanup = self.close(run_dir, session, target)
            checks['cleanup'] = self.cleanup_passed(cleanup)
            passed = all(checks.values())
            (run_dir / 'stats-checks.json').write_text(json.dumps(checks, indent=2) + '\n')
            assertions.append(self.required_assertion(
                run_dir, label, label,
                'Real pane observations paired with local TLS HTTP request counts and statuses.',
                [run_dir / 'pane-target.txt', run_dir / 'openai-stats-http.json',
                 run_dir / 'stats-checks.json', *panes], passed=passed,
                reason='OpenAI stats pane/HTTP/cleanup assertions incomplete'))
            scenarios.append({'label': label, 'checks': checks, 'cleanup': cleanup,
                              'evidence_dir': str(run_dir)})
        passed = all(all(item['checks'].values()) for item in scenarios)
        self.record({'label': 'openai-stats', 'scenarios': scenarios,
                     'evidence_dir': scenarios[0]['evidence_dir'],
                     'validation_verdict': 'passed' if passed else 'failed',
                     'assertions': assertions})

    def unsupported_required_target(self, label):
        result = {
            'label': label,
            'validation_verdict': 'not covered',
            'reason': (
                'specified/not executable: deterministic binary-side fault '
                'injection or lifecycle assertions are not available'
            ),
            'assertions': [],
        }
        self.record(result)

    def run(self, targets):
        self.acquire_lease()
        try:
            self.evidence_root.mkdir(parents=True, exist_ok=False)
        except Exception:
            self.release_lease()
            raise
        planned_targets = ['readiness-smoke', *targets]
        self.manifest.update({
            'completion_state': 'running',
            'normal_exit': False,
            'expected_run_count': len(planned_targets),
            'recorded_run_count': 0,
            'planned_targets': planned_targets,
            'readiness_smoke': {
                'status': 'planned',
                'reason': None,
            },
            'matrix_complete': False,
            'completion_reason': None,
        })
        (self.evidence_root / 'driver-start-manifest.json').write_text(
            json.dumps(self.manifest, indent=2) + '\n'
        )
        actions = {
            'openai-stats': self.openai_stats,
            'goal-lifecycle': self.goal_lifecycle,
            'agent-fg-bg': self.direct_agent,
            'subagent-stop-failure-lifecycle': self.subagent_stop_failure_lifecycle,
            'nested-agent': self.nested_agent,
            'workflow': self.workflow,
            'deep-research': lambda: self.slash_workflow('deep-research'),
            'code-review': lambda: self.slash_workflow('code-review'),
            'effort-openai-responses-wire': self.effort_openai_responses_wire,
            'plugins-reload': self.plugins_reload,
            'deferred-tool-discovery': self.deferred_tool_discovery,
            'fast-openai-responses-wire': self.fast_openai_responses_wire,
            'openai-image-input-wire': self.openai_image_input_wire,
            'openai-remote-compaction': self.openai_remote_compaction,
            'openai-responses-usage-error': self.openai_responses_usage_error,
            'model-discovery-picker': self.model_discovery_picker,
            'model-discovery-empty-picker': self.model_discovery_empty_picker,
            'first-party-bootstrap-picker': self.first_party_bootstrap_picker,
            'model-internal-update-config-skill': self.model_internal_update_config_skill,
            'prompt-modes-cache-prefix': self.prompt_modes_cache_prefix,
            'team-concurrency': self.team_concurrency,
            'workflow-retry-partial-failure': self.workflow_retry_partial_failure,
            'workflow-failure-detail': self.workflow_failure_detail,
            'coordinator-selector': self.coordinator_selector,
            'transcript-retention': self.transcript_retention,
            'ssh-remote-session-lifecycle': self.ssh_remote_session_lifecycle,
            'terminal-interaction': self.terminal_interaction,
            'terminal-canonical-diff': self.terminal_canonical_diff,
            'builtin-mods': self.builtin_mods,
            'mods-process-spawn': self.mods_process_spawn,
        }
        try:
            self.run_target('readiness-smoke', self.readiness_smoke)
            readiness_result = self.manifest['runs'][-1]
            self.manifest['readiness_smoke'] = {
                'status': readiness_result['validation_verdict'],
                'evidence_dir': readiness_result['evidence_dir'],
            }
            for target in targets:
                self.run_target(target, actions[target])
        except Exception as error:
            self.manifest['driver_error'] = repr(error)
            self.manifest['completion_reason'] = repr(error)
        else:
            self.manifest['normal_exit'] = True
            self.manifest['completion_state'] = 'completed'
            self.manifest['completion_reason'] = 'completed matrix'
        finally:
            self.manifest['recorded_run_count'] = len(self.manifest['runs'])
            self.manifest['matrix_complete'] = (
                self.manifest['recorded_run_count']
                == self.manifest['expected_run_count']
            )
            if not self.manifest['normal_exit']:
                self.manifest['completion_state'] = (
                    'interrupted' if self.cleanup_started else 'failed'
                )
            self.manifest['emergency_cleanup'] = self.close_active_runs()
            self.manifest['auth_cleanup'] = self.remove_auth_homes()
            self.manifest['workflow_runs_cleanup'] = (
                self.archive_and_remove_workflow_runs()
            )
            self.manifest['finished'] = time.time()
            final_state = self.repository_state()
            self.manifest['repository_state_end'] = final_state
            self.manifest['git_status_end'] = final_state['status_porcelain']
            self.manifest['repository_state_unchanged'] = all(
                final_state[key] == self.baseline.get(key)
                for key in (
                    'head',
                    'branch',
                    'status_porcelain',
                    'unstaged_diff_sha256',
                    'staged_diff_sha256',
                    'untracked_files_sha256',
                    'ignored_files_excluded_roots',
                    'ignored_files_sha256',
                    'binary',
                )
            )
            expected_runs = len(planned_targets)
            required_coverage = validate_required_target_results(
                set(self.manifest['required_targets']),
                self.manifest['runs'],
                self.registered_runs,
            )
            self.manifest['required_target_coverage'] = required_coverage
            planned_coverage = validate_required_target_results(
                set(targets), self.manifest['runs'], self.registered_runs,
            )
            self.manifest['planned_target_coverage'] = planned_coverage
            self.manifest['overall_verdict'] = (
                'passed'
                if (
                    self.manifest['normal_exit']
                    and self.manifest['matrix_complete']
                    and 'driver_error' not in self.manifest
                    and len(self.manifest['runs']) == expected_runs
                    and required_coverage['passed']
                    and planned_coverage['passed']
                    and all(
                        run['validation_verdict'] == 'passed'
                        for run in self.manifest['runs']
                    )
                    and self.manifest['repository_state_unchanged']
                    and self.manifest['workflow_runs_cleanup']['passed']
                    and not self.manifest['auth_cleanup']['errors']
                    and all(
                        self.cleanup_passed(cleanup)
                        for cleanup in self.manifest['emergency_cleanup']
                    )
                )
                else 'failed'
            )
            self.manifest['ownership_lease_release'] = self.release_lease()
            (self.evidence_root / 'driver-final-manifest.json').write_text(
                json.dumps(self.manifest, indent=2) + '\n'
            )
        print(json.dumps(self.manifest, indent=2))
        return self.manifest['overall_verdict'] == 'passed'


def retained_target_policy(targets):
    reasons = {
        'readiness-smoke': 'real credential copy and runtime cleanup not adapted',
        'plugins-reload': 'plugin update/delete lifecycle not adapted',
        'terminal-interaction': 'fixture git commit is forbidden',
        'builtin-mods': 'S7 cold-cache restart has not run',
        'team-concurrency': 'team directory cleanup not adapted',
        'transcript-retention': 'team directory cleanup not adapted',
        'coordinator-selector': 'team directory cleanup not adapted',
        'ssh-remote-session-lifecycle': 'socket fallback outside run root not constrained',
    }
    planned = ['readiness-smoke', *targets]
    return {
        'overall_verdict': 'blocked', 'completion_state': 'blocked',
        'normal_exit': False, 'matrix_complete': False, 'runs': [],
        'planned_targets': planned, 'expected_run_count': len(planned),
        'recorded_run_count': 0,
        'readiness_smoke': {'status': 'blocked', 'reason': reasons['readiness-smoke']},
        'blocked_targets': {
            target: reasons.get(target, 'runtime cleanup and child environment not adapted')
            for target in planned
        },
    }


def retained_sandbox_profile(root, port):
    quoted = json.dumps(str(root))
    config = str(root / 'config/.claude.json')
    atomic = json.dumps('^' + ''.join(
        character if character.isalnum() or character in '/_-' else f'[{character}]'
        for character in config
    ) + r'[.]tmp[.][0-9]+[.][0-9]+$')
    return f'''(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath {quoted}))
(allow file-write* (literal "/dev/null") (literal "/dev/ptmx") (regex #"^/dev/ttys"))
(deny file-write-unlink)
(allow file-write-unlink (literal {json.dumps(str(root / 't'))}))
(allow file-write-unlink (literal {json.dumps(config)}) (literal {json.dumps(config + '.lock')}) (regex #{atomic}))
(deny network*)
(allow network* (local unix-socket) (remote unix-socket))
(allow network-outbound (remote ip "localhost:{port}"))
(deny process-exec (literal "/usr/bin/security"))
(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc"))
(deny file-read* (regex #"/Library/Keychains(/|$)"))
'''


def retained_readiness_request(requests):
    return any(
        request.get('method') == 'POST'
        and request.get('path') == '/v1/responses'
        and request.get('authorization', {}).get('matches_dummy') is True
        and request.get('response_kind') == 'retained-readiness'
        and any(
            message.get('role') == 'user' and (
                message.get('content') == 'RELEASE_RETAINED_INPUT'
                or isinstance(message.get('content'), list) and any(
                    part.get('type') == 'input_text'
                    and part.get('text') == 'RELEASE_RETAINED_INPUT'
                    for part in message['content'] if isinstance(part, dict)
                )
            )
            for message in (request.get('body') or {}).get('input', [])
            if isinstance(message, dict)
        )
        for request in requests
    )


def retained_builtin_cache_sandbox_profile(root, port, target, *, cold):
    root = Path(root)
    target = Path(target)
    cache = target.parent
    writable = [
        root / 'config', root / 'tmp', root / 'cwd', root / 'evidence',
        root / 'home/.cache', root / 'home/.config', root / 'home/.local',
    ]
    rules = [
        '(version 1)', '(allow default)', '(deny file-write*)',
        *(f'(allow file-write* (subpath {json.dumps(str(path))}))' for path in writable),
        f'(allow file-write* (literal {json.dumps(str(root / "t"))}))',
        '(allow file-write* (literal "/dev/null") (literal "/dev/ptmx") (regex #"^/dev/ttys"))',
        '(deny file-write-unlink)',
        f'(allow file-write-unlink (literal {json.dumps(str(root / "t"))}))',
        f'(allow file-write-unlink (subpath {json.dumps(str(root / "config"))}))',
        '(deny network*)',
        '(allow network* (local unix-socket) (remote unix-socket))',
        f'(allow network-outbound (remote ip "localhost:{port}"))',
        '(deny process-exec (literal "/usr/bin/security"))',
        '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc"))',
        '(deny file-read* (regex #"/Library/Keychains(/|$)"))',
    ]
    if cold:
        escaped_target = ''.join(
            character if character.isalnum() or character in '/_-' else f'[{character}]'
            for character in str(target)
        )
        temporary = '^' + escaped_target + r'[.]tmp[.][0-9]+[.]' + '[0-9a-f-]' * 36 + '(/|$)'
        for path in (root / 'home/Library', root / 'home/Library/Caches',
                     cache.parent, cache, target):
            rules.append(f'(allow file-write* (literal {json.dumps(str(path))}))')
        rules.extend((
            f'(allow file-write* (subpath {json.dumps(str(target))}) (regex #"{temporary}"))',
            f'(allow file-write-unlink (subpath {json.dumps(str(target))}) (regex #"{temporary}"))',
            f'(allow file-write* (literal {json.dumps(str(target) + ".lock")}))',
            f'(allow file-write-unlink (literal {json.dumps(str(target) + ".lock")}))',
        ))
    else:
        rules.append(f'(deny file-write* (subpath {json.dumps(str(cache))}))')
    return '\n'.join(rules) + '\n'


def retained_builtin_cache_snapshot(root):
    root = Path(root)
    entries = {}
    if not root.is_dir() or root.is_symlink():
        return {'root': str(root), 'entries': entries}
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root).as_posix()
        stat_result = path.lstat()
        entry = {'type': 'directory' if path.is_dir() else 'file',
                 'inode': stat_result.st_ino, 'mtime_ns': stat_result.st_mtime_ns}
        if path.is_file() and not path.is_symlink():
            entry.update({'size': stat_result.st_size, 'sha256': sha256(path)})
        elif path.is_symlink():
            entry['type'] = 'symlink'
        entries[relative] = entry
    return {'root': str(root), 'entries': entries}


RETAINED_BUILTIN_TREE_DIGEST_SCRIPT = r'''
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
async function treeDigest(root, relative = '') {
  const hash = createHash('sha256');
  for (const name of (await readdir(join(root, relative), { withFileTypes: true }))
    .filter(entry => relative !== '' || entry.name !== '.complete')
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const path = relative ? `${relative}/${name.name}` : name.name;
    hash.update(name.isDirectory() ? `d\0${path}\0` : `f\0${path}\0`);
    hash.update(name.isDirectory() ? await treeDigest(root, path) : await readFile(join(root, path)));
  }
  return hash.digest('hex');
}
console.log(await treeDigest(process.argv.at(-2), process.argv.at(-1)));
'''


def retained_builtin_tree_digest(root, relative=''):
    env = {
        'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
        'HOME': '/dev/null',
        'TMPDIR': '/private/tmp',
        'LANG': 'en_US.UTF-8',
        'BUN_RUNTIME_TRANSPILER_CACHE_PATH': '0',
    }
    completed = subprocess.run(
        ['bun', '--eval', RETAINED_BUILTIN_TREE_DIGEST_SCRIPT, str(root), relative],
        env=env, capture_output=True, text=True, check=True, timeout=30,
    )
    tree_digest = completed.stdout.strip()
    if not re.fullmatch('[0-9a-f]{64}', tree_digest):
        raise ValueError('invalid builtin tree digest output')
    return tree_digest


def validate_retained_builtin_cache(archive, target, first, second):
    import zipfile

    target = Path(target)
    archive = Path(archive)
    expected = {}
    try:
        with zipfile.ZipFile(archive) as zipped:
            expected = {entry.filename: hashlib.sha256(zipped.read(entry)).hexdigest()
                        for entry in zipped.infolist() if not entry.is_dir()}
        complete = (target / '.complete').read_text().splitlines()
    except (OSError, ValueError, zipfile.BadZipFile):
        complete = []
    entries = second.get('entries', {})
    archive_entries = all(
        entries.get(name, {}).get('sha256') == digest for name, digest in expected.items()
    )
    expected_names = {*expected, '.complete'}
    expected_directories = {
        parent.as_posix()
        for name in expected
        for parent in Path(name).parents
        if parent != Path('.')
    }
    return {
        'archive_digest': hashlib.sha256(archive.read_bytes()).hexdigest() == OFFICIAL_BUILTIN_MODS_SHA256,
        'archive_entries': archive_entries,
        'complete_marker': complete == [OFFICIAL_BUILTIN_MODS_SHA256,
                                        retained_builtin_tree_digest(target)],
        'no_extra_entries': set(entries) == expected_names | expected_directories,
        'no_generated_artifacts': not any(
            name.endswith('/types') or name.endswith('/generated')
            or '.tmp.' in name or '.stale.' in name
            for name in entries if name not in expected_names and name not in expected_directories
        ),
        'identity_unchanged': first == second,
    }


def retained_request_texts(request):
    texts = []
    body = request.get('body') if isinstance(request.get('body'), dict) else {}
    instructions = body.get('instructions')
    if isinstance(instructions, str):
        texts.append(instructions)
    for message in body.get('input', []):
        if not isinstance(message, dict):
            continue
        content = message.get('content')
        if isinstance(content, str):
            texts.append(content)
        elif isinstance(content, list):
            texts.extend(part.get('text', '') for part in content
                         if isinstance(part, dict) and part.get('type') == 'input_text')
    return texts


def retained_builtin_response_ready(pane, request, prompt, agents_marker):
    texts = retained_request_texts(request)
    plain = strip_ansi(pane)
    return (
        is_main_response_request(request)
        and prompt in texts
        and any(agents_marker in text for text in texts)
        and request.get('authorization', {}).get('matches_dummy') is True
        and request.get('response_kind') == 'retained-readiness'
        and 'RELEASE_RETAINED_RESPONSE' in plain
        and input_prompt_ready(plain)
    )


def retained_builtin_diff_list_ready(pane, tracked_filename):
    plain = strip_ansi(pane)
    return 'Diff · files' in plain and tracked_filename in plain


def retained_builtin_diff_detail_ready(pane, tracked_filename, diff_marker):
    plain = strip_ansi(pane)
    return all(marker in plain for marker in ('Diff · detail', tracked_filename, diff_marker))


def validate_retained_builtin_launch_behavior(*, requests, request_offset, prompt,
                                               agents_marker, tracked_filename,
                                               diff_marker, response_pane,
                                               diff_list_pane, diff_detail_pane,
                                               closed_pane):
    corresponding = [
        request for request in requests[request_offset:]
        if is_main_response_request(request)
        and prompt in retained_request_texts(request)
    ]
    request = corresponding[0] if len(corresponding) == 1 else {}
    texts = retained_request_texts(request)
    plain_closed = strip_ansi(closed_pane)
    return {
        'one_corresponding_provider_request': len(corresponding) == 1,
        'provider_dummy_authorized': request.get('authorization', {}).get('matches_dummy') is True,
        'provider_response_ready': retained_builtin_response_ready(
            response_pane, request, prompt, agents_marker,
        ),
        'agents_marker_in_corresponding_request': any(agents_marker in text for text in texts),
        'diff_list_has_tracked_file': retained_builtin_diff_list_ready(
            diff_list_pane, tracked_filename,
        ),
        'diff_detail_has_independent_marker': retained_builtin_diff_detail_ready(
            diff_detail_pane, tracked_filename, diff_marker,
        ),
        'diff_closed': tracked_filename not in plain_closed
            and diff_marker not in plain_closed
            and input_prompt_ready(plain_closed),
        'provider_request_sequence': request.get('sequence'),
        'provider_request_path': request.get('path'),
    }


def seed_retained_builtin_cache(repo, root, env):
    import io
    import zipfile

    # Retained readiness is macOS-only. Match env-paths('claude-cli') there.
    if sys.platform != 'darwin' or Path(env['HOME']) != root / 'home':
        raise ValueError('retained builtin cache requires the isolated macOS HOME')
    archive = repo / 'assets/builtin-mods-2.1.277.zip'
    data = archive.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != OFFICIAL_BUILTIN_MODS_SHA256:
        raise ValueError('retained builtin archive does not match official SHA-256')
    cache = root / 'home/Library/Caches/claude-cli-nodejs/builtin-mods'
    target = cache / digest
    for parent in (target, *target.parents):
        if parent.is_symlink():
            raise ValueError(f'retained cache path is a symlink: {parent}')
        if parent == root:
            break
    target.mkdir(parents=True, mode=0o700)
    # The pinned archive is trusted; still keep extraction confined to target.
    with zipfile.ZipFile(io.BytesIO(data)) as zipped:
        for entry in zipped.infolist():
            name = entry.filename
            if name.startswith('/') or '\\' in name or any(
                part in ('', '.', '..') for part in name.rstrip('/').split('/')
            ):
                raise ValueError(f'unsafe builtin archive entry: {name}')
            if entry.is_dir():
                continue
            path = target / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open('xb') as stream:
                stream.write(zipped.read(entry))
    completed = subprocess.run(
        ['bun', '--eval', RETAINED_BUILTIN_TREE_DIGEST_SCRIPT, str(target), ''],
        cwd=root, env=env, capture_output=True, text=True, check=True, timeout=30,
    )
    tree_digest = completed.stdout.strip()
    if not re.fullmatch('[0-9a-f]{64}', tree_digest):
        raise ValueError('invalid builtin tree digest output')
    with (target / '.complete').open('x') as stream:
        stream.write(f'{digest}\n{tree_digest}')
    return {'archive': str(archive), 'path': str(target),
            'archive_digest': digest, 'tree_digest': tree_digest}


def seed_retained_ripgrep_cache(repo, root, env):
    if (sys.platform != 'darwin' or os.uname().machine != 'arm64'
            or Path(env['HOME']) != root / 'home'):
        raise ValueError('retained ripgrep cache requires the isolated macOS arm64 HOME')
    # Keep these inputs identical to scripts/package-binary.mjs.
    package = repo / 'node_modules/@vscode/ripgrep/package.json'
    version = json.loads(package.read_text())['version']
    if not isinstance(version, str) or not re.fullmatch(r'[0-9A-Za-z][0-9A-Za-z.+-]*', version):
        raise ValueError('invalid installed ripgrep version')
    source = repo / 'node_modules/@vscode/ripgrep-darwin-arm64/bin/rg'
    data = source.read_bytes()
    target = root / f'home/Library/Caches/claude-cli-nodejs/ripgrep/{version}-arm64-darwin/rg'
    for parent in (target, *target.parents):
        if parent.is_symlink():
            raise ValueError(f'retained cache path is a symlink: {parent}')
        if parent == root:
            break
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('xb') as stream:
        stream.write(data)
        os.fchmod(stream.fileno(), 0o755)
    return {'source': str(source), 'version': version, 'path': str(target),
            'sha256': hashlib.sha256(data).hexdigest()}


def retained_builtin_cache_restart(root, binary, repo, evidence, baseline_module):
    result = {
        'label': 'builtin-mods', 'status': 'failed', 'validation_verdict': 'failed',
        'scenario_id': 'S7-builtin-cache-restart', 'evidence_dir': str(evidence),
        'physical_covered': False, 'physical_frames': 'not covered', 'assertions': [],
    }
    env = {**baseline_module.retained_environment(root),
           'PATH': '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
           'SHELL': '/bin/sh', 'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8'}
    for name in ('home/.codex', 'config', 'tmp', 'cwd', 'evidence/first', 'evidence/second'):
        (root / name).mkdir(parents=True, mode=0o700)
    fixture = root / 'cwd'
    tracked_filename = '00-s7-fixture.txt'
    tracked_file = fixture / tracked_filename
    agents_file = fixture / 'AGENTS.md'
    tracked_file.write_text('S7 fixture baseline\n')
    agents_file.write_text('S7 AGENTS baseline\n')
    command(['git', '-C', str(fixture), 'init', '-q'], check=True)
    command(['git', '-C', str(fixture), 'add', tracked_filename, 'AGENTS.md'], check=True)
    (root / 'home/.codex/auth.json').write_text(json.dumps({'OPENAI_API_KEY': DUMMY_OPENAI_API_KEY}))
    (root / 'home/.codex/auth.json').chmod(0o600)
    (root / 'config/.claude.json').write_text(json.dumps({
        'numStartups': 1, 'installMethod': 'local', 'hasCompletedOnboarding': True,
        'projects': {str(root / 'cwd'): {'hasTrustDialogAccepted': True,
                                       'hasCompletedProjectOnboarding': True}},
    }))
    (root / 'config/settings.json').write_text(json.dumps({
        'skipDangerousModePermissionPrompt': True, 'model': 'gpt-release-discovered',
        'enabledPlugins': {'agents-md@builtin': True, 'diff@builtin': True,
                           'telemetry@builtin': False},
    }))
    result['ripgrep_cache'] = seed_retained_ripgrep_cache(repo, root, env)
    archive = repo / 'assets/builtin-mods-2.1.277.zip'
    cache = root / 'home/Library/Caches/claude-cli-nodejs/builtin-mods'
    target = cache / OFFICIAL_BUILTIN_MODS_SHA256
    result['cache_initially_absent'] = not cache.exists()
    if not result['cache_initially_absent']:
        result['error'] = f'S7 builtin cache was not cold: {cache}'
        (evidence / 's7-result.json').write_text(json.dumps(result, indent=2) + '\n')
        return result
    provider = MockOpenAIServer(evidence, 'retained-readiness')
    launcher = repo / '.claude/skills/claude-agent-workflow-validation/scripts/launch-built-claude.sh'
    tmux_path = shutil.which('tmux', path=env['PATH'])
    socket_path = str(root / 't')
    if not tmux_path or not Path('/usr/bin/sandbox-exec').is_file():
        raise RuntimeError('retained S7 requires tmux and macOS sandbox-exec')
    server = None
    log = None

    def launch_once(name, cold):
        nonlocal server, log
        run_evidence = evidence / name
        profile = evidence / f'{name}.sb'
        prompt = f'S7_{name.upper()}_PROMPT'
        agents_marker = f'S7_{name.upper()}_AGENTS_MARKER'
        diff_marker = f'S7_{name.upper()}_DIFF_MARKER'
        agents_file.write_text(f'{agents_marker}\n')
        tracked_file.write_text(f'S7 fixture baseline\n{diff_marker}\n')
        # Unborn HEAD reads the staged body and withholds stale unstaged edits.
        command(['git', '-C', str(fixture), 'add', tracked_filename, 'AGENTS.md'], check=True)
        request_offset = len(provider.snapshot())
        url = result['provider_url']
        profile.write_text(retained_builtin_cache_sandbox_profile(
            root, urlsplit(url).port, target, cold=cold,
        ))
        launch_env = {**env, 'CC_VALIDATION_RETAIN_ARTIFACTS': '1',
            'CC_VALIDATION_RUN_ROOT': str(root), 'CC_VALIDATION_BINARY': str(binary),
            'CC_VALIDATION_REPO_ROOT': str(repo), 'CC_VALIDATION_CWD': str(root / 'cwd'),
            'CC_VALIDATION_HOME': env['HOME'], 'CC_VALIDATION_CONFIG_DIR': env['CLAUDE_CONFIG_DIR'],
            'CC_VALIDATION_EVIDENCE_DIR': str(run_evidence),
            'CC_VALIDATION_OPENAI_BASE_URL': url + '/v1',
            'CC_VALIDATION_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
        command_line = shlex.join(['/usr/bin/env', '-i',
            *(f'{key}={value}' for key, value in launch_env.items()), '/bin/sh', str(launcher)])
        argv = ['/usr/bin/sandbox-exec', '-f', str(profile), tmux_path,
                '-D', '-S', socket_path, '-f', '/dev/null']
        log = (run_evidence / 'tmux-server.log').open('x')
        server = subprocess.Popen(argv, cwd=root / 'cwd', env=env, stdout=log, stderr=log,
                                  start_new_session=True)
        deadline = time.monotonic() + 10
        while not (root / 't').exists() and server.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        def tmux(*arguments, check=True):
            completed = subprocess.run([tmux_path, '-S', socket_path, *arguments],
                                       cwd=root / 'cwd', env=env, capture_output=True,
                                       text=True, timeout=10)
            if check and completed.returncode:
                raise RuntimeError(f'tmux {arguments!r}: {completed.stderr}')
            return completed
        inputs = []
        def send(label, value, *, key=False):
            encoded = ({'Enter': b'\r', 'Escape': b'\x1b'}[value]
                       if key else value.encode())
            inputs.append({'label': label, 'hex': encoded.hex(),
                           'transport': 'tmux key' if key else 'tmux literal'})
            (run_evidence / 'input-hex.json').write_text(json.dumps(inputs, indent=2) + '\n')
            tmux('send-keys', '-t', 's7:0.0', *([] if key else ['-l']), value)
        tmux('set-option', '-g', 'remain-on-exit', 'on')
        # Below the native sidebar threshold; Enter/Escape belong to the dialog.
        tmux('new-session', '-d', '-s', 's7', '-x', '109', '-y', '40', command_line)
        def wait_state(label, predicate):
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                pane = tmux('capture-pane', '-p', '-S', '-2000', '-t', 's7:0.0', check=False)
                (run_evidence / f'{label}.txt').write_text(pane.stdout)
                if pane.returncode == 0 and predicate(strip_ansi(pane.stdout)):
                    return pane.stdout
                if server.poll() is not None:
                    break
                time.sleep(0.1)
            raise RuntimeError(f'S7 {name} {label} state not observed')
        startup = wait_state('startup', input_prompt_ready)
        send('prompt', prompt)
        send('prompt-submit', 'Enter', key=True)
        response = wait_state('response-ready', lambda pane:
            any(retained_builtin_response_ready(pane, request, prompt, agents_marker)
                    for request in provider.snapshot()[request_offset:]))
        send('diff-command', '/diff')
        send('diff-submit', 'Enter', key=True)
        diff_list = wait_state('diff-list', lambda pane:
                              retained_builtin_diff_list_ready(pane, tracked_filename))
        send('diff-detail', 'Enter', key=True)
        diff_detail = wait_state('diff-detail', lambda pane:
            retained_builtin_diff_detail_ready(pane, tracked_filename, diff_marker))
        send('diff-back', 'Escape', key=True)
        wait_state('diff-list-restored', lambda pane:
                   retained_builtin_diff_list_ready(pane, tracked_filename))
        send('diff-close', 'Escape', key=True)
        diff_closed = wait_state('diff-closed', lambda pane:
            tracked_filename not in pane and diff_marker not in pane and input_prompt_ready(pane))
        checks = validate_retained_builtin_launch_behavior(
            requests=provider.snapshot(), request_offset=request_offset, prompt=prompt,
            agents_marker=agents_marker, tracked_filename=tracked_filename,
            diff_marker=diff_marker, response_pane=response, diff_list_pane=diff_list,
            diff_detail_pane=diff_detail, closed_pane=diff_closed,
        )
        (run_evidence / 'behavior-checks.json').write_text(json.dumps(checks, indent=2) + '\n')
        if not all(checks.values()):
            raise RuntimeError(f'S7 {name} behavior checks failed: {checks}')
        send('exit-command', '/exit')
        send('exit-submit', 'Enter', key=True)
        wait_state('exit', lambda _pane: tmux(
            'display-message', '-p', '-t', 's7:0.0', '#{pane_dead} #{pane_dead_status}',
        ).stdout.strip() == '1 0')
        launch = {
            'name': name, 'cache_state': 'cold' if cold else 'warm',
            'argv': [str(binary), '--dangerously-skip-permissions', '--debug',
                     '--debug-file', str(run_evidence / 'debug.log')],
            'command': command_line, 'profile': str(profile),
            'home': env['HOME'], 'config': env['CLAUDE_CONFIG_DIR'],
            'cwd': str(fixture), 'cache': str(cache),
            'prompt': prompt, 'agents_marker': agents_marker, 'diff_marker': diff_marker,
            'request_offset': request_offset,
            'provider_request_sequence': checks['provider_request_sequence'],
            'provider_request_path': checks['provider_request_path'],
            'panes': {label: str(run_evidence / f'{label}.txt') for label in (
                'startup', 'response-ready', 'diff-list', 'diff-detail',
                'diff-list-restored', 'diff-closed', 'exit')},
            'input_hex': str(run_evidence / 'input-hex.json'),
            'checks': checks, 'normal_exit': True,
        }
        (run_evidence / 'launch.json').write_text(json.dumps(launch, indent=2) + '\n')
        result.setdefault('launches', []).append(launch)
        closed = tmux('kill-server', check=False)
        server.wait(timeout=10)
        socket_file = root / 't'
        if socket_file.is_socket():
            socket_file.unlink()
        cleanup = {'kill_returncode': closed.returncode, 'server_exit': server.returncode,
                   'socket_released': not socket_file.exists()}
        log.close()
        log = None
        server = None
        if not all((cleanup['kill_returncode'] == 0, cleanup['server_exit'] == 0,
                    cleanup['socket_released'])):
            raise RuntimeError(f'S7 {name} cleanup failed: {cleanup}')
        return checks

    try:
        result['provider_url'] = provider.start()
        before_binary = baseline_module.binary_identity(binary)
        launch_once('first', True)
        first = retained_builtin_cache_snapshot(target)
        (evidence / 'cache-first.json').write_text(json.dumps(first, indent=2) + '\n')
        launch_once('second', False)
        second = retained_builtin_cache_snapshot(target)
        (evidence / 'cache-second.json').write_text(json.dumps(second, indent=2) + '\n')
        checks = validate_retained_builtin_cache(archive, target, first, second)
        checks.update({
            'cache_initially_absent': result['cache_initially_absent'],
            'two_normal_exits': len(result.get('launches', [])) == 2
                and all(launch['normal_exit'] for launch in result['launches']),
            'same_home_config_cache_cwd': True,
            'no_resume': all('--resume' not in launch['command'] for launch in result['launches']),
            'binary_unchanged': before_binary == baseline_module.binary_identity(binary),
        })
        result['checks'] = checks
        checks_path = evidence / 's7-checks.json'
        checks_path.write_text(json.dumps(checks, indent=2) + '\n')
        passed = all(checks.values())
        result['status'] = result['validation_verdict'] = 'passed' if passed else 'failed'
        result['assertions'] = [{
            'assertion_id': 'retained-builtin-cache-restart', 'source_run': 'builtin-mods',
            'runtime_state': 'done', 'validation_verdict': result['validation_verdict'],
            'observed_evidence_paths': [str(checks_path), str(evidence / 'cache-first.json'),
                                        str(evidence / 'cache-second.json')],
        }]
    except Exception as error:
        result['error'] = f'{type(error).__name__}: {error}'
    finally:
        if server is not None:
            subprocess.run([tmux_path, '-S', socket_path, 'kill-server'], env=env,
                           capture_output=True, timeout=10)
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.terminate()
                server.wait(timeout=10)
            socket_file = root / 't'
            if socket_file.is_socket():
                socket_file.unlink()
        provider.stop()
        if log:
            log.close()
        result.pop('provider_url', None)
        (evidence / 's7-result.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def retained_g5_consent(pane):
    return all(text in pane for text in (
        'mod_hot_reload', 'How does this work?', 'Enable for this session', 'Not now'))


def retained_g5_clear_cancelled(pane, expected_draft, before, after):
    plain = strip_ansi(pane).replace('\u00a0', ' ')
    if (retained_g5_consent(plain)
            or not submitted_input_visible(plain, expected_draft)):
        return False
    prompt_index = plain.rfind('❯')
    if prompt_index < 0 or 'esc to interrupt' in plain[prompt_index:].lower():
        return False
    before_posts = [request for request in before['requests']
                    if request.get('method') == 'POST']
    after_posts = [request for request in after['requests']
                   if request.get('method') == 'POST']
    return (after_posts == before_posts
            and after['roots'] == before['roots']
            and after['entries'] == before['entries'])


def retained_g5_terminal_semantics(scenario, pane, expected_draft, before, after):
    if retained_g5_consent(pane):
        return False
    if scenario == 'cancel':
        return (before is not None
                and expected_draft is not None
                and retained_g5_clear_cancelled(
                    pane, expected_draft, before, after,
                ))
    return (retained_g5_semantics(
                'enable' if scenario in (
                    'turn-end-load', 'same-session-resume', 'fork-session'
                ) else scenario,
                after['requests'], after['roots'], after['entries'],
                input_prompt_ready(pane),
            )
            and 'RELEASE_RETAINED_RESPONSE' in pane)


def retained_g5_semantics(scenario, requests, roots, entries, prompt_ready):
    if not prompt_ready:
        return False
    posts = [request for request in requests if request.get('method') == 'POST']
    texts = []
    for request in posts:
        if (request.get('path') != '/v1/responses'
                or request.get('authorization', {}).get('matches_dummy') is not True
                or request.get('response_kind') != 'retained-readiness'):
            continue
        for message in (request.get('body') or {}).get('input', []):
            if not isinstance(message, dict) or message.get('role') != 'user':
                continue
            content = message.get('content', [])
            if isinstance(content, str):
                texts.append(content)
            elif isinstance(content, list):
                texts.extend(part.get('text', '') for part in content
                             if isinstance(part, dict) and part.get('type') == 'input_text')
    if scenario == 'cancel':
        return not posts and not roots and not entries
    if scenario == 'not-now':
        return not roots and not entries and any(
            'This invocation did not enable a session authoring root;' in text for text in texts)
    if scenario == 'enable':
        return any(entry.get('type') == 'dev-mods'
                   and entry.get('folder') in roots
                   and Path(entry['folder']).name == entry.get('sessionId')
                   and any('Session authoring was enabled for this session only.' in text
                           and f"`{entry['folder']}`" in text for text in texts)
                   for entry in entries)
    return False


def retained_g5_held_identity(requests, roots, config, response_kind=None):
    held = [request for request in requests if is_main_response_request(request)]
    if len(held) != 1:
        return None
    request = held[0]
    if (request.get('response_kind') != response_kind
            or request.get('authorization', {}).get('matches_dummy') is not True):
        return None
    headers = request.get('headers', {})
    session = headers.get('session-id', '')
    if (not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', session)
            or any(headers.get(key) != session for key in ('thread-id', 'x-claude-code-session-id'))):
        return None
    folders = []
    for message in request.get('body', {}).get('input', []):
        if not isinstance(message, dict) or message.get('role') != 'user':
            continue
        content = message.get('content', [])
        texts = [content] if isinstance(content, str) else [
            part.get('text', '') for part in content
            if isinstance(part, dict) and part.get('type') == 'input_text']
        for text in texts:
            folders.extend(re.findall(
                r'Session authoring was enabled for this session only\. '
                r'Create plugins as direct child directories of `([^`]+)`; '
                r'valid child plugins load after the current turn and are watched for later changes\.', text))
    if len(folders) != 1:
        return None
    folder = Path(folders[0])
    if (folders[0] not in roots or folder != config / 'dev-mods' / session
            or not folder.is_dir() or folder.is_symlink() or folder.parent.is_symlink()):
        return None
    return {'sessionId': session, 'folder': folders[0], 'request_sequence': request['sequence']}


def retained_g5_identity_persisted(identity, entries):
    return any(entry.get('type') == 'dev-mods'
               and entry.get('sessionId') == identity['sessionId']
               and entry.get('folder') == identity['folder'] for entry in entries)


def retained_g5_resumed(identity, entries, requests, pane):
    posts = [request for request in requests if is_main_response_request(request)]
    return (len(posts) == 1
            and posts[0].get('authorization', {}).get('matches_dummy') is True
            and posts[0].get('response_kind') == 'retained-readiness'
            and all(posts[0].get('headers', {}).get(key) == identity['sessionId']
                    for key in ('session-id', 'thread-id', 'x-claude-code-session-id'))
            and retained_g5_identity_persisted(identity, entries)
            and all(marker in pane for marker in (
                'G5_SAME_SESSION_ROOT_ACTIVE', 'G5_SAME_SESSION_CHILD_ACTIVE'))
            and input_prompt_ready(pane))


def retained_g5_forked(original, entries, roots, requests, pane):
    posts = [request for request in requests if is_main_response_request(request)]
    if len(posts) != 1:
        return False
    request = posts[0]
    headers = request.get('headers', {})
    fork_session = headers.get('session-id', '')
    return (request.get('authorization', {}).get('matches_dummy') is True
            and request.get('response_kind') == 'retained-readiness'
            and re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', fork_session) is not None
            and fork_session != original['sessionId']
            and all(headers.get(key) == fork_session
                    for key in ('thread-id', 'x-claude-code-session-id'))
            and roots == [original['folder']]
            and len(entries) == 1
            and retained_g5_identity_persisted(original, entries)
            and 'G5_FORK_IDENTITY_PROBE' in pane
            and all(marker not in pane for marker in (
                'G5_SAME_SESSION_ACTIVE', 'G5_SAME_SESSION_ROOT_ACTIVE',
                'G5_SAME_SESSION_CHILD_ACTIVE'))
            and input_prompt_ready(pane))


def retained_g5_turn_active(pane, waiting, released, declarations):
    return (waiting and not released and not declarations
            and 'esc to interrupt' in strip_ansi(pane).lower()
            and 'G5_TURN_END_ACTIVE' not in pane)


def retained_g5(root, binary, repo, evidence, baseline_module, scenario_only=None):
    result = {'label': 'terminal-interaction', 'validation_verdict': 'blocked',
              'logical_frames': 'not covered', 'physical_frames': 'not covered',
              'turn_end_plugin_load': 'not covered', 'resume': 'not covered',
              'fork_session': 'not covered', 'scenarios': []}
    scenarios = ((scenario_only,) if scenario_only else
                 ('not-now', 'enable', 'cancel', 'turn-end-load',
                  'same-session-resume', 'fork-session'))
    for scenario in scenarios:
        child = root / f'g5-{scenario}'
        child.mkdir(mode=0o700)
        child_evidence = child / 'evidence'
        child_evidence.mkdir(mode=0o700)
        run = retained_readiness(child, binary, repo, child_evidence, baseline_module, scenario)
        result['scenarios'].append(run)
        if scenario == 'turn-end-load':
            result['turn_end_plugin_load'] = run['status']
        if scenario == 'same-session-resume':
            result['resume'] = run['status']
        if scenario == 'fork-session':
            result['fork_session'] = run['status']
        if run['status'] != 'passed':
            break
    result['first_divergence'] = next((run for run in result['scenarios']
                                       if run['status'] != 'passed'), None)
    (evidence / 'g5-result.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def retained_readiness(root, binary, repo, evidence, baseline_module, scenario=None):
    result = {'label': 'readiness-smoke', 'status': 'failed',
              'evidence_dir': str(evidence), 'physical_covered': False,
              'feature_matrix_covered': False, 'assertions': []}
    env = {**baseline_module.retained_environment(root),
           'PATH': '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
           'SHELL': '/bin/sh', 'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8'}
    for name in ('home/.codex', 'config', 'tmp', 'cwd'):
        (root / name).mkdir(parents=True, mode=0o700)
    (root / 'home/.codex/auth.json').write_text(json.dumps({'OPENAI_API_KEY': DUMMY_OPENAI_API_KEY}))
    (root / 'home/.codex/auth.json').chmod(0o600)
    (root / 'config/.claude.json').write_text(json.dumps({
        'numStartups': 1, 'installMethod': 'local', 'hasCompletedOnboarding': True,
        'projects': {str(root / 'cwd'): {'hasTrustDialogAccepted': True,
                                       'hasCompletedProjectOnboarding': True}}}))
    (root / 'config/settings.json').write_text(json.dumps({
        'skipDangerousModePermissionPrompt': True, 'model': 'gpt-release-discovered'}))
    result['builtin_cache'] = seed_retained_builtin_cache(repo, root, env)
    result['ripgrep_cache'] = seed_retained_ripgrep_cache(repo, root, env)
    provider = MockOpenAIServer(evidence, 'retained-turn-end-load'
                                if scenario == 'turn-end-load' else 'retained-readiness')
    server = None
    log = None
    socket_path = str(root / 't')
    tmux_path = shutil.which('tmux', path=env['PATH'])
    if not tmux_path or not Path('/usr/bin/sandbox-exec').is_file():
        raise RuntimeError('retained readiness requires tmux and macOS sandbox-exec')
    def tmux(*arguments, check=True):
        completed = subprocess.run([tmux_path, '-S', socket_path, *arguments],
                                   cwd=root / 'cwd', env=env, capture_output=True,
                                   text=True, timeout=10)
        if check and completed.returncode:
            raise RuntimeError(f'tmux {arguments!r}: {completed.stderr}')
        return completed
    def wait_pane(name, predicate):
        deadline = time.monotonic() + 45
        last = ''
        while time.monotonic() < deadline:
            captured = tmux('capture-pane', '-p', '-t', 'readiness:0.0', check=False)
            last = captured.stdout
            (evidence / f'{name}.txt').write_text(last)
            if captured.returncode == 0 and predicate(strip_ansi(last)):
                result['assertions'].append({'state': name, 'passed': True})
                return
            if server.poll() is not None:
                break
            time.sleep(0.1)
        raise RuntimeError(f'{name} state not observed; see {evidence / (name + ".txt")}')
    def g5_interaction():
        result.update({'label': f'G5-{scenario}', 'scenario_id': f'G5-{scenario}',
                       'logical_frames': 'not covered', 'physical_frames': 'not covered',
                       'raw_inputs': [], 'clear': 'not covered'})
        def send(value, hex_value=None):
            result['raw_inputs'].append({'hex': hex_value or value.encode().hex(),
                                         'transport': 'tmux key' if hex_value else 'tmux literal',
                                         'value': value})
            (evidence / 'input.json').write_text(json.dumps(result['raw_inputs'], indent=2))
            tmux('send-keys', '-t', 'readiness:0.0', *([] if hex_value else ['-l']), value)
        def snapshot():
            roots = sorted(str(path) for path in (root / 'config/dev-mods').glob('*') if path.is_dir())
            entries = []
            for path in (root / 'config/projects').rglob('*.jsonl'):
                for line in path.read_text().splitlines():
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    if entry.get('type') == 'dev-mods':
                        entries.append({**entry, 'evidence_path': str(path)})
            result['semantic_state'] = {'roots': roots, 'entries': entries,
                                        'requests_path': str(evidence / 'mock-openai-requests.json')}
            return roots, entries
        send('/plugin-authoring')
        wait_pane('command-draft', lambda pane: '/plugin-authoring' in pane)
        send('Enter', '0d')
        wait_pane('consent', retained_g5_consent)
        roots, entries = snapshot()
        if roots or entries or any(r.get('method') == 'POST' for r in provider.snapshot()):
            raise RuntimeError('G5 consent had premature filesystem or model side effects')
        before_cancel = None
        if scenario == 'cancel':
            before_cancel = {
                'requests': provider.snapshot(),
                'roots': roots,
                'entries': entries,
            }
            send('C-c', '03')
        else:
            send('Down', '1b5b42')
            if scenario == 'not-now':
                send('Down', '1b5b42')
            send('Enter', '0d')
        if scenario == 'turn-end-load':
            wait_pane('turn-active-before-write', lambda pane: retained_g5_turn_active(
                pane, provider.turn_waiting.is_set(), provider.turn_release.is_set(), False))
            roots, entries = snapshot()
            identity = retained_g5_held_identity(provider.snapshot(), roots, root / 'config')
            if identity is None:
                raise RuntimeError('harness gap: exact held request consent session root not observed')
            result['held_identity'] = identity
            (evidence / 'held-identity.json').write_text(json.dumps({
                **identity, 'entries_at_hold': entries,
                'requests': provider.snapshot()}, indent=2) + '\n')
            plugin = Path(identity['folder']) / 'g5-turn-marker'
            (plugin / '.claude-plugin').mkdir(parents=True)
            (plugin / 'hooks').mkdir()
            (plugin / '.claude-plugin/plugin.json').write_text(json.dumps({
                'name': 'g5-turn-marker', 'version': '0.0.1',
                'description': 'Retained G5 turn boundary fixture'}))
            (plugin / 'hooks/hooks.json').write_text(json.dumps({'modules': ['./marker.mjs']}))
            (plugin / 'hooks/marker.mjs').write_text('''export function register(on) {
  on("ui.render", { component: "AbovePrompt" }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: "G5_TURN_END_ACTIVE" });
  });
}
''')
            result['fixture'] = {'root': str(plugin),
                                 'files': baseline_module.tree_manifest(plugin)}
            # Check every sampled active pane while the provider response is held.
            # This is bounded semantic sampling, not per-frame physical coverage.
            observations = []
            for index in range(20):
                pane = tmux('capture-pane', '-p', '-t', 'readiness:0.0').stdout
                (evidence / f'turn-held-{index:02d}.txt').write_text(pane)
                state = {'sample': index, 'waiting': provider.turn_waiting.is_set(),
                         'released': provider.turn_release.is_set(),
                         'declarations': (plugin / '.claude-plugin/types').exists()}
                state['passed'] = retained_g5_turn_active(pane, state['waiting'],
                                                          state['released'], state['declarations'])
                observations.append(state)
                (evidence / 'turn-observations.json').write_text(json.dumps(observations, indent=2))
                if not state['passed']:
                    raise RuntimeError('turn boundary divergence or active-state harness gap; response remains held')
                threading.Event().wait(0.1)
            result['assertions'].append({'state': 'turn-held-no-early-load', 'passed': True})
            provider.turn_release.set()
        def terminal(pane):
            roots, entries = snapshot()
            if scenario == 'turn-end-load' and not retained_g5_identity_persisted(
                    result['held_identity'], entries):
                return False
            return retained_g5_terminal_semantics(
                scenario,
                pane,
                '/plugin-authoring' if scenario == 'cancel' else None,
                before_cancel,
                {
                    'requests': provider.snapshot(),
                    'roots': roots,
                    'entries': entries,
                },
            )
        wait_pane('semantic-terminal', terminal)
        if scenario == 'turn-end-load':
            wait_pane('turn-end-ui-active', lambda pane: terminal(pane)
                      and 'G5_TURN_END_ACTIVE' in pane)
        if scenario in ('same-session-resume', 'fork-session'):
            roots, entries = snapshot()
            identity = retained_g5_held_identity(provider.snapshot(), roots, root / 'config',
                                                'retained-readiness')
            if identity is None or not retained_g5_identity_persisted(identity, entries):
                raise RuntimeError('harness gap: exact original consent identity not observed')
            result['original_identity'] = identity
            (evidence / 'original-identity.json').write_text(json.dumps({
                **identity, 'entries': entries, 'requests': provider.snapshot()}, indent=2))
            plugins = []
            for name, marker in (
                ('g5-resume-root-marker', 'G5_SAME_SESSION_ROOT_ACTIVE'),
                ('g5-resume-child-marker', 'G5_SAME_SESSION_CHILD_ACTIVE'),
            ):
                plugin = Path(identity['folder']) / name
                (plugin / '.claude-plugin').mkdir(parents=True)
                (plugin / 'hooks').mkdir()
                (plugin / '.claude-plugin/plugin.json').write_text(json.dumps({
                    'name': name, 'version': '0.0.1'}))
                (plugin / 'hooks/hooks.json').write_text(json.dumps({'modules': ['./marker.mjs']}))
                (plugin / 'hooks/marker.mjs').write_text(f'''export function register(on) {{
  on("ui.render", {{ component: "AbovePrompt" }}, async ($, e, next) => {{
    const {{ Box, Text }} = $.ui.resolve(e);
    return Box({{ children: [await next(e), Text({{ children: "{marker}" }})] }});
  }});
}}
''')
                plugins.append(plugin)
            result['fixtures'] = [
                {'root': str(plugin), 'files': baseline_module.tree_manifest(plugin)}
                for plugin in plugins
            ]
            wait_pane('original-ui-active', lambda pane: input_prompt_ready(pane)
                      and all(marker in pane for marker in (
                          'G5_SAME_SESSION_ROOT_ACTIVE', 'G5_SAME_SESSION_CHILD_ACTIVE')))
            def normal_exit(name):
                send('/exit')
                wait_pane(name + '-draft', lambda pane: submitted_input_visible(pane, '/exit'))
                send('Enter', '0d')
                def exited(_pane):
                    state = tmux('display-message', '-p', '-t', 'readiness:0.0',
                                 '#{pane_dead} #{pane_dead_status}').stdout.strip()
                    result[name] = state
                    (evidence / (name + '.json')).write_text(json.dumps({'dead_status': state}))
                    return state == '1 0'
                wait_pane(name, exited)
            normal_exit('original-exit')
            _, entries = snapshot()
            (evidence / 'authorization-after-exit.json').write_text(json.dumps(entries, indent=2))
            if not retained_g5_identity_persisted(identity, entries):
                raise RuntimeError('original authorization missing after normal exit')
            before_sequences = {request['sequence'] for request in provider.snapshot()}
            resume_args = ['--resume', identity['sessionId']]
            if scenario == 'fork-session':
                resume_args.append('--fork-session')
            resume_command = command_line + ' ' + shlex.join(resume_args)
            result['resume_argv'] = [str(binary), '--dangerously-skip-permissions', '--debug',
                                     '--debug-file', str(evidence / 'debug.log'), *resume_args]
            result['resume_command'] = resume_command
            (evidence / 'resume-launch.json').write_text(json.dumps({
                'argv': result['resume_argv'], 'command': resume_command}, indent=2))
            tmux('respawn-pane', '-t', 'readiness:0.0', resume_command)
            def resumed_ready(pane):
                if not input_prompt_ready(pane):
                    return False
                if scenario == 'fork-session':
                    return all(marker not in pane for marker in (
                        'G5_SAME_SESSION_ROOT_ACTIVE', 'G5_SAME_SESSION_CHILD_ACTIVE'))
                return all(marker in pane for marker in (
                    'G5_SAME_SESSION_ROOT_ACTIVE', 'G5_SAME_SESSION_CHILD_ACTIVE'))
            wait_pane('resumed-startup', resumed_ready)
            result['resumed_pane_identity'] = tmux('display-message', '-p', '-t', 'readiness:0.0',
                '#{session_id} #{window_id} #{pane_id} #{pane_pid}').stdout.strip()
            probe = ('G5_FORK_IDENTITY_PROBE' if scenario == 'fork-session'
                     else 'G5_RESUME_IDENTITY_PROBE')
            send(probe)
            wait_pane('resume-probe-draft', lambda pane: submitted_input_visible(pane, probe))
            send('Enter', '0d')
            def resumed(pane):
                roots, entries = snapshot()
                requests = [request for request in provider.snapshot()
                            if request['sequence'] not in before_sequences]
                (evidence / 'resumed-identity.json').write_text(json.dumps({
                    'expected': identity, 'roots': roots, 'entries': entries,
                    'requests': requests}, indent=2))
                if scenario == 'fork-session':
                    return retained_g5_forked(identity, entries, roots, requests, pane)
                return retained_g5_resumed(identity, entries, requests, pane)
            wait_pane('resumed-exact-identity-ui', resumed)
            if scenario == 'fork-session':
                roots, entries = snapshot()
                before_cancel = {'requests': provider.snapshot(), 'roots': roots, 'entries': entries}
                send('/plugin-authoring')
                wait_pane('fork-command-draft', lambda pane:
                          submitted_input_visible(pane, '/plugin-authoring'))
                send('Enter', '0d')
                wait_pane('fork-consent', retained_g5_consent)
                send('C-c', '03')
                def fork_cancelled(pane):
                    roots, entries = snapshot()
                    return retained_g5_clear_cancelled(pane, '/plugin-authoring', before_cancel, {
                        'requests': provider.snapshot(), 'roots': roots, 'entries': entries})
                wait_pane('fork-consent-cancel', fork_cancelled)
                send('C-u', '15')
                wait_pane('fork-cancel-draft-cleared', input_prompt_ready)
            normal_exit('resumed-exit')
        if scenario == 'enable':
            before = {
                'requests': provider.snapshot(),
                'roots': list(result['semantic_state']['roots']),
                'entries': list(result['semantic_state']['entries']),
            }
            send('/clear')
            wait_pane('clear-draft', lambda pane: '/clear' in pane)
            send('Enter', '0d')
            wait_pane('clear-ready', lambda pane: input_prompt_ready(pane)
                      and 'RELEASE_RETAINED_RESPONSE' not in pane)
            send('/plugin-authoring')
            wait_pane('clear-command-draft', lambda pane: '/plugin-authoring' in pane)
            send('Enter', '0d')
            wait_pane('clear-consent', retained_g5_consent)
            send('C-c', '03')
            def clear_cancelled(pane):
                roots, entries = snapshot()
                after = {
                    'requests': provider.snapshot(),
                    'roots': roots,
                    'entries': entries,
                }
                return retained_g5_clear_cancelled(
                    pane, '/plugin-authoring', before, after,
                )
            wait_pane('clear-cancel', clear_cancelled)
            result['clear'] = 'passed'

    try:
        url = provider.start()
        profile = root / 'sandbox.sb'
        profile.write_text(retained_sandbox_profile(root, urlsplit(url).port))
        launch_env = {**env, 'CC_VALIDATION_RETAIN_ARTIFACTS': '1',
            'CC_VALIDATION_RUN_ROOT': str(root), 'CC_VALIDATION_BINARY': str(binary),
            'CC_VALIDATION_REPO_ROOT': str(repo), 'CC_VALIDATION_CWD': str(root / 'cwd'),
            'CC_VALIDATION_HOME': env['HOME'], 'CC_VALIDATION_CONFIG_DIR': env['CLAUDE_CONFIG_DIR'],
            'CC_VALIDATION_EVIDENCE_DIR': str(evidence),
            'CC_VALIDATION_OPENAI_BASE_URL': url + '/v1',
            'CC_VALIDATION_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
        launcher = repo / '.claude/skills/claude-agent-workflow-validation/scripts/launch-built-claude.sh'
        command_line = shlex.join(['/usr/bin/env', '-i',
            *(f'{key}={value}' for key, value in launch_env.items()), '/bin/sh', str(launcher)])
        argv = ['/usr/bin/sandbox-exec', '-f', str(profile), tmux_path,
                '-D', '-S', socket_path, '-f', '/dev/null']
        result.update({'command': argv, 'environment': launch_env,
                       'binary_before': baseline_module.binary_identity(binary),
                       'socket': socket_path, 'target': 'readiness:0.0'})
        log = (evidence / 'tmux-server.log').open('x')
        server = subprocess.Popen(argv, cwd=root / 'cwd', env=env, stdout=log, stderr=log,
                                  start_new_session=True)
        result['server_pid'] = server.pid
        deadline = time.monotonic() + 10
        while not (root / 't').exists() and server.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        tmux('set-option', '-g', 'remain-on-exit', 'on')
        result['launch_command'] = command_line
        tmux('new-session', '-d', '-s', 'readiness', '-x', '120', '-y', '40', command_line)
        wait_pane('startup', input_prompt_ready)
        result['pane_identity'] = tmux('display-message', '-p', '-t', 'readiness:0.0',
                                      '#{session_id} #{window_id} #{pane_id} #{pane_pid}').stdout.strip()
        if scenario:
            g5_interaction()
        else:
            raw = b'RELEASE_RETAINED_INPUT'
            (evidence / 'input.json').write_text(json.dumps([
                {'hex': raw.hex(), 'transport': 'tmux send-keys -l'},
                {'hex': '0d', 'transport': 'tmux send-keys Enter'}], indent=2))
            tmux('send-keys', '-t', 'readiness:0.0', '-l', raw.decode())
            wait_pane('input', lambda pane: raw.decode() in pane)
            tmux('send-keys', '-t', 'readiness:0.0', 'Enter')
            # A fast response clears the composer; observe the submitted transcript instead.
            wait_pane('submitted', lambda pane: bool(re.search(
                r'^\s*❯ RELEASE_RETAINED_INPUT\s*\n\s*⏺ RELEASE_RETAINED_RESPONSE\s*$',
                pane, re.MULTILINE)) and input_prompt_ready(pane)
                      and retained_readiness_request(provider.snapshot()))
            wait_pane('response', lambda pane: 'RELEASE_RETAINED_RESPONSE' in pane
                      and input_prompt_ready(pane))
        result['binary_after'] = baseline_module.binary_identity(binary)
        if result['binary_before'] != result['binary_after']:
            raise RuntimeError('binary identity changed during readiness')
        result['status'] = 'passed'
    except Exception as error:
        result['error'] = f'{type(error).__name__}: {error}'
    finally:
        if server is not None:
            closed = tmux('kill-server', check=False)
            result['close_server'] = {'returncode': closed.returncode, 'stderr': closed.stderr}
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.terminate()
                server.wait(timeout=10)
            result['server_exit'] = server.returncode
            socket_file = root / 't'
            if socket_file.is_socket():
                socket_file.unlink()
            result['socket_released'] = not (root / 't').exists()
            if not result['socket_released']:
                result['status'] = 'failed'
        if scenario == 'turn-end-load':
            provider.turn_release.set()
        provider.stop()
        if log:
            log.close()
        result['validation_verdict'] = result['status']
        (evidence / 'readiness-result.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def retained_preflight(args, extra_targets):
    # Never construct BinaryGate here: its legacy lifecycle owns destructive cleanup.
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        'release_baseline', Path(__file__).with_name('capture-release-baseline.py'),
    )
    baseline_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(baseline_module)
    repo = args.repo.resolve()
    root, binary = baseline_module.retained_paths(repo, args.run_root, args.binary)
    if args.baseline.parent.resolve() / args.baseline.name != root / 'baseline.json' or args.baseline.is_symlink():
        raise ValueError('--baseline must be <run-root>/baseline.json, not a symlink')
    baseline = json.loads(args.baseline.read_text())
    if baseline.get('run_root') != str(root) or baseline.get('retain_artifacts') is not True:
        raise ValueError('baseline does not own this retained run root')
    if baseline.get('repo') != str(repo):
        raise ValueError('baseline repository does not match --repo')
    evidence = args.evidence_root.parent.resolve() / args.evidence_root.name
    if evidence != root / 'evidence' or evidence.exists() or evidence.is_symlink():
        raise ValueError('--evidence-root must be a new <run-root>/evidence')
    if {p.name for p in root.iterdir()} != {'baseline.json'}:
        raise ValueError('run root contains unexpected artifacts or was already used')
    state = baseline_module.retained_repository_state(repo, root, binary)
    for key, value in state.items():
        if baseline.get(key) != value:
            raise ValueError(f'baseline {key} does not match current repository state')
    inputs = collect_required_target_inputs(repo, baseline, args.base_ref)
    required = required_targets_for_paths(inputs['all_paths'])
    targets = plan_targets(extra_targets, required, retain_artifacts=True)
    manifest = {
        **retained_target_policy(targets),
        'repo': str(repo), 'run_root': str(root), 'retain_artifacts': True,
        'baseline': str(args.baseline), 'binary': state['binary'],
        'protected_root_binary': state['protected_root_binary'],
        'required_target_inputs': inputs, 'required_targets': sorted(required),
        'required_target_coverage': validate_required_target_results(required, []),
        'environment': baseline_module.retained_environment(root),
        'tmux': {'socket': str(root / 't'), 'started': False},
        'processes_started': [], 'cleanup': 'not needed; no handlers started',
        'repository_state_start': state,
    }
    socket_path = str(root / 't')
    if len(socket_path.encode()) >= 100:
        manifest['isolation_blocker'] = 'private tmux socket path too long; no external fallback allowed'
    evidence.mkdir(mode=0o700)
    if 'isolation_blocker' not in manifest:
        readiness = retained_readiness(root, binary, repo, evidence, baseline_module)
        manifest['readiness_smoke'] = readiness
        manifest['runs'] = [readiness]
        manifest['recorded_run_count'] = 1
        manifest['blocked_targets'].pop('readiness-smoke')
        manifest['tmux']['started'] = 'server_pid' in readiness
        manifest['processes_started'] = [readiness['server_pid']] if 'server_pid' in readiness else []
        manifest['cleanup'] = {key: readiness.get(key) for key in ('server_exit', 'socket_released', 'close_server')}
        if readiness['status'] == 'passed' and 'builtin-mods' in targets:
            s7_root = root / 's7-builtin-cache-restart'
            s7_root.mkdir(mode=0o700)
            s7_evidence = s7_root / 'evidence'
            s7_evidence.mkdir(mode=0o700)
            s7 = retained_builtin_cache_restart(
                s7_root, binary, repo, s7_evidence, baseline_module,
            )
            manifest['runs'].append(s7)
            manifest['recorded_run_count'] = len(manifest['runs'])
            if s7.get('validation_verdict') == 'passed':
                manifest['blocked_targets']['builtin-mods'] = (
                    'full builtin-mods acceptance contract not covered by retained S7'
                )
        if readiness['status'] == 'passed' and 'terminal-interaction' in targets:
            g5 = retained_g5(root, binary, repo, evidence, baseline_module,
                             getattr(args, 'g5_scenario', None))
            manifest['runs'].append(g5)
            manifest['recorded_run_count'] = len(manifest['runs'])
        manifest['required_target_coverage'] = validate_required_target_results(
            required, manifest['runs'],
        )
    final_state = baseline_module.retained_repository_state(repo, root, binary)
    manifest['repository_state_unchanged'] = final_state == state
    manifest['repository_state_end'] = final_state
    manifest['retained_inventory_before_report'] = baseline_module.tree_manifest(root)
    manifest['inventory_excludes_self'] = 'evidence/driver-final-manifest.json'
    with (evidence / 'driver-final-manifest.json').open('x') as stream:
        stream.write(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest, indent=2))
    return 2


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    parser.add_argument('--evidence-root', type=Path, required=True)
    parser.add_argument('--auth-source', type=Path, default=Path('~/.codex/auth.json'))
    parser.add_argument(
        '--baseline',
        type=Path,
        required=True,
        help='baseline JSON captured after the current make build',
    )
    parser.add_argument(
        '--base-ref',
        help=(
            'explicit commit-ish used to derive the committed release range instead '
            'of baseline.release_base_ref'
        ),
    )
    parser.add_argument(
        '--targets',
        default=None,
        help='comma-separated extra targets to append after diff-required targets',
    )
    parser.add_argument('--binary', type=Path)
    parser.add_argument('--run-root', type=Path)
    parser.add_argument('--retain-artifacts', action='store_true')
    parser.add_argument('--g5-scenario', choices=['turn-end-load', 'same-session-resume', 'fork-session'],
                        help='retained diagnostic subset; required targets and blocked verdict remain unchanged')
    args = parser.parse_args()
    if args.g5_scenario and not args.retain_artifacts:
        parser.error('--g5-scenario requires retained mode')
    try:
        extra_targets = parse_target_list(args.targets)
    except ValueError as error:
        parser.error(str(error))
    allowed = {
        *DEFAULT_TARGETS,
        *(target for target, _ in TARGET_PATH_RULES),
    }
    unknown = set(extra_targets) - allowed
    if unknown:
        parser.error(f'unknown targets: {sorted(unknown)}')
    if args.retain_artifacts or args.run_root or args.binary:
        if not (args.retain_artifacts and args.run_root and args.binary):
            parser.error('retained mode requires --binary, --run-root and --retain-artifacts')
        try:
            return retained_preflight(args, extra_targets)
        except (RuntimeError, ValueError, OSError) as error:
            parser.error(str(error))
    try:
        gate = BinaryGate(
            args.repo,
            args.evidence_root,
            args.auth_source,
            args.baseline,
            base_ref=args.base_ref,
        )
        targets = plan_targets(extra_targets, set(gate.manifest['required_targets']))
    except (RuntimeError, ValueError) as error:
        parser.error(str(error))
    return 0 if gate.run(targets) else 1


if __name__ == '__main__':
    sys.exit(main())

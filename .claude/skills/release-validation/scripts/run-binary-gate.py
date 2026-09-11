#!/usr/bin/env python3
import argparse
import atexit
import base64
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import ssl
import socket
import select
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit


sys.dont_write_bytecode = True


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
})
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
DUMMY_OPENAI_API_KEY = 'release-validation-dummy-key'
DUMMY_ANTHROPIC_API_KEY = 'release-validation-dummy-anthropic-key'
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
)
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
    if not prompt_text:
        return False

    def is_terminal_chrome(line):
        compact = line.replace(' ', '')
        return (
            bool(compact) and set(compact) <= {'─'}
        ) or 'bypass permissions on' in line or 'Debug mode' in line

    trailing_content = [
        line.strip()
        for line in lines[prompt_index + 1:]
        if line.strip()
    ]
    return not any(
        not is_terminal_chrome(line)
        for line in trailing_content
    )


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
        'untracked': sorted(untracked_manifest(repo)),
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



def plan_targets(extra_targets, required_targets):
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



def assertion_is_valid(assertion, source_runs):
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
    source_root = source_runs[source_run]
    for evidence_path in evidence_paths:
        if not isinstance(evidence_path, str) or not evidence_path.strip():
            return False
        absolute_path = Path(evidence_path)
        if not absolute_path.is_absolute() or not absolute_path.exists():
            return False
        if not is_relative_to(absolute_path.resolve(strict=False), source_root):
            return False
    return True



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
            and all(assertion_is_valid(assertion, own_sources) for assertion in assertions)
        )
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


def sse_function_call(call_id, name, arguments):
    events = [
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
        {
            'type': 'response.completed',
            'response': {
                'usage': {'input_tokens': 1, 'output_tokens': 1},
            },
        },
    ]
    return ''.join(
        f'data: {json.dumps(event, separators=(",", ":"))}\n\n'
        for event in events
    )


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

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
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

    def response_for(self, body):
        current_request = {
            'method': 'POST',
            'path': '/v1/responses',
            'body': body,
        }
        if not is_main_response_request(current_request):
            return 'title', sse_completed('{"title":"Release validation"}')
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
                    'subagent_type': 'general-purpose',
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
                            'subagent_type': 'general-purpose',
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
        if self.server is None:
            return {'stopped': True, 'thread_alive': False}
        self.server.shutdown()
        self.server.server_close()
        if self.thread is not None:
            self.thread.join(timeout=5)
        alive = bool(self.thread and self.thread.is_alive())
        self.flush()
        return {'stopped': not alive, 'thread_alive': alive}


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
        return command(['tmux', *args], check=check, timeout=timeout)

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
import atexit, json, os, signal, sys
io = os.environ["CC_VALIDATION_SSH_IO"]
def event(name, **extra):
    with open(io, "a") as stream:
        stream.write(json.dumps({"event": name, **extra}, sort_keys=True) + "\\n")
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
        cleanup_absent = require_cleanup or not any(
            name in observed_names for name in cleanup_names
        )
        return {
            'passed': (
                ids_match and not missing_events and unique and ordered
                and event_fields_match and cleanup_absent
            ),
            'missing_events': missing_events,
            'ids_match': ids_match,
            'unique': unique,
            'ordered': ordered,
            'event_fields_match': event_fields_match,
            'cleanup_absent': cleanup_absent,
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
        if label == 'model-discovery-empty-picker':
            settings['model'] = 'gpt-empty-discovery-current'
        if label == 'first-party-bootstrap-picker':
            settings['model'] = 'release-first-party-bootstrap-model'
        (config / 'settings.json').write_text(
            json.dumps(settings, indent=2) + '\n'
        )
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
        result = self.tmux(*args)
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
            'mock_openai': {
                'enabled': mock_base_url is not None,
                'base_url': mock_base_url,
                'request_evidence': (
                    str(run_dir / 'mock-openai-requests.json')
                    if mock_base_url else None
                ),
            },
            'terminal': {'cols': 200, 'rows': 60},
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
        return {
            'kill_exit': close_result.returncode,
            'session_exists_after': session_exists_after,
            'pane_pid': pane_pid,
            'process_remaining': bool(remaining),
            'remaining_processes': list(remaining.values()),
            'forced_termination': terminated,
            'mock_server': mock_cleanup,
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

    def send(self, target, run_dir, text, filename, *, confirm_pending=True):
        input_path = run_dir / filename
        single_line_command = text.startswith('/') and '\n' not in text and '\r' not in text
        input_path.write_text(text if single_line_command else text + '\n')
        buffer_name = f'cc-release-{self.pid}-{self.session_index}'
        self.tmux('load-buffer', '-b', buffer_name, str(input_path), check=True)
        self.tmux('paste-buffer', '-b', buffer_name, '-t', target, check=True)
        self.tmux('send-keys', '-t', target, 'Enter', check=True)
        time.sleep(0.5)
        submitted_path = run_dir / '02-submitted-pane.txt'
        submitted = self.capture(target, submitted_path)
        plain = strip_ansi(submitted)
        if confirm_pending and ('[Pasted text' in plain or submitted_input_pending(submitted)):
            self.tmux('send-keys', '-t', target, 'Enter', check=True)
            time.sleep(0.5)
            self.capture(target, submitted_path)

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
            'Release gate read-only validation. Call the Agent tool directly exactly once in foreground. '
            'Use a general-purpose agent with description "release foreground background" and omit run_in_background. '
            'The child must run the harmless command sleep 18, then read Makefile and report only the VERSION line. '
            'The child must not call Agent or delegate; it must use Bash and Read directly. '
            'Do not modify files and do not use any other parent tools. After continuation returns, print RELEASE_FGBG_PARENT_RESTORED.'
        )
        self.send(target, run_dir, prompt, 'input-agent.txt')
        registered = self.wait_until(
            lambda: '[AgentLifecycle] foreground_registered' in self.debug(run_dir), 90
        )
        self.capture(target, run_dir / '03-foreground-running-pane.txt')
        if registered:
            self.tmux('send-keys', '-t', target, 'C-b')
        transitioned = registered and self.wait_until(
            lambda: '[AgentLifecycle] foreground_to_background' in self.debug(run_dir), 30
        )
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
                    expected_output='VERSION :=',
                )['complete'],
                30,
                0.5,
            )
            agent_proof = self.agent_completion_proof(
                run_dir,
                agent_id=task_match.group(1),
                task_id=task_match.group(2),
                expected_output='VERSION :=',
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
        passed = (
            terminal
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
                ),
                360,
                1,
            )
            final = self.capture(target, run_dir / '03-terminal-pane.txt')
            prompt_restored = self.wait_until(
                lambda: '❯' in strip_ansi(
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
        notifications = self.notification_count(run_dir)
        parent_result = 'RELEASE_NESTED_PARENT_DONE' in self.assistant_text(
            run_dir, subagents=True
        )
        child_result = 'RELEASE_NESTED_CHILD_DONE' in self.assistant_text(
            run_dir, subagents=True
        )
        cleanup = self.close(run_dir, session, target)
        passed = (
            terminal
            and parent_result
            and child_result
            and prompt_restored
            and len(ids) == 2
            and markers['[AgentLifecycle] foreground_registered'] == 2
            and notifications == 0
            and self.cleanup_passed(cleanup)
        )
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'agent_ids': ids,
            'notification_count': notifications,
            'marker_counts': markers,
            'child_result_observed': child_result,
            'parent_result_observed': parent_result,
            'parent_prompt_restored': prompt_restored,
            'cleanup': cleanup,
        })
        self.record(result)

    def workflow(self):
        run_dir, session, target, ready = self.start('inline-workflow')
        result = {'label': 'workflow', 'evidence_dir': str(run_dir)}
        completion_proof = {'complete': False, 'status': None}
        if ready:
            script = """export const meta = { name: 'release-inline-workflow', description: 'Read-only two-agent release probe.', phases: [{ title: 'Probe' }] }
phase('Probe')
const results = await parallel([
  () => agent('Read-only. Read Makefile and report only VERSION.', { label: 'probe-a' }),
  () => agent('Read-only. Read package.json and report only version.', { label: 'probe-b' }),
])
return { results }
"""
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
            and completion_proof['complete']
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
        passed = (
            ready
            and launched
            and status == 'completed'
            and workflow_complete['complete']
            and len(ids) > 0
            and notifications == 1
            and '❯' in strip_ansi(terminal)
            and fetch_ok
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
            'notification_count': notifications,
            'permission_approvals': approvals,
            'parent_prompt_restored': '❯' in strip_ansi(terminal),
            'web_tool_evidence': web_tools,
            'deep_research_phase_evidence': phase_evidence,
            'marker_counts': markers,
            'assertions': [
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
                           reason=None):
        return {
            'assertion_id': assertion_id,
            'source_run': run_dir.name,
            'subject': subject,
            'predicate': predicate,
            'required_evidence': [str(path) for path in paths],
            'observed_evidence_paths': [str(path.resolve()) for path in paths],
            'runtime_state': runtime_state,
            'validation_verdict': 'passed' if passed else 'failed',
            'reason_if_not_passed': None if passed else reason,
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
            and hook_record.get('agent_type') == 'general-purpose'
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
            ('DEFAULT', 'gpt-5.6-luna', '08-default-model-pane.txt'),
        ):
            pane_path = run_dir / pane_name
            input_path = run_dir / f'input-{case.lower()}-model.txt'
            before = len(self.mock_response_requests(run_dir))
            visible = False
            if current:
                if case == 'DEFAULT':
                    self.send(target, run_dir, '/model sonnet', 'input-model-alias.txt')
                    alias_selected = self.wait_until(
                        lambda: 'Set model to Sonnet' in strip_ansi(
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
                and 'additionalModelOptionsCacheKey' not in global_config
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
        unkeyed_cache = (
            isinstance(options, list)
            and options == [{
                'value': 'release-first-party-bootstrap-model',
                'label': 'RELEASE_FIRST_PARTY_BOOTSTRAP_MODEL',
                'description': 'Release validation bootstrap model',
            }]
            and 'additionalModelOptionsCacheKey' not in global_config
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
            'unkeyed_cache': unkeyed_cache,
            'picker_visible': picker_visible,
            'current_model_confirmed': current,
        }, indent=2) + '\n')
        cleanup = self.close(run_dir, session, target)
        cache_passed = (
            ready and endpoint_once and unkeyed_cache
            and self.cleanup_passed(cleanup)
        )
        picker_passed = (
            ready and picker_visible and current and unkeyed_cache
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
            'unkeyed_cache': unkeyed_cache,
            'bootstrap_endpoint_once': endpoint_once,
            'picker_visible': picker_visible,
            'current_model_confirmed': current,
            'assertions': [
                self.required_assertion(
                    run_dir,
                    'first-party-bootstrap-startup-cache',
                    'First-party bootstrap startup cache',
                    'Startup consumes the persisted unkeyed /api/claude_cli/bootstrap model cache without keyed-discovery filtering.',
                    evidence,
                    passed=cache_passed,
                    reason='the isolated startup did not preserve and consume the unkeyed bootstrap cache',
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
            self.send(target, run_dir, '/plan', 'input-plan-mode-command.txt')
            plan_enabled = self.wait_until(
                lambda: 'Enabled plan mode' in strip_ansi(
                    self.capture(target, plan_path)
                ),
                30,
                0.25,
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
        requests = server.snapshot() if server else []
        responses = [request for request in requests if is_main_response_request(request)]
        kinds = [request.get('response_kind') for request in responses]
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
        marker_path = run_dir / 'debug-marker-search.txt'
        config_evidence = run_dir / 'team-config.json'
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
        else:
            running_path.write_text('readiness failed\n')
            terminal_path.write_text('readiness failed\n')
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
        cleanup = self.close(run_dir, session, target)
        passed = (
            ready and terminal and config_ok and markers_ok
            and self.cleanup_passed(cleanup)
        )
        evidence = [
            run_dir / 'input-team-concurrency.txt',
            running_path,
            terminal_path,
            config_evidence,
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
                [config_evidence, marker_path, run_dir / 'debug.log'],
                passed=passed and markers_ok,
                reason='team mutation marker counts were incomplete',
            ),
        ]
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'reason': None if passed else 'team concurrency assertions were incomplete',
            'team_name': team_config.get('name') if isinstance(team_config, dict) else None,
            'member_count': len(members),
            'agent_ids': agent_ids,
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
                return time.monotonic() > evidence['main_escape_sent'] + 0.8
            observed = self.wait_until(observe, 2, 0.05)
            evidence['isolated'] = observed and not any(sample['rewind'] for sample in evidence['samples'])
            if evidence['isolated']:
                evidence['double_first_sent'] = time.monotonic()
                self.tmux('send-keys', '-t', target, 'Escape', check=True)
                evidence['double_second_sent'] = time.monotonic()
                self.tmux('send-keys', '-t', target, 'Escape', check=True)
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
                        r'\x1b\[1m(?:\x1b\[[0-9;]*m)*\s*(Overview|Models|OpenAI)\s*\x1b\[0m', bar)
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
        self.manifest.update({
            'completion_state': 'running',
            'normal_exit': False,
            'expected_run_count': len(targets) + 1,
            'recorded_run_count': 0,
            'planned_targets': ['readiness-smoke', *targets],
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
        }
        try:
            self.run_target('readiness-smoke', self.readiness_smoke)
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
            expected_runs = len(targets) + 1
            required_coverage = validate_required_target_results(
                set(self.manifest['required_targets']),
                self.manifest['runs'],
                self.registered_runs,
            )
            self.manifest['required_target_coverage'] = required_coverage
            self.manifest['overall_verdict'] = (
                'passed'
                if (
                    self.manifest['normal_exit']
                    and self.manifest['matrix_complete']
                    and 'driver_error' not in self.manifest
                    and len(self.manifest['runs']) == expected_runs
                    and required_coverage['passed']
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
    args = parser.parse_args()
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

#!/usr/bin/env python3
import argparse
import atexit
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit


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
TARGET_PATH_RULES = (
    ('team-concurrency', (
        'src/utils/swarm/',
        'src/tools/shared/spawnMultiAgent',
    )),
    ('workflow-retry-partial-failure', (
        'src/tools/WorkflowTool/',
        'src/tasks/LocalWorkflowTask/',
    )),
    ('workflow-failure-detail', (
        'src/tools/WorkflowTool/',
        'src/tasks/LocalWorkflowTask/',
        'src/commands/workflows/',
    )),
    ('coordinator-selector', (
        'src/components/CoordinatorAgentStatus',
        'src/components/PromptInput/',
        'src/components/tasks/BackgroundTaskStatus',
        'src/state/AppStateStore',
    )),
    ('transcript-retention', (
        'src/state/selectors',
        'src/state/teammateViewHelpers',
        'src/utils/swarm/inProcessRunner',
        'src/components/TeammateViewHeader',
        'src/components/Spinner',
        'src/components/PromptInput/useSwarmBanner',
    )),
)
DEFAULT_TARGETS = (
    'agent-fg-bg',
    'nested-agent',
    'workflow',
    'deep-research',
    'code-review',
)
ASSERTION_RUNTIME_STATES = {'running', 'done', 'failed', 'stopped'}


def submitted_input_pending(pane):
    plain = strip_ansi(pane)
    prompt_lines = [line for line in plain.splitlines() if '❯' in line]
    return bool(prompt_lines and prompt_lines[-1].split('❯', 1)[1].strip())



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
    upstream = baseline.get('upstream')
    if not upstream:
        raise RuntimeError(
            'baseline did not record an upstream; pass --base-ref <commit-ish> '
            'to validate committed release-range targets'
        )
    merge_base = command(
        ['git', '-C', str(repo), 'merge-base', 'HEAD', upstream],
        check=False,
    )
    resolved = merge_base.stdout.strip()
    if merge_base.returncode != 0 or not resolved:
        raise RuntimeError(
            'could not determine committed release base from baseline upstream '
            f'{upstream!r}; pass --base-ref <commit-ish>'
        )
    return {
        'base_ref': upstream,
        'merge_base': resolved,
        'source': 'baseline upstream merge-base',
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
    for target in extra_targets:
        if target not in seen:
            planned.append(target)
            seen.add(target)
    for target in sorted(required_targets):
        if target not in seen:
            planned.append(target)
            seen.add(target)
    return planned



def assertion_source_runs(runs):
    source_runs = {}
    for run in runs:
        evidence_dir = run.get('evidence_dir')
        if not isinstance(evidence_dir, str) or not evidence_dir:
            continue
        source_run = Path(evidence_dir).name
        if source_run and source_run not in source_runs:
            source_runs[source_run] = Path(evidence_dir).resolve(strict=False)
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



def validate_required_target_results(required_targets, runs):
    runs_by_label = {run.get('label'): run for run in runs}
    missing = sorted(required_targets - set(runs_by_label))
    invalid = []
    source_runs = assertion_source_runs(runs)
    for target in sorted(required_targets & set(runs_by_label)):
        run = runs_by_label[target]
        assertions = run.get('assertions')
        valid = (
            run.get('validation_verdict') == 'passed'
            and isinstance(assertions, list)
            and bool(assertions)
            and all(assertion_is_valid(assertion, source_runs) for assertion in assertions)
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
        if any(
            relative == root or relative.startswith(f'{root}/')
            for root in excluded_roots
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


class BinaryGate:
    def __init__(self, repo, evidence_root, auth_source, baseline_path, *, base_ref=None):
        self.repo = repo.resolve()
        self.evidence_root = evidence_root.resolve()
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
        self.auth_homes = set()
        self.cleanup_started = False
        self.workflow_task_ids = set()
        self.workflow_run_ids = set()
        self.workflow_runs = self.repo / '.claude' / 'workflow-runs'
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
            'workflow_runs_exists',
            'workflow_runs_sha256',
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

    def git(self, *args):
        return command(['git', '-C', str(self.repo), *args], check=True).stdout

    def workflow_runs_state(self):
        manifest = tree_manifest(self.workflow_runs)
        baseline_manifest = self.baseline.get('workflow_runs_manifest', {})
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
            if (
                not self.baseline.get('workflow_runs_exists', False)
                and self.workflow_runs.is_dir()
            ):
                try:
                    self.workflow_runs.rmdir()
                except OSError as error:
                    cleanup_errors.append({
                        'path': str(self.workflow_runs),
                        'error': repr(error),
                    })

        after = self.workflow_runs_state()
        passed = (
            not state['modified_paths']
            and not state['removed_paths']
            and not unowned_paths
            and not archive_errors
            and not cleanup_errors
            and after['exists'] == self.baseline.get('workflow_runs_exists', False)
            and after['sha256'] == self.baseline.get('workflow_runs_sha256')
        )
        return {
            'passed': passed,
            'ownership': ownership,
            'state_before_cleanup': state,
            'owned_added_paths': owned_paths,
            'cleanup_roots': cleanup_roots,
            'unowned_added_paths': unowned_paths,
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
            'mtime_ns': self.binary.stat().st_mtime_ns if self.binary.is_file() else None,
            'sha256': sha256(self.binary) if self.binary.is_file() else None,
        }
        workflow_runs_state = self.workflow_runs_state()
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
            'workflow_runs_exists': workflow_runs_state['exists'],
            'workflow_runs_sha256': workflow_runs_state['sha256'],
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

    def make_fixture(self, run_dir):
        config = run_dir / 'config'
        home = Path(tempfile.mkdtemp(prefix='claude-release-home-'))
        self.auth_homes.add(home)
        config.mkdir(parents=True)
        (home / '.codex').mkdir(parents=True)
        if not self.auth_source.is_file():
            raise RuntimeError(f'authenticated Codex source unavailable: {self.auth_source}')
        auth_target = (home / '.codex/auth.json').resolve()
        if is_relative_to(auth_target, self.evidence_root):
            raise RuntimeError('auth target must be outside the evidence root')
        if is_relative_to(auth_target, self.repo):
            raise RuntimeError('auth target must be outside the repository')
        shutil.copyfile(self.auth_source, auth_target)
        auth_target.chmod(0o600)
        (config / '.claude.json').write_text(json.dumps({
            'numStartups': 1,
            'installMethod': 'local',
            'hasCompletedOnboarding': True,
            'projects': {
                str(self.repo): {
                    'hasTrustDialogAccepted': True,
                    'hasCompletedProjectOnboarding': True,
                },
            },
        }, indent=2) + '\n')
        (config / 'settings.json').write_text(json.dumps({
            'enableWorkflows': True,
            'workflowKeywordTriggerEnabled': True,
            'skipWorkflowUsageWarning': True,
            'skipDangerousModePermissionPrompt': True,
        }, indent=2) + '\n')
        (run_dir / 'auth-source-metadata.json').write_text(json.dumps({
            'source': str(self.auth_source),
            'strategy': 'copy account auth into a private temporary HOME outside evidence; remove it after the gate',
            'source_exists': self.auth_source.exists(),
            'target_outside_evidence': not is_relative_to(
                auth_target, self.evidence_root
            ),
            'target_outside_repository': not is_relative_to(auth_target, self.repo),
            'target_mode': oct(auth_target.stat().st_mode & 0o777),
        }, indent=2) + '\n')
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
        config, home = self.make_fixture(run_dir)
        session = f'cc-release-{label}-{self.stamp}-{self.pid}-{self.session_index}'[:90]
        if self.tmux('has-session', '-t', session).returncode == 0:
            raise RuntimeError(f'tmux session collision: {session}')
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
        args.append(str(self.launcher))
        result = self.tmux(*args)
        (run_dir / 'tmux-start-stdout.txt').write_text(result.stdout)
        (run_dir / 'tmux-start-stderr.txt').write_text(result.stderr)
        (run_dir / 'pane-target.txt').write_text(target + '\n')
        (run_dir / 'run-metadata.json').write_text(json.dumps({
            'label': label,
            'session': session,
            'target': target,
            'repo': str(self.repo),
            'head': self.manifest['head'],
            'binary': str(self.binary),
            'binary_sha256': self.manifest['binary_sha256'],
            'launcher': str(self.launcher),
            'config': str(config),
            'home': str(home),
            'terminal': {'cols': 200, 'rows': 60},
            'flags': ['--dangerously-skip-permissions', '--debug', '--debug-file', '<evidence>/debug.log'],
            'inherited_auth_env': {
                name: 'set' if os.environ.get(name) else 'unset'
                for name in AUTH_ENV_VARS
            },
            'auth_env_policy': (
                'launcher uses env -i and restores only non-secret runtime '
                'variables plus CLAUDE_CODE_USE_OPENAI=1'
            ),
        }, indent=2) + '\n')
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
        self.wait_until(lambda: not self.run_processes(run_dir, before), 5, 0.25)
        remaining = self.run_processes(run_dir, before)
        terminated = self.terminate_processes(remaining) if remaining else []
        remaining = self.run_processes(run_dir, before)
        (run_dir / 'process-after-close.txt').write_text(
            '\n'.join(remaining.values()) + ('\n' if remaining else '')
        )
        self.active_runs.pop(session, None)
        return {
            'kill_exit': close_result.returncode,
            'pane_pid': pane_pid,
            'process_remaining': bool(remaining),
            'remaining_processes': list(remaining.values()),
            'forced_termination': terminated,
        }

    def close_active_runs(self):
        cleanup = []
        for session, (run_dir, target) in list(self.active_runs.items()):
            cleanup.append({
                'session': session,
                'evidence_dir': str(run_dir),
                **self.close(run_dir, session, target),
            })
        return cleanup

    def cleanup_passed(self, cleanup):
        return (
            cleanup['kill_exit'] == 0
            and not cleanup['process_remaining']
            and not cleanup['forced_termination']
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
        signal.signal(signum, signal.SIG_IGN)
        cleanup = {
            'signal': signal.Signals(signum).name,
            'active_runs': self.close_active_runs(),
            'auth_homes': self.remove_auth_homes(),
        }
        if self.evidence_root.is_dir():
            (self.evidence_root / 'signal-cleanup.json').write_text(
                json.dumps(cleanup, indent=2) + '\n'
            )
        raise SystemExit(128 + signum)

    def record(self, result):
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
                ordinary_state_keys = (
                    set(state_before)
                    - {'workflow_runs_exists', 'workflow_runs_sha256'}
                )
                ordinary_state_unchanged = all(
                    state_before[key] == state_after[key]
                    for key in ordinary_state_keys
                )
                workflow_state_expected = (
                    not workflow_modified
                    and not workflow_removed
                    and not unexpected_workflow_paths
                )
                result['repository_state_before'] = state_before
                result['repository_state_after'] = state_after
                result['repository_state_unchanged'] = (
                    ordinary_state_unchanged and workflow_state_expected
                )
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

    def send(self, target, run_dir, text, filename):
        input_path = run_dir / filename
        input_path.write_text(text + '\n')
        buffer_name = f'cc-release-{self.pid}-{self.session_index}'
        self.tmux('load-buffer', '-b', buffer_name, str(input_path), check=True)
        self.tmux('paste-buffer', '-b', buffer_name, '-t', target, check=True)
        self.tmux('send-keys', '-t', target, 'Enter', check=True)
        time.sleep(0.5)
        submitted_path = run_dir / '02-submitted-pane.txt'
        submitted = self.capture(target, submitted_path)
        plain = strip_ansi(submitted)
        if '[Pasted text' in plain or submitted_input_pending(submitted):
            self.tmux('send-keys', '-t', target, 'Enter', check=True)
            time.sleep(0.5)
            self.capture(target, submitted_path)

    def debug(self, run_dir):
        path = run_dir / 'debug.log'
        return path.read_text(errors='replace') if path.exists() else ''

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

    def deep_research_web_tools_complete(self, web_tools):
        return (
            tool_occurrence_count(web_tools['WebSearch']) == 5
            and len(web_tools['WebSearch']['successful_result_ids']) == 5
            and not web_tools['WebSearch']['failed_result_ids']
            and not web_tools['WebSearch']['invalid_result_ids']
            and tool_occurrence_count(web_tools['WebFetch']) == 15
            and not web_tools['WebFetch']['invalid_result_ids']
            and (
                len(web_tools['WebFetch']['successful_result_ids'])
                + len(web_tools['WebFetch']['failed_result_ids'])
                == 15
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
                    and set(exact_once_indexes) == expected_indexes
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
                selected_sources = (
                    worker_attempts.get('1', [{}])[0].get('selected_sources')
                    if len(worker_attempts.get('1', [])) == 1
                    else None
                )
                expected_ranks = list(range(1, 16))
                selected_urls = (
                    [source['url'] for source in selected_sources]
                    if selected_sources is not None
                    else []
                )
                sources_complete = (
                    selected_sources is not None
                    and len(selected_sources) == 15
                    and [source['rank'] for source in selected_sources]
                    == expected_ranks
                    and all(selected_urls)
                    and len(set(selected_urls)) == 15
                )
                phase_result.update({
                    'selected_sources': selected_sources,
                    'sources_complete': sources_complete,
                    'complete': phase_result['complete'] and sources_complete,
                })
            result[phase] = phase_result
        selected_sources = result['select-sources'].get('selected_sources')
        selected_source_by_index = {
            str(source['rank']): source['url']
            for source in selected_sources or []
        }
        fetch_sources_match = (
            result['select-sources']['complete']
            and all(
                len(phase_attempts) == 1
                and phase_attempts[0]['selected_source'] is not None
                and phase_attempts[0]['selected_source']['url']
                == selected_source_by_index.get(index)
                for index, phase_attempts in attempts['fetch'].items()
            )
        )
        result['fetch']['selected_sources_match'] = fetch_sources_match
        result['fetch']['complete'] = (
            result['fetch']['complete'] and fetch_sources_match
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
                    'RELEASE_NESTED_PARENT_DONE' in self.assistant_text(run_dir)
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
        parent_result = 'RELEASE_NESTED_PARENT_DONE' in self.assistant_text(run_dir)
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
        result = {'label': 'inline-workflow', 'evidence_dir': str(run_dir)}
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
            prompt = (
                '/code-review high Read-only validation of current changes in src/tools/AgentTool, '
                'src/tools/WorkflowTool, src/tasks/LocalWorkflowTask, and src/utils/sessionStorage.ts. '
                'Do not modify files, commit, push, release, or create worktrees.'
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
                and self.deep_research_web_tools_complete(web_tools)
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
            script = """export const meta = { name: 'release-failure-detail', description: 'Deterministic workflow failure diagnostics.', phases: [{ title: 'Failure probe' }] }
phase('Failure probe')
const result = await agent('Return any short answer.', { label: 'invalid-schema-worker', schema: { type: 'definitely-invalid-json-schema-type' } })
if (result === null) throw new Error('release deterministic workflow failure')
return result
"""
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
        cleanup = self.close(run_dir, session, target)
        passed = (
            ready and launched and completion_proof['complete']
            and status == 'failed' and detail_ok
            and marker_ok and no_retry and self.cleanup_passed(cleanup)
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
        if ready:
            prompt = (
                'Coordinator selector binary validation. Call the Agent tool exactly once in foreground with description '
                '"release coordinator selector". The general-purpose child must run the harmless command sleep 30, then '
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
            and selected_agent and viewed_agent and self.cleanup_passed(cleanup)
        )
        evidence = [
            run_dir / 'input-coordinator-selector.txt',
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
            script = """export const meta = { name: 'release-partial-retry', description: 'Controlled partial transient retry.', phases: [{ title: 'Retry probe' }] }
phase('Retry probe')
return await parallel([
  () => agent('Return exactly stable-worker-ok.', { label: 'stable-worker' }),
  () => agent('Return exactly transient-worker-ok.', { label: 'transient-worker' }),
])
"""
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
        cleanup = self.close(run_dir, session, target)
        passed = (
            ready and launched and status == 'completed'
            and completion_proof['complete']
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

    def transcript_retention(self):
        run_dir, session, target, ready = self.start('transcript-retention')
        result = {'label': 'transcript-retention', 'evidence_dir': str(run_dir)}
        running_path = run_dir / '03-running-pane.txt'
        viewed_path = run_dir / '04-viewed-pane.txt'
        terminal_path = run_dir / '05-terminal-viewed-pane.txt'
        main_path = run_dir / '06-main-pane.txt'
        marker_path = run_dir / 'debug-marker-search.txt'
        viewed = retained = exited = terminal_visible = False
        task_id = None
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
                lambda: 'team_mutation_commit' in self.debug(run_dir),
                120,
                0.5,
            )
            self.capture(target, running_path)
            if registered:
                self.tmux('send-keys', '-t', target, 'Down', check=True)
                self.tmux('send-keys', '-t', target, 'Right', check=True)
                self.tmux('send-keys', '-t', target, 'Enter', check=True)
                viewed = self.wait_until(
                    lambda: re.search(
                        r'viewed_agent_changed[^\n]*after=([^ ]+)[^\n]*type=in_process_teammate',
                        self.debug(run_dir),
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
                retained = bool(task_id) and self.wait_until(
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
                    self.tmux('send-keys', '-t', target, 'Escape', check=True)
                    exited = self.wait_until(
                        lambda: (
                            f'viewed_agent_changed] before={task_id} after=main'
                            in self.debug(run_dir)
                        ),
                        30,
                        0.25,
                    )
                self.capture(target, main_path)
        for path in (running_path, viewed_path, terminal_path, main_path):
            if not path.exists():
                path.write_text('required transcript state was not reached\n')
        log = self.debug(run_dir)
        marker_lines = [
            line
            for line in log.splitlines()
            if 'viewed_agent_changed' in line
            or 'transcript_retention_decision' in line
        ]
        marker_path.write_text(
            '\n'.join(marker_lines) + ('\n' if marker_lines else '')
        )
        cleanup = self.close(run_dir, session, target)
        passed = (
            ready and bool(task_id) and viewed and retained and terminal_visible
            and exited and self.cleanup_passed(cleanup)
        )
        evidence = [
            run_dir / 'input-transcript-retention.txt',
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
                passed=passed,
                reason='view, retention, terminal transcript, or exit evidence was incomplete',
            ),
        ]
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'reason': None if passed else 'transcript retention assertions were incomplete',
            'task_id': task_id,
            'runtime_state': 'done' if retained else 'running',
            'viewed': viewed,
            'retained': retained,
            'terminal_visible': terminal_visible,
            'exited': exited,
            'assertions': assertions,
            'cleanup': cleanup,
        })
        self.record(result)

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
        self.evidence_root.mkdir(parents=True, exist_ok=False)
        (self.evidence_root / 'driver-start-manifest.json').write_text(
            json.dumps(self.manifest, indent=2) + '\n'
        )
        actions = {
            'agent-fg-bg': self.direct_agent,
            'nested-agent': self.nested_agent,
            'workflow': self.workflow,
            'deep-research': lambda: self.slash_workflow('deep-research'),
            'code-review': lambda: self.slash_workflow('code-review'),
            'team-concurrency': self.team_concurrency,
            'workflow-retry-partial-failure': self.workflow_retry_partial_failure,
            'workflow-failure-detail': self.workflow_failure_detail,
            'coordinator-selector': self.coordinator_selector,
            'transcript-retention': self.transcript_retention,
        }
        try:
            self.run_target('readiness-smoke', self.readiness_smoke)
            for target in targets:
                result_label = 'inline-workflow' if target == 'workflow' else target
                self.run_target(result_label, actions[target])
        except Exception as error:
            self.manifest['driver_error'] = repr(error)
        finally:
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
                    'workflow_runs_exists',
                    'workflow_runs_sha256',
                    'binary',
                )
            )
            expected_runs = len(targets) + 1
            required_coverage = validate_required_target_results(
                set(self.manifest['required_targets']),
                self.manifest['runs'],
            )
            self.manifest['required_target_coverage'] = required_coverage
            self.manifest['overall_verdict'] = (
                'passed'
                if (
                    'driver_error' not in self.manifest
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
            'explicit commit-ish used to derive the committed release range when '
            'baseline upstream is unavailable or unsafe'
        ),
    )
    parser.add_argument(
        '--targets',
        default=None,
        help=(
            'comma-separated extra targets to append after the default matrix; '
            'default targets always run'
        ),
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

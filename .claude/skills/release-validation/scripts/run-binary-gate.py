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
    def __init__(self, repo, evidence_root, auth_source, baseline_path):
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
                or re.search(r'(^|\n)\s*❯\s*$', plain)
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
            str(self.launcher),
        ]
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
        submitted = self.capture(target, run_dir / '02-submitted-pane.txt')
        if '[Pasted text' in submitted:
            self.tmux('send-keys', '-t', target, 'Enter')

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
        passive_workers = {'verify': {}, 'synthesize': {}}
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
                    r'(?:deep-research: (verify)(?: (\d+)/(\d+))?'
                    r'|deep-research: (synthesize))'
                    r'(?: retry \d+(?:/\d+)?)?',
                    description,
                )
                if not passive_match:
                    continue
                phase = passive_match.group(1) or passive_match.group(4)
                index = passive_match.group(2) or '1'
                all_tools = self.tool_evidence(
                    run_dir,
                    set(),
                    [transcript_path] if transcript_path.is_file() else [],
                    allowed_names=set(),
                )
                passive_workers[phase].setdefault(index, []).append({
                    'agent_id': metadata.get('agentId') or meta_path.name[6:-10],
                    'expected_total': int(passive_match.group(3) or 1),
                    'retry': ' retry ' in description,
                    'transcript': str(transcript_path),
                    'tool_names': all_tools['unexpected_tool_names'],
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
        passive_required = {'verify': 3, 'synthesize': 1}
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
                    for attempt in phase_attempts
                )
            )
            result[phase] = {
                'expected_logical_workers': count,
                'observed_logical_indexes': sorted(worker_attempts),
                'violating_logical_indexes': violating_indexes,
                'complete': (
                    set(worker_attempts) == expected_indexes
                    and not violating_indexes
                ),
                'attempts': worker_attempts,
            }
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
        final = self.capture(target, run_dir / '06-final-pane.txt')
        log = self.debug(run_dir)
        markers = self.write_markers(run_dir, log)
        ids = self.agent_ids(log)
        notifications = self.notification_count(run_dir)
        cleanup = self.close(run_dir, session, target)
        passed = (
            terminal
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
                lambda: 'RELEASE_NESTED_PARENT_DONE' in self.assistant_text(run_dir),
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
        cleanup = self.close(run_dir, session, target)
        parent_result = 'RELEASE_NESTED_PARENT_DONE' in self.assistant_text(run_dir)
        child_result = 'RELEASE_NESTED_CHILD_DONE' in self.assistant_text(
            run_dir, subagents=True
        )
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
            completed = launched and self.wait_until(
                lambda: self.workflow_status(run_dir, task_id) is not None, 420, 1
            )
            status = self.workflow_status(run_dir, task_id)
            terminal = self.capture(target, run_dir / '04-terminal-pane.txt')
            page_ok = detail_ok = agent_ok = False
            if completed and status == 'completed':
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
            page_ok = detail_ok = agent_ok = False
            terminal = final = ''
        log = self.debug(run_dir)
        markers = self.write_markers(run_dir, log)
        ids = self.agent_ids(log)
        notifications = self.notification_count(run_dir)
        cleanup = self.close(run_dir, session, target)
        passed = (
            status == 'completed'
            and len(ids) == 2
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
            'notification_count': notifications,
            'workflow_page': {'page': page_ok, 'detail': detail_ok, 'agent_terminal': agent_ok},
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
            while launched and status is None and time.monotonic() < deadline:
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
                time.sleep(1)
            timed_out = launched and status is None
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
        cleanup = self.close(run_dir, session, target)
        fetch_ok = (
            kind != 'deep-research'
            or (
                phase_evidence['search']['complete']
                and phase_evidence['fetch']['complete']
                and phase_evidence['verify']['complete']
                and phase_evidence['synthesize']['complete']
                and self.deep_research_web_tools_complete(web_tools)
            )
        )
        passed = (
            ready
            and launched
            and status == 'completed'
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
        }
        try:
            self.readiness_smoke()
            for target in targets:
                actions[target]()
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
            self.manifest['overall_verdict'] = (
                'passed'
                if (
                    'driver_error' not in self.manifest
                    and len(self.manifest['runs']) == expected_runs
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
        '--targets',
        default='agent-fg-bg,nested-agent,workflow,deep-research,code-review',
        help='comma-separated targets',
    )
    args = parser.parse_args()
    targets = [target for target in args.targets.split(',') if target]
    allowed = {'agent-fg-bg', 'nested-agent', 'workflow', 'deep-research', 'code-review'}
    unknown = set(targets) - allowed
    if unknown:
        parser.error(f'unknown targets: {sorted(unknown)}')
    gate = BinaryGate(
        args.repo, args.evidence_root, args.auth_source, args.baseline
    )
    return 0 if gate.run(targets) else 1


if __name__ == '__main__':
    sys.exit(main())

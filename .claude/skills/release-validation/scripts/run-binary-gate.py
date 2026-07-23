#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


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


def strip_ansi(text):
    return re.sub(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))', '', text)


class BinaryGate:
    def __init__(self, repo, evidence_root, auth_source):
        self.repo = repo.resolve()
        self.evidence_root = evidence_root.resolve()
        self.auth_source = auth_source.expanduser().resolve()
        self.launcher = (
            self.repo
            / '.claude/skills/claude-agent-workflow-validation/scripts/launch-built-claude.sh'
        )
        self.binary = self.repo / 'built-claude'
        self.stamp = time.strftime('%Y%m%dT%H%M%S')
        self.pid = os.getpid()
        self.session_index = 0
        self.manifest = {
            'started': time.time(),
            'repo': str(self.repo),
            'head': self.git('rev-parse', 'HEAD').strip(),
            'git_status_start': self.git('status', '--short'),
            'binary': str(self.binary),
            'binary_sha256': sha256(self.binary),
            'runs': [],
        }

    def git(self, *args):
        return command(['git', '-C', str(self.repo), *args], check=True).stdout

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
        home = run_dir / 'home'
        config.mkdir(parents=True)
        (home / '.codex').mkdir(parents=True)
        if not self.auth_source.is_file():
            raise RuntimeError(f'authenticated Codex source unavailable: {self.auth_source}')
        auth_target = home / '.codex/auth.json'
        auth_target.symlink_to(self.auth_source)
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
            'strategy': 'read-only symlink into isolated HOME; secret contents not copied',
            'source_exists': self.auth_source.exists(),
            'target_points_to_source': auth_target.resolve() == self.auth_source,
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
        }, indent=2) + '\n')
        ready = result.returncode == 0 and self.wait_ready(target, run_dir)
        return run_dir, session, target, ready

    def close(self, run_dir, session, target):
        pid_result = self.tmux('display-message', '-p', '-t', target, '#{pane_pid}')
        pane_pid = pid_result.stdout.strip() if pid_result.returncode == 0 else ''
        if pane_pid:
            before = command(['ps', '-p', pane_pid, '-o', 'pid=,ppid=,etime=,command='])
            (run_dir / 'process-before-close.txt').write_text(before.stdout)
        close_result = self.tmux('kill-session', '-t', session)
        remaining = ''
        for _ in range(20):
            if not pane_pid:
                break
            remaining = command(
                ['ps', '-p', pane_pid, '-o', 'pid=,ppid=,etime=,command=']
            ).stdout
            if not remaining.strip():
                break
            time.sleep(0.25)
        (run_dir / 'process-after-close.txt').write_text(remaining)
        return {
            'kill_exit': close_result.returncode,
            'pane_pid': pane_pid,
            'process_remaining': bool(remaining.strip()),
        }

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
            'validation_verdict': 'passed' if ready and not cleanup['process_remaining'] else 'failed',
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

    def transcript_paths(self, run_dir):
        return [
            path for path in (run_dir / 'config').glob('projects/**/*.jsonl')
            if 'subagents' not in path.parts
        ]

    def transcript(self, run_dir):
        return '\n'.join(
            path.read_text(errors='replace') for path in self.transcript_paths(run_dir)
        )

    def notification_count(self, run_dir):
        count = 0
        for path in self.transcript_paths(run_dir):
            for line in path.read_text(errors='replace').splitlines():
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get('type') == 'user' and entry.get('origin', {}).get('kind') == 'task-notification':
                    count += 1
        return count

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
        return task.group(1) if task else None, run.group(1) if run else None

    def agent_ids(self, log):
        return sorted(set(re.findall(r'AgentLifecycle\] foreground_registered agent_id=([^ ]+)', log)))

    def write_markers(self, run_dir, log):
        keys = [
            'AgentTool launch params',
            '[AgentLifecycle] foreground_registered',
            '[AgentLifecycle] foreground_to_background',
            '[AgentLifecycle] background_terminal',
            'WebSearch',
            'WebFetch',
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
            and not cleanup['process_remaining']
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
                lambda: 'RELEASE_NESTED_PARENT_DONE' in strip_ansi(
                    self.capture(target, run_dir / '03-terminal-pane.txt')
                ),
                360,
                1,
            )
            final = self.capture(target, run_dir / '04-final-pane.txt')
        else:
            terminal = False
            final = ''
        log = self.debug(run_dir)
        markers = self.write_markers(run_dir, log)
        ids = self.agent_ids(log)
        cleanup = self.close(run_dir, session, target)
        passed = terminal and len(ids) >= 2 and not cleanup['process_remaining']
        result.update({
            'validation_verdict': 'passed' if passed else 'failed',
            'agent_ids': ids,
            'marker_counts': markers,
            'parent_prompt_restored': 'RELEASE_NESTED_PARENT_DONE' in strip_ansi(final),
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
            and not cleanup['process_remaining']
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
            terminal = self.capture(target, run_dir / '05-terminal-pane.txt')
        else:
            task_id = run_id = status = None
            terminal = ''
        log = self.debug(run_dir)
        markers = self.write_markers(run_dir, log)
        ids = self.agent_ids(log)
        notifications = self.notification_count(run_dir)
        cleanup = self.close(run_dir, session, target)
        fetch_ok = kind != 'deep-research' or (markers['WebSearch'] > 0 and markers['WebFetch'] > 0)
        passed = (
            status == 'completed'
            and len(ids) > 0
            and notifications == 1
            and '❯' in strip_ansi(terminal)
            and fetch_ok
            and not cleanup['process_remaining']
        )
        result.update({
            'validation_verdict': 'passed' if passed else 'failed' if status else 'running',
            'task_id': task_id,
            'run_id': run_id,
            'agent_ids': ids,
            'notification_count': notifications,
            'permission_approvals': approvals,
            'parent_prompt_restored': '❯' in strip_ansi(terminal),
            'marker_counts': markers,
            'cleanup': cleanup,
        })
        self.record(result)

    def run(self, targets):
        self.evidence_root.mkdir(parents=True, exist_ok=False)
        (self.evidence_root / 'driver-start-manifest.json').write_text(
            json.dumps(self.manifest, indent=2) + '\n'
        )
        self.readiness_smoke()
        actions = {
            'agent-fg-bg': self.direct_agent,
            'nested-agent': self.nested_agent,
            'workflow': self.workflow,
            'deep-research': lambda: self.slash_workflow('deep-research'),
            'code-review': lambda: self.slash_workflow('code-review'),
        }
        for target in targets:
            actions[target]()
        self.manifest['finished'] = time.time()
        self.manifest['git_status_end'] = self.git('status', '--short')
        self.manifest['overall_verdict'] = (
            'passed'
            if all(run['validation_verdict'] == 'passed' for run in self.manifest['runs'])
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
    gate = BinaryGate(args.repo, args.evidence_root, args.auth_source)
    return 0 if gate.run(targets) else 1


if __name__ == '__main__':
    sys.exit(main())

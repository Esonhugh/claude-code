#!/usr/bin/env python3
import ast
import importlib.util
import json
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch
from urllib.request import Request, urlopen


sys.dont_write_bytecode = True


SCRIPTS_DIR = Path(__file__).resolve().parent
DRIVER_PATH = SCRIPTS_DIR / 'run-binary-gate.py'
BASELINE_PATH = SCRIPTS_DIR / 'capture-release-baseline.py'
LAUNCHER_PATH = (
    SCRIPTS_DIR.parent.parent
    / 'claude-agent-workflow-validation/scripts/launch-built-claude.sh'
)


def load_driver():
    spec = importlib.util.spec_from_file_location('run_binary_gate', DRIVER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_baseline():
    spec = importlib.util.spec_from_file_location(
        'capture_release_baseline', BASELINE_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_gate(module, repo, evidence, baseline_manifest, baseline_exists):
    gate = object.__new__(module.BinaryGate)
    gate.repo = repo
    gate.evidence_root = evidence
    gate.workflow_runs = repo / '.claude' / 'workflow-runs'
    gate.workflow_task_ids = set()
    gate.workflow_run_ids = set()
    gate.workflow_runs_initial_manifest = baseline_manifest
    gate.baseline = {}
    return gate


def write_transcript(path, entries):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(''.join(json.dumps(entry) + '\n' for entry in entries))


def deep_research_entries(phase, index, *, error=None, tool_id=None,
                          fetch_url=None, selected_url=None,
                          source_quality=None, claims=None):
    tool = 'WebSearch' if phase == 'search' else 'WebFetch'
    tool_id = tool_id or f'{phase}-{index}-tool'
    entries = []
    tool_input = {}
    if phase == 'fetch':
        fetch_url = fetch_url or f'https://example.test/source-{index}'
        selected_url = selected_url or fetch_url
        entries.append({
            'type': 'user',
            'message': {
                'role': 'user',
                'content': (
                    f'Fetch exactly one source: source {index} in that '
                    f'one-based order. Upstream source: {selected_url}'
                ),
            },
        })
        tool_input = {'url': fetch_url, 'prompt': 'extract claims'}
    entries.extend([{
        'type': 'assistant',
        'message': {
            'role': 'assistant',
            'content': [{
                'type': 'tool_use',
                'id': tool_id,
                'name': tool,
                'input': tool_input,
            }],
        },
    }, {
        'type': 'user',
        'message': {
            'role': 'user',
            'content': [{
                'type': 'tool_result',
                'tool_use_id': tool_id,
                **({'is_error': True, 'content': error}
                   if error is not None else {'content': 'ok'}),
            }],
        },
    }])
    if phase == 'fetch':
        entries.append({
            'type': 'assistant',
            'message': {
                'role': 'assistant',
                'content': [{
                    'type': 'text',
                    'text': json.dumps({
                        'selectedSource': {
                            'oneBasedRank': index,
                            'url': selected_url,
                        },
                        'sourceQuality': source_quality or (
                            'unreliable' if error is not None else 'primary'
                        ),
                        'claims': [] if claims is None else claims,
                    }),
                }],
            },
        })
    return entries


def deep_research_select_sources_entries(count=15):
    output = {
        'sources': [
            {
                'oneBasedRank': index,
                'url': f'https://example.test/source-{index}',
                'title': f'Source {index}',
                'originatingSearchWorker': 1,
            }
            for index in range(1, count + 1)
        ],
    }
    if count < 15:
        output['shortfall'] = {'missingCount': 15 - count}
    return [{
        'type': 'assistant',
        'message': {
            'role': 'assistant',
            'content': [{
                'type': 'text',
                'text': json.dumps(output),
            }],
        },
    }]


def deep_research_shortfall_entries(index):
    return [{
        'type': 'user',
        'message': {
            'role': 'user',
            'content': (
                f'Select only source {index}. The upstream source list has no '
                'source at that rank.'
            ),
        },
    }, {
        'type': 'assistant',
        'message': {
            'role': 'assistant',
            'content': [{
                'type': 'text',
                'text': json.dumps({
                    'selectedSource': {
                        'oneBasedRank': index,
                        'url': None,
                    },
                    'sourceQuality': 'unreliable',
                    'claims': [],
                    'missingReason': 'source list shortfall',
                }),
            }],
        },
    }]


def write_select_sources_worker(subagents, entries=None, description=None):
    stem = 'agent-select-sources'
    (subagents / f'{stem}.meta.json').parent.mkdir(parents=True, exist_ok=True)
    (subagents / f'{stem}.meta.json').write_text(json.dumps({
        'agentId': stem,
        'description': description or 'deep-research: select-sources',
    }))
    write_transcript(
        subagents / f'{stem}.jsonl',
        deep_research_select_sources_entries() if entries is None else entries,
    )



def make_required_assertion(source_dir, *, assertion_id='assertion-1',
                            validation_verdict='passed', runtime_state='done',
                            evidence_name='pane.txt', include_source_run=True,
                            include_assertion_id=True,
                            include_runtime_state=True,
                            evidence_absolute=True, create_evidence=True):
    evidence_path = source_dir / evidence_name
    if create_evidence:
        evidence_path.parent.mkdir(parents=True, exist_ok=True)
        evidence_path.write_text('evidence\n')
    assertion = {
        'validation_verdict': validation_verdict,
        'observed_evidence_paths': [
            str(evidence_path if evidence_absolute else Path(evidence_name))
        ],
    }
    if include_assertion_id:
        assertion['assertion_id'] = assertion_id
    if include_source_run:
        assertion['source_run'] = source_dir.name
    if include_runtime_state:
        assertion['runtime_state'] = runtime_state
    return assertion



def assert_driver_behavior(module, baseline_module):
    with tempfile.TemporaryDirectory(prefix='release-driver-single-submit-') as directory:
        gate = object.__new__(module.BinaryGate)
        gate.pid = 1
        gate.session_index = 1
        commands = []
        gate.tmux = lambda *args, **kwargs: commands.append(args)
        gate.capture = lambda *args: 'Background tasks'
        with patch.object(module.time, 'sleep'):
            gate.send('pane', Path(directory), '/tasks', 'input.txt')
        assert (Path(directory) / 'input.txt').read_bytes() == b'/tasks'
        assert sum(command[0] == 'send-keys' and command[-1] == 'Enter'
                   for command in commands) == 1

    with tempfile.TemporaryDirectory(prefix='release-driver-test-') as root_string:
        root = Path(root_string)
        repo = root / 'repo'
        evidence = root / 'evidence'
        runs = repo / '.claude' / 'workflow-runs'
        runs.mkdir(parents=True)
        evidence.mkdir()
        (runs / 'existing.json').write_text('existing\n')
        baseline = module.tree_manifest(runs)
        gate = make_gate(module, repo, evidence, baseline, True)
        gate.workflow_task_ids.add('task_owned')
        gate.workflow_run_ids.add('wf_owned')
        (runs / 'task_owned.json').write_text('task\n')
        owned = runs / 'wf_owned'
        owned.mkdir()
        (owned / 'session.json').write_text('session\n')

        result = module.BinaryGate.archive_and_remove_workflow_runs(gate)
        assert result['passed'] is True
        assert (runs / 'existing.json').read_text() == 'existing\n'
        assert not (runs / 'task_owned.json').exists()
        assert not owned.exists()
        assert (evidence / 'workflow-runs-artifacts/task_owned.json').is_file()
        assert (evidence / 'workflow-runs-artifacts/wf_owned/session.json').is_file()

        (runs / 'external.json').write_text('external\n')
        result = module.BinaryGate.archive_and_remove_workflow_runs(gate)
        assert result['passed'] is True
        assert result['external_paths_ignored'] == ['external.json']
        assert (runs / 'external.json').is_file()

    with tempfile.TemporaryDirectory(prefix='release-driver-test-') as root_string:
        root = Path(root_string)
        repo = root / 'repo'
        evidence = root / 'evidence'
        runs = repo / '.claude' / 'workflow-runs'
        runs.mkdir(parents=True)
        evidence.mkdir()
        (runs / 'existing.json').write_text('existing\n')
        baseline = module.tree_manifest(runs)
        gate = make_gate(module, repo, evidence, baseline, True)
        gate.workflow_task_ids.add('existing')
        (runs / 'existing.json').write_text('changed\n')

        result = module.BinaryGate.archive_and_remove_workflow_runs(gate)
        assert result['passed'] is True
        assert result['state_before_cleanup']['modified_paths'] == ['existing.json']
        assert result['owned_added_paths'] == []
        assert (runs / 'existing.json').read_text() == 'changed\n'

    with tempfile.TemporaryDirectory(prefix='release-driver-test-') as root_string:
        root = Path(root_string)
        repo = root / 'repo'
        repo.mkdir()
        subprocess.run(['git', '-C', str(repo), 'init'], check=True, capture_output=True)
        untracked = repo / 'untracked.txt'
        untracked.write_text('before\n')
        before = module.untracked_manifest(repo)
        untracked.write_text('after\n')
        after = module.untracked_manifest(repo)
        assert before.keys() == after.keys()
        assert module.tree_sha256(before) != module.tree_sha256(after)

        workflow_runs = repo / '.claude' / 'workflow-runs'
        workflow_runs.mkdir(parents=True)
        workflow_artifact = workflow_runs / 'run.json'
        workflow_artifact.write_text('before\n')
        assert not any(
            path == module.WORKFLOW_RUNS_ROOT
            or path.startswith(f'{module.WORKFLOW_RUNS_ROOT}/')
            for path in module.untracked_manifest(repo)
        )
        before = module.tree_manifest(workflow_runs)
        workflow_artifact.write_text('after\n')
        after = module.tree_manifest(workflow_runs)
        assert module.tree_sha256(before) != module.tree_sha256(after)

        (repo / '.gitignore').write_text(
            'ignored.txt\n.*.bun-build\n__pycache__/\n*.py[cod]\n'
        )
        ignored = repo / 'ignored.txt'
        ignored.write_text('before\n')
        before = module.ignored_manifest(repo)
        ignored.write_text('after\n')
        after = module.ignored_manifest(repo)
        assert before.keys() == after.keys()
        assert module.tree_sha256(before) != module.tree_sha256(after)

        bun_build_temporary = repo / '.0123456789abcdef-00000000.bun-build'
        bun_build_temporary.write_text('temporary\n')
        assert str(bun_build_temporary.relative_to(repo)) not in module.ignored_manifest(repo)
        assert str(bun_build_temporary.relative_to(repo)) not in baseline_module.ignored_manifest(repo)
        regular_bun_build = repo / '.not-a-temporary.bun-build'
        regular_bun_build.write_text('not a Bun temporary filename\n')
        assert str(regular_bun_build.relative_to(repo)) in module.ignored_manifest(repo)
        assert str(regular_bun_build.relative_to(repo)) in baseline_module.ignored_manifest(repo)

        pycache = repo / 'src/__pycache__'
        pycache.mkdir(parents=True)
        bytecode = pycache / 'module.cpython-314.pyc'
        bytecode.write_bytes(b'ephemeral bytecode')
        assert str(bytecode.relative_to(repo)) not in module.ignored_manifest(repo)
        assert (
            str(bytecode.relative_to(repo))
            not in baseline_module.ignored_manifest(repo)
        )

        ignored_dir = repo / 'ignored-dir'
        ignored_dir.mkdir()
        nested_ignored = ignored_dir / 'nested.txt'
        nested_ignored.write_text('before\n')
        original_command = module.command
        module.command = lambda *_args, **_kwargs: subprocess.CompletedProcess(
            args=[], returncode=0, stdout='ignored-dir/\0', stderr=''
        )
        try:
            before = module.ignored_manifest(repo)
            nested_ignored.write_text('after\n')
            after = module.ignored_manifest(repo)
        finally:
            module.command = original_command
        assert before['ignored-dir'] == {'type': 'dir'}
        assert before['ignored-dir/nested.txt']['type'] == 'file'
        assert module.tree_sha256(before) != module.tree_sha256(after)

    with tempfile.TemporaryDirectory(prefix='release-driver-test-') as root_string:
        run_dir = Path(root_string)
        project = run_dir / 'config/projects/project'
        main_transcript = project / 'session.jsonl'
        child_transcript = project / 'subagents/agent-child.jsonl'
        gate = object.__new__(module.BinaryGate)
        write_transcript(main_transcript, [{
            'type': 'user',
            'message': {
                'role': 'user',
                'content': 'RELEASE_NESTED_PARENT_DONE RELEASE_NESTED_CHILD_DONE',
            },
        }, {
            'type': 'assistant',
            'message': {
                'role': 'assistant',
                'content': [{
                    'type': 'tool_use',
                    'name': 'Agent',
                    'input': {'prompt': 'RELEASE_NESTED_CHILD_DONE'},
                }],
            },
        }])
        write_transcript(child_transcript, [{
            'type': 'user',
            'message': {'role': 'user', 'content': 'RELEASE_NESTED_CHILD_DONE'},
        }])
        assert module.BinaryGate.assistant_text(gate, run_dir) == ''
        assert module.BinaryGate.assistant_text(gate, run_dir, subagents=True) == ''

        write_transcript(main_transcript, [{
            'type': 'assistant',
            'message': {
                'role': 'assistant',
                'content': [{'type': 'text', 'text': 'RELEASE_NESTED_PARENT_DONE'}],
            },
        }])
        write_transcript(child_transcript, [{
            'type': 'assistant',
            'message': {
                'role': 'assistant',
                'content': [{'type': 'text', 'text': 'RELEASE_NESTED_CHILD_DONE'}],
            },
        }])
        assert module.BinaryGate.assistant_text(gate, run_dir) == 'RELEASE_NESTED_PARENT_DONE'
        assert module.BinaryGate.assistant_text(
            gate, run_dir, subagents=True
        ) == 'RELEASE_NESTED_CHILD_DONE'

        workflow_run_dir = run_dir / 'workflow-proof'
        workflow_run_dir.mkdir()
        gate.workflow_status = lambda _run_dir, _task_id: 'running'
        assert module.BinaryGate.workflow_completion_proof(
            gate, workflow_run_dir, 'task-1', 'wf_1'
        )['complete'] is False
        (workflow_run_dir / 'debug.log').write_text(
            '[workflow_worker_start] task=task-1 run=wf_1 phase=p logical=worker agent=a attempt=0\n'
            '[workflow_worker_terminal] task=task-1 run=wf_1 phase=p logical=worker agent=a attempt=0 status=completed\n'
            '[workflow_phase_terminal] task=task-1 run=wf_1 phase=p logical=- agent=- attempt=0 status=completed\n'
        )
        gate.workflow_status = lambda _run_dir, _task_id: 'completed'
        assert module.BinaryGate.workflow_completion_proof(
            gate, workflow_run_dir, 'task-1', 'wf_1'
        )['complete'] is False
        workflow_session = workflow_run_dir / 'config/projects/project/session.jsonl'
        workflow_session.parent.mkdir(parents=True)
        workflow_session.write_text(
            json.dumps({
                'type': 'user',
                'origin': {'kind': 'task-notification'},
                'message': {'role': 'user', 'content': 'done'},
            }) + '\n'
        )
        assert module.BinaryGate.workflow_completion_proof(
            gate, workflow_run_dir, 'task-1', 'wf_1'
        )['complete'] is True

        retention_terminal = 'RELEASE_RETENTION_WORKER_DONE'
        user_prompt_path = project / 'retention-user-prompt.jsonl'
        viewed_pane_path = run_dir / 'retention-viewed-pane.txt'
        worker_assistant_path = project / 'subagents/retention-worker.jsonl'
        write_transcript(user_prompt_path, [{
            'type': 'user',
            'message': {'role': 'user', 'content': retention_terminal},
        }])
        viewed_pane_path.write_text(retention_terminal)
        assert retention_terminal not in module.BinaryGate.assistant_text(
            gate, run_dir, subagents=True
        )
        write_transcript(worker_assistant_path, [{
            'type': 'assistant',
            'message': {
                'role': 'assistant',
                'content': [{'type': 'text', 'text': retention_terminal}],
            },
        }])
        assert retention_terminal in module.BinaryGate.assistant_text(
            gate, run_dir, subagents=True
        )

        task_notification = {
            'type': 'user',
            'origin': {'kind': 'task-notification'},
            'message': {
                'role': 'user',
                'content': '<task-notification><status>completed</status></task-notification>',
            },
        }
        write_transcript(main_transcript, [])
        timer = threading.Timer(
            0.05,
            lambda: write_transcript(main_transcript, [task_notification]),
        )
        timer.start()
        try:
            assert module.BinaryGate.wait_for_notification_count(
                gate, run_dir, 1, timeout=1, interval=0.01
            ) is True
        finally:
            timer.join()
        assert module.BinaryGate.notification_count(gate, run_dir) == 1

    with tempfile.TemporaryDirectory(prefix='release-driver-test-') as root_string:
        run_dir = Path(root_string)
        subagents = run_dir / 'config/projects/project/subagents'
        gate = object.__new__(module.BinaryGate)
        for phase, count, tool in (
            ('search', 5, 'WebSearch'),
            ('fetch', 15, 'WebFetch'),
        ):
            for index in range(1, count + 1):
                stem = f'agent-{phase}-{index}'
                (subagents / f'{stem}.meta.json').parent.mkdir(
                    parents=True, exist_ok=True
                )
                (subagents / f'{stem}.meta.json').write_text(json.dumps({
                    'agentId': stem,
                    'description': f'deep-research: {phase} {index}/{count}',
                }))
                write_transcript(
                    subagents / f'{stem}.jsonl',
                    deep_research_entries(phase, index),
                )
        write_select_sources_worker(subagents)
        for phase, count in (('verify', 3), ('synthesize', 1)):
            for index in range(1, count + 1):
                stem = f'agent-{phase}-{index}'
                description = (
                    f'deep-research: verify {index}/3'
                    if phase == 'verify'
                    else 'deep-research: synthesize'
                )
                (subagents / f'{stem}.meta.json').write_text(json.dumps({
                    'agentId': stem,
                    'description': description,
                }))
                write_transcript(subagents / f'{stem}.jsonl', [{
                    'type': 'assistant',
                    'message': {
                        'role': 'assistant',
                        'content': [{'type': 'text', 'text': '{}'}],
                    },
                }])
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['search']['complete'] is True
        assert evidence['select-sources']['complete'] is True
        assert evidence['fetch']['complete'] is True
        assert evidence['verify']['complete'] is True
        assert evidence['synthesize']['complete'] is True
        web_tools = module.BinaryGate.tool_evidence(
            gate, run_dir, {'WebSearch', 'WebFetch'}
        )
        assert module.BinaryGate.deep_research_web_tools_complete(
            gate, web_tools, evidence
        ) is True

        passive_path = subagents / 'agent-verify-1.jsonl'
        with passive_path.open('a') as stream:
            stream.write(json.dumps({
                'type': 'assistant',
                'message': {
                    'role': 'assistant',
                    'content': [{
                        'type': 'tool_use',
                        'id': 'verify-agent',
                        'name': 'Agent',
                        'input': {'prompt': 'delegate'},
                    }],
                },
            }) + '\n')
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['verify']['complete'] is False
        assert evidence['verify']['violating_logical_indexes'] == ['1']

        write_transcript(passive_path, [{
            'type': 'assistant',
            'message': {
                'role': 'assistant',
                'content': [{'type': 'text', 'text': '{}'}],
            },
        }])
        extra_path = subagents / 'agent-synthesize-1.jsonl'
        with extra_path.open('a') as stream:
            stream.write(json.dumps({
                'type': 'assistant',
                'message': {
                    'role': 'assistant',
                    'content': [{
                        'type': 'tool_use',
                        'id': 'extra-search',
                        'name': 'WebSearch',
                        'input': {'query': 'extra'},
                    }],
                },
            }) + '\n')
            stream.write(json.dumps({
                'type': 'user',
                'message': {
                    'role': 'user',
                    'content': [{
                        'type': 'tool_result',
                        'tool_use_id': 'extra-search',
                        'content': 'ok',
                    }],
                },
            }) + '\n')
        web_tools = module.BinaryGate.tool_evidence(
            gate, run_dir, {'WebSearch', 'WebFetch'}
        )
        assert module.BinaryGate.deep_research_web_tools_complete(
            gate, web_tools, evidence
        ) is False
        write_transcript(extra_path, [{
            'type': 'assistant',
            'message': {
                'role': 'assistant',
                'content': [{'type': 'text', 'text': '{}'}],
            },
        }])

        select_sources_path = subagents / 'agent-select-sources.jsonl'
        write_select_sources_worker(
            subagents,
            deep_research_select_sources_entries(14),
        )
        write_transcript(
            subagents / 'agent-fetch-15.jsonl',
            deep_research_shortfall_entries(15),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['select-sources']['complete'] is True
        assert evidence['select-sources']['sources_complete'] is True
        assert evidence['fetch']['complete'] is True
        assert evidence['fetch']['shortfall_logical_indexes'] == ['15']
        assert set(evidence['fetch']['exact_once_logical_indexes']) == {
            str(index) for index in range(1, 15)
        }
        web_tools = module.BinaryGate.tool_evidence(
            gate, run_dir, {'WebSearch', 'WebFetch'}
        )
        assert module.BinaryGate.deep_research_web_tools_complete(
            gate, web_tools, evidence
        ) is True

        write_transcript(
            subagents / 'agent-fetch-15.jsonl',
            deep_research_entries('fetch', 15),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['select-sources']['complete'] is True
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['invalid_shortfall_logical_indexes'] == ['15']
        web_tools = module.BinaryGate.tool_evidence(
            gate, run_dir, {'WebSearch', 'WebFetch'}
        )
        assert module.BinaryGate.deep_research_web_tools_complete(
            gate, web_tools, evidence
        ) is False

        invalid_shortfall_entries = deep_research_select_sources_entries(14)
        invalid_shortfall_output = json.loads(
            invalid_shortfall_entries[0]['message']['content'][0]['text']
        )
        invalid_shortfall_output['shortfall']['missingCount'] = 2
        invalid_shortfall_entries[0]['message']['content'][0]['text'] = json.dumps(
            invalid_shortfall_output
        )
        write_select_sources_worker(subagents, invalid_shortfall_entries)
        write_transcript(
            subagents / 'agent-fetch-15.jsonl',
            deep_research_shortfall_entries(15),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['select-sources']['complete'] is False

        entries = deep_research_select_sources_entries()
        output = json.loads(entries[0]['message']['content'][0]['text'])
        output['sources'][1]['url'] = output['sources'][0]['url']
        entries[0]['message']['content'][0]['text'] = json.dumps(output)
        write_select_sources_worker(subagents, entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['select-sources']['complete'] is False

        entries = deep_research_select_sources_entries()
        entries[0]['message']['content'][0]['text'] = '```json\n{}\n```'
        write_select_sources_worker(subagents, entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['select-sources']['complete'] is False

        entries = deep_research_select_sources_entries()
        entries.append(entries[0].copy())
        write_select_sources_worker(subagents, entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['select-sources']['complete'] is False

        entries = deep_research_select_sources_entries()
        output = json.loads(entries[0]['message']['content'][0]['text'])
        output['sources'][1]['oneBasedRank'] = 3
        entries[0]['message']['content'][0]['text'] = json.dumps(output)
        write_select_sources_worker(subagents, entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['select-sources']['complete'] is False

        entries = deep_research_select_sources_entries()
        entries[0]['message']['content'].append({
            'type': 'tool_use',
            'id': 'select-sources-bash',
            'name': 'Bash',
            'input': {'command': 'pwd'},
        })
        write_select_sources_worker(subagents, entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['select-sources']['complete'] is False
        assert evidence['select-sources']['violating_logical_indexes'] == ['1']

        write_select_sources_worker(
            subagents,
            description='deep-research: select-sources retry 1/1',
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['select-sources']['complete'] is False

        write_select_sources_worker(subagents)
        write_transcript(
            subagents / 'agent-fetch-15.jsonl',
            deep_research_entries('fetch', 15),
        )
        write_transcript(
            subagents / 'agent-fetch-2.jsonl',
            deep_research_entries(
                'fetch', 2,
                fetch_url='https://example.test/source-1',
                selected_url='https://example.test/source-1',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['selected_sources_match'] is False

        write_transcript(
            subagents / 'agent-fetch-2.jsonl',
            deep_research_entries('fetch', 2),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['select-sources']['complete'] is True
        assert evidence['fetch']['selected_sources_match'] is True

        duplicate_path = subagents / 'agent-search-1.jsonl'
        with duplicate_path.open('a') as stream:
            stream.write(json.dumps({
                'type': 'assistant',
                'message': {
                    'role': 'assistant',
                    'content': [{
                        'type': 'tool_use',
                        'id': 'search-1-duplicate',
                        'name': 'WebSearch',
                        'input': {},
                    }],
                },
            }) + '\n')
            stream.write(json.dumps({
                'type': 'user',
                'message': {
                    'role': 'user',
                    'content': [{
                        'type': 'tool_result',
                        'tool_use_id': 'search-1-duplicate',
                        'is_error': True,
                        'content': 'failed',
                    }],
                },
            }) + '\n')
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['search']['complete'] is False
        assert evidence['search']['logical_worker_tool_counts']['1'] == {
            'tool_uses': 2,
            'tool_use_occurrences': 2,
            'successful_results': 1,
            'failed_results': 1,
            'invalid_results': 0,
        }

        fetch_failure_path = subagents / 'agent-fetch-1.jsonl'
        fetch_failure_path.write_text('')
        write_transcript(
            fetch_failure_path,
            deep_research_entries(
                'fetch', 1,
                error='Request failed with status code 403',
                tool_id='fetch-1-failed',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is True
        assert evidence['fetch']['external_failure_logical_indexes'] == ['1']
        assert evidence['fetch']['non_external_failure_logical_indexes'] == []
        assert '1' not in evidence['fetch']['successful_logical_indexes']
        assert evidence['fetch']['attempts']['1'][0]['failed_result_messages'] == {
            'fetch-1-failed': ['Request failed with status code 403'],
        }

        write_transcript(
            fetch_failure_path,
            deep_research_entries(
                'fetch', 1,
                error='Request failed with status code 403',
                tool_id='fetch-1-invalid-output',
                source_quality='primary',
                claims=[{'claim': 'unsupported'}],
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['external_failure_logical_indexes'] == []
        assert evidence['fetch']['failed_output_mismatch_logical_indexes'] == ['1']

        write_transcript(
            fetch_failure_path,
            deep_research_entries(
                'fetch', 1,
                error='Permission denied by policy',
                tool_id='fetch-1-denied',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['external_failure_logical_indexes'] == []
        assert evidence['fetch']['non_external_failure_logical_indexes'] == ['1']

        write_transcript(
            fetch_failure_path,
            deep_research_entries(
                'fetch', 1,
                error='WebFetch crashed unexpectedly',
                tool_id='fetch-1-denied',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['external_failure_logical_indexes'] == []
        assert evidence['fetch']['non_external_failure_logical_indexes'] == ['1']

        write_transcript(
            fetch_failure_path,
            deep_research_entries(
                'fetch', 1,
                error='Request failed with status code 403',
                tool_id='fetch-1-failed',
            ),
        )
        retry_stem = 'agent-fetch-2-retry'
        (subagents / f'{retry_stem}.meta.json').write_text(json.dumps({
            'agentId': retry_stem,
            'description': 'deep-research: fetch 2/15 retry 1/1',
        }))
        write_transcript(subagents / f'{retry_stem}.jsonl', [])
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['logical_worker_attempt_counts']['2'] == 2
        assert evidence['fetch']['retry_logical_indexes'] == ['2']
        assert '2' not in evidence['fetch']['exact_once_logical_indexes']

    with tempfile.TemporaryDirectory(prefix='release-driver-test-') as root_string:
        run_dir = Path(root_string)
        subagents = run_dir / 'config/projects/project/subagents'
        gate = object.__new__(module.BinaryGate)

        def write_complete_workers():
            for phase, count in (('search', 5), ('fetch', 15)):
                for index in range(1, count + 1):
                    stem = f'agent-{phase}-{index}'
                    (subagents / f'{stem}.meta.json').parent.mkdir(
                        parents=True, exist_ok=True
                    )
                    (subagents / f'{stem}.meta.json').write_text(json.dumps({
                        'agentId': stem,
                        'description': f'deep-research: {phase} {index}/{count}',
                    }))
                    write_transcript(
                        subagents / f'{stem}.jsonl',
                        deep_research_entries(phase, index),
                    )

        write_complete_workers()
        write_select_sources_worker(subagents)
        retry_meta = subagents / 'agent-fetch-1.meta.json'
        retry_meta.write_text(json.dumps({
            'agentId': 'agent-fetch-1',
            'description': 'deep-research: fetch 1/15 retry 1/1',
        }))
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['retry_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        duplicate_use_path = subagents / 'agent-fetch-1.jsonl'
        entries = deep_research_entries('fetch', 1)
        entries[1]['message']['content'].append(
            entries[1]['message']['content'][0].copy()
        )
        write_transcript(duplicate_use_path, entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['logical_worker_tool_counts']['1'][
            'tool_use_occurrences'
        ] == 2

        write_complete_workers()
        write_select_sources_worker(subagents)
        duplicate_result_path = subagents / 'agent-fetch-1.jsonl'
        entries = deep_research_entries('fetch', 1)
        entries[2]['message']['content'].append({
            'type': 'tool_result',
            'tool_use_id': 'fetch-1-tool',
            'is_error': True,
            'content': 'Request failed with status code 403',
        })
        write_transcript(duplicate_result_path, entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['logical_worker_tool_counts']['1'][
            'invalid_results'
        ] == 1

        write_complete_workers()
        write_select_sources_worker(subagents)
        write_transcript(
            subagents / 'agent-fetch-1.jsonl',
            deep_research_entries(
                'fetch', 1,
                error='HTTP status 500 internal server error',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['external_failure_logical_indexes'] == []
        assert evidence['fetch']['non_external_failure_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        write_transcript(
            subagents / 'agent-fetch-1.jsonl',
            deep_research_entries(
                'fetch', 1,
                error='Permission denied by policy; HTTP status 403',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['external_failure_logical_indexes'] == []
        assert evidence['fetch']['non_external_failure_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        write_transcript(
            subagents / 'agent-fetch-1.jsonl',
            deep_research_entries(
                'fetch', 1,
                fetch_url='https://example.test/source-2',
                selected_url='https://example.test/source-1',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['source_mismatch_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        write_transcript(
            subagents / 'agent-fetch-1.jsonl',
            deep_research_entries(
                'fetch', 1,
                fetch_url='https://example.test/source?id=2',
                selected_url='https://example.test/source?id=1',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['source_mismatch_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        write_transcript(
            subagents / 'agent-fetch-1.jsonl',
            deep_research_entries(
                'fetch', 1,
                fetch_url='http://example.test/source-1',
                selected_url='https://example.test/source-1',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['source_mismatch_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        write_transcript(
            subagents / 'agent-fetch-1.jsonl',
            deep_research_entries(
                'fetch', 1,
                fetch_url='https://example.test/source-1/',
                selected_url='https://example.test/source-1',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['source_mismatch_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        write_transcript(
            subagents / 'agent-fetch-2.jsonl',
            deep_research_entries(
                'fetch', 2,
                fetch_url='https://example.test/source-1',
                selected_url='https://example.test/source-1',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['duplicate_source_logical_indexes'] == ['1', '2']

        write_complete_workers()
        write_select_sources_worker(subagents)
        entries = deep_research_entries('fetch', 1)
        output = json.loads(entries[-1]['message']['content'][0]['text'])
        output['fetchedSource'] = output.pop('selectedSource')
        entries[-1]['message']['content'][0]['text'] = json.dumps(output)
        write_transcript(subagents / 'agent-fetch-1.jsonl', entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['source_mismatch_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        entries = deep_research_entries('fetch', 1)
        output = json.loads(entries[-1]['message']['content'][0]['text'])
        output['selectedSource']['rank'] = output['selectedSource'].pop('oneBasedRank')
        entries[-1]['message']['content'][0]['text'] = json.dumps(output)
        write_transcript(subagents / 'agent-fetch-1.jsonl', entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['source_mismatch_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        entries = deep_research_entries('fetch', 1)
        entries.append(entries[-1].copy())
        write_transcript(subagents / 'agent-fetch-1.jsonl', entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['source_mismatch_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        entries = deep_research_entries('fetch', 1)
        entries[1]['message']['content'].append({
            'type': 'tool_use',
            'id': 'fetch-1-bash',
            'name': 'Bash',
            'input': {'command': 'pwd'},
        })
        write_transcript(subagents / 'agent-fetch-1.jsonl', entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['unexpected_tool_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        entries = deep_research_entries('fetch', 1)
        entries[1]['message']['content'].append({
            'type': 'tool_use',
            'id': 'fetch-1-discovery',
            'name': 'ToolSearch',
            'input': {'query': 'select:WebFetch', 'max_results': 1},
        })
        entries[2]['message']['content'].append({
            'type': 'tool_result',
            'tool_use_id': 'fetch-1-discovery',
            'content': 'loaded',
        })
        write_transcript(subagents / 'agent-fetch-1.jsonl', entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is True
        assert evidence['fetch']['unexpected_tool_logical_indexes'] == []

        write_complete_workers()
        write_select_sources_worker(subagents)
        entries = deep_research_entries('fetch', 1)
        entries[1]['message']['content'].append({
            'type': 'tool_use',
            'id': 'fetch-1-discovery',
            'name': 'ToolSearch',
            'input': {'query': 'WebFetch'},
        })
        entries[2]['message']['content'].append({
            'type': 'tool_result',
            'tool_use_id': 'fetch-1-discovery',
            'content': 'loaded',
        })
        write_transcript(subagents / 'agent-fetch-1.jsonl', entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['unexpected_tool_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        entries = deep_research_entries('fetch', 1)
        for suffix in ('a', 'b'):
            entries[1]['message']['content'].append({
                'type': 'tool_use',
                'id': f'fetch-1-discovery-{suffix}',
                'name': 'ToolSearch',
                'input': {'query': 'select:WebFetch', 'max_results': 1},
            })
            entries[2]['message']['content'].append({
                'type': 'tool_result',
                'tool_use_id': f'fetch-1-discovery-{suffix}',
                'content': 'loaded',
            })
        write_transcript(subagents / 'agent-fetch-1.jsonl', entries)
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['unexpected_tool_logical_indexes'] == ['1']

        write_complete_workers()
        write_select_sources_worker(subagents)
        write_transcript(
            subagents / 'agent-fetch-1.jsonl',
            deep_research_entries(
                'fetch', 1,
                error='timeout of 60000ms exceeded',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is True
        assert evidence['fetch']['external_failure_logical_indexes'] == ['1']
        assert evidence['fetch']['non_external_failure_logical_indexes'] == []

        write_complete_workers()
        write_select_sources_worker(subagents)
        write_transcript(
            subagents / 'agent-fetch-1.jsonl',
            deep_research_entries(
                'fetch', 1,
                error='network error while contacting the model gateway',
            ),
        )
        evidence = module.BinaryGate.deep_research_phase_evidence(gate, run_dir)
        assert evidence['fetch']['complete'] is False
        assert evidence['fetch']['external_failure_logical_indexes'] == []
        assert evidence['fetch']['non_external_failure_logical_indexes'] == ['1']

    with tempfile.TemporaryDirectory(prefix='release-driver-test-') as root_string:
        root = Path(root_string)
        evidence = root / 'evidence'
        evidence.mkdir()
        home = root / 'auth-home'
        home.mkdir()
        (home / 'auth.json').write_text('secret\n')
        gate = object.__new__(module.BinaryGate)
        gate.evidence_root = evidence
        gate.active_runs = {}
        gate.mock_servers = {}
        gate.auth_homes = {home}
        gate.cleanup_started = False
        try:
            module.BinaryGate.handle_signal(gate, signal.SIGTERM, None)
        except SystemExit as error:
            assert error.code == 128 + signal.SIGTERM
        else:
            raise AssertionError('signal handler did not terminate')
        assert not home.exists()
        cleanup = json.loads((evidence / 'signal-cleanup.json').read_text())
        assert cleanup['signal'] == 'SIGTERM'
        assert cleanup['auth_homes']['errors'] == []

    with tempfile.TemporaryDirectory(prefix='release-driver-lease-') as root_string:
        root = Path(root_string)
        repo = root / 'repo'
        repo.mkdir()
        alias = root / 'repo-alias'
        alias.symlink_to(repo, target_is_directory=True)
        lease_a = object.__new__(module.BinaryGate)
        lease_a.repo = repo.resolve()
        lease_a.binary = repo / 'built-claude'
        lease_a.evidence_root = root / 'evidence-a'
        lease_a.pid = 101
        lease_a.manifest = {}
        lease_a.lease_file = lease_a.lease_path = lease_a.lease_metadata = None
        module.BinaryGate.acquire_lease(lease_a)
        assert lease_a.lease_metadata['repo'] == str(repo.resolve())
        assert lease_a.lease_metadata['binary'] == str(repo / 'built-claude')
        lease_b = object.__new__(module.BinaryGate)
        lease_b.repo = alias.resolve()
        lease_b.binary = repo / 'built-claude'
        lease_b.evidence_root = root / 'evidence-b'
        lease_b.pid = 102
        lease_b.manifest = {}
        lease_b.lease_file = lease_b.lease_path = lease_b.lease_metadata = None
        try:
            module.BinaryGate.acquire_lease(lease_b)
        except RuntimeError as error:
            assert str(repo.resolve()) in str(error)
        else:
            raise AssertionError('equivalent repo realpaths must conflict')
        assert module.BinaryGate.release_lease(lease_a)['released'] is True
        module.BinaryGate.acquire_lease(lease_b)
        assert module.BinaryGate.release_lease(lease_b)['released'] is True

    assert module.required_targets_for_paths([
        'src/commands/goal.ts',
        'src/tools/AgentTool/agentToolUtils.ts',
        'src/tools/WorkflowTool/bundled/index.ts',
    ]) == {
        'goal-lifecycle',
        'agent-fg-bg',
        'workflow',
        'code-review',
    }
    assert module.required_targets_for_paths([
        'src/tools/AgentTool/runAgent.ts',
    ]) == {
        'agent-fg-bg',
        'subagent-stop-failure-lifecycle',
    }
    assert module.required_targets_for_paths([
        'src/state/AppStateStore.ts',
    ]) == set()
    assert module.required_targets_for_paths([
        'src/tools/WorkflowTool/bundled/index.ts',
    ]) == {'workflow', 'code-review'}
    assert module.required_targets_for_paths([
        'src/tools/WorkflowTool/workflowOrchestrator.ts',
    ]) == {
        'workflow-retry-partial-failure',
        'workflow-failure-detail',
    }
    assert module.required_targets_for_paths([
        'src/services/api/openai-compat.ts',
    ]) == {
        'deferred-tool-discovery',
        'effort-openai-responses-wire',
        'fast-openai-responses-wire',
        'openai-image-input-wire',
        'openai-remote-compaction',
        'openai-responses-usage-error',
        'model-discovery-picker',
        'prompt-modes-cache-prefix',
    }
    assert module.required_targets_for_paths([
        'src/commands/fast/fast.tsx',
        'src/utils/fastMode.ts',
    ]) == {'fast-openai-responses-wire'}
    assert module.required_targets_for_paths([
        'src/commands/compact/compact.ts',
        'src/services/compact/codexCompact.ts',
    ]) == {'openai-remote-compaction'}
    assert module.required_targets_for_paths([
        '.github/workflows/release.yml',
        'scripts/build.mjs',
        'scripts/package-binary.mjs',
        'scripts/verify-bundled-image-runtime.mjs',
        'scripts/shims/embedded-ripgrep.js',
        'scripts/shims/embedded-sharp.js',
        'scripts/shims/image-processor-napi.js',
        'scripts/shims/sharp-native.cjs',
        'src/tools/FileReadTool/imageProcessor.ts',
        'src/utils/imageResizer.ts',
    ]) == {'openai-image-input-wire'}
    assert module.required_targets_for_paths([
        'src/hooks/useSSHSession.ts',
        'src/hooks/useRemoteSession.ts',
        'src/ssh/remoteHistoryReplay.ts',
        'src/screens/REPL.tsx',
        'src/entrypoints/sdk/controlSchemas.ts',
    ]) == {
        'effort-openai-responses-wire',
        'ssh-remote-session-lifecycle',
    }
    assert module.required_targets_for_paths([
        'src/ssh/createSSHSession.ts',
    ]) == {'ssh-remote-session-lifecycle'}

    with tempfile.TemporaryDirectory(prefix='release-driver-ssh-fixture-') as root_string:
        root = Path(root_string)
        run_dir = root / 'run'
        run_dir.mkdir()
        gate = object.__new__(module.BinaryGate)
        gate.baseline = {'makefile_version': '9.8.7'}
        fixture = module.BinaryGate.make_ssh_transport_fixture(gate, run_dir)
        executable = Path(fixture['bin_dir']) / 'ssh'
        assert executable.is_file()
        assert executable.stat().st_mode & 0o111
        assert "print('9.8.7')" in executable.read_text()
        assert fixture['session_id'] == 'release-ssh-session-0001'
        assert fixture['task_id'] == 'release-ssh-task-0001'
        assert fixture['tool_use_id'] == 'release-ssh-tool-0001'
        assert fixture['permission_request_id'] == 'release-ssh-permission-0001'
        assert fixture['io_path'] == str(run_dir / 'fake-ssh-io.jsonl')
        probe = subprocess.run(
            [
                str(executable),
                '-o',
                'ControlMaster=auto',
                '--',
                'release-ssh-host',
                'set -eu; printf "%s\\n" "$(uname -s)" "$(uname -m)" "$HOME" "$PWD"',
            ],
            env={'CC_VALIDATION_SSH_IO': fixture['io_path']},
            capture_output=True,
            text=True,
            check=False,
        )
        assert probe.returncode == 0, probe.stderr
        assert probe.stdout == 'Linux\nx86_64\n/release-home\n/release-work\n'
        events = [json.loads(line) for line in Path(fixture['io_path']).read_text().splitlines()]
        assert [event['event'] for event in events] == ['ssh-invocation']
        assert events[0]['args'][-2:] == [
            'release-ssh-host',
            'set -eu; printf "%s\\n" "$(uname -s)" "$(uname -m)" "$HOME" "$PWD"',
        ]

        lifecycle = subprocess.Popen(
            [
                str(executable), '--', 'release-ssh-host',
                'set -eu; trap cleanup EXIT; claude --input-format stream-json --output-format stream-json',
            ],
            env={'CC_VALIDATION_SSH_IO': fixture['io_path']},
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        assert lifecycle.stdin is not None
        for message in (
            {
                'type': 'control_request',
                'request_id': 'history-request',
                'request': {'subtype': 'replay_history'},
            },
            {'type': 'user'},
            {
                'type': 'control_response',
                'response': {
                    'request_id': 'release-ssh-permission-0001',
                    'response': {
                        'behavior': 'allow',
                        'updatedInput': {'command': 'pwd'},
                    },
                },
            },
        ):
            lifecycle.stdin.write(json.dumps(message) + '\n')
        lifecycle.stdin.flush()
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if Path(fixture['io_path']).exists() and 'task-result' in Path(
                fixture['io_path']
            ).read_text():
                break
            time.sleep(0.01)
        else:
            raise AssertionError('fake SSH lifecycle did not reach task result')
        try:
            assert lifecycle.wait(timeout=2) == 0
        finally:
            if lifecycle.poll() is None:
                lifecycle.kill()
                lifecycle.wait(timeout=2)
            lifecycle.stdin.close()
        lifecycle_events = [
            json.loads(line)
            for line in Path(fixture['io_path']).read_text().splitlines()
        ]
        assert lifecycle_events[-1]['event'] == 'remote-process-exit'

    assert module.BinaryGate.ssh_lifecycle_evidence({
        'session_id': 'release-ssh-session-0001',
        'task_id': 'release-ssh-task-0001',
        'tool_use_id': 'release-ssh-tool-0001',
        'permission_request_id': 'release-ssh-permission-0001',
        'events': [
            {'event': 'remote-process-start'},
            {'event': 'history-bootstrap-request'},
            {'event': 'goal-bootstrap', 'goal_id': 'release-ssh-goal-0001'},
            {'event': 'history-bootstrap-response'},
            {'event': 'task-start', 'task_id': 'release-ssh-task-0001'},
            {'event': 'tool-use', 'tool_use_id': 'release-ssh-tool-0001'},
            {
                'event': 'permission-response',
                'request_id': 'release-ssh-permission-0001',
                'behavior': 'allow',
                'tool_use_id': 'release-ssh-tool-0001',
            },
            {'event': 'task-stopped', 'task_id': 'release-ssh-task-0001'},
            {'event': 'task-result', 'task_id': 'release-ssh-task-0001'},
            {'event': 'remote-process-exit'},
            {'event': 'cleanup-command'},
            {'event': 'control-master-stop'},
        ],
    })['passed'] is True
    incomplete_ssh_evidence = module.BinaryGate.ssh_lifecycle_evidence({
        'session_id': 'release-ssh-session-0001',
        'task_id': 'release-ssh-task-0001',
        'tool_use_id': 'release-ssh-tool-0001',
        'permission_request_id': 'release-ssh-permission-0001',
        'events': [{'event': 'remote-process-start'}],
    })
    assert incomplete_ssh_evidence['passed'] is False
    assert 'task-start' in incomplete_ssh_evidence['missing_events']

    complete_events = [
        {'event': 'remote-process-start'},
        {'event': 'history-bootstrap-request'},
        {'event': 'goal-bootstrap', 'goal_id': 'release-ssh-goal-0001'},
        {'event': 'history-bootstrap-response'},
        {'event': 'task-start', 'task_id': 'release-ssh-task-0001'},
        {'event': 'tool-use', 'tool_use_id': 'release-ssh-tool-0001'},
        {
            'event': 'permission-response',
            'request_id': 'release-ssh-permission-0001',
            'behavior': 'allow',
            'tool_use_id': 'release-ssh-tool-0001',
        },
        {'event': 'task-stopped', 'task_id': 'release-ssh-task-0001'},
        {'event': 'task-result', 'task_id': 'release-ssh-task-0001'},
        {'event': 'remote-process-exit'},
        {'event': 'cleanup-command'},
        {'event': 'control-master-stop'},
    ]
    assert module.BinaryGate.ssh_lifecycle_evidence({
        **module.SSH_LIFECYCLE_IDS,
        'events': complete_events[:-2],
    }, require_cleanup=False)['passed'] is True
    assert module.BinaryGate.ssh_lifecycle_evidence({
        **module.SSH_LIFECYCLE_IDS,
        'events': complete_events,
    }, require_cleanup=False)['passed'] is False
    for mutation in (
        lambda events: events.__setitem__(4, {
            'event': 'task-start', 'task_id': 'wrong-task',
        }),
        lambda events: events.__setitem__(5, {
            'event': 'tool-use', 'tool_use_id': 'wrong-tool',
        }),
        lambda events: events.__setitem__(6, {
            'event': 'permission-response',
            'request_id': 'wrong-request',
            'behavior': 'deny',
            'tool_use_id': 'wrong-tool',
        }),
        lambda events: events.insert(5, dict(events[4])),
        lambda events: events.__setitem__(7, events.pop(8)),
    ):
        events = [dict(event) for event in complete_events]
        mutation(events)
        assert module.BinaryGate.ssh_lifecycle_evidence({
            **module.SSH_LIFECYCLE_IDS,
            'events': events,
        })['passed'] is False
    required = module.required_targets_for_paths([
        'src/utils/effort.ts',
        'src/services/api/bootstrap.ts',
        'src/utils/model/modelOptions.ts',
        'src/utils/model/openaiModelOptions.ts',
        'src/skills/bundled/updateConfig.ts',
        'src/utils/promptLayers.ts',
        'src/utils/swarm/teamHelpers.ts',
        'src/tools/WorkflowTool/workflowScriptRuntime.ts',
        'src/components/PromptInput/PromptInput.tsx',
        'src/utils/swarm/inProcessRunner.ts',
    ])
    assert required == {
        'effort-openai-responses-wire',
        'model-discovery-picker',
        'model-discovery-empty-picker',
        'first-party-bootstrap-picker',
        'model-internal-update-config-skill',
        'prompt-modes-cache-prefix',
        'team-concurrency',
        'workflow-retry-partial-failure',
        'coordinator-selector',
        'transcript-retention',
    }

    with tempfile.TemporaryDirectory(prefix='release-driver-mock-cleanup-') as root_string:
        root = Path(root_string)
        repo = root / 'repo'
        evidence = root / 'evidence'
        auth_source = root / 'auth-source.json'
        repo.mkdir()
        evidence.mkdir()
        auth_source.write_text('{}\n')
        gate = object.__new__(module.BinaryGate)
        gate.repo = repo
        gate.evidence_root = evidence
        gate.auth_source = auth_source
        gate.auth_homes = set()
        gate.active_runs = {}
        gate.mock_servers = {}
        gate.session_index = 0
        gate.stamp = 'collision-test'
        gate.pid = 123
        gate.make_fixture = lambda run_dir, label: (
            run_dir / 'config',
            run_dir / 'home',
        )
        gate.tmux = lambda *args, **kwargs: module.subprocess.CompletedProcess(
            args, 0, '', ''
        )
        with patch.object(module.MockOpenAIServer, 'start') as mock_start:
            try:
                gate.start('effort-openai-responses-wire')
            except RuntimeError as error:
                assert 'tmux session collision' in str(error)
            else:
                raise AssertionError('collision did not abort startup')
            mock_start.assert_not_called()
        assert gate.mock_servers == {}

        orphan_dir = evidence / 'runs' / 'orphan-mock'
        orphan_dir.mkdir(parents=True)
        orphan = module.MockOpenAIServer(
            orphan_dir,
            'effort-openai-responses-wire',
        )
        orphan.start()
        gate.mock_servers['orphan-mock'] = orphan
        cleanup = gate.close_active_runs()
        assert cleanup == [{
            'session': None,
            'evidence_dir': str(evidence / 'runs' / 'orphan-mock'),
            'kill_exit': 0,
            'pane_pid': '',
            'process_remaining': False,
            'remaining_processes': [],
            'forced_termination': [],
            'mock_server': {'stopped': True, 'thread_alive': False},
        }]
        assert gate.mock_servers == {}

    with tempfile.TemporaryDirectory(prefix='release-retention-gc-verdict-') as root_string:
        server = module.MockOpenAIServer(Path(root_string), 'transcript-retention')
        gate = object.__new__(module.BinaryGate)
        def probe_request(phase, task, output):
            return {'body': {'input': [
                {'type': 'function_call', 'call_id': f'fc_retention_probe_{phase}',
                 'name': 'TaskOutput', 'arguments': json.dumps({'task_id': task, 'block': False})},
                {'type': 'function_call_output', 'call_id': f'fc_retention_probe_{phase}', 'output': output},
            ]}}
        before = '<task_id>task-real</task_id>\n<task_type>in_process_teammate</task_type>\n<status>completed</status>'
        server.requests = [{'method': 'GET', 'path': '/v1/models', 'body': None}]
        assert not gate.retention_probe_result(server, 'task-real', 'before')
        server.requests.append(probe_request('before', 'task-real', before))
        assert gate.retention_probe_result(server, 'task-real', 'before')
        assert not gate.retention_probe_result(server, 'wrong-task', 'before')
        assert not gate.retention_probe_result(server, 'task-real', 'after')
        missing = '<tool_use_error>No task found with ID: task-real</tool_use_error>'
        server.requests.append(probe_request('after', 'task-real', missing))
        assert gate.retention_probe_result(server, 'task-real', 'after')
        server.requests[-1]['body']['input'][-1]['output'] = missing + '\n<system-reminder>Reminder</system-reminder>'
        assert gate.retention_probe_result(server, 'task-real', 'after')
        for invalid in ('No task found with ID: task-real',
                        '<system-reminder>' + missing + '</system-reminder>',
                        '<tool_use_error>No task found with ID: other-task</tool_use_error>'):
            server.requests[-1]['body']['input'][-1]['output'] = invalid
            assert not gate.retention_probe_result(server, 'task-real', 'after')
        server.requests[-1]['body']['input'][-1]['output'] = before
        assert not gate.retention_probe_result(server, 'task-real', 'after')
        server.requests[-1]['body']['input'][-1]['output'] = 'No task found with ID: other-task'
        assert not gate.retention_probe_result(server, 'task-real', 'after')
        server.requests[-1]['body']['input'][-1]['type'] = 'message'
        server.requests[-1]['body']['input'][-1]['output'] = 'No task found with ID: task-real'
        assert not gate.retention_probe_result(server, 'task-real', 'after')

    for wait_timeout in (False, True):
        with tempfile.TemporaryDirectory(prefix='release-retention-gc-clock-') as root_string:
            run_dir = Path(root_string)
            gate = object.__new__(module.BinaryGate)
            clock = [105.0]
            sent = []
            gate.send = lambda target, directory, text, filename: sent.append((text, clock[0]))
            gate.retention_probe_result = lambda *args: True
            gate.capture = lambda *args, **kwargs: (
                'RELEASE_RETENTION_PROBE_BEFORE_DONE RELEASE_RETENTION_GC_TICK_DONE '
                'RELEASE_RETENTION_PROBE_AFTER_DONE')
            def wait_until(predicate, timeout, interval):
                if predicate():
                    return True
                if wait_timeout:
                    return False
                while clock[0] < 140:
                    clock[0] += interval
                    if predicate():
                        return True
                return False
            gate.wait_until = wait_until
            # Escape sent at 100, but its state transition was only observed at 105.
            with patch.object(module.time, 'monotonic', side_effect=lambda: clock[0]):
                passed = gate.retention_gc(run_dir, 'pane', None, 'task-real', 130, 135)
            assert passed is not wait_timeout
            ticks = [stamp for text, stamp in sent if text == 'RELEASE_RETENTION_GC_TICK']
            assert ticks == ([] if wait_timeout else [137.0])
            evidence = json.loads((run_dir / 'gc-evidence.json').read_text())
            assert evidence['before_observed'] < 130
            assert evidence['passed'] is not wait_timeout

    for scenario in ('pass', 'wrong-agent', 'stale', 'exited', 'terminal', 'no-resume',
                     'missing-interruption', 'wrong-view'):
        with tempfile.TemporaryDirectory(prefix='release-retention-abort-verdict-') as root_string:
            run_dir = Path(root_string)
            gate = object.__new__(module.BinaryGate)
            server = module.MockOpenAIServer(run_dir, 'transcript-retention')
            server.retention_child_waiting.set()
            agent = 'other@test' if scenario == 'wrong-agent' else 'retention-worker@test'
            markers = (f'[inProcessRunner] {agent} current work aborted (Escape pressed)\n'
                       f'[inProcessRunner] {agent} work interrupted, returning to idle\n')
            log = ['[spawnInProcessTeammate] Spawning retention-worker@test (taskId: task-real)\n']
            if scenario == 'stale':
                log.append(markers)
            gate.debug = lambda *args: ''.join(log)
            def press(*args, **kwargs):
                if scenario != 'stale':
                    log.append(markers)
                if scenario == 'exited':
                    log.append('[viewed_agent_changed] before=task-real after=main\n')
                if scenario == 'terminal':
                    log.append('[transcript_retention_decision] task=task-real status=completed\n')
            gate.tmux = press
            gate.wait_until = lambda predicate, *args: bool(predicate())
            pane = ('Viewing @other-worker' if scenario == 'wrong-view'
                    else 'Viewing @retention-worker')
            if scenario != 'missing-interruption':
                pane += '\nInterrupted · What should Claude do instead?'
            pane += '\nRELEASE_RETENTION_WORKER_DONE'
            gate.capture = lambda *args, **kwargs: pane
            gate.assistant_text = lambda *args, **kwargs: 'RELEASE_RETENTION_WORKER_DONE'
            def send(*args):
                assert server.retention_child_release.is_set()
                if scenario != 'no-resume':
                    server.requests.append({'response_kind': 'retention-worker-marker'})
            gate.send = send
            assert gate.retention_active_abort(run_dir, 'pane', server, 'task-real') == (scenario == 'pass')
            if scenario in ('wrong-agent', 'stale'):
                assert not server.retention_child_release.is_set()
            server.stop()

    for scenario in ('pass', 'late', 'polluted', 'disabled-rewind'):
        with tempfile.TemporaryDirectory(prefix='release-retention-escape-window-') as root_string:
            run_dir = Path(root_string)
            gate = object.__new__(module.BinaryGate)
            clock = [10.9 if scenario == 'late' else 10.1]
            presses = []
            gate.tmux = lambda *args, **kwargs: presses.append((args[-1], clock[0]))
            def capture(target, path, **kwargs):
                text = 'Rewind' if (
                    scenario == 'polluted' or
                    (scenario != 'disabled-rewind' and len(presses) == 3)
                ) else '❯ '
                path.write_text(text)
                return text
            gate.capture = capture
            def wait_until(predicate, timeout, interval):
                deadline = clock[0] + timeout
                while clock[0] <= deadline:
                    if predicate():
                        return True
                    clock[0] += interval
                return False
            gate.wait_until = wait_until
            with patch.object(module.time, 'monotonic', side_effect=lambda: clock[0]):
                passed = gate.retention_escape_window(run_dir, 'pane', 'task-real', 10.0)
            assert passed == (scenario == 'pass'), scenario
            evidence = json.loads((run_dir / 'escape-window-evidence.json').read_text())
            assert evidence['passed'] == passed
            if scenario == 'pass':
                assert 0 <= presses[0][1] - 10.0 < 0.8
                assert presses[1][1] - presses[0][1] > 0.8
                assert presses[2][1] - presses[1][1] < 0.8
                assert presses[-1][0] == 'Escape'
                assert len(evidence['samples']) > 1
                assert clock[0] - presses[-1][1] >= 0.8
            elif scenario == 'late':
                assert not presses

    # Relevant visible rows from round8 shift-main.txt, with ANSI preserved.
    rewind_pane = (
        '\x1b[38;5;231m⏺\x1b[39m RELEASE_RETENTION_PARENT_OK\n'
        '\x1b[38;5;231m⏺\x1b[39m RELEASE_RETENTION_PARENT_OK\n'
        '\x1b[38;5;153m────────────────────────────────────────────────\n'
        '\x1b[39m \x1b[1m\x1b[38;5;153mRewind\x1b[0m\n\n'
        ' Restore the code and/or conversation to the point before…\n\n'
        '   Transcript retention binary validation. Use TeamCreate once\n\n'
        ' \x1b[1m\x1b[38;5;153m❯ \x1b[0;3m\x1b[38;5;153m(current)\x1b[0m\n\n'
        ' \x1b[3m\x1b[38;5;246mEnter to continue · Esc to exit\x1b[0m\n'
    )
    for scenario in ('no-active-abort', 'no-escape-window', 'no-gc', 'second-exit-rewind', 'parent-only', 'rewind-with-input',
                     'pass', 'team-only', 'wrong-task', 'no-reopen', 'no-marker',
                     'no-shift', 'no-spinner', 'no-tasks', 'stale-entry',
                     'duplicate-spawn', 'no-exit', 'no-selection',
                     'no-pills', 'input-only', 'stale-exit', 'wrong-exit-task',
                     'still-viewing', 'empty-main', 'unrelated-main',
                     'no-shift-transcript', 'no-spinner-transcript', 'no-tasks-transcript'):
        with tempfile.TemporaryDirectory(prefix='release-retention-handler-') as root_string:
            run_dir = Path(root_string)
            gate = object.__new__(module.BinaryGate)
            server = module.MockOpenAIServer(run_dir, 'transcript-retention')
            gate.mock_servers = {run_dir.name: server}
            log = ['team_mutation_commit\n']
            if scenario != 'team-only':
                log.append('[spawnInProcessTeammate] Spawning retention-worker@test (taskId: task-real)\n'
                           '[spawnInProcessTeammate] Registered retention-worker@test in AppState\n')
            recorded = []
            opens = []
            gate.start = lambda label: (run_dir, 'session', 'pane', True)
            gate.send = lambda *args: None
            def retention_debug(directory):
                if server.retention_release.is_set() and not any('transcript_retention_decision' in line for line in log):
                    log.append('[transcript_retention_decision] task=task-real status=completed retain=keep\n')
                return ''.join(log)

            gate.debug = retention_debug
            gate.wait_until = lambda predicate, *args: bool(predicate())
            gate.assistant_text = lambda *args, **kwargs: 'RELEASE_RETENTION_WORKER_DONE'
            gate.cleanup_passed = lambda cleanup: True
            gate.close = lambda *args: server.stop()
            gate.record = recorded.append
            gate.required_assertion = lambda *args, **kwargs: kwargs
            def retention_gc(*args):
                assert len(args) == 6
                assert args[-1] >= args[-2]
                return scenario != 'no-gc'
            gate.retention_gc = retention_gc
            gate.retention_escape_window = lambda *args: scenario != 'no-escape-window'
            gate.retention_active_abort = lambda *args: scenario != 'no-active-abort'

            ui = {'state': 'main', 'tree': False, 'index': -1, 'captures': 0}
            commands = []
            gate.send = lambda *args: ui.update(state='tasks') if args[2] == '/tasks' else None

            def retention_capture(target, path, **kwargs):
                ui['captures'] += 1
                state = ui['state']
                text = {
                    'main': '@main @retention-worker shift + ↓ expand',
                    'footer': '@main @retention-worker selected main',
                    'worker': '@main @retention-worker selected worker',
                    'selection': ('› ╒═ team-lead hide' if ui['index'] == -1 else
                                  '› ├─ retention-worker enter to view hide' if ui['index'] == 0 else
                                  '› ╘═ hide enter to collapse'),
                    'tasks': 'Background tasks › @team-lead @retention-worker',
                    'task-row': 'Background tasks › @retention-worker',
                    'detail': '@retention-worker Completed Prompt f to foreground go back',
                    'view': '@retention-worker RELEASE_RETENTION_WORKER_DONE',
                }[state]
                if scenario == 'no-marker' or (opens and scenario == f'no-{opens[-1]}-transcript'):
                    text = text.replace('RELEASE_RETENTION_WORKER_DONE', '')
                if state == 'main':
                    text += '\n⏺ RELEASE_RETENTION_PARENT_OK\n────────────────\n❯ \n────────────────'
                    if 'Escape' in commands:
                        text = {
                            'no-pills': '\x1b[32m⏺ RELEASE_RETENTION_PARENT_OK\x1b[0m\n────────────────\n❯ \n────────────────',
                            'input-only': '────────────────\n❯ \n────────────────',
                            'still-viewing': text + '\nViewing @retention-worker',
                            'empty-main': '',
                            'unrelated-main': 'No tasks available',
                            'parent-only': '⏺ RELEASE_RETENTION_PARENT_OK',
                            'rewind-with-input': text + '\n' + rewind_pane,
                        }.get(scenario, text)
                        if scenario == 'second-exit-rewind' and commands.count('Escape') >= 2:
                            text = rewind_pane
                path.write_text(text)
                return text

            def retention_tmux(*args, **kwargs):
                key = args[-1]
                commands.append(key)
                # Every navigation key must observe the previous UI before advancing.
                assert ui['captures'] > 0
                ui['captures'] = 0
                state = ui['state']
                if key == 'Down':
                    ui['state'] = 'task-row' if state == 'tasks' else 'footer'
                elif key == 'Right':
                    if scenario != 'no-selection':
                        ui['state'] = 'worker'
                elif key == 'S-Down':
                    ui['index'] = ui['index'] + 1 if ui['tree'] else -1
                    ui.update(tree=True, state='selection')
                elif key == 'S-Up':
                    ui.update(index=ui['index'] - 1, state='selection')
                elif key in ('Enter', 'f'):
                    if state == 'selection' and ui['index'] == 1:
                        ui.update(tree=False, index=-1, state='main')
                        return
                    if state == 'task-row':
                        ui['state'] = 'detail'
                        return
                    route = ('tasks' if state == 'detail' else 'spinner' if key == 'f'
                             else 'shift' if state == 'selection' else 'footer')
                    opens.append(route)
                    blocked = scenario == f'no-{route}' or (scenario == 'no-reopen' and len(opens) > 1)
                    if not blocked:
                        task = 'wrong' if scenario == 'wrong-task' else 'task-real'
                        if scenario == 'stale-exit':
                            log.append('[viewed_agent_changed] before=task-real after=main reason=exit\n')
                        if scenario != 'stale-entry' or len(opens) == 1:
                            log.append(f'[viewed_agent_changed] before=main after={task} type=in_process_teammate\n')
                        ui['state'] = 'view'
                        if scenario == 'duplicate-spawn' and len(opens) == 2:
                            log.append('[spawnInProcessTeammate] Spawning retention-worker@test (taskId: task-extra)\n')
                elif key == 'Escape' and scenario != 'no-exit':
                    if scenario != 'stale-exit':
                        task = 'wrong' if scenario == 'wrong-exit-task' else 'task-real'
                        log.append(f'[viewed_agent_changed] before={task} after=main reason=exit\n')
                    ui['state'] = 'main'
                return module.subprocess.CompletedProcess(args, 0, '', '')

            gate.capture = retention_capture
            gate.tmux = retention_tmux
            module.BinaryGate.transcript_retention(gate)
            assert recorded[0]['validation_verdict'] == ('passed' if scenario == 'pass' else 'failed'), scenario
            if scenario == 'no-gc':
                assert recorded[0]['assertions'][0]['passed']
            if scenario in ('no-pills', 'input-only'):
                assert recorded[0]['exited'], scenario
                assert recorded[0]['single_escape_exits'] == [True], scenario
                assert commands.count('Escape') == 1
                # Successful exit must not waive the required footer reentry.
                assert not recorded[0]['entry_paths']['footer']
                assert not recorded[0]['reopened']
            if scenario == 'second-exit-rewind':
                assert recorded[0]['single_escape_exits'] == [True, False], scenario
                assert commands.count('Escape') == 2
                assert opens == ['footer', 'footer']
                assert not any(key in ('S-Down', 'S-Up') for key in commands)
                assert recorded[0]['entry_paths'] == {
                    'footer': True, 'shift': False, 'spinner': False, 'tasks': False,
                }
                assert not (run_dir / 'shift-selection.txt').exists()
                assert log[-1] == '[viewed_agent_changed] before=task-real after=main reason=exit\n'
            if scenario in ('no-exit', 'stale-exit', 'wrong-exit-task',
                            'still-viewing', 'empty-main', 'unrelated-main',
                            'parent-only', 'rewind-with-input'):
                assert not recorded[0]['exited'], scenario
                assert recorded[0]['single_escape_exits'] == [False], scenario
                assert commands.count('Escape') == 1
            if scenario == 'team-only':
                assert not opens
            assert server.retention_stopped.is_set()
            if scenario == 'pass':
                assert opens == ['footer', 'footer', 'shift', 'spinner', 'tasks']
                assert commands.count('Escape') == 5
                assert all(recorded[0]['entry_paths'].values())
                assert len(recorded[0]['assertions']) == 9
            if scenario in ('no-shift', 'no-spinner', 'no-tasks'):
                assert not recorded[0]['entry_paths'][scenario[3:]]
                assert any(not assertion['passed'] for assertion in recorded[0]['assertions'])

    with tempfile.TemporaryDirectory(prefix='release-retention-active-turn-') as root_string:
        server = module.MockOpenAIServer(Path(root_string), 'transcript-retention')
        responses = []
        child_body = {'input': [{'role': 'user', 'content': 'RELEASE_RETENTION_CHILD_REQUEST'}]}
        worker = threading.Thread(target=lambda: responses.append(server.response_for(child_body)))
        try:
            assert hasattr(server, 'retention_child_waiting')
            worker.start()
            assert server.retention_child_waiting.wait(2)
            assert worker.is_alive()
            server.retention_child_release.set()
            worker.join(2)
            assert responses[0][0] == 'retention-child-cancelled'
            resumed = server.response_for({'input': child_body['input'] + [
                {'role': 'user', 'content': 'RELEASE_RETENTION_RESUME'}]})
            assert resumed[0] == 'retention-worker-marker'
            assert 'RELEASE_RETENTION_WORKER_DONE' in resumed[1]
        finally:
            server.stop()
            if worker.ident is not None:
                worker.join(2)

    assert 'transcript-retention' in module.MOCK_OPENAI_TARGETS
    with tempfile.TemporaryDirectory(prefix='release-driver-retention-') as root_string:
        run_dir = Path(root_string)
        server = module.MockOpenAIServer(run_dir, 'transcript-retention')
        base_url = server.start()

        def retention_request(items):
            request = Request(
                f'{base_url}/v1/responses',
                data=json.dumps({'input': items}).encode(),
                headers={'Content-Type': 'application/json',
                         'Authorization': f'Bearer {module.DUMMY_OPENAI_API_KEY}'},
            )
            with urlopen(request, timeout=5) as response:
                return response.read().decode()

        def retention_output(name):
            return {'type': 'function_call_output', 'call_id': f'fc_retention_{name}', 'output': 'ok'}

        parent = [{'role': 'user', 'content': 'Transcript retention binary validation.'}]
        child = [{'role': 'user', 'content': 'RELEASE_RETENTION_CHILD_REQUEST'},
                 {'role': 'user', 'content': 'RELEASE_RETENTION_RESUME'}]
        results = []
        try:
            team = retention_request(parent)
            assert '"name":"TeamCreate"' in team
            assert retention_request(parent + [{'type': 'function_call', 'arguments': 'RELEASE_RETENTION_CHILD_REQUEST'}]) == team
            agent = retention_request(parent + [retention_output('team')])
            assert '"name":"Agent"' in agent
            assert '\\"run_in_background\\":true' in agent
            assert 'retention-worker' in agent
            assert 'RELEASE_RETENTION_WORKER_DONE' in retention_request(child)
            assert server.response_for({'instructions': module.TITLE_GENERATION_INSTRUCTION})[0] == 'title'
            probe_input = parent + [retention_output('shutdown'), {
                'role': 'user', 'content': 'RELEASE_RETENTION_PROBE task-real before',
            }]
            probe = retention_request(probe_input)
            reminder = {'type': 'input_text', 'text': '<system-reminder>Reminder</system-reminder>'}
            for command, marker in [('RELEASE_RETENTION_PROBE task-real before', '"name":"TaskOutput"'),
                                    ('RELEASE_RETENTION_GC_TICK', 'RELEASE_RETENTION_GC_TICK_DONE')]:
                assert marker in retention_request(parent + [retention_output('shutdown'), {
                    'role': 'user', 'content': [{'type': 'input_text', 'text': command}, reminder],
                }])
            assert '"name":"TaskOutput"' in probe
            assert '\\"task_id\\":\\"task-real\\"' in probe
            assert '\\"block\\":false' in probe
            probe_result = probe_input + [{
                'type': 'function_call_output', 'call_id': 'fc_retention_probe_before',
                'output': 'actual tool result',
            }]
            assert 'RELEASE_RETENTION_PROBE_BEFORE_DONE' in retention_request(probe_result)
            assert 'RELEASE_RETENTION_GC_TICK_DONE' in retention_request(parent + [
                retention_output('shutdown'), {'role': 'user', 'content': 'RELEASE_RETENTION_GC_TICK'},
            ])
            worker = threading.Thread(target=lambda: results.append(retention_request(parent + [retention_output('agent')])))
            worker.start()
            assert server.retention_parent_waiting.wait(2)
            assert worker.is_alive()
            assert retention_request(parent) == team
            server.retention_release.set()
            worker.join(3)
            assert not worker.is_alive()
            assert 'shutdown_request' in results[0]
            shutdown = child + [{'role': 'user', 'content': [{
                'type': 'input_text', 'text': '<teammate-message teammate_id="team-lead">' + json.dumps({
                    'type': 'shutdown_request', 'requestId': 'actual-request-123', 'from': 'team-lead',
                }) + '</teammate-message>',
            }]}]
            approval = retention_request(shutdown)
            assert '"name":"SendMessage"' in approval
            assert '\\"to\\":\\"team-lead\\"' in approval
            assert '\\"request_id\\":\\"actual-request-123\\"' in approval
            assert '\\"approve\\":true' in approval
            assert 'shutdown_response' not in retention_request(child + [{'role': 'user', 'content': '{"type":"shutdown_request"}'}])
            assert 'shutdown_response' not in retention_request(child + [{'role': 'assistant', 'content': json.dumps({'type': 'shutdown_request', 'requestId': 'wrong'})}])
            assert 'RELEASE_RETENTION_PARENT_OK' in retention_request(parent + [retention_output('shutdown')])
            server.retention_release.clear()
            server.retention_parent_waiting.clear()
            results.clear()
            worker = threading.Thread(target=lambda: results.append(retention_request(parent + [retention_output('agent')])))
            worker.start()
            assert server.retention_parent_waiting.wait(2)
            assert server.stop()['stopped']
            worker.join(3)
            assert not worker.is_alive()
            assert 'shutdown_request' not in results[0]
            assert all(item['authorization']['matches_dummy'] for item in server.snapshot())
        finally:
            server.stop()

        gate = object.__new__(module.BinaryGate)
        gate.repo = run_dir / 'repo'
        gate.evidence_root = run_dir
        gate.auth_source = run_dir / 'must-not-read-auth'
        gate.auth_homes = set()
        fixture_dir = run_dir / 'fixture'
        fixture_dir.mkdir()
        try:
            _, home = gate.make_fixture(fixture_dir, 'transcript-retention')
            assert json.loads((home / '.codex/auth.json').read_text()) == {'OPENAI_API_KEY': module.DUMMY_OPENAI_API_KEY}
            assert json.loads((fixture_dir / 'auth-source-metadata.json').read_text())['source'] is None
        finally:
            for home in gate.auth_homes:
                shutil.rmtree(home)

    for label in ('workflow-failure-detail', 'workflow-retry-partial-failure'):
        assert label in module.MOCK_OPENAI_TARGETS
        with tempfile.TemporaryDirectory(prefix='release-workflow-protocol-') as directory:
            server = module.MockOpenAIServer(Path(directory), label)
            script = module.WORKFLOW_FAULT_SCRIPTS[label]
            parent = [{'role': 'user', 'content': 'Use Workflow with this exact inline script.\n```js\n' + script + '```'}]
            kind, wire = server.response_for({'input': parent})
            assert kind == 'workflow-search' and 'ToolSearch' in wire
            parent.append({'type': 'function_call_output', 'call_id': 'fc_workflow_search', 'output': 'Workflow discovered'})
            kind, wire = server.response_for({'input': parent})
            assert kind == 'workflow-launch' and '"name":"Workflow"' in wire
            parent.append({'type': 'function_call_output', 'call_id': 'fc_workflow_launch', 'output': 'Workflow launched in background. Task ID: wfixture'})
            assert server.response_for({'input': parent})[0] == 'workflow-parent-completed'
            assert server.response_for({'input': [{'role': 'user', 'content': 'unknown'}]})[0] == 'workflow-unrecognized'
            if label == 'workflow-retry-partial-failure':
                for worker in ('transient', 'stable'):
                    kind, wire = server.response_for({'input': [{'role': 'user', 'content': f'Return exactly {worker}-worker-ok.'}]})
                    assert kind == f'workflow-{worker}-completed' and f'{worker}-worker-ok' in wire
                    kind, wire = server.response_for({'input': [{'role': 'user', 'content': [
                        {'type': 'input_text', 'text': '<system-reminder>Runtime context</system-reminder>'},
                        {'type': 'input_text', 'text': f'Return exactly {worker}-worker-ok.'},
                    ]}]})
                    assert kind == f'workflow-{worker}-completed'
            gate = object.__new__(module.BinaryGate)
            gate.mock_servers = {Path(directory).name: server}
            kinds = ['workflow-search', 'workflow-launch', 'workflow-parent-completed']
            if label == 'workflow-retry-partial-failure':
                kinds += ['workflow-transient-completed', 'workflow-stable-completed']
            server.requests = [
                {'method': 'POST', 'path': '/v1/responses', 'body': {'input': []},
                 'response_kind': kind, 'authorization': {'matches_dummy': True}}
                for kind in kinds
            ]
            assert gate.workflow_mock_wire(Path(directory), label)['validation_verdict'] == 'passed'
            server.requests.append(server.requests[1])
            assert gate.workflow_mock_wire(Path(directory), label)['validation_verdict'] == 'failed'
            server.requests.pop()
            server.requests[0]['authorization']['matches_dummy'] = False
            assert gate.workflow_mock_wire(Path(directory), label)['validation_verdict'] == 'failed'

    assert 'coordinator-selector' in module.MOCK_OPENAI_TARGETS
    with tempfile.TemporaryDirectory(prefix='release-driver-coordinator-') as root_string:
        run_dir = Path(root_string)
        server = module.MockOpenAIServer(run_dir, 'coordinator-selector')
        base_url = server.start()

        def coordinator_request(items):
            request = Request(
                f'{base_url}/v1/responses',
                data=json.dumps({'input': items}).encode(),
                headers={
                    'Content-Type': 'application/json',
                    'Authorization': f'Bearer {module.DUMMY_OPENAI_API_KEY}',
                },
            )
            with urlopen(request, timeout=5) as response:
                return response.read().decode()

        def tool_output(call_id, output):
            return {'type': 'function_call_output', 'call_id': call_id, 'output': output}

        parent = [{'role': 'user', 'content': 'Coordinator selector binary validation.'}]
        child = [{'role': 'user', 'content': 'RELEASE_COORDINATOR_CHILD_REQUEST'}]
        try:
            agent = coordinator_request(parent)
            assert '"name":"Agent"' in agent
            assert '\\"run_in_background\\":false' in agent
            assert 'RELEASE_COORDINATOR_CHILD_REQUEST' in agent
            bash = coordinator_request(child)
            assert '"name":"Bash"' in bash
            assert 'fc_release_coordinator_bash' in bash
            assert coordinator_request(parent) == agent
            assert coordinator_request(parent + [{
                'type': 'function_call', 'name': 'Agent',
                'arguments': json.dumps({'prompt': 'RELEASE_COORDINATOR_CHILD_REQUEST'}),
            }]) == agent
            assert server.response_for({'instructions': module.TITLE_GENERATION_INSTRUCTION, 'input': parent})[0] == 'title'
            assert coordinator_request(child + [tool_output('unrelated', 'ok')]) == bash
            parent_done = coordinator_request(parent + [tool_output('fc_release_coordinator_agent', 'background task result')])
            assert 'RELEASE_COORDINATOR_PARENT_OK' in parent_done
            read = coordinator_request(child + [tool_output('fc_release_coordinator_bash', 'RELEASE_COORDINATOR_BASH_OK')])
            assert '"name":"Read"' in read
            assert 'Makefile' in read
            results = []
            worker = threading.Thread(target=lambda: results.append(coordinator_request(child + [
                tool_output('fc_release_coordinator_bash', 'RELEASE_COORDINATOR_BASH_OK'),
                tool_output('fc_release_coordinator_read', 'VERSION := test'),
            ])))
            worker.start()
            assert server.coordinator_tools_done.wait(2)
            assert worker.is_alive()
            assert coordinator_request(parent + [tool_output('fc_release_coordinator_agent', 'done')]) == parent_done
            server.coordinator_release.set()
            worker.join(3)
            assert not worker.is_alive()
            assert 'RELEASE_COORDINATOR_CHILD_OK' in results[0]
            assert all(item['authorization']['matches_dummy'] for item in server.snapshot())
            assert module.DUMMY_OPENAI_API_KEY not in (run_dir / 'mock-openai-requests.json').read_text()
            server.coordinator_release.clear()
            server.coordinator_tools_done.clear()
            results.clear()
            worker = threading.Thread(target=lambda: results.append(coordinator_request(child + [
                tool_output('fc_release_coordinator_read', 'VERSION := test'),
            ])))
            worker.start()
            assert server.coordinator_tools_done.wait(2)
            assert server.stop()['stopped']
            worker.join(3)
            assert not worker.is_alive()
            assert 'RELEASE_COORDINATOR_CHILD_OK' not in results[0]
        finally:
            server.stop()

        gate = object.__new__(module.BinaryGate)
        gate.repo = run_dir / 'repo'
        gate.evidence_root = run_dir
        gate.auth_source = run_dir / 'must-not-read-auth'
        gate.auth_homes = set()
        fixture_dir = run_dir / 'fixture'
        fixture_dir.mkdir()
        try:
            _, home = gate.make_fixture(fixture_dir, 'coordinator-selector')
            assert json.loads((home / '.codex/auth.json').read_text()) == {'OPENAI_API_KEY': module.DUMMY_OPENAI_API_KEY}
            assert json.loads((fixture_dir / 'auth-source-metadata.json').read_text())['source'] is None
        finally:
            for home in gate.auth_homes:
                shutil.rmtree(home)

    with tempfile.TemporaryDirectory(prefix='release-driver-mock-openai-') as root_string:
        run_dir = Path(root_string)
        server = module.MockOpenAIServer(
            run_dir,
            'model-internal-update-config-skill',
        )
        base_url = server.start()
        try:
            model_request = Request(
                f'{base_url}/v1/models',
                headers={'Authorization': f'Bearer {module.DUMMY_OPENAI_API_KEY}'},
            )
            with urlopen(model_request, timeout=5) as response:
                models = json.loads(response.read())
            assert models['data'][0]['id'] == 'gpt-release-discovered'

            empty_run_dir = run_dir / 'empty'
            empty_run_dir.mkdir()
            empty_server = module.MockOpenAIServer(
                empty_run_dir,
                'model-discovery-empty-picker',
            )
            empty_base_url = empty_server.start()
            try:
                empty_request = Request(
                    f'{empty_base_url}/v1/models',
                    headers={
                        'Authorization': f'Bearer {module.DUMMY_OPENAI_API_KEY}'
                    },
                )
                with urlopen(empty_request, timeout=5) as response:
                    assert json.loads(response.read()) == {'data': []}
            finally:
                assert empty_server.stop() == {
                    'stopped': True,
                    'thread_alive': False,
                }

            def post_response(server_url, *, instructions, input_items=None):
                payload = {
                    'model': 'gpt-release-discovered',
                    'instructions': instructions,
                }
                if input_items is not None:
                    payload['input'] = input_items
                response_request = Request(
                    f'{server_url}/v1/responses',
                    data=json.dumps(payload).encode(),
                    method='POST',
                    headers={
                        'Authorization': f'Bearer {module.DUMMY_OPENAI_API_KEY}',
                        'Content-Type': 'application/json',
                    },
                )
                with urlopen(response_request, timeout=5) as response:
                    return response.read().decode()

            title_sse = post_response(
                base_url,
                instructions=module.TITLE_GENERATION_INSTRUCTION,
            )
            title_events = [
                json.loads(line[6:])
                for line in title_sse.splitlines()
                if line.startswith('data: ')
            ]
            assert title_events[0] == {
                'type': 'response.output_text.delta',
                'delta': '{"title":"Release validation"}',
            }
            assert title_events[-1]['type'] == 'response.completed'
            assert 'response.function_call_arguments.done' not in title_sse

            first_sse = post_response(
                base_url,
                instructions='normal system prompt',
            )
            assert 'response.function_call_arguments.done' in first_sse
            assert 'update-config' in first_sse

            second_sse = post_response(
                base_url,
                instructions='normal system prompt',
            )
            assert 'RELEASE_UPDATE_CONFIG_SKILL_OK' in second_sse
            assert 'response.reasoning_summary_text.delta' in module.sse_completed(
                'done',
                reasoning='reasoning marker',
            )
            requests = server.snapshot()
            assert [request['response_kind'] for request in requests] == [
                'models',
                'title',
                'skill-call',
                'completed',
            ]
            assert all(
                request['authorization'] == {
                    'present': True,
                    'matches_dummy': True,
                }
                for request in requests
            )
            assert module.DUMMY_OPENAI_API_KEY not in (
                run_dir / 'mock-openai-requests.json'
            ).read_text()

            image_run_dir = run_dir / 'image'
            image_run_dir.mkdir()
            image_server = module.MockOpenAIServer(
                image_run_dir,
                'openai-image-input-wire',
            )
            image_base_url = image_server.start()
            try:
                read_sse = post_response(
                    image_base_url,
                    instructions='normal system prompt',
                    input_items=[{
                        'type': 'message',
                        'role': 'user',
                        'content': [{
                            'type': 'input_text',
                            'text': 'read image',
                        }],
                    }],
                )
                assert 'response.function_call_arguments.done' in read_sse
                assert str(image_run_dir / 'fixture.png') in read_sse
                completed_sse = post_response(
                    image_base_url,
                    instructions='normal system prompt',
                    input_items=[{
                        'type': 'function_call_output',
                        'call_id': 'fc_release_read_image',
                        'output': [],
                    }],
                )
                assert 'RELEASE_OPENAI_IMAGE_WIRE_OK' in completed_sse
                assert [
                    request['response_kind']
                    for request in image_server.snapshot()
                ] == ['read-call', 'completed']
            finally:
                assert image_server.stop() == {
                    'stopped': True,
                    'thread_alive': False,
                }

            compaction_run_dir = run_dir / 'compaction'
            compaction_run_dir.mkdir()
            compaction_server = module.MockOpenAIServer(
                compaction_run_dir,
                'openai-remote-compaction',
            )
            compaction_base_url = compaction_server.start()
            try:
                def post_compaction(input_items):
                    return post_response(
                        compaction_base_url,
                        instructions='normal system prompt',
                        input_items=input_items,
                    )

                seed_sse = post_compaction([{
                    'type': 'message',
                    'role': 'user',
                    'content': [{'type': 'input_text', 'text': 'seed'}],
                }])
                assert 'RELEASE_COMPACTION_SEED_OK' in seed_sse
                first_compact_sse = post_compaction([
                    {'type': 'message', 'role': 'user', 'content': []},
                    {'type': 'compaction_trigger'},
                ])
                assert '"type":"compaction"' in first_compact_sse
                assert 'release-opaque-state-0' in first_compact_sse
                continuation = {
                    'type': 'compaction',
                    'id': 'cmp_release_0',
                    'encrypted_content': 'release-opaque-state-0',
                }
                continuation_sse = post_compaction([
                    continuation,
                    {'type': 'message', 'role': 'user', 'content': []},
                ])
                assert 'RELEASE_COMPACTION_CONTINUATION_OK' in continuation_sse
                second_compact_sse = post_compaction([
                    continuation,
                    {'type': 'message', 'role': 'user', 'content': []},
                    {'type': 'compaction_trigger'},
                ])
                assert 'release-opaque-state-1' in second_compact_sse
                assert [
                    request['response_kind']
                    for request in compaction_server.snapshot()
                ] == [
                    'completed',
                    'compaction',
                    'completed',
                    'compaction',
                ]
            finally:
                assert compaction_server.stop() == {
                    'stopped': True,
                    'thread_alive': False,
                }

            subagent_run_dir = run_dir / 'subagent-stop'
            subagent_run_dir.mkdir()
            subagent_server = module.MockOpenAIServer(
                subagent_run_dir,
                'subagent-stop-failure-lifecycle',
            )
            subagent_base_url = subagent_server.start()
            try:
                def post_subagent(input_items):
                    return post_response(
                        subagent_base_url,
                        instructions='normal system prompt',
                        input_items=input_items,
                    )

                first_subagent_sse = post_subagent([{
                    'type': 'message',
                    'role': 'user',
                    'content': [{'type': 'input_text', 'text': 'start'}],
                }])
                assert 'fc_release_subagent_stop' in first_subagent_sse
                assert '"name":"Agent"' in first_subagent_sse
                second_subagent_sse = post_subagent([{
                    'type': 'function_call_output',
                    'call_id': 'fc_release_subagent_stop',
                    'output': 'Error: RELEASE_SUBAGENT_QUERY_FAILURE',
                }])
                assert 'RELEASE_SUBAGENT_STOP_PARENT_OK' in second_subagent_sse
                assert [
                    request['response_kind']
                    for request in subagent_server.snapshot()
                ] == ['agent-call', 'parent-completed']
            finally:
                assert subagent_server.stop() == {
                    'stopped': True,
                    'thread_alive': False,
                }
        finally:
            cleanup = server.stop()
        assert cleanup == {'stopped': True, 'thread_alive': False}

    framed_custom_instructions = (
        'fixed release framing\n'
        + module.CUSTOM_SYSTEM_PROMPT_MARKER
        + '\nfixed repository context'
    )
    assert module.custom_prompt_instructions_stable([
        {'instructions': framed_custom_instructions},
        {'instructions': framed_custom_instructions},
    ]) is True
    assert module.custom_prompt_instructions_stable([
        {'instructions': framed_custom_instructions},
        {'instructions': framed_custom_instructions.replace(
            module.CUSTOM_SYSTEM_PROMPT_MARKER,
            module.CUSTOM_SYSTEM_PROMPT_MARKER * 2,
        )},
    ]) is False
    assert module.custom_prompt_instructions_stable([
        {'instructions': framed_custom_instructions},
        {'instructions': framed_custom_instructions + '\nchanged'},
    ]) is False

    with tempfile.TemporaryDirectory(prefix='release-driver-targets-') as root_string:
        root = Path(root_string)
        repo = root / 'repo'
        subprocess.run(['git', '-C', str(root), 'init', str(repo)], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(repo), 'config', 'user.name', 'Tester'], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(repo), 'config', 'user.email', 'tester@example.com'], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(repo), 'config', 'commit.gpgsign', 'false'], check=True, capture_output=True)
        committed_paths = [
            repo / 'src/utils/effort.ts',
            repo / 'src/utils/model/modelOptions.ts',
            repo / 'src/utils/model/openaiModelOptions.ts',
            repo / 'src/skills/bundled/updateConfig.ts',
            repo / 'src/utils/promptLayers.ts',
            repo / 'src/utils/swarm/teamHelpers.ts',
        ]
        for path in committed_paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('before\n')
        staged = repo / 'src/components/PromptInput/PromptInput.tsx'
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_text('baseline staged\n')
        unstaged = repo / 'src/tools/WorkflowTool/workflowScriptRuntime.ts'
        unstaged.parent.mkdir(parents=True, exist_ok=True)
        unstaged.write_text('baseline unstaged\n')
        subprocess.run([
            'git', '-C', str(repo), 'add',
            *(str(path.relative_to(repo)) for path in committed_paths),
            str(staged.relative_to(repo)),
            str(unstaged.relative_to(repo)),
        ], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(repo), 'commit', '-m', 'init'], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(repo), 'tag', 'v0.0.1'], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(repo), 'branch', 'origin/master'], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(repo), 'branch', '-M', 'feature'], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(repo), 'branch', '--set-upstream-to', 'origin/master'], check=True, capture_output=True)

        for path in committed_paths:
            path.write_text('after\n')
        subprocess.run([
            'git', '-C', str(repo), 'add',
            *(str(path.relative_to(repo)) for path in committed_paths),
        ], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(repo), 'commit', '-m', 'change'], check=True, capture_output=True)
        assert baseline_module.default_release_base_ref(repo) == 'v0.0.1'

        staged.write_text('staged\n')
        subprocess.run(['git', '-C', str(repo), 'add', str(staged.relative_to(repo))], check=True, capture_output=True)

        unstaged.write_text('unstaged\n')

        untracked = repo / 'src/utils/swarm/inProcessRunner.ts'
        untracked.parent.mkdir(parents=True, exist_ok=True)
        untracked.write_text('untracked\n')

        release_base_commit = subprocess.run(
            ['git', '-C', str(repo), 'rev-parse', 'v0.0.1^{commit}'],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        subprocess.run(
            ['git', '-C', str(repo), 'branch', '-f', 'origin/master', 'HEAD'],
            check=True,
            capture_output=True,
        )
        baseline = {
            'upstream': 'origin/master',
            'release_base_ref': 'origin/master',
            'release_base_commit': release_base_commit,
        }
        inputs = module.collect_required_target_inputs(repo, baseline)
        assert inputs['release_base']['base_ref'] == 'origin/master'
        assert inputs['release_base']['merge_base'] == release_base_commit
        assert inputs['release_base']['source'] == 'baseline immutable release base commit'
        assert inputs['paths_by_source']['committed_release_range'] == [
            'src/skills/bundled/updateConfig.ts',
            'src/utils/effort.ts',
            'src/utils/model/modelOptions.ts',
            'src/utils/model/openaiModelOptions.ts',
            'src/utils/promptLayers.ts',
            'src/utils/swarm/teamHelpers.ts',
        ]
        assert inputs['paths_by_source']['staged'] == [
            'src/components/PromptInput/PromptInput.tsx'
        ]
        assert inputs['paths_by_source']['unstaged'] == [
            'src/tools/WorkflowTool/workflowScriptRuntime.ts'
        ]
        assert inputs['paths_by_source']['untracked'] == [
            'src/utils/swarm/inProcessRunner.ts'
        ]
        assert module.required_targets_for_paths(inputs['all_paths']) == required
        explicit = module.collect_required_target_inputs(repo, {}, explicit_base_ref='origin/master')
        assert explicit['release_base']['base_ref'] == 'origin/master'
        assert 'origin/master..HEAD' not in module.code_review_prompt(
            explicit['release_base']['merge_base']
        )
        assert (
            f"{explicit['release_base']['merge_base']}..HEAD"
            in module.code_review_prompt(explicit['release_base']['merge_base'])
        )
        try:
            module.collect_required_target_inputs(repo, {'upstream': 'origin/master'})
        except RuntimeError as error:
            assert 'release_base_commit' in str(error)
            assert '--base-ref <commit-ish>' in str(error)
        else:
            raise AssertionError('expected missing release base to fail closed')

        try:
            module.collect_required_target_inputs(repo, {})
        except RuntimeError as error:
            assert '--base-ref <commit-ish>' in str(error)
        else:
            raise AssertionError('expected missing release base to fail closed')

    assert module.submitted_input_pending(
        '❯ /deep-research inspect workflow behavior\n'
    ) is True
    assert module.submitted_input_pending(
        '❯ /deep-research inspect workflow behavior\n✶ Working…\n❯ \n'
    ) is False
    assert module.submitted_input_pending(
        '❯ /deep-research old request\n'
        '● Finished old request\n'
        '❯ /deep-research current request\n'
    ) is True
    assert module.submitted_input_pending('❯ \n') is False
    assert module.input_prompt_ready('❯ /goal wait for token\nGoal is set\n') is False
    assert module.input_prompt_ready(
        '❯ /goal wait for token\nGoal is set\n✶ Working…\n❯ \n'
        'esc to interrupt\n'
    ) is False
    assert module.input_prompt_ready(
        '❯ /goal wait for token\nGoal is set\n❯ \n'
    ) is True
    assert module.input_prompt_ready('status without prompt\n') is False

    title_request = {
        'method': 'POST',
        'path': '/v1/responses',
        'body': {
            'instructions': (
                'system prefix\n'
                + module.TITLE_GENERATION_INSTRUCTION
                + ' (3-7 words)\nReturn JSON.'
            ),
        },
    }
    main_request = {
        'method': 'POST',
        'path': '/v1/responses',
        'body': {'instructions': 'normal system prompt'},
    }
    mock_gate = object.__new__(module.BinaryGate)
    mock_gate.mock_servers = {
        'run': type(
            'SnapshotServer',
            (),
            {'snapshot': lambda self: [title_request, main_request]},
        )(),
    }
    assert mock_gate.mock_response_requests(Path('run')) == [main_request]

    assert module.parse_target_list(None) == []
    assert module.parse_target_list('team-concurrency,workflow') == [
        'team-concurrency', 'workflow'
    ]
    for raw, expected in (
        ('', 'targets must not be empty'),
        ('workflow,,team-concurrency', 'empty target'),
        ('workflow,workflow', 'duplicate target'),
    ):
        try:
            module.parse_target_list(raw)
        except ValueError as error:
            assert expected in str(error)
        else:
            raise AssertionError(f'expected parse_target_list({raw!r}) to fail')

    code_review_prompt = module.code_review_prompt('release-base-sha')
    assert (
        'git diff release-base-sha..HEAD -- '
        'src/tools/WorkflowTool/bundled/index.ts '
        'src/tools/WorkflowTool/bundled/index.test.ts'
    ) in code_review_prompt
    assert 'Do not widen the diff range or path scope' in code_review_prompt
    assert 'current changes' not in code_review_prompt
    assert 'src/tools/AgentTool' not in code_review_prompt
    assert 'src/tasks/LocalWorkflowTask' not in code_review_prompt
    assert 'src/utils/sessionStorage.ts' not in code_review_prompt

    planned = module.plan_targets(['team-concurrency'], {'workflow-failure-detail'})
    assert planned == ['workflow-failure-detail', 'team-concurrency']
    for path in (
        'src/tasks/InProcessTeammateTask/types.ts',
        'src/hooks/useBackgroundTaskNavigation.ts',
        'src/components/tasks/BackgroundTasksDialog.tsx',
        'src/components/tasks/InProcessTeammateDetailDialog.tsx',
        'src/components/tasks/backgroundTasksDialogState.ts',
        'src/components/PromptInput/PromptInput.tsx',
    ):
        assert 'transcript-retention' in module.required_targets_for_paths([path]), path
    assert module.plan_targets([], {'ssh-remote-session-lifecycle'}) == [
        'ssh-remote-session-lifecycle',
    ]

    with tempfile.TemporaryDirectory(prefix='release-driver-assertions-') as root_string:
        root = Path(root_string)
        source_run = root / 'run-a'
        source_run.mkdir()
        foreign_run = root / 'run-b'
        foreign_run.mkdir()
        source_runs = {'run-a': source_run.resolve(strict=False)}
        valid_assertion = make_required_assertion(source_run)
        assert module.assertion_is_valid(valid_assertion, source_runs) is True
        assert module.assertion_is_valid(
            make_required_assertion(source_run, include_assertion_id=False),
            source_runs,
        ) is False
        assert module.assertion_is_valid(
            make_required_assertion(source_run, include_source_run=False),
            source_runs,
        ) is False
        assert module.assertion_is_valid(
            make_required_assertion(source_run, include_runtime_state=False),
            source_runs,
        ) is False
        assert module.assertion_is_valid(
            make_required_assertion(source_run, runtime_state='invalid-state'),
            source_runs,
        ) is False
        assert module.assertion_is_valid(
            make_required_assertion(source_run, evidence_absolute=False),
            source_runs,
        ) is False
        assert module.assertion_is_valid(
            make_required_assertion(
                source_run,
                create_evidence=False,
                evidence_name='missing.txt',
            ),
            source_runs,
        ) is False
        foreign_assertion = make_required_assertion(source_run)
        foreign_assertion['observed_evidence_paths'] = [str(foreign_run / 'pane.txt')]
        (foreign_run / 'pane.txt').write_text('foreign\n')
        assert module.assertion_is_valid(foreign_assertion, source_runs) is False

        audit_runs = []
        for target in required:
            directory = root / target
            directory.mkdir()
            (directory / 'run-metadata.json').write_text(json.dumps({
                'label': target, 'driver_run': 'driver-a', 'source_run': directory.name,
                'evidence_dir': str(directory.resolve()),
            }))
            audit_runs.append({'label': target, 'validation_verdict': 'passed',
                'driver_run': 'driver-a', 'evidence_dir': str(directory),
                'assertions': [make_required_assertion(directory)]})
        registered = {str(Path(run['evidence_dir']).resolve()):
                      (Path(run['evidence_dir']) / 'run-metadata.json').read_text()
                      for run in audit_runs}
        coverage = module.validate_required_target_results(required, audit_runs, registered)
        assert coverage['passed'] is True
        assert coverage['missing_targets'] == []
        assert coverage['invalid_targets'] == []
        for field, value in [('driver_run', 'foreign-driver'), ('source_run', 'forged'),
                             ('evidence_dir', str(root)), ('label', 'forged')]:
            metadata_path = Path(audit_runs[0]['evidence_dir']) / 'run-metadata.json'
            original = metadata_path.read_text()
            metadata = json.loads(original)
            metadata[field] = value
            metadata_path.write_text(json.dumps(metadata))
            assert not module.validate_required_target_results(required, audit_runs, registered)['passed'], field
            metadata_path.write_text(original)
        assert not module.validate_required_target_results(required, audit_runs)['passed']
        forged_runs = json.loads(json.dumps(audit_runs))
        for run in forged_runs:
            run['driver_run'] = 'forged-driver'
            path = Path(run['evidence_dir']) / 'run-metadata.json'
            metadata = json.loads(path.read_text())
            metadata['driver_run'] = 'forged-driver'
            path.write_text(json.dumps(metadata))
        assert not module.validate_required_target_results(
            required, forged_runs, registered)['passed']
        for directory, original in registered.items():
            (Path(directory) / 'run-metadata.json').write_text(original)
        forged_runs = json.loads(json.dumps(audit_runs))
        forged_dir = root / 'unregistered-source'
        forged_dir.mkdir()
        forged = forged_runs[0]
        forged['evidence_dir'] = str(forged_dir)
        forged['assertions'] = [make_required_assertion(forged_dir)]
        (forged_dir / 'run-metadata.json').write_text(json.dumps({
            'label': forged['label'], 'driver_run': 'driver-a',
            'source_run': forged_dir.name, 'evidence_dir': str(forged_dir.resolve()),
        }))
        assert not module.validate_required_target_results(required, forged_runs, registered)['passed']
        cross_target = json.loads(json.dumps(audit_runs))
        assert module.validate_required_target_results(required, cross_target, registered)['passed']
        cross_target[0]['assertions'] = cross_target[1]['assertions']
        assert not module.validate_required_target_results(required, cross_target, registered)['passed']
        cross_run = json.loads(json.dumps(audit_runs))
        assert module.validate_required_target_results(required, cross_run, registered)['passed']
        cross_run[0]['driver_run'] = 'foreign-driver'
        assert not module.validate_required_target_results(required, cross_run, registered)['passed']
        assert not module.validate_required_target_results({'audit'}, [{
            'label': 'audit', 'validation_verdict': 'passed',
            'evidence_dir': str(source_run), 'driver_run': 'driver-a',
            'assertions': [make_required_assertion(source_run)],
        }])['passed'], 'missing source metadata must not pass'

        coverage = module.validate_required_target_results(
            required,
            [{
                'label': 'team-concurrency',
                'validation_verdict': 'passed',
                'evidence_dir': str(source_run),
                'assertions': [],
            }],
        )
        assert coverage['passed'] is False
        assert 'workflow-retry-partial-failure' in coverage['missing_targets']
        assert coverage['invalid_targets'] == ['team-concurrency']

        coverage = module.validate_required_target_results(
            {'workflow-failure-detail'},
            [{
                'label': 'workflow-failure-detail',
                'validation_verdict': 'passed',
                'evidence_dir': str(source_run),
                'assertions': [foreign_assertion],
            }],
        )
        assert coverage['passed'] is False
        assert coverage['invalid_targets'] == ['workflow-failure-detail']

    driver = DRIVER_PATH.read_text()
    assert module.openai_request_metadata_matches(
        {
            'session-id': 'cache-key',
            'thread-id': 'cache-key',
            'x-client-request-id': 'request-1',
            'x-app': 'cli',
            'x-claude-code-session-id': 'cache-key',
            'user-agent': 'claude-code/test',
        },
        'cache-key',
    ) is True
    assert module.openai_request_metadata_matches(
        {
            'session-id': 'cache-key',
            'thread-id': 'cache-key',
            'x-client-request-id': '',
            'x-app': 'cli',
            'x-claude-code-session-id': 'cache-key',
            'user-agent': 'claude-code/test',
        },
        'cache-key',
    ) is False
    cleanup_gate = object.__new__(module.BinaryGate)
    cleanup_base = {
        'process_remaining': False,
        'forced_termination': [],
        'mock_server': {'stopped': True, 'thread_alive': False},
    }
    assert cleanup_gate.cleanup_passed({
        **cleanup_base,
        'kill_exit': 1,
        'session_exists_after': False,
    }) is True
    assert cleanup_gate.cleanup_passed({
        **cleanup_base,
        'kill_exit': 1,
        'session_exists_after': True,
    }) is False
    assert "f'Goal: {condition}'" in driver
    assert 'status_dismissed' in driver
    assert "log.count('Removed session hooks for event Stop and source ')" in driver
    assert "def workflow_completion_proof(" in driver
    assert "def agent_completion_proof(" in driver
    assert "self.workflow_completion_proof(" in driver
    assert "self.agent_completion_proof(" in driver
    assert "parent_result = 'RELEASE_NESTED_PARENT_DONE' in self.assistant_text(\n            run_dir, subagents=True\n        )" in driver
    assert "'RELEASE_NESTED_PARENT_DONE'\n                    in self.assistant_text(run_dir, subagents=True)" in driver
    assert "The child must not call Agent or delegate" in driver
    assert "workflow did not reach a terminal status before timeout" in driver
    assert "'goal-lifecycle': self.goal_lifecycle" in driver
    assert "def goal_lifecycle(self):" in driver
    assert "'subagent-stop-failure-lifecycle': self.subagent_stop_failure_lifecycle" in driver
    assert "def subagent_stop_failure_lifecycle(self):" in driver
    assert "'subagent-stop-query-failure-propagation'" in driver
    assert "'subagent-stop-fallback-exactly-once'" in driver
    assert "'goal-lifecycle-set-status-clear'" in driver
    assert "'agent-foreground-background-lifecycle'" in driver
    assert "result = {'label': 'workflow', 'evidence_dir': str(run_dir)}" in driver
    assert "'inline-workflow-lifecycle'" in driver
    assert "f'{kind}-workflow-lifecycle'" in driver
    assert "'team-concurrency': self.team_concurrency" in driver
    assert "'workflow-retry-partial-failure': self.workflow_retry_partial_failure" in driver
    assert "'workflow-failure-detail': self.workflow_failure_detail" in driver
    assert "'coordinator-selector': self.coordinator_selector" in driver
    assert "'transcript-retention': self.transcript_retention" in driver
    assert "def team_concurrency(self):" in driver
    assert "def workflow_retry_partial_failure(self):" in driver
    assert "def workflow_failure_detail(self):" in driver
    assert "def coordinator_selector(self):" in driver
    assert "def transcript_retention(self):" in driver
    assert "def run_target(self, label, action):" in driver
    assert "result['repository_state_expected_workflow_artifacts']" in driver
    assert "self.run_target(target, actions[target])" in driver
    assert "result_label = 'inline-workflow' if target == 'workflow' else target" not in driver
    assert "global_config_path = config / (" in driver
    assert "'.claude-local-oauth.json'" in driver
    assert "if label in {'goal-lifecycle', 'openai-responses-usage-error'}:" in driver
    assert "'CC_VALIDATION_DISABLE_NONSTREAMING_FALLBACK=1'" in driver
    assert "'CC_VALIDATION_MAX_RETRIES=0'" in driver
    assert "'history-bootstrap-response' in self.ssh_fixture_events(run_dir)" in driver
    assert "or 'task-result' in self.ssh_fixture_events(run_dir)" in driver
    assert "run_dir / '04-prompt-after-detail-dialog.txt'" in driver
    assert "re.fullmatch(r'\\s*❯\\s*', line)" in driver
    assert "f'/workflows detail {task_id}'" in driver
    assert 'structured shutdown_request' in driver
    assert 'then return. Do not modify files.' in driver
    assert "status=completed retain=keep" in driver
    assert "input-transcript-retention-exit.txt" not in driver
    assert "passed=marker_ok and no_retry" in driver
    assert "logical_workers == ['probe-a', 'probe-b']" in driver
    assert "self.tmux('send-keys', '-t', target, 'Escape', check=True)" in driver
    assert "'-e', 'CC_VALIDATION_AGENT_TEAMS=1'" in driver
    assert "CC_VALIDATION_WORKFLOW_FAULT_INJECTION=service_unavailable:transient-worker:attempt:0" in driver
    assert "page_ok = detail_ok = agent_ok = None" in driver
    assert "ui_skipped_reason = 'workflow did not complete'" in driver
    assert "ui_skipped_reason = 'readiness failed'" in driver
    assert "'skipped_reason': ui_skipped_reason" in driver
    assert "specified/not executable" in driver
    assert "--base-ref" in driver
    assert "required_target_inputs" in driver
    assert "extra targets to append after diff-required targets" in driver

    assert "'effort-openai-responses-wire': self.effort_openai_responses_wire" in driver
    assert "'fast-openai-responses-wire': self.fast_openai_responses_wire" in driver
    assert "'openai-image-input-wire': self.openai_image_input_wire" in driver
    assert "'openai-remote-compaction': self.openai_remote_compaction" in driver
    assert "'openai-responses-usage-error': self.openai_responses_usage_error" in driver
    assert "'model-discovery-picker': self.model_discovery_picker" in driver
    assert "'model-discovery-empty-picker': self.model_discovery_empty_picker" in driver
    assert "'first-party-bootstrap-picker': self.first_party_bootstrap_picker" in driver
    assert "'model-internal-update-config-skill': self.model_internal_update_config_skill" in driver
    assert "'prompt-modes-cache-prefix': self.prompt_modes_cache_prefix" in driver
    assert 'def effort_openai_responses_wire(self):' in driver
    assert 'def fast_openai_responses_wire(self):' in driver
    assert 'def openai_image_input_wire(self):' in driver
    assert 'def openai_remote_compaction(self):' in driver
    assert 'def openai_responses_usage_error(self):' in driver
    assert 'def model_discovery_picker(self):' in driver
    assert 'def model_discovery_empty_picker(self):' in driver
    assert 'def first_party_bootstrap_picker(self):' in driver
    assert 'def model_internal_update_config_skill(self):' in driver
    assert 'def prompt_modes_cache_prefix(self):' in driver
    effort_method = driver.split(
        '    def effort_openai_responses_wire(self):', 1
    )[1].split('\n    def ', 1)[0]
    for effort, expected in (
        ('none', 'none'),
        ('minimal', 'minimal'),
        ('low', 'low'),
        ('medium', 'medium'),
        ('high', 'high'),
        ('xhigh', 'xhigh'),
        ('max', 'max'),
        ('ultra', 'ultra'),
        ('ultracode', 'xhigh'),
    ):
        assert repr((effort, expected)) in effort_method
    assert "thinking_path = run_dir / '05-thinking-transcript-pane.txt'" in effort_method
    assert "self.tmux('send-keys', '-t', target, 'C-o', check=True)" in effort_method
    assert "prompt_restored = self.wait_until(" in effort_method
    assert "self.capture(target, terminal_path, history=False)" in effort_method
    assert "if prompt_restored:" in effort_method
    assert "thinking_visible = prompt_restored and self.wait_until(" in effort_method
    assert "'prompt_restored_before_transcript': prompt_restored" in effort_method
    assert 'thinking_path.read_text(errors=\'replace\')' in effort_method
    assert 'thinking_transcript_shows_marker = (' in effort_method
    assert 'and thinking_transcript_shows_marker' in effort_method
    assert "'thinking_transcript_shows_marker': thinking_transcript_shows_marker" in effort_method
    assert '            thinking_path,' in effort_method
    usage_error_method = driver.split(
        '    def openai_responses_usage_error(self):', 1
    )[1].split('\n    def ', 1)[0]
    assert "'input_tokens': 100" in usage_error_method
    assert "'cache_read_input_tokens': 60" in usage_error_method
    assert "'cache_creation_input_tokens': 15" in usage_error_method
    assert "'response.incomplete'" in driver
    assert 'RELEASE_OPENAI_INCOMPLETE_REASON' in usage_error_method
    assert 'openai-responses-usage-normalization' in usage_error_method
    assert 'openai-responses-error-propagation' in usage_error_method
    model_picker_method = driver.split(
        '    def model_discovery_picker(self):', 1
    )[1].split('\n    def ', 1)[0]
    assert "self.tmux('send-keys', '-t', target, 'M-p', check=True)" in model_picker_method
    assert "'Set model to gpt-release-discovered'" not in model_picker_method
    assert 'self.record(result)' in model_picker_method
    empty_model_picker_method = driver.split(
        '    def model_discovery_empty_picker(self):', 1
    )[1].split('\n    def ', 1)[0]
    first_party_bootstrap_method = driver.split(
        '    def first_party_bootstrap_picker(self):', 1
    )[1].split('\n    def ', 1)[0]
    assert 'RELEASE_FIRST_PARTY_BOOTSTRAP_MODEL' in first_party_bootstrap_method
    assert "'RELEASE_FIRST_PARTY_BOOTSTRAP_MODEL ✔'" in first_party_bootstrap_method
    assert "'/model current'" not in first_party_bootstrap_method
    assert "'/api/claude_cli/bootstrap'" in driver
    assert 'first-party-bootstrap-startup-cache' in first_party_bootstrap_method
    assert 'first-party-bootstrap-picker' in first_party_bootstrap_method
    assert "'model-discovery-empty-picker'" in driver
    assert "self.tmux('send-keys', '-t', target, 'M-p', check=True)" in empty_model_picker_method
    assert "'input-empty-model-picker.txt'" in empty_model_picker_method
    assert "('GPT-5.5', 'GPT-5.4-Mini')" in empty_model_picker_method
    assert "'gpt-empty-discovery-current ✔'" in empty_model_picker_method
    assert "for marker in ('Select model', 'gpt-empty-discovery-current')" not in empty_model_picker_method
    assert "'gpt-empty-discovery-current ·'" not in empty_model_picker_method
    assert 'gpt-empty-discovery-current' in empty_model_picker_method
    assert "'model-discovery-empty-picker'" in empty_model_picker_method
    assert "'Empty discovered model list'" in empty_model_picker_method

    with tempfile.TemporaryDirectory(prefix='release-driver-empty-picker-') as root_string:
        run_dir = Path(root_string) / 'model-discovery-empty-picker'
        run_dir.mkdir()
        recorded = []
        empty_picker_gate = object.__new__(module.BinaryGate)
        empty_picker_gate.start = lambda _label: (
            run_dir,
            'empty-picker-session',
            'empty-picker-target',
            True,
        )
        empty_picker_gate.tmux = lambda *args, **kwargs: module.subprocess.CompletedProcess(
            args, 0, '', ''
        )
        def capture_empty_picker(_target, path, **_kwargs):
            path.write_text(
                'Select model\n'
                'gpt-empty-discovery-current · API Usage Billing\n'
                '1. gpt-empty-discovery-current ✔  Custom model\n'
            )
            return path.read_text()

        empty_picker_gate.capture = capture_empty_picker
        empty_picker_gate.wait_until = lambda predicate, *_args: predicate()
        empty_picker_gate.mock_servers = {
            run_dir.name: SimpleNamespace(snapshot=lambda: [{
                'method': 'GET',
                'path': '/v1/models',
                'authorization': {
                    'present': True,
                    'matches_dummy': True,
                },
            }]),
        }
        empty_picker_gate.mock_response_requests = lambda _run_dir: []
        empty_picker_gate.close = lambda *_args: {
            'kill_exit': 0,
            'process_remaining': False,
            'remaining_processes': [],
            'forced_termination': [],
            'mock_server': {'stopped': True, 'thread_alive': False},
        }
        empty_picker_gate.required_assertion = (
            lambda _run_dir, assertion_id, *_args, passed, **_kwargs: [
                assertion_id,
                'passed' if passed else 'failed',
            ]
        )
        empty_picker_gate.record = recorded.append
        empty_picker_gate.model_discovery_empty_picker()
        assert recorded[0]['validation_verdict'] == 'passed'
        assert recorded[0]['empty_discovery_honored'] is True
        assert (run_dir / 'input-empty-model-picker.txt').read_text().startswith('M-p ')

    model_mock = module.MockOpenAIServer(Path('/unused'), 'model-discovery-picker')
    for case in ('EXPLICIT', 'DEFAULT'):
        kind, response = model_mock.response_for({'input': [
            {'role': 'user', 'content': 'RELEASE_EXPLICIT_MODEL_REQUEST'},
            {'role': 'user', 'content': [{'type': 'input_text', 'text': f'RELEASE_{case}_MODEL_REQUEST'}]},
        ]})
        assert kind == 'model-mapping-completed'
        assert f'RELEASE_{case}_MODEL_OK' in response

    for faulty in (None, 'alias-model', 'explicit-model', 'missing-response', 'missing-pane', 'duplicate-response'):
        with tempfile.TemporaryDirectory(prefix='release-driver-default-model-') as root_string:
            run_dir = Path(root_string)
            gate = object.__new__(module.BinaryGate)
            gate.start = lambda _label: (run_dir, 'model-session', 'model-target', True)
            requests = [{
                'method': 'GET', 'path': '/v1/models',
                'authorization': {'present': True, 'matches_dummy': True},
            }]
            gate.mock_servers = {run_dir.name: SimpleNamespace(snapshot=lambda: requests)}
            gate.tmux = lambda *args, **kwargs: None
            def capture_model(_target, path, **_kwargs):
                text = {
                    '03-model-picker-pane.txt': 'Select model\nGPT Release Discovered',
                    '04-model-selected-pane.txt': 'gpt-release-discovered',
                    '05-model-current-pane.txt': 'Current model: gpt-release-discovered',
                    '06-explicit-model-pane.txt': 'RELEASE_EXPLICIT_MODEL_OK',
                    '07-alias-selected-pane.txt': 'Set model to Sonnet',
                    '08-default-model-pane.txt': 'RELEASE_DEFAULT_MODEL_OK',
                }.get(path.name, '')
                if faulty == 'missing-pane' and path.name == '08-default-model-pane.txt':
                    text = ''
                path.write_text(text)
                return text
            gate.capture = capture_model
            gate.wait_until = lambda predicate, *_args: predicate()
            def send_model(_target, _run_dir, text, filename, **_kwargs):
                (run_dir / filename).write_text(text)
                if text.startswith('/') or faulty == 'missing-response':
                    return
                explicit = 'RELEASE_EXPLICIT_MODEL_REQUEST' in text
                model = 'gpt-release-discovered' if explicit else 'gpt-5.6-luna'
                if faulty == ('explicit-model' if explicit else 'alias-model'):
                    model = 'wrong-model'
                request = {
                    'method': 'POST', 'path': '/v1/responses',
                    'sequence': len(requests) + 1,
                    'authorization': {'present': True, 'matches_dummy': True},
                    'body': {'model': model, 'input': [{'role': 'user', 'content': text}]},
                    'response_kind': 'model-mapping-completed',
                }
                requests.append(request)
                if faulty == 'duplicate-response':
                    requests.append(dict(request))
            gate.send = send_model
            gate.close = lambda *_args: {'kill_exit': 0, 'process_remaining': False,
                'remaining_processes': [], 'forced_termination': [],
                'mock_server': {'stopped': True, 'thread_alive': False}}
            gate.required_assertion = lambda _dir, assertion_id, *_args, passed, **_kwargs: {
                'assertion_id': assertion_id, 'passed': passed,
            }
            recorded = []
            gate.record = recorded.append
            gate.model_discovery_picker()
            assert recorded[0]['validation_verdict'] == ('passed' if faulty is None else 'failed'), faulty
            if faulty is None:
                assert {item['assertion_id'] for item in recorded[0]['assertions']} >= {
                    'openai-default-model-alias', 'openai-explicit-model-preserved',
                }
                assert (run_dir / 'input-model-alias.txt').read_text() == '/model sonnet'

    for assertion_id in (
        'openai-wire-cross-client-prefix',
        'openai-wire-create-compact-isolation',
        'effort-all-configured-openai-wire',
        'effort-ultracode-openai-wire',
        'fast-openai-priority-wire',
        'fast-openai-disable-wire',
        'openai-remote-compaction-trigger',
        'openai-remote-compaction-continuation',
        'openai-responses-usage-normalization',
        'openai-responses-error-propagation',
        'model-discovery-picker-selection',
        'model-discovery-empty-picker',
        'first-party-bootstrap-startup-cache',
        'first-party-bootstrap-picker',
        'update-config-skill-tool-lifecycle',
        'update-config-full-settings-schema',
        'custom-prompt-stable-cache-routing',
        'plan-release-artifact-read-only-boundary',
    ):
        assert assertion_id in driver

    with tempfile.TemporaryDirectory(prefix='release-driver-effort-thinking-') as root_string:
        run_dir = Path(root_string) / 'effort-openai-responses-wire'
        (run_dir / 'config').mkdir(parents=True)
        (run_dir / 'config' / 'settings.json').write_text(
            json.dumps({'effortLevel': 'minimal'})
        )
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

        effort_gate = object.__new__(module.BinaryGate)
        transcript_open = False
        visible_requests = 0
        tmux_calls = []
        recorded = []
        requests = [
            {
                'body': {
                    'reasoning': {'effort': expected},
                    'prompt_cache_key': 'cache-key',
                },
                'headers': {
                    'session-id': 'cache-key',
                    'thread-id': 'cache-key',
                    'x-client-request-id': f'request-{index}',
                    'x-app': 'cli',
                    'x-claude-code-session-id': 'cache-key',
                    'user-agent': 'claude-code/test',
                },
                'authorization': {'present': True, 'matches_dummy': True},
            }
            for index, (_, expected) in enumerate(effort_cases, 1)
        ]

        def capture_effort(target, path, *, history=True):
            nonlocal transcript_open
            if path.name.startswith('03-effort-'):
                effort = path.stem.removesuffix('-pane').split('-', 3)[-1]
                text = f'Set effort level to {effort}\n'
            elif path.name == '05-thinking-transcript-pane.txt':
                text = (
                    'Showing detailed transcript\n'
                    'Release validation reasoning marker.\n'
                    if transcript_open else ''
                )
            else:
                text = 'RELEASE_EFFORT_WIRE_OK\n❯\n'
            path.write_text(text)
            return text

        def tmux_effort(*args, **kwargs):
            nonlocal transcript_open
            tmux_calls.append(args)
            if args[-1] == 'C-o':
                transcript_open = True
            return subprocess.CompletedProcess(args, 0, '', '')

        effort_gate.start = lambda label: (run_dir, 'session', 'target', True)

        def send_effort(*args):
            nonlocal visible_requests
            prompt = str(args[2])
            if prompt.startswith('Reply with'):
                visible_requests += 1
            elif prompt == '/effort ultracode':
                (run_dir / 'config' / 'settings.json').write_text(
                    json.dumps({'effortLevel': 'ultracode'})
                )

        effort_gate.send = send_effort
        effort_gate.wait_until = lambda predicate, timeout, interval=0.5: predicate()
        effort_gate.capture = capture_effort
        effort_gate.tmux = tmux_effort
        effort_gate.mock_response_requests = lambda _: requests[:visible_requests]
        effort_gate.mock_servers = {run_dir.name: SimpleNamespace(snapshot=lambda: requests[:visible_requests])}
        effort_gate.assistant_text = lambda _: 'RELEASE_EFFORT_WIRE_OK'
        effort_gate.transcript = lambda _: 'Release validation reasoning marker.'
        effort_gate.close = lambda *args: {'stopped': True}
        effort_gate.cleanup_passed = lambda _: True
        effort_gate.record = recorded.append

        module.BinaryGate.effort_openai_responses_wire(effort_gate)

        assert recorded[0]['validation_verdict'] == 'failed', (
            'wire diagnostics require product debug logs, not fixture transcripts'
        )
        assert recorded[0]['wire_efforts'] == {
            'none': 'none',
            'minimal': 'minimal',
            'low': 'low',
            'medium': 'medium',
            'high': 'high',
            'xhigh': 'xhigh',
            'max': 'max',
            'ultra': 'ultra',
            'ultracode': 'xhigh',
        }
        assert recorded[0]['thinking_transcript_shows_marker'] is True
        assert ('send-keys', '-t', 'target', 'C-o') in tmux_calls
        assert 'Release validation reasoning marker.' not in (
            run_dir / '04-terminal-pane.txt'
        ).read_text()
        assert 'Release validation reasoning marker.' in (
            run_dir / '05-thinking-transcript-pane.txt'
        ).read_text()

        effort_assertions = {a['assertion_id']: a for a in recorded[0]['assertions']}
        assert effort_assertions['effort-all-configured-openai-wire']['validation_verdict'] == 'passed'
        assert effort_assertions['effort-ultracode-openai-wire']['validation_verdict'] == 'passed'

        # Existing effort lifecycle remains a positive unit case with an explicit
        # analyzer stub, not a fixture masquerading as a product debug log.
        visible_requests = 0
        transcript_open = False
        recorded.clear()
        with patch.object(module, 'analyze_openai_wire_debug', return_value={
            'matched': True, 'cross_client_append_only': True,
        }):
            module.BinaryGate.effort_openai_responses_wire(effort_gate)
        assert recorded[0]['validation_verdict'] == 'passed'

    with tempfile.TemporaryDirectory(prefix='release-driver-fast-wire-') as root_string:
        run_dir = Path(root_string) / 'fast-openai-responses-wire'
        (run_dir / 'config').mkdir(parents=True)
        (run_dir / 'config' / 'settings.json').write_text('{}\n')
        recorded = []
        visible_requests = 0
        fast_enabled = False
        fast_gate = object.__new__(module.BinaryGate)
        requests = [{
            'body': {'service_tier': 'priority'},
            'authorization': {'present': True, 'matches_dummy': True},
        }, {
            'body': {},
            'authorization': {'present': True, 'matches_dummy': True},
        }]
        fast_gate.start = lambda _label: (
            run_dir,
            'fast-session',
            'fast-target',
            True,
        )

        def send_fast(_target, _run_dir, text, _filename):
            nonlocal visible_requests, fast_enabled
            if text == '/fast on':
                fast_enabled = True
            elif text == '/fast off':
                fast_enabled = False
                (run_dir / 'config' / 'settings.json').write_text('{}\n')
            elif text.startswith('Reply with'):
                visible_requests += 1

        def capture_fast(_target, path, **_kwargs):
            if path.name == '03-fast-enabled-pane.txt':
                text = 'Fast mode ON\n'
            elif path.name == '05-fast-disabled-pane.txt':
                text = 'Fast mode OFF\n'
            else:
                text = 'RELEASE_FAST_WIRE_OK\n❯\n'
            path.write_text(text)
            return text

        fast_gate.send = send_fast
        fast_gate.wait_until = lambda predicate, *_args: predicate()
        fast_gate.capture = capture_fast
        fast_gate.mock_response_requests = lambda _run_dir: requests[:visible_requests]
        fast_gate.assistant_text = lambda _run_dir: 'RELEASE_FAST_WIRE_OK'
        fast_gate.close = lambda *_args: {'stopped': True}
        fast_gate.cleanup_passed = lambda _cleanup: True
        fast_gate.record = recorded.append
        fast_gate.required_assertion = (
            module.BinaryGate.required_assertion.__get__(
                fast_gate,
                module.BinaryGate,
            )
        )

        module.BinaryGate.fast_openai_responses_wire(fast_gate)

        assert recorded[0]['validation_verdict'] == 'passed'
        assert recorded[0]['service_tiers'] == ['priority', None]
        assert recorded[0]['preference_disabled_at_end'] is True
        assert fast_enabled is False

    with tempfile.TemporaryDirectory(prefix='release-driver-image-wire-') as root_string:
        run_dir = Path(root_string) / 'openai-image-input-wire'
        run_dir.mkdir()
        recorded = []
        visible_requests = 0
        image_gate = object.__new__(module.BinaryGate)
        processed_base64 = (
            'iVBORw0KGgoAAAANSUhEUgAAB9AAAAABCAIAAAAJn6IqAAAAHUlEQVR4nO3BMQEA'
            'AADCoPVPbQhfoAAAAAAAgNsAF3EAAW1SnXoAAAAASUVORK5CYII='
        )
        requests = [{
            'response_kind': 'read-call',
            'body': {'input': [{'type': 'message'}]},
            'authorization': {'present': True, 'matches_dummy': True},
        }, {
            'response_kind': 'completed',
            'body': {
                'input': [{
                    'type': 'function_call',
                    'id': 'fc_release_read_image',
                    'call_id': 'fc_release_read_image',
                    'name': 'Read',
                    'arguments': json.dumps({
                        'file_path': str(run_dir / 'fixture.png'),
                    }, separators=(',', ':')),
                }, {
                    'type': 'function_call_output',
                    'call_id': 'fc_release_read_image',
                    'output': [{
                        'type': 'input_image',
                        'image_url': f'data:image/png;base64,{processed_base64}',
                        'detail': 'high',
                    }],
                }],
            },
            'authorization': {'present': True, 'matches_dummy': True},
        }]
        image_gate.start = lambda _label: (
            run_dir,
            'image-session',
            'image-target',
            True,
        )

        def send_image(*_args):
            nonlocal visible_requests
            visible_requests = 2

        def capture_image(_target, path, **_kwargs):
            text = 'Read fixture.png\nRELEASE_OPENAI_IMAGE_WIRE_OK\n❯\n'
            path.write_text(text)
            return text

        image_gate.send = send_image
        image_gate.wait_until = lambda predicate, *_args: predicate()
        image_gate.capture = capture_image
        image_gate.mock_response_requests = (
            lambda _run_dir: requests[:visible_requests]
        )
        image_gate.assistant_text = (
            lambda _run_dir: 'RELEASE_OPENAI_IMAGE_WIRE_OK'
        )
        image_gate.close = lambda *_args: {'stopped': True}
        image_gate.cleanup_passed = lambda _cleanup: True
        image_gate.record = recorded.append
        image_gate.required_assertion = (
            module.BinaryGate.required_assertion.__get__(
                image_gate,
                module.BinaryGate,
            )
        )

        module.BinaryGate.openai_image_input_wire(image_gate)

        assert recorded[0]['validation_verdict'] == 'passed'
        assert recorded[0]['request_count'] == 2
        assert recorded[0]['response_kinds'] == ['read-call', 'completed']
        analysis = json.loads(
            (run_dir / 'openai-image-wire-analysis.json').read_text()
        )
        assert analysis['read_function_call_wire'] is True
        assert analysis['function_call_output_image_wire'] is True

    # Parser-only examples stay in memory, never in binary evidence/debug.log.
    wire_requests = [
        {'response_kind': kind, 'body': {
            'instructions': 'private instruction', 'tools': [],
            'input': items, 'prompt_cache_key': 'unit-thread',
        }}
        for kind, items in (
            ('completed', ['private seed']),
            ('completed', ['private seed', 'next']),
            ('compaction', ['private seed', 'next', 'trigger']),
            ('completed', ['opaque', 'continued']),
            ('compaction', ['opaque', 'continued', 'trigger']),
        )
    ]
    diagnostic_examples = []
    for index, (request, prefix, append) in enumerate(zip(
        wire_requests, (0, 1, 0, 0, 0), ('false', 'true', 'false', 'false', 'false')
    )):
        kind = 'compact' if request['response_kind'] == 'compaction' else 'create'
        items = request['body']['input']
        size = len(json.dumps(items, separators=(',', ':')).encode())
        diagnostic_examples.append(
            '[OpenAI Compat] SSE client → http://unit.invalid/responses\n'
            f'[OpenAI Compat] Wire prefix kind={kind} '
            'instructions=aaaaaaaaaaaaaaaa/19B tools=bbbbbbbbbbbbbbbb/2B/0 '
            f'input={index:016x}/{size}B/{len(items)} '
            f'commonPrefixItems={prefix} appendOnly={append}'
        )
    diagnostic_text = '\n'.join(diagnostic_examples)
    wire_analysis = module.analyze_openai_wire_debug(diagnostic_text, wire_requests)
    assert wire_analysis['matched']
    assert wire_analysis['cross_client_append_only']
    assert wire_analysis['create_compact_isolated']
    ambiguous_requests = [wire_requests[0], {**wire_requests[0], 'body': {
        **wire_requests[0]['body'], 'prompt_cache_key': 'other-thread'}}]
    ambiguous_text = '\n'.join([diagnostic_examples[0]] * 2)
    assert not module.analyze_openai_wire_debug(ambiguous_text, ambiguous_requests)['matched']
    other_scope = json.loads(json.dumps(wire_requests))
    other_scope[0]['body']['prompt_cache_key'] = 'title-thread'
    scoped_text = diagnostic_text.replace('commonPrefixItems=1 appendOnly=true',
                                          'commonPrefixItems=0 appendOnly=false')
    assert module.analyze_openai_wire_debug(scoped_text, other_scope)['matched']
    with_models = [{'method': 'GET', 'path': '/v1/models', 'body': None}, *wire_requests]
    assert module.analyze_openai_wire_debug(diagnostic_text, with_models)['matched']
    title_only = json.loads(json.dumps(wire_requests))
    for request in title_only:
        request['body']['instructions'] = module.TITLE_GENERATION_INSTRUCTION
    title_text = diagnostic_text.replace('19B', str(len(module.TITLE_GENERATION_INSTRUCTION.encode())) + 'B')
    title_analysis = module.analyze_openai_wire_debug(title_text, title_only)
    assert title_analysis['matched']
    assert not title_analysis['create_compact_isolated']
    assert not title_analysis['cross_client_append_only']
    for broken in (
        '',
        diagnostic_text.replace('commonPrefixItems=1 appendOnly=true',
                                'commonPrefixItems=0 appendOnly=false'),
        diagnostic_text.replace('kind=compact', 'kind=create', 1),
        diagnostic_text.replace('19B', '20B', 1),
        diagnostic_text.replace('aaaaaaaaaaaaaaaa', 'cccccccccccccccc', 1),
        diagnostic_text.replace('appendOnly=true', 'appendOnly=true private seed'),
        diagnostic_text + '\n[OpenAI Compat] Wire prefix analysis failed: failure',
        diagnostic_text + '\n' + diagnostic_examples[-1],
    ):
        assert not module.analyze_openai_wire_debug(broken, wire_requests)['matched']
    no_client = diagnostic_text.replace('[OpenAI Compat] SSE client → ', 'not a client ')
    assert not module.analyze_openai_wire_debug(
        no_client, wire_requests
    )['cross_client_append_only']
    shared_baseline = diagnostic_text.replace(
        diagnostic_examples[2], diagnostic_examples[2].replace(
            'commonPrefixItems=0 appendOnly=false',
            'commonPrefixItems=2 appendOnly=true',
        ),
    )
    assert not module.analyze_openai_wire_debug(shared_baseline, wire_requests)['matched']

    with tempfile.TemporaryDirectory(prefix='release-driver-remote-compact-') as root_string:
        run_dir = Path(root_string) / 'openai-remote-compaction'
        transcript_path = run_dir / 'config' / 'projects' / 'release.jsonl'
        entries = []
        write_transcript(transcript_path, entries)
        recorded = []
        visible_requests = 0
        compact_gate = object.__new__(module.BinaryGate)
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
        requests = [{
            'response_kind': 'completed',
            'body': {'input': [{'type': 'message'}]},
            'authorization': {'present': True, 'matches_dummy': True},
        }, {
            'response_kind': 'compaction',
            'body': {'input': [{'type': 'message'}, {'type': 'compaction_trigger'}]},
            'authorization': {'present': True, 'matches_dummy': True},
        }, {
            'response_kind': 'completed',
            'body': {'input': [first_item, {'type': 'message'}]},
            'authorization': {'present': True, 'matches_dummy': True},
        }, {
            'response_kind': 'compaction',
            'body': {'input': [first_item, {'type': 'message'}, {'type': 'compaction_trigger'}]},
            'authorization': {'present': True, 'matches_dummy': True},
        }]
        compact_gate.start = lambda _label: (
            run_dir,
            'compact-session',
            'compact-target',
            True,
        )

        def send_compact(_target, _run_dir, text, _filename):
            nonlocal visible_requests
            visible_requests += 1
            if text.startswith('Reply with the remote compaction seed'):
                entries.append({
                    'type': 'assistant',
                    'message': {
                        'role': 'assistant',
                        'content': [{'type': 'text', 'text': 'RELEASE_COMPACTION_SEED_OK'}],
                    },
                })
            elif text == '/compact RELEASE_COMPACT_CALLER' and visible_requests == 2:
                entries.append({
                    'type': 'system',
                    'subtype': 'compact_boundary',
                    'content': 'Conversation compacted',
                    'openAICompaction': first_item,
                    'compactMetadata': {'mode': 'codex'},
                })
            elif text.startswith('Reply with the remote compaction continuation'):
                entries.append({
                    'type': 'assistant',
                    'message': {
                        'role': 'assistant',
                        'content': [{'type': 'text', 'text': 'RELEASE_COMPACTION_CONTINUATION_OK'}],
                    },
                })
            elif text == '/compact' and visible_requests == 4:
                entries.append({
                    'type': 'system',
                    'subtype': 'compact_boundary',
                    'content': 'Conversation compacted',
                    'openAICompaction': second_item,
                    'compactMetadata': {'mode': 'codex'},
                })
            write_transcript(transcript_path, entries)

        def capture_compact(_target, path, **_kwargs):
            text = 'Conversation compacted\nRELEASE_COMPACTION_CONTINUATION_OK\n❯\n'
            path.write_text(text)
            return text

        compact_gate.send = send_compact
        compact_gate.wait_until = lambda predicate, *_args: predicate()
        compact_gate.capture = capture_compact
        compact_gate.mock_response_requests = (
            lambda _run_dir: requests[:visible_requests]
        )
        compact_gate.mock_servers = {run_dir.name: SimpleNamespace(snapshot=lambda: requests[:visible_requests])}
        compact_gate.transcript_paths = (
            lambda _run_dir, **_kwargs: [transcript_path]
        )
        compact_gate.transcript = (
            module.BinaryGate.transcript.__get__(compact_gate, module.BinaryGate)
        )
        compact_gate.path_entries = (
            module.BinaryGate.path_entries.__get__(compact_gate, module.BinaryGate)
        )
        compact_gate.assistant_text = (
            module.BinaryGate.assistant_text.__get__(compact_gate, module.BinaryGate)
        )
        compact_gate.close = lambda *_args: {'stopped': True}
        compact_gate.cleanup_passed = lambda _cleanup: True
        compact_gate.record = recorded.append
        compact_gate.required_assertion = (
            module.BinaryGate.required_assertion.__get__(
                compact_gate,
                module.BinaryGate,
            )
        )

        module.BinaryGate.openai_remote_compaction(compact_gate)

        assert recorded[0]['response_kinds'] == [
            'completed',
            'compaction',
            'completed',
            'compaction',
        ]
        assert recorded[0]['persisted_compaction_count'] == 2
        assert recorded[0]['validation_verdict'] == 'failed', (
            'compact boundaries without checkpoint metadata must fail'
        )

        assert not json.loads((run_dir / 'openai-remote-compaction-analysis.json').read_text())['persisted_chain']
        original_send = compact_gate.send

        def send_with_checkpoint(*args):
            original_send(*args)
            for entry in entries:
                if entry.get('subtype') == 'compact_boundary':
                    entry['compactMetadata'].update({
                        'provider': 'openai',
                        'preCompactTokens': 100,
                        'postCompactTokens': 20,
                        'compactionCallTokens': 30,
                        'compactionResponseId': entry['openAICompaction']['id'],
                    })
            write_transcript(transcript_path, entries)

        entries.clear()
        visible_requests = 0
        recorded.clear()
        compact_gate.send = send_with_checkpoint
        module.BinaryGate.openai_remote_compaction(compact_gate)
        assert recorded[0]['validation_verdict'] == 'failed', (
            'checkpoint fixtures cannot substitute for create/compact product diagnostics'
        )
        assert json.loads((run_dir / 'openai-remote-compaction-analysis.json').read_text())['persisted_chain']
        requests[1]['body']['instructions'] = 'system\n\nRELEASE_COMPACT_CALLER\n\nRELEASE_PRECOMPACT_HOOK'
        requests[3]['body']['instructions'] = 'system\n\nRELEASE_PRECOMPACT_HOOK'
        # Test handler composition separately, without fabricating product log files.
        with patch.object(module, 'analyze_openai_wire_debug', return_value={
            'matched': True, 'create_compact_isolated': True,
        }):
            for sender, expected in ((original_send, 'failed'),
                                     (send_with_checkpoint, 'passed')):
                entries.clear()
                visible_requests = 0
                recorded.clear()
                compact_gate.send = sender
                module.BinaryGate.openai_remote_compaction(compact_gate)
                assert recorded[0]['validation_verdict'] == expected
            for invalid in ('', 'system\n\nRELEASE_PRECOMPACT_HOOK',
                            'RELEASE_PRECOMPACT_HOOK\n\nRELEASE_COMPACT_CALLER',
                            'RELEASE_COMPACT_CALLER\n\nRELEASE_PRECOMPACT_HOOK\n\nRELEASE_PRECOMPACT_HOOK'):
                requests[1]['body']['instructions'] = invalid
                entries.clear()
                visible_requests = 0
                recorded.clear()
                compact_gate.send = send_with_checkpoint
                module.BinaryGate.openai_remote_compaction(compact_gate)
                assert recorded[0]['validation_verdict'] == 'failed', (
                    'missing, reordered or duplicate compact instructions must fail'
                )

    with tempfile.TemporaryDirectory(prefix='release-driver-usage-error-') as root_string:
        run_dir = Path(root_string) / 'openai-responses-usage-error'
        transcript_path = run_dir / 'config' / 'projects' / 'release.jsonl'
        write_transcript(transcript_path, [{
            'type': 'assistant',
            'message': {
                'role': 'assistant',
                'content': [{
                    'type': 'text',
                    'text': 'RELEASE_OPENAI_USAGE_OK',
                }],
                'usage': {
                    'input_tokens': 25,
                    'output_tokens': 7,
                    'cache_read_input_tokens': 60,
                    'cache_creation_input_tokens': 15,
                },
            },
        }, {
            'type': 'assistant',
            'isApiErrorMessage': True,
            'message': {
                'role': 'assistant',
                'content': 'RELEASE_OPENAI_INCOMPLETE_REASON',
            },
        }])
        recorded = []
        visible_requests = 0
        usage_error_gate = object.__new__(module.BinaryGate)
        requests = [{
            'response_kind': 'usage-completed',
        }, {
            'response_kind': 'response.incomplete',
        }]
        usage_error_gate.start = lambda _label: (
            run_dir,
            'usage-error-session',
            'usage-error-target',
            True,
        )

        def send_usage_error(*_args):
            nonlocal visible_requests
            visible_requests += 1

        def capture_usage_error(_target, path, **_kwargs):
            text = 'RELEASE_OPENAI_INCOMPLETE_REASON\n❯\n'
            path.write_text(text)
            return text

        usage_error_gate.send = send_usage_error
        usage_error_gate.wait_until = lambda predicate, *_args: predicate()
        usage_error_gate.capture = capture_usage_error
        usage_error_gate.mock_response_requests = (
            lambda _run_dir: requests[:visible_requests]
        )
        usage_error_gate.transcript_paths = (
            lambda _run_dir, **_kwargs: [transcript_path]
        )
        usage_error_gate.path_entries = module.BinaryGate.path_entries.__get__(
            usage_error_gate,
            module.BinaryGate,
        )
        usage_error_gate.close = lambda *_args: {'stopped': True}
        usage_error_gate.cleanup_passed = lambda _cleanup: True
        usage_error_gate.record = recorded.append
        usage_error_gate.required_assertion = (
            module.BinaryGate.required_assertion.__get__(
                usage_error_gate,
                module.BinaryGate,
            )
        )

        module.BinaryGate.openai_responses_usage_error(usage_error_gate)

        assert recorded[0]['validation_verdict'] == 'passed'
        assert recorded[0]['request_count'] == 2
        assert recorded[0]['observed_normalized_usage'] == {
            'input_tokens': 25,
            'output_tokens': 7,
            'cache_read_input_tokens': 60,
            'cache_creation_input_tokens': 15,
        }
        assert recorded[0]['error_propagated'] is True
        assert recorded[0]['no_fallback_or_retry'] is True

    with tempfile.TemporaryDirectory(prefix='release-driver-first-party-') as root_string:
        run_dir = Path(root_string) / 'first-party-bootstrap-picker'
        config = run_dir / 'config'
        config.mkdir(parents=True)
        option = {
            'value': 'release-first-party-bootstrap-model',
            'label': 'RELEASE_FIRST_PARTY_BOOTSTRAP_MODEL',
            'description': 'Release validation bootstrap model',
        }
        (config / '.claude.json').write_text('{}\n')
        (run_dir / 'debug.log').write_text('')
        bootstrap_requests = []
        recorded = []
        first_party_gate = object.__new__(module.BinaryGate)
        first_party_gate.start = lambda _label: (
            run_dir,
            'first-party-session',
            'first-party-target',
            True,
        )
        def first_party_tmux(*args, **_kwargs):
            if args[:4] == ('send-keys', '-t', 'first-party-target', 'M-p'):
                assert bootstrap_requests == [{
                    'path': '/api/claude_cli/bootstrap',
                }]
            return subprocess.CompletedProcess(args, 0, '', '')

        first_party_gate.tmux = first_party_tmux
        first_party_gate.send = lambda *_args: (_ for _ in ()).throw(AssertionError('unexpected model current command'))

        def capture_first_party(_target, path, **_kwargs):
            if not bootstrap_requests:
                bootstrap_requests.append({'path': '/api/claude_cli/bootstrap'})
                (config / '.claude-local-oauth.json').write_text(json.dumps({
                    'additionalModelOptionsCache': [option],
                }))
            text = 'Select model\nRELEASE_FIRST_PARTY_BOOTSTRAP_MODEL ✔\n'
            path.write_text(text)
            return text

        first_party_gate.capture = capture_first_party

        def wait_first_party(predicate, *_args):
            if not bootstrap_requests:
                bootstrap_requests.append({'path': '/api/claude_cli/bootstrap'})
                (config / '.claude-local-oauth.json').write_text(json.dumps({
                    'additionalModelOptionsCache': [option],
                }))
            return predicate()

        first_party_gate.wait_until = wait_first_party
        first_party_gate.mock_servers = {
            run_dir.name: SimpleNamespace(snapshot=lambda: bootstrap_requests),
        }
        first_party_gate.close = lambda *_args: {'stopped': True}
        first_party_gate.cleanup_passed = lambda _cleanup: True
        first_party_gate.record = recorded.append
        first_party_gate.required_assertion = (
            module.BinaryGate.required_assertion.__get__(
                first_party_gate,
                module.BinaryGate,
            )
        )

        module.BinaryGate.first_party_bootstrap_picker(first_party_gate)

        assert recorded[0]['validation_verdict'] == 'passed'
        assert recorded[0]['unkeyed_cache'] is True
        assert recorded[0]['bootstrap_endpoint_once'] is True
        assert recorded[0]['picker_visible'] is True
        assert recorded[0]['current_model_confirmed'] is True
        assert all(
            'bootstrap-cache-seed.json' not in path
            for assertion in recorded[0]['assertions']
            for path in assertion['observed_evidence_paths']
        )

    class OrphanMockServer:
        def __init__(self):
            self.stop_calls = 0

        def stop(self):
            self.stop_calls += 1
            return {'stopped': True, 'thread_alive': False}

    orphan_gate = object.__new__(module.BinaryGate)
    orphan_gate.active_runs = {}
    orphan_gate.mock_servers = {'orphan-run': OrphanMockServer()}
    orphan_gate.evidence_root = Path('/tmp/release-driver-orphan-evidence')
    orphan_server = orphan_gate.mock_servers['orphan-run']
    orphan_cleanup = module.BinaryGate.close_active_runs(orphan_gate)
    assert orphan_server.stop_calls == 1
    assert orphan_cleanup == [{
        'session': None,
        'evidence_dir': '/tmp/release-driver-orphan-evidence/runs/orphan-run',
        'kill_exit': 0,
        'pane_pid': '',
        'process_remaining': False,
        'remaining_processes': [],
        'forced_termination': [],
        'mock_server': {'stopped': True, 'thread_alive': False},
    }]

    assert "if label in MOCK_OPENAI_TARGETS:" in driver
    repository_state_method = driver.split(
        '    def repository_state(self):', 1
    )[1].split('\n    def ', 1)[0]
    assert "'mtime_ns'" not in repository_state_method
    assert "'size': self.binary.stat().st_size" in repository_state_method
    assert "'sha256': sha256(self.binary)" in repository_state_method
    baseline_binary = BASELINE_PATH.read_text().split(
        "        'binary': {", 1
    )[1].split('        },', 1)[0]
    assert "'mtime_ns'" not in baseline_binary
    assert "'size': binary.stat().st_size" in baseline_binary
    assert "'sha256': sha256(binary)" in baseline_binary
    start_method = driver.split('    def start(self, label):', 1)[1].split('\n    def ', 1)[0]
    collision_check = start_method.index("if self.tmux('has-session', '-t', session).returncode == 0:")
    mock_server_start = start_method.index('mock_base_url = mock_server.start()')
    assert collision_check < mock_server_start

    launcher = LAUNCHER_PATH.read_text()
    assert "value = os.environ.get(f'CC_VALIDATION_{name}') or os.environ.get(name)" in driver
    assert "value = merge_no_proxy(value, '127.0.0.1', 'localhost')" in driver
    assert "uses_local_mock = label in MOCK_OPENAI_TARGETS or label == 'first-party-bootstrap-picker'" in driver
    assert "if uses_local_mock:\n            mock_server = MockOpenAIServer(run_dir, label)" in driver
    assert "if name == 'NO_PROXY' and uses_local_mock:" in driver
    assert 'set -- env -i' in launcher
    assert 'exec "$@"' in launcher
    assert 'CLAUDE_CODE_USE_OPENAI="${CC_VALIDATION_USE_OPENAI:-1}"' in launcher
    assert 'ANTHROPIC_API_KEY="$CC_VALIDATION_ANTHROPIC_API_KEY"' in launcher
    assert 'CC_VALIDATION_LOCAL_OAUTH_API_BASE' in launcher
    assert 'USE_LOCAL_OAUTH=1' in launcher
    assert 'CLAUDE_LOCAL_OAUTH_API_BASE="$CC_VALIDATION_LOCAL_OAUTH_API_BASE"' in launcher
    assert 'DISABLE_AUTOUPDATER=1' in launcher
    assert 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS="${CC_VALIDATION_AGENT_TEAMS:-}"' in launcher
    assert 'CLAUDE_CODE_RUN_AGENT_FAULT_INJECTION_FOR_TESTING="${CC_VALIDATION_RUN_AGENT_FAULT_INJECTION:-}"' in launcher
    assert 'CC_VALIDATION_RUN_AGENT_FAULT_INJECTION=after_query_start' in driver
    assert 'CC_VALIDATION_SSH_IO="${CC_VALIDATION_SSH_IO:-}"' in launcher
    assert 'CC_VALIDATION_SSH_BIN="${CC_VALIDATION_SSH_BIN:-}"' in launcher
    assert 'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK="${CC_VALIDATION_DISABLE_NONSTREAMING_FALLBACK:-}"' in launcher
    assert 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="${CC_VALIDATION_DISABLE_NONESSENTIAL_TRAFFIC:-}"' in launcher
    assert 'CLAUDE_CODE_MAX_RETRIES="${CC_VALIDATION_MAX_RETRIES:-}"' in launcher
    for name in (
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'NO_PROXY',
        'http_proxy',
        'https_proxy',
        'all_proxy',
        'no_proxy',
    ):
        assert f'{name}="${{CC_VALIDATION_{name.upper()}:-${{{name}:-}}}}"' in launcher
    for name in module.AUTH_ENV_VARS:
        if name == 'ANTHROPIC_API_KEY':
            continue
        assert f'{name}=' not in launcher

    with tempfile.TemporaryDirectory(prefix='release-launcher-test-') as root_string:
        root = Path(root_string)
        repo = root / 'repo'
        evidence = root / 'evidence'
        config = root / 'config'
        home = root / 'home'
        for path in (repo, evidence, config, home):
            path.mkdir()
        binary = repo / 'built-claude'
        binary.write_text(
            '#!/bin/sh\n'
            '/usr/bin/env > "$HOME/child.env"\n'
            '/usr/bin/printf "%s\\n" "$@" > "$HOME/child.args"\n'
        )
        binary.chmod(0o755)
        proxy_env = {
            name: f'http://{name.lower()}.example.test:7890'
            for name in (
                'HTTP_PROXY',
                'HTTPS_PROXY',
                'ALL_PROXY',
                'NO_PROXY',
                'http_proxy',
                'https_proxy',
                'all_proxy',
                'no_proxy',
            )
        }
        validation_proxy_env = {
            f'CC_VALIDATION_{name.upper()}': f'http://validation-{name.lower()}.example.test:7891'
            for name in ('HTTP_PROXY', 'NO_PROXY', 'http_proxy', 'no_proxy')
        }
        launch_env = {
            'PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
            'CC_VALIDATION_REPO_ROOT': str(repo),
            'CC_VALIDATION_EVIDENCE_DIR': str(evidence),
            'CC_VALIDATION_CONFIG_DIR': str(config),
            'CC_VALIDATION_HOME': str(home),
            'CC_VALIDATION_USE_OPENAI': '1',
            'CC_VALIDATION_OPENAI_BASE_URL': 'http://127.0.0.1:34567',
            'CC_VALIDATION_SYSTEM_PROMPT': 'release launcher prompt marker',
            'CC_VALIDATION_DISABLE_NONSTREAMING_FALLBACK': '1',
            'CC_VALIDATION_DISABLE_NONESSENTIAL_TRAFFIC': '1',
            'CC_VALIDATION_MAX_RETRIES': '0',
            'RELEASE_DRIVER_UNRELATED': 'must-not-pass',
            **proxy_env,
            **validation_proxy_env,
            **{name: 'must-not-pass' for name in module.AUTH_ENV_VARS},
        }
        subprocess.run(
            [str(LAUNCHER_PATH)],
            check=True,
            env=launch_env,
            capture_output=True,
            text=True,
        )
        child_env = dict(
            line.split('=', 1)
            for line in (home / 'child.env').read_text().splitlines()
            if '=' in line
        )
        expected_proxy_env = {
            name: launch_env.get(f'CC_VALIDATION_{name.upper()}', value)
            for name, value in proxy_env.items()
        }
        assert {name: child_env.get(name) for name in proxy_env} == expected_proxy_env
        assert child_env['CLAUDE_CODE_USE_OPENAI'] == '1'
        assert child_env['CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK'] == '1'
        assert child_env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] == '1'
        assert child_env['CLAUDE_CODE_MAX_RETRIES'] == '0'
        assert child_env['DISABLE_AUTOUPDATER'] == '1'
        assert child_env['OPENAI_BASE_URL'] == 'http://127.0.0.1:34567'
        assert 'ANTHROPIC_API_KEY' not in child_env
        assert 'CLAUDE_LOCAL_OAUTH_API_BASE' not in child_env
        assert 'RELEASE_DRIVER_UNRELATED' not in child_env
        for name in module.AUTH_ENV_VARS:
            assert name not in child_env
        assert (home / 'child.args').read_text().splitlines() == [
            '--dangerously-skip-permissions',
            '--debug',
            '--debug-file',
            str(evidence / 'debug.log'),
            '--system-prompt',
            'release launcher prompt marker',
        ]

        launch_env['CC_VALIDATION_ANTHROPIC_API_KEY'] = (
            module.DUMMY_ANTHROPIC_API_KEY
        )
        subprocess.run(
            [str(LAUNCHER_PATH)],
            check=True,
            env=launch_env,
            capture_output=True,
            text=True,
        )
        validation_child_env = dict(
            line.split('=', 1)
            for line in (home / 'child.env').read_text().splitlines()
            if '=' in line
        )
        assert validation_child_env['ANTHROPIC_API_KEY'] == (
            module.DUMMY_ANTHROPIC_API_KEY
        )

    with tempfile.TemporaryDirectory(prefix='release-driver-fixture-') as root_string:
        root = Path(root_string)
        repo = root / 'repo'
        evidence = root / 'evidence'
        auth_source = root / 'auth-source.json'
        repo.mkdir()
        evidence.mkdir()
        auth_source.write_text('{"real": "credential"}\n')
        gate = object.__new__(module.BinaryGate)
        gate.repo = repo
        gate.evidence_root = evidence
        gate.auth_source = auth_source
        gate.auth_homes = set()
        run_dir = evidence / 'runs' / 'dummy-effort-run'
        run_dir.mkdir(parents=True)
        config, home = module.BinaryGate.make_fixture(
            gate,
            run_dir,
            'effort-openai-responses-wire',
        )
        try:
            auth_target = home / '.codex' / 'auth.json'
            assert json.loads(auth_target.read_text()) == {
                'OPENAI_API_KEY': module.DUMMY_OPENAI_API_KEY,
            }
            assert auth_target.stat().st_mode & 0o777 == 0o600
            assert json.loads((run_dir / 'auth-source-metadata.json').read_text()) == {
                'source': None,
                'strategy': (
                    'write a fixed dummy API key into a private temporary HOME; '
                    'the local mock server accepts no real credential'
                ),
                'source_exists': None,
                'uses_dummy_credential': True,
                'target_outside_evidence': True,
                'target_outside_repository': True,
                'target_mode': '0o600',
            }
            fixture_settings = json.loads((config / 'settings.json').read_text())
            assert fixture_settings['enableWorkflows'] is True
            assert 'model' not in fixture_settings
            assert 'effortLevel' not in fixture_settings
        finally:
            shutil.rmtree(home)

        first_party_run_dir = evidence / 'runs' / 'first-party-run'
        first_party_run_dir.mkdir(parents=True)
        first_party_config, first_party_home = module.BinaryGate.make_fixture(
            gate,
            first_party_run_dir,
            'first-party-bootstrap-picker',
        )
        try:
            assert json.loads(
                (first_party_home / '.codex' / 'auth.json').read_text()
            ) == {}
            first_party_global_config = json.loads(
                (first_party_config / '.claude-local-oauth.json').read_text()
            )
            assert 'additionalModelOptionsCache' not in first_party_global_config
            assert 'additionalModelOptionsCacheKey' not in first_party_global_config
            assert first_party_global_config['customApiKeyResponses']['approved'] == [
                module.DUMMY_ANTHROPIC_API_KEY[-20:]
            ]
            assert json.loads(
                (first_party_config / 'settings.json').read_text()
            )['model'] == 'release-first-party-bootstrap-model'
            first_party_auth_metadata = json.loads(
                (first_party_run_dir / 'auth-source-metadata.json').read_text()
            )
            assert first_party_auth_metadata['uses_dummy_credential'] is True
            assert first_party_auth_metadata['source'] is None
        finally:
            shutil.rmtree(first_party_home)


def assert_deferred_tool_discovery(module):
    assert 'deferred-tool-discovery' in dict(module.TARGET_PATH_RULES)
    assert callable(getattr(module.BinaryGate, 'deferred_tool_discovery', None))
    assert 'deferred-tool-discovery' in module.MOCK_OPENAI_TARGETS
    assert 'deferred-tool-discovery-off' in module.MOCK_OPENAI_TARGETS
    assert not module.BinaryGate.deferred_discovery_evidence([], True)['passed']
    terminal_schema = {'type': 'object', 'required': ['action'], 'properties': {
        'action': {'enum': ['new-session', 'list-panes', 'send-keys', 'capture-pane',
                            'resize-pane', 'send-signal', 'display-message', 'kill-pane']},
        **{name: {'type': kind} for name, kind in [('target', 'string'), ('text', 'string'),
            ('cols', 'integer'), ('rows', 'integer'), ('enter', 'boolean')]},
    }}
    for enabled in (False, True):
        # Synthetic wire inputs exercise the driver only, not the product binary.
        label = 'deferred-tool-discovery' if enabled else 'deferred-tool-discovery-off'
        with tempfile.TemporaryDirectory() as tmp:
            server = module.MockOpenAIServer(Path(tmp), label)
            body = {'tools': [{'name': 'ToolSearch'}], 'input': []}
            requests = []
            results = {
                'deferred-search': 'Terminal, Workflow' if enabled else 'Terminal',
                'deferred-workflow-off': 'No matching deferred tools found',
                'deferred-open': json.dumps({'target': 'unit-session', 'isRunning': True, 'pid': 88097,
                    'command': '/bin/sh', 'args': ['-c', 'stty -echo; exec cat'],
                    'cols': 80, 'rows': 24, 'preview': ''}),
                'deferred-write': json.dumps({'target': 'unit-session', 'accepted': True, 'isRunning': True}),
                'deferred-resize': json.dumps({'target': 'unit-session', 'cols': 91, 'rows': 31, 'isRunning': True}),
                'deferred-read': json.dumps({'target': 'unit-session', 'text': 'RELEASE_TERMINAL_ROUNDTRIP\r\n',
                    'fromCursor': 0, 'toCursor': 28, 'cols': 91, 'rows': 31, 'isRunning': True,
                    'exitCode': None, 'truncatedBeforeCursor': False, 'mode': 'full',
                    'compressed': False, 'originalBytes': 28, 'returnedBytes': 28}),
                'deferred-status': json.dumps({'target': 'unit-session', 'pid': 88097,
                    'isRunning': True, 'exitCode': None, 'cols': 91, 'rows': 31,
                    'bufferCursor': 1, 'startedAt': 1789060572000, 'lastActivityAt': 1789060573000}),
                'deferred-signal': json.dumps({'target': 'unit-session', 'accepted': True, 'isRunning': True}),
                'deferred-close': json.dumps({'target': 'unit-session', 'closed': True, 'exitCode': 0}),
                'deferred-closed-status': json.dumps({'target': 'unit-session', 'pid': 88097,
                    'isRunning': False, 'exitCode': 0, 'cols': 91, 'rows': 31,
                    'bufferCursor': 1, 'startedAt': 1789060572000, 'lastActivityAt': 1789060574000}),
            }
            for _ in range(12):
                kind, sse = server.response_for(body)
                requests.append({'body': json.loads(json.dumps(body)), 'response_kind': kind,
                                 'authorization': {'present': True, 'matches_dummy': True}})
                if kind == 'deferred-completed':
                    break
                events = [json.loads(line[6:]) for line in sse.splitlines() if line.startswith('data: ')]
                call = next(event for event in events if event['type'] == 'response.function_call_arguments.done')
                assert call['call_id'] == 'fc_' + kind
                assert all(event.get('item', {}).get('id', 'fc_').startswith('fc_') for event in events)
                arguments = json.loads(call['arguments'])
                if kind not in ('deferred-search', 'deferred-workflow-off', 'deferred-open'):
                    assert call['name'] == 'Terminal' and arguments['target'] == 'unit-session'
                body['input'].append({'type': 'function_call', 'call_id': call['call_id'],
                                      'name': call['name'], 'arguments': call['arguments']})
                body['input'].append({'type': 'function_call_output', 'call_id': 'fc_' + kind, 'output': results[kind]})
                body['tools'] = [{'name': 'ToolSearch'}, {'name': 'Terminal', 'parameters': terminal_schema}]
                if enabled:
                    body['tools'].append({'name': 'Workflow', 'parameters': {'type': 'object', 'properties': {
                        name: {'type': 'string'} for name in ('name', 'script', 'scriptPath')}}})
            if enabled:
                notification = ('<task-notification>\n<task-id>unit-task</task-id>\n'
                    '<tool-use-id>fc_deferred-open</tool-use-id>\n'
                    '<task-type>interactive_terminal</task-type>\n'
                    '<output-file>/tmp/tasks/unit-task.output</output-file>\n'
                    '<status>killed</status>\n'
                    '<summary>Terminal unit-session was stopped</summary>\n</task-notification>')
                body['input'].append({'role': 'user', 'content': [
                    {'type': 'input_text', 'text': notification}]})
                kind, sse = server.response_for(body)
                requests.append({'body': json.loads(json.dumps(body)), 'response_kind': kind,
                                 'authorization': {'present': True, 'matches_dummy': True}})
            assert module.BinaryGate.deferred_discovery_evidence(requests, enabled)['passed']
            if enabled:
                assert kind == 'deferred-notification-ack'
                assert 'RELEASE_DEFERRED_NOTIFICATION_ACK' in sse
                assert not module.BinaryGate.deferred_discovery_evidence(requests[:-1], True)['passed']
                for mutation in ('foreign-session', 'foreign-tool', 'foreign-task', 'wrong-type',
                                 'wrong-status', 'duplicate-notification', 'no-notification',
                                 'extra-round', 'early-notification', 'duplicate-call',
                                 'duplicate-result', 'missing-result', 'reordered-call', 'reordered-round'):
                    broken = json.loads(json.dumps(requests))
                    items = broken[-1]['body']['input']
                    text = items[-1]['content'][0]['text']
                    replacements = {
                        'foreign-session': ('Terminal unit-session', 'Terminal foreign-session'),
                        'foreign-tool': ('fc_deferred-open', 'fc_foreign-open'),
                        'foreign-task': ('<task-id>unit-task', '<task-id>foreign-task'),
                        'wrong-type': ('interactive_terminal', 'local_bash'),
                        'wrong-status': ('<status>killed', '<status>running'),
                    }
                    if mutation in replacements:
                        items[-1]['content'][0]['text'] = text.replace(*replacements[mutation])
                    elif mutation == 'duplicate-notification':
                        items.append(items[-1])
                    elif mutation == 'no-notification':
                        items.pop()
                    elif mutation == 'extra-round':
                        broken.append(broken[-1])
                    elif mutation == 'early-notification':
                        broken[-2]['body']['input'].append(items[-1])
                    elif mutation == 'duplicate-call':
                        items.insert(0, items[0])
                    elif mutation == 'duplicate-result':
                        items.insert(1, items[1])
                    elif mutation == 'missing-result':
                        items.pop(1)
                    elif mutation == 'reordered-call':
                        items[0], items[2] = items[2], items[0]
                    else:
                        broken[3], broken[4] = broken[4], broken[3]
                    assert not module.BinaryGate.deferred_discovery_evidence(broken, True)['passed'], mutation
                # The first DONE pane is not a completion barrier: notification
                # delivery and rendering of its acknowledgement are separate ticks.
                gate = object.__new__(module.BinaryGate)
                gate.start = lambda label: (Path(tmp), 'session', 'pane', True)
                gate.send = lambda *args: None
                gate.close = lambda *args: {}
                gate.cleanup_passed = lambda cleanup: True
                gate.record = lambda result: None
                gate.required_assertion = lambda *args, **kwargs: {
                    'validation_verdict': 'passed' if kwargs['passed'] else 'failed'}
                tick = {'value': 0}
                gate.mock_response_requests = lambda directory: (
                    requests if tick['value'] >= 1 else requests[:-1])
                def capture(target, path):
                    text = ('RELEASE_DEFERRED_NOTIFICATION_ACK' if tick['value'] >= 2
                            else 'RELEASE_DEFERRED_DONE')
                    path.write_text(text)
                    return text
                gate.capture = capture
                waits = []
                def wait(predicate, *args):
                    for value in range(3):
                        tick['value'] = value
                        waits.append(bool(predicate()))
                    return waits[-1]
                gate.wait_until = wait
                # Isolate the enabled case while retaining the handler's two-case loop.
                original = module.BinaryGate.deferred_discovery_evidence
                gate.deferred_discovery_evidence = lambda rows, active: (
                    original(rows, True) if active else {'passed': True})
                module.BinaryGate.deferred_tool_discovery(gate)
                assert waits[-3:] == [False, False, True]
                for step, field, value in [
                    *[(step, 'target', 'foreign-session') for step in
                      ('open', 'write', 'resize', 'read', 'status', 'signal', 'close', 'closed-status')],
                    ('open', 'isRunning', False), ('write', 'accepted', False),
                    ('write', 'isRunning', False), ('resize', 'cols', 80),
                    ('resize', 'rows', 24), ('resize', 'isRunning', False),
                    ('read', 'text', ''), ('status', 'isRunning', False),
                    ('signal', 'accepted', False), ('close', 'closed', False),
                    ('closed-status', 'isRunning', True),
                ]:
                    broken = json.loads(json.dumps(requests))
                    for request in broken:
                        for item in request['body']['input']:
                            if item.get('type') == 'function_call_output' and item.get('call_id') == f'fc_deferred-{step}':
                                result = json.loads(item['output'])
                                result[field] = value
                                if step == 'read':
                                    result['preview'] = 'RELEASE_TERMINAL_ROUNDTRIP'
                                item['output'] = json.dumps(result)
                    assert not module.BinaryGate.deferred_discovery_evidence(broken, True)['passed'], (step, field)
            for mutation in ('schema', 'result', 'auth', 'completion', 'initial'):
                broken = json.loads(json.dumps(requests))
                if mutation == 'schema':
                    broken[1]['body']['tools'][1]['parameters']['properties'].pop('target')
                elif mutation == 'result':
                    for request in broken:
                        request['body']['input'] = [item for item in request['body']['input']
                            if item.get('call_id') != ('fc_deferred-close' if enabled else 'fc_deferred-workflow-off')]
                elif mutation == 'auth':
                    broken[-1]['authorization']['matches_dummy'] = False
                elif mutation == 'completion':
                    broken[-1]['response_kind'] = 'deferred-invalid-open'
                else:
                    broken[0]['body']['tools'].append({'name': 'Terminal'})
                assert not module.BinaryGate.deferred_discovery_evidence(broken, enabled)['passed'], mutation


def assert_plugins_reload(module):
    assert 'plugins-reload' in dict(module.TARGET_PATH_RULES)
    assert 'plugins-reload' in module.MOCK_OPENAI_TARGETS
    for path in ('src/utils/plugins/refresh.ts', 'src/services/plugins/pluginOperations.ts',
                 'src/commands/reload-plugins/reload-plugins.ts', 'src/services/mcp/utils.ts'):
        assert 'plugins-reload' in module.required_targets_for_paths([path])
    assert callable(getattr(module.BinaryGate, 'plugins_reload', None))
    assert not module.BinaryGate.plugins_reload_evidence([], [])['passed']
    requests, events = [], []
    for index, phase in enumerate(('v1', 'v2', 'repeat')):
        version = 'v1' if phase == 'v1' else 'v2'
        items = []
        for step, server_version, pid in [('plugin', version, 100 + index), ('other', 'other', 200)]:
            result = {'pid': pid, 'version': server_version, 'phase': phase}
            items.append({'type': 'function_call_output', 'call_id': f'fc_plugins-{phase}-{step}', 'output': json.dumps(result)})
            events.append({'pid': pid, 'version': server_version, 'request': {
                'method': 'tools/call', 'params': {'name': f'probe_{server_version}', 'arguments': {'phase': phase}}}})
        for name in ('version', 'standalone', 'removed-command', 'removed-skill'):
            removed = phase != 'v1' and name.startswith('removed-')
            items.append({'type': 'function_call_output', 'call_id': f'fc_plugins-{phase}-{name}',
                          'output': f'Unknown skill: fixture:{name}' if removed else 'Launching skill'})
            if not removed:
                items.append({'role': 'user', 'content': f'PLUGIN_CONTENT_{name}_{version}'})
        items.append({'type': 'function_call_output', 'call_id': 'fc_plugins-update-update',
                      'output': 'Plugin "fixture" updated from 1.0.0 to 2.0.0 for scope user.'})
        requests.append({'response_kind': f'plugins-{phase}-completed',
                         'authorization': {'present': True, 'matches_dummy': True},
                         'body': {'input': items, 'tools': [{'name': f'mcp__plugin_fixture_server__probe_{version}',
                                  'parameters': {'properties': {'phase': {'type': 'string'}}}}]}})
    assert module.BinaryGate.plugins_reload_evidence(requests, events)['passed']
    for mutation in ('missing-call', 'reused-plugin', 'lost-other', 'stale-skill', 'stale-schema', 'no-update', 'real-auth'):
        rows, logs = json.loads(json.dumps(requests)), json.loads(json.dumps(events))
        if mutation == 'missing-call':
            logs.pop()
        elif mutation == 'reused-plugin':
            logs[4]['pid'] = logs[2]['pid']
        elif mutation == 'lost-other':
            logs[5]['pid'] = 201
        elif mutation == 'stale-skill':
            rows[1]['body']['input'] = [item for item in rows[1]['body']['input'] if item.get('role') != 'user']
        elif mutation == 'stale-schema':
            rows[1]['body']['tools'].extend(rows[0]['body']['tools'])
        elif mutation == 'no-update':
            for row in rows:
                row['body']['input'] = [item for item in row['body']['input'] if item.get('call_id') != 'fc_plugins-update-update']
        else:
            rows[0]['authorization']['matches_dummy'] = False
        assert not module.BinaryGate.plugins_reload_evidence(rows, logs)['passed'], mutation
    with tempfile.TemporaryDirectory(prefix='plugins-driver-unit-') as directory:
        root = Path(directory)
        config, home = root / 'config', root / 'home'
        config.mkdir()
        home.mkdir()
        (config / '.claude.json').write_text('{}')
        gate = object.__new__(module.BinaryGate)
        gate.binary = root / 'must-not-run-binary'
        with patch.object(module.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='', stderr='')) as install:
            gate.make_plugin_fixture(root, config, home)
        assert install.call_count == 2
        assert all(call.kwargs['env']['HOME'] == str(home) for call in install.call_args_list)
        assert all('ANTHROPIC_API_KEY' not in call.kwargs['env'] for call in install.call_args_list)
        ast.parse((root / 'plugin-mcp.py').read_text())
        rpc = [{'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2024-11-05'}},
               {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
               {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'probe_v1', 'arguments': {'phase': 'v1'}}}]
        result = subprocess.run([sys.executable, str(root / 'plugin-mcp.py'), 'v1'],
                                input=''.join(json.dumps(row) + '\n' for row in rpc), capture_output=True, text=True, timeout=10)
        assert result.returncode == 0, result.stderr
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        assert replies[1]['result']['tools'][0]['name'] == 'probe_v1'
        assert json.loads(replies[2]['result']['content'][0]['text'])['phase'] == 'v1'
        gate.write_plugin_version(root, 'v2')
        assert not (root / 'marketplace/fixture/commands/removed-command.md').exists()
        assert not (root / 'marketplace/fixture/skills/removed-skill/SKILL.md').exists()
        assert 'PLUGIN_CONTENT_version_v2' in (root / 'marketplace/fixture/commands/version.md').read_text()
        server = module.MockOpenAIServer(root, 'plugins-reload')
        base = server.start()
        try:
            assert base.startswith('http://127.0.0.1:')
            payload = {'model': 'gpt-test', 'input': [{'role': 'user', 'content': 'Run plugin probe'}]}
            request = Request(base + '/v1/responses', data=json.dumps(payload).encode(),
                              headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {module.DUMMY_OPENAI_API_KEY}'})
            with urlopen(request, timeout=10) as response:
                text = response.read().decode()
            assert 'ToolSearch' in text and 'probe_v1' in text
            assert server.snapshot()[-1]['authorization']['matches_dummy']
        finally:
            server.stop()


def assert_openai_stats(module):
    for path in ('src/components/Stats.tsx', 'src/components/Stats.openai.test.tsx',
                 'src/components/OpenAIActivity.tsx', 'src/services/api/usage-chatgpt.ts',
                 'src/services/api/usage.ts', 'src/utils/auth.ts'):
        assert 'openai-stats' in module.required_targets_for_paths([path]), path
    assert callable(getattr(module.BinaryGate, 'openai_stats', None))
    with tempfile.TemporaryDirectory(prefix='stats-auth-unit-') as tmp:
        gate = object.__new__(module.BinaryGate)
        gate.repo = DRIVER_PATH.parents[4]
        gate.evidence_root = Path(tmp)
        gate.auth_source = Path(tmp) / 'must-not-read-real-auth'
        gate.auth_homes = set()
        try:
            for label in ('openai-stats', 'openai-stats-api-key'):
                _, home = gate.make_fixture(Path(tmp) / label, label)
                auth = json.loads((home / '.codex/auth.json').read_text())
                assert auth == {'auth_mode': 'chatgpt', 'tokens': {'access_token': module.OpenAIStatsServer.token}}
                metadata = json.loads((Path(tmp) / label / 'auth-source-metadata.json').read_text())
                assert metadata['uses_dummy_credential'] and metadata['source'] is None
        finally:
            assert not gate.remove_auth_homes()['errors']
    import http.client
    import ssl
    with tempfile.TemporaryDirectory(prefix='stats-driver-unit-') as tmp:
        root = Path(tmp)
        server = module.OpenAIStatsServer(root, root)
        proxy = server.start()
        port = int(proxy.rsplit(':', 1)[1])
        try:
            context = ssl.create_default_context(cafile=str(server.ca))
            def request(path, token=server.token):
                connection = http.client.HTTPSConnection('127.0.0.1', port, context=context, timeout=5)
                try:
                    connection.request('GET', path, headers={'Authorization': f'Bearer {token}'})
                    response = connection.getresponse()
                    return response.status, json.loads(response.read())
                finally:
                    connection.close()
            endpoint = 'https://chatgpt.com' + server.activity_path
            assert request(endpoint) == (200, {'stats': {'lifetime_tokens': 42, 'daily_usage_buckets': []}})
            server.fail = True
            assert request(endpoint)[0] == 503
            server.fail = False
            assert request(endpoint)[0] == 200
            for path in ('https://example.invalid/', 'https://chatgpt.com/unknown',
                         endpoint + '?unexpected=1', 'http://chatgpt.com' + server.activity_path):
                assert request(path)[0] == 403
            assert request(endpoint, 'not-a-credential')[0] == 403
            try:
                connection = http.client.HTTPSConnection('127.0.0.1', port, timeout=5)
                connection.request('GET', endpoint)
            except ssl.SSLCertVerificationError:
                pass
            else:
                raise AssertionError('fixture CA unexpectedly trusted globally')
            finally:
                connection.close()
            # Exercise the actual axios/Bun transport, not the product binary or UI.
            env = {'PATH': module.os.environ.get('PATH', ''), 'HOME': tmp,
                   'NODE_EXTRA_CA_CERTS': str(server.ca), 'HTTPS_PROXY': proxy,
                   'HTTP_PROXY': proxy, 'NO_PROXY': '127.0.0.1,localhost'}
            script = ('import axios from "axios";'
                      'const r = await axios.get(process.argv[1], {headers: '
                      '{Authorization: "Bearer " + process.argv[2]}, timeout: 5000});'
                      'console.log(JSON.stringify(r.data));')
            result = subprocess.run(['bun', '-e', script, endpoint, server.token],
                                    cwd=DRIVER_PATH.parents[4], env=env,
                                    capture_output=True, text=True, timeout=15)
            assert result.returncode == 0, (server.snapshot(), result.stderr)
            assert json.loads(result.stdout)['stats']['lifetime_tokens'] == 42
            assert server.token not in (root / 'openai-stats-http.json').read_text()
        finally:
            assert server.stop()['tls_removed']
        assert not server.tls_dir.exists()
        assert server.stop()['tls_removed']
    # Synthetic panes exercise driver verdict rejection, never product validation.
    for mutation in (None, 'pane', 'http', 'override', 'cleanup', 'stale-local'):
        with tempfile.TemporaryDirectory(prefix='stats-verdict-unit-') as tmp:
            root = Path(tmp)
            gate = object.__new__(module.BinaryGate)
            gate.evidence_root = root
            gate.mock_servers = {}
            registered = {}
            state = {}
            recorded = []
            def start(label):
                run = root / 'runs' / label
                run.mkdir(parents=True)
                (run / 'run-metadata.json').write_text(json.dumps({
                    'driver_run': 'stats-unit', 'source_run': run.name,
                    'label': label, 'evidence_dir': str(run.resolve()),
                }))
                registered[str(run.resolve())] = (run / 'run-metadata.json').read_text()
                (run / 'pane-target.txt').write_text('synthetic-only')
                (run / 'openai-stats-http.json').write_text('[]')
                state.update(label=label, tab=0, rows=[])
                stub = SimpleNamespace(fail=False, snapshot=lambda: list(state['rows']))
                gate.mock_servers[label] = stub
                return run, label, label, True
            def tmux(*args):
                assert args[3:].count('Tab') <= 1, 'navigate one tab per observed state'
                for key in args[3:]:
                    if key == 'Tab':
                        state['tab'] = (state['tab'] + 1) % (2 if state['label'].endswith('api-key') else 3)
                        if state['tab'] == 2 and not state['rows']:
                            state['rows'].append({'route': 'activity', 'status': 200, 'matches_dummy': True})
                    elif key == 'r':
                        state['rows'].append({'route': 'activity', 'status':
                            503 if gate.mock_servers[state['label']].fail else 200, 'matches_dummy': True})
            def capture(target, path, **kwargs):
                text = 'OpenAI provider header\nOverview  Models'
                if not state['label'].endswith('api-key') or mutation == 'override':
                    text += '  OpenAI'
                active = ('Overview', 'Models', 'OpenAI')[state['tab']]
                if mutation == 'stale-local' and state['tab'] == 1:
                    active = 'Overview'
                text = text.replace('  ' + active if active != 'Overview' else '\nOverview',
                                    ('  ' if active != 'Overview' else '\n')
                                    + '\x1b[1m\x1b[48;5;174m ' + active + ' \x1b[0m', 1)
                text += '\nNo stats available yet'
                if state['tab'] == 2:
                    text += '\n' + ('Failed to load OpenAI activity' if gate.mock_servers[state['label']].fail
                            else 'Lifetime tokens: 42')
                    text += '\nEsc to cancel · r to refresh'
                if mutation == 'pane':
                    text = 'unrelated pane'
                if mutation == 'http' and state['rows']:
                    state['rows'][0]['matches_dummy'] = False
                path.write_text(text)
                return text
            gate.start = start
            gate.tmux = tmux
            gate.capture = capture
            gate.send = lambda *args: None
            gate.wait_until = lambda predicate, *args: predicate()
            gate.close = lambda *args: {'process_remaining': mutation == 'cleanup', 'forced_termination': []}
            gate.record = recorded.append
            with patch.object(module.time, 'sleep', return_value=None):
                gate.openai_stats()
            result = recorded[0]
            result['driver_run'] = 'stats-unit'
            assert (result['validation_verdict'] == 'passed') == (mutation is None), mutation
            if mutation is None:
                assert module.validate_required_target_results({'openai-stats'}, recorded, registered)['passed']


def assert_failed_discovery_panes(module):
    for method in ('plugins_reload', 'deferred_tool_discovery',
                   'effort_openai_responses_wire', 'openai_remote_compaction'):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            gate = object.__new__(module.BinaryGate)
            def start(label):
                directory = root / label
                directory.mkdir()
                gate.mock_servers = {directory.name: SimpleNamespace(snapshot=lambda: [])}
                return directory, label, label, False
            def capture(target, path):
                path.write_text('actual failed pane')
                return 'actual failed pane'
            def close(directory, *args):
                panes = list(directory.glob('*pane.txt'))
                assert panes and all(p.read_text() == 'actual failed pane' for p in panes)
                return {}
            gate.start = start
            gate.capture = capture
            gate.close = close
            gate.mock_response_requests = lambda directory: []
            gate.required_assertion = lambda *args, **kwargs: {'validation_verdict': 'failed'}
            gate.record = lambda result: None
            getattr(gate, method)()


def main():
    assert_failed_discovery_panes(load_driver())
    assert_openai_stats(load_driver())
    assert_plugins_reload(load_driver())
    ast.parse(DRIVER_PATH.read_text())
    ast.parse(BASELINE_PATH.read_text())
    module = load_driver()
    baseline_module = load_baseline()
    assert_deferred_tool_discovery(module)
    assert_driver_behavior(module, baseline_module)
    print('test-release-driver.py passed')


if __name__ == '__main__':
    main()
